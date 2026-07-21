# Pushbridge Web / PWA — RelayMock 0.1.1対応版

RelayMock REST APIへ接続する、Pushbullet風のWeb／PWAクライアントです。現在のアプリ版は**0.4.0**、対応するRelayMock契約は**0.1.1**です。

## 0.4.0の主な変更

- 受信／送信済み／保存済み／要確認／すべての分類
- タイトル、本文、URL、ファイル名のローカル検索
- サーバー状態と端末内Blobを合成したファイル利用可能性表示
- `GET /v1/storage/usage`による容量と圧迫度表示
- GUI判断モデルの単体試験

Web／PWAは同一オリジンの`/api/v1`を呼び、ローカル開発プロキシがRelayMockの`/v1`へ変換します。同期の正本は`GET /v1/pushes?after=...`であり、将来Cloudflare Workers、D1、R2、Durable Objectsへ移行してもクライアント側のURLと同期原則を維持できる構成です。

## 0.3.0の主な変更

- RelayMock 0.1.1のCapabilitiesを正本として、ファイル、Payload、端末数、TTL、ポーリング間隔を動的に反映
- 厳格化された6種類の`PushCreate oneOf`へ送信JSONを適合
- `PushOut.file_ref`を同期し、ファイルの`ready`、`expired`、`deleted`状態を通常のPushカーソルで更新
- `GET /v1/web-push-config`とSubscription CRUDをPWA設定画面へ結合
- Subscription再登録の200 upsertと初回201の双方へ対応
- 全REST要求へ`X-Request-ID`を付与し、APIエラーのRequest IDを画面へ表示
- upload／download ticketのbinary転送と410／413／422エラーを正規化
- RelayMock 0.1.1 OpenAPI契約を自動検査する`npm run check:contract`を追加
- RelayMock 0.1.0に対する読み取り互換フォールバックを維持

## 実装済み

- 開発専用Bootstrapと端末スコープBearer Token認証
- `GET /v1/devices/me`による現在端末の自動解決
- note、link、file Push
- `all_other_devices`、`all_devices`、特定端末の宛先
- `Idempotency-Key`と`client_guid`による安全な再送
- RESTカーソル同期、削除墓標、複数ページ取得
- dismiss、再表示、pin、unpin、soft delete、expired表示
- `file_ref`を利用するファイル状態同期
- Ticket方式のファイル送受信：`init → PUT → complete → push`
- 端末一覧、名称変更、追加端末リンク、端末失効、最大端末数表示
- IndexedDB履歴キャッシュとBlob対応オフライン送信箱
- 受信本文とファイルBlobのIndexedDB永続化、サーバー削除後のローカル閲覧
- 既定512MiBの端末内ファイル上限と、未pin／LRU順の自動整理
- Web Locksによる複数タブの送信競合抑止
- PWA Manifest、Service Worker、オフラインアプリシェル
- Web Push設定取得、ブラウザーSubscription作成、APIへのupsert、解除
- RelayMock APIエラーとFastAPI標準422エラーの正規化
- Request IDを含む診断可能なエラー表示
- Cloudflare移行後のWebSocket tickleを追加できる拡張点

## 必要環境

- Node.js 22.12以降
- npm
- RelayMock REST API 0.1.1

RelayMockの既定接続先は次です。

```text
http://127.0.0.1:8000
```

## 起動

RelayMockを`127.0.0.1:8000`へ起動した後、Web／PWA側で実行します。

```bash
npm ci
npm run dev
```

ブラウザーで次を開きます。

```text
http://127.0.0.1:5173
```

初回は「設定」でBootstrapを実行します。ユーザー、現在のPWA端末、端末Bearer Tokenが作成されます。

## 同一オリジン・プロキシ

ブラウザーは`/api/v1`を呼びます。Viteまたは同梱ゲートウェイが次のように変換します。

```text
/api/v1/*       -> http://127.0.0.1:8000/v1/*
/mock-storage/* -> http://127.0.0.1:8000/mock-storage/*
/health         -> http://127.0.0.1:8000/health
```

