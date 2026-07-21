# RelayMock 0.1.1からCloudflareへの移行

Web／PWAが依存するのは外部API契約です。FastAPI、SQLite、ローカルファイルパス、Ticket保存方式には依存しません。

## 維持するブラウザー向け契約

```text
GET    /api/v1/system/capabilities
GET    /api/v1/web-push-config

POST   /api/v1/auth/bootstrap
GET    /api/v1/devices
GET    /api/v1/devices/me
POST   /api/v1/devices/link
PATCH  /api/v1/devices/:id
DELETE /api/v1/devices/:id

GET    /api/v1/pushes?after=...
POST   /api/v1/pushes
GET    /api/v1/pushes/:id
PATCH  /api/v1/pushes/:id
DELETE /api/v1/pushes/:id

POST   /api/v1/files/init
GET    /api/v1/files/:id
POST   /api/v1/files/:id/complete
POST   /api/v1/files/:id/download-ticket
DELETE /api/v1/files/:id

POST   /api/v1/web-push-subscriptions
GET    /api/v1/web-push-subscriptions
DELETE /api/v1/web-push-subscriptions/:id
```

Cloudflare上では`/api/v1`をWorker Routeとして直接処理します。ローカル開発だけが`/api`を除去してRelayMockの`/v1`へ転送します。

## アダプター置換

| RelayMock | Cloudflare |
|---|---|
| FastAPI router | Worker router |
| SQLite | D1 |
| local filesystem | Private R2 |
| upload／download Ticket | R2署名付きPUT／GET URL |
| asyncio cleanup | Cron Trigger＋R2 Lifecycle |
| REST polling | REST polling＋Durable Objects tickle |
| Subscription保存 | VAPID Web Push配送 |
| Bootstrap | Passkey／OAuth／承認済み端末リンク |

## 同期

D1実装でも次の順序を維持します。

```sql
WHERE user_id = ?
  AND (
    modified_at > ?
    OR (modified_at = ? AND id > ?)
  )
ORDER BY modified_at, id
LIMIT ?
```

WebSocketは`sync_required`だけを送り、切断復旧は必ず`GET /pushes?after=`で行います。

### `file_ref`

R2 LifecycleまたはCronでFile状態が変わった場合、参照Pushの`modified_at`を更新して通常のPushカーソルへ再投入します。`file_ref`はID、state、size、expires_atだけを持ち、ファイル名とMIME型はPayloadまたは将来のciphertextへ残します。

## ファイル

Workerはファイル本体を経由しません。

```text
POST /files/init -> 短寿命R2 PUT URL
Browser -> R2 direct PUT
POST /files/:id/complete
POST /pushes
```

PWAは相対RelayMock Ticket URLと絶対R2 URLの双方を処理します。署名付きURLへはAPI用Bearer Token、`X-Request-ID`、`X-Client-Version`を付加しません。署名時に返されたHeadersだけを送ります。

## Capabilities

Workerは環境と料金制御に合わせて次を返します。

- R2空き容量に応じた`max_file_bytes`
- 日次利用量に応じた`max_push_payload_bytes`
- 許可するTTL
- 最大端末数
- Realtime／Web Pushの段階的な有効化
- 推奨RESTポーリング間隔

これにより、無料枠へ近づいた際にクライアントを再配布せず縮退できます。

## Web Push

`GET /api/v1/web-push-config`のVAPID公開鍵と、保存済みSubscriptionを本番配送へ接続します。

- Subscription endpoint、p256dh、authは暗号化保存
- 404／410となったSubscriptionは失効
- Push本文は原則wake-up情報だけ。ファイル時のみ端末別の短寿命・一回限りdownload URLを暗号化payloadへ含める
- Service Workerはユーザー操作を待たずファイルをIndexedDBへ取得し、その後RESTカーソル同期で状態と取りこぼしを補完
- `delivery`を段階的にtrueへ変更

## Request ID

Workerでも`X-Request-ID`を維持します。APIエラー本文の`detail.request_id`と一致させ、CloudflareログまたはTraceへ結び付けます。R2署名付きURLの応答IDはR2側の識別子へ置き換わる可能性があるため、ファイルinit／complete／download-ticketのAPI要求IDも監査ログへ残します。

## 認証

RelayMockのBootstrapと長寿命端末Bearer TokenはPoC用です。本番ではパスキー承認、短寿命Session、端末リンクへ置換します。E2EE鍵は認証Credentialから分離します。

## 移行順序

1. Static AssetsへWeb／PWAを配備
2. WorkerでRelayMock 0.1.1互換APIを実装
3. 同じOpenAPI契約試験と実HTTPスモーク試験を両方へ実行
4. D1 Cursor同期と`file_ref`再投入を検証
5. R2署名付きURLとCORSを検証
6. Subscription保存とWeb Push配送を検証
7. Worker側Routeを有効化
8. RelayMock Tunnel／Proxyを削除
9. Durable Objects tickleを追加
10. 認証とE2EEを本番方式へ切り替え