通常のローカル開発ではCORS設定が不要です。接続先を変更する場合は次のようにします。

```bash
API_PROXY_TARGET=http://127.0.0.1:9000 npm run dev
```

または`.env.local`を作成します。

```dotenv
API_PROXY_TARGET=http://127.0.0.1:8000
VITE_API_BASE_URL=/api/v1
VITE_AUTH_MODE=bearer
VITE_REMEMBER_BEARER_TOKEN=true
VITE_STORAGE_NAMESPACE=relaymock-local
VITE_POLL_INTERVAL_SECONDS=30
```

## ビルド済みPWAとRelayMockを結合する

Web PushのブラウザーSubscriptionやService Workerを含む本番相当の動作は、ビルド済みPWAで確認します。

```bash
npm run build
API_PROXY_TARGET=http://127.0.0.1:8000 npm run serve:local
```

次を開きます。

```text
http://127.0.0.1:4173
```

`serve:local`は`dist/`を配信し、APIプレフィックスの変換とTicket URLの転送を行います。

## 認証

RelayMockの通常APIは端末スコープBearer Tokenを要求します。初回接続は次を使用します。

```text
POST /v1/auth/bootstrap
```

既存Tokenを設定画面へ貼り付けることもできます。TokenはRelayMockから再表示されないため、ローカルPoCではlocalStorageへの保存を既定にしています。無効化した場合はsessionStorageだけを利用します。

これはローカルPoC専用です。本番移行時はパスキー承認、HttpOnly Cookie、短寿命セッション、または安全な端末Credentialへ置き換えてください。

## Capabilities

起動時に次を取得します。

```text
GET /v1/system/capabilities
```

クライアントは以下を固定値として扱いません。

- 最大ファイルサイズ
- 最大Push Payloadサイズ
- Pushおよびファイルの既定TTL
- 選択可能なファイルTTL
- 最大端末数
- 推奨ポーリング間隔
- Realtime、直接アップロード、Web Push登録の可否

0.1.0サーバーでCapabilitiesが404の場合だけ、安全な互換値へフォールバックします。

## REST同期

RelayMockではREST同期だけで最終整合性を保ちます。

```text
GET /v1/pushes?after=<cursor>&limit=100&include_deleted=true
```

同期規則は次のとおりです。

1. IndexedDBから最後のCursorを取得
2. `has_more=true`の間は同一同期処理で次ページを取得
3. 1件以上返った場合は`next_cursor`を保存
4. 0件かつ`next_cursor=null`なら既存Cursorを維持
5. 同一Pushは`modified_at`が新しい場合だけ上書き
6. `status=deleted`はローカルPushを削除
7. `status=expired`はPayload消去済みの履歴として表示
8. `file_ref`の変更も同じPush更新として反映

将来WebSocketを追加する場合も、同期開始のtickleに限定し、このREST同期を正本として維持します。

## Push Payload v1

RelayMock 0.1.1は次の6種類を相互排他的な`oneOf`として定義しています。

```text
note plaintext
note ciphertext + nonce
link plaintext
link ciphertext + nonce
file plaintext + file_id
file ciphertext + nonce + file_id
```

このPWAは現在、平文のnote、link、fileを送信します。たとえばlinkは次の形です。

```json
{
  "target": { "kind": "all_other_devices" },
  "type": "link",
  "payload_version": 1,
  "payload": {
    "title": "Documentation",
    "body": "Read this",
    "url": "https://example.com"
  },
  "client_guid": "job_...",
  "expires_in": 2592000
}
```

file Pushでは`file_id`をトップレベルに置き、表示用メタデータだけを`payload.file`へ格納します。サーバー管理項目の`state`は厳格な`FilePayloadV1`へ送信しません。

## ファイル送受信と`file_ref`

送信手順は次です。

```text
POST /v1/files/init
PUT  /mock-storage/uploads/{ticket}
POST /v1/files/{file_id}/complete
POST /v1/pushes
```

Push応答には非秘密メタデータが含まれます。

```json
{
  "file_ref": {
    "id": "fil_...",
    "state": "ready",
    "size": 12345,
    "expires_at": "2026-07-15T00:00:00Z"
  }
}
```

RelayMockがファイルを`expired`または`deleted`へ変更すると、参照Pushの`modified_at`も進みます。PWAは追加の全件ファイル照会を行わず、通常のカーソル同期でダウンロード可否を更新します。旧0.1.0応答で`file_ref`がない場合だけ、必要に応じて`GET /v1/files/{file_id}`を利用します。

Ticket URLは相対URLと絶対URLの両方へ対応します。URLはCredentialとして扱い、ログや画面へ出力しません。

## Web Push Subscription

設定画面では次の結合試験を行えます。

```text
GET    /v1/web-push-config
POST   /v1/web-push-subscriptions
GET    /v1/web-push-subscriptions
DELETE /v1/web-push-subscriptions/{id}
```

登録時はService Workerと`PushManager`を使い、ブラウザーが発行した`endpoint`、`p256dh`、`auth`をRelayMockへ送ります。同じ端末・endpointの再登録は200 upsert、初回は201として処理されます。

RelayMock 0.1.1はSubscriptionを保存しますが、実際の通知配送は行いません。`vapid_public_key`にはBase64 URL形式の非圧縮P-256公開鍵（65 bytes）が必要で、PWAは登録前に検証します。

## Request IDとエラー

通常のREST要求には次の形式のIDを付けます。

```http
X-Request-ID: req_...
```

RelayMockが返す同じIDをAPIエラー本文またはHeaderから取得し、画面上のエラーへ表示します。Ticket URLには将来の署名付きR2 URLとの互換性を保つため、任意Headerを追加しません。Ticketエラー時はサーバーが生成したRequest IDを利用します。

## PWAキャッシュ

Service Workerは静的アプリシェルだけをキャッシュします。次はキャッシュしません。

```text
/api/*
/mock-storage/*
/health
/realtime
```

Push、端末、同期Cursor、送信箱はHTTP CacheではなくIndexedDBで管理します。

## コマンド

| コマンド | 内容 |
|---|---|
| `npm run dev` | Vite開発サーバーとRelayMockプロキシ |
| `npm run build` | 型検査後にPWAを`dist/`へビルド |
| `npm run serve:local` | `dist/`配信とRelayMockプロキシ |
| `npm run smoke:api` | RelayMock 0.1.1主要フローを実HTTPで検証 |
| `npm run check:contract` | 同梱OpenAPIが必要な0.1.1契約を満たすか検査 |
| `npm run typecheck` | TypeScript型検査 |
| `npm test` | Vitest単体試験 |
| `npm run check` | 契約、型、単体試験、ビルドを一括検証 |

スモーク試験はTokenが未指定ならテスト用アカウントをBootstrapします。

```bash
API_ORIGIN=http://127.0.0.1:8000 npm run smoke:api
```

既存Tokenを使う場合は次のとおりです。

```bash
API_ORIGIN=http://127.0.0.1:8000 \
API_BEARER_TOKEN='replace-me' \
npm run smoke:api
```

スモーク試験はPush、ファイル、Subscriptionを実際に作成し、主要なデータを最後に削除します。共有データを持つ環境では使用しないでください。

## 契約資料

```text
openapi/relaymock.openapi.json

docs/RELAYMOCK_README.md
docs/RESTAPI_DESIGN.md
docs/relaymock-comparison.md
docs/api-adaptation.md
docs/cloudflare-migration.md
```

## 現在の制約

- RelayMockにはWebSocketがなく、推奨間隔によるRESTポーリングを使用
- Web PushはSubscription登録までで、RelayMockによる配送は無効
- E2EEは未実装で、Payloadはローカルモック上では平文
- Token保存はローカルPoC向けであり、本番認証ではない
- ファイルのマルウェア検査はない
- ブラウザー拡張機能はこの成果物に含まれない
- RelayMockサーバー実装自体はこの成果物に含まれない

0.1.1との照合結果と、残る非必須の契約改善候補は[`docs/relaymock-comparison.md`](docs/relaymock-comparison.md)に記載しています。
