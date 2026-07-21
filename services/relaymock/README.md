# RelayMock REST API 0.1.1

Pushbullet型の「端末間Push」クライアントをローカルで開発するためのPythonモックサーバーです。FastAPI、SQLite、ローカルファイルストレージだけで動作します。

| 本番想定 | ローカルモック |
|---|---|
| Cloudflare Worker | FastAPI |
| D1 | SQLite |
| R2 | `data/objects` |
| R2署名付きURL | 短寿命のupload／download ticket |
| Web Push配送 | Subscription登録と設定取得。配送は無効 |
| Durable Objects | RESTカーソル同期のみ |

## 0.1.1の主な変更

- 実際のHTTP動作とOpenAPIレスポンス契約を一致
- 共通`ApiError`と401／403／404／409／410／413レスポンスを定義
- upload requestとdownload responseを`application/octet-stream`として記述
- `PushCreate`を相互排他的な6種類の`oneOf`へ変更
- note／link／fileのPayload v1 Schemaを正式化
- 全日時をOpenAPI `date-time`、ticket URLを`uri-reference`として記述
- `GET /v1/system/capabilities`を追加
- `GET /v1/web-push-config`を追加
- file状態を`PushOut.file_ref`へ反映し、状態変更をPushカーソル同期へ再投入
- Web Push Subscription再登録をupsert化（初回201、再登録200）
- Token応答へ`Cache-Control: no-store`と`Pragma: no-cache`を付与
- 全HTTP応答へ`X-Request-ID`を付与し、APIエラー本文にも同じIDを格納
- 管理Routerを既定で無効化

## 実装済み

- 開発用アカウント作成と端末単位Bearer Token
- 端末一覧、追加、名称変更、失効、最大端末数制限
- note／link／file Push
- 全端末、他の全端末、特定端末の宛先
- `Idempotency-Key`による重複抑止
- `(modified_at, id)`カーソルによる差分同期
- dismiss、pin、soft delete、削除墓標
- PushとファイルのTTL
- file init → PUT → complete → download-ticketフロー
- SHA-256とサイズ検証
- Web Push Subscription登録モック
- CapabilitiesとWeb Push設定
- 任意の管理用reset、cleanup、stats
- Swagger UI、ReDoc、OpenAPI 3.1

## 非目標

これはローカル開発専用です。パスキー、E2EE鍵管理、実際のWeb Push配送、マルウェアスキャン、WebSocket、分散ロック、Cloudflare料金制御は実装していません。`/v1/auth/bootstrap`をインターネットへ公開しないでください。

## 起動

Python 3.11以上を使用します。

```bash
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -e '.[dev]'
python -m uvicorn relaymock.main:app --reload --host 127.0.0.1 --port 8000
```

- API: `http://127.0.0.1:8000`
- Swagger UI: `http://127.0.0.1:8000/docs`
- ReDoc: `http://127.0.0.1:8000/redoc`
- OpenAPI JSON: `http://127.0.0.1:8000/openapi.json`

Docker Composeはloopbackへだけ公開し、開発用管理Routerを明示的に有効化します。

```bash
docker compose up --build
```

## Capabilities

PWAや拡張機能は、固定値を持たず最初に次を取得します。

```bash
curl -sS http://127.0.0.1:8000/v1/system/capabilities
```

標準応答の要点です。

```json
{
  "api_version": "0.1.1",
  "environment_id": "relaymock-local",
  "features": {
    "realtime": false,
    "web_push_delivery": false,
    "web_push_subscription_registration": true,
    "e2ee": false,
    "direct_upload": true,
    "device_registration": true
  },
  "limits": {
    "max_file_bytes": 26214400,
    "max_push_payload_bytes": 2000000,
    "file_ttl_seconds": [3600, 86400, 259200, 604800],
    "default_push_ttl_seconds": 2592000,
    "default_file_ttl_seconds": 86400,
    "max_devices": 10
  },
  "transports": {
    "realtime": ["poll"],
    "upload": ["server-ticket"]
  },
  "recommended_poll_interval_seconds": 30
}
```

旧0.1.0サーバーでこのEndpointが404になる場合だけ、クライアント側の互換値へフォールバックしてください。

## 最短の動作確認

### 1. ユーザーと最初の端末

```bash
curl -i http://127.0.0.1:8000/v1/auth/bootstrap \
  -H 'Content-Type: application/json' \
  -d '{
    "handle":"alice",
    "device_name":"Alice PWA",
    "device_kind":"pwa"
  }'
```

Tokenを平文で返すため、成功応答には次が付与されます。

```http
Cache-Control: no-store
Pragma: no-cache
X-Request-ID: req_...
```

レスポンスの`access_token`を環境変数へ入れます。

```bash
export TOKEN='rly_...'
```

### 2. Noteを送信

```bash
curl -i http://127.0.0.1:8000/v1/pushes \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: note-001' \
  -d '{
    "target":{"kind":"all_other_devices"},
    "type":"note",
    "payload":{"title":"Hello","body":"Local mock works"}
  }'
```

```text
初回作成                   201
同一キー・同一内容の再送   200 + Idempotent-Replayed: true
同一キー・異なる内容       409
```

### 3. 差分同期

```bash
curl -sS "http://127.0.0.1:8000/v1/pushes?limit=100" \
  -H "Authorization: Bearer $TOKEN"
```

`next_cursor`はページ内最後の変更を示すチェックポイントです。`has_more=true`なら直ちに次ページへ進み、`false`でも次回ポーリング時の`after`として保存します。

## PushCreate Payload v1

`payload`と`ciphertext`／`nonce`は排他的です。`type=file`だけが`file_id`を持てます。

### Note plaintext

```json
{
  "type": "note",
  "payload_version": 1,
  "payload": {
    "title": "任意",
    "body": "titleまたはbodyの少なくとも一方が必要"
  }
}
```

### Link plaintext

```json
{
  "type": "link",
  "payload_version": 1,
  "payload": {
    "url": "https://example.com/",
    "title": "任意",
    "body": "任意"
  }
}
```

### File plaintext

```json
{
  "type": "file",
  "file_id": "fil_...",
  "payload_version": 1,
  "payload": {
    "title": "任意",
    "file": {
      "name": "document.pdf",
      "mime_type": "application/pdf",
      "size": 12345,
      "sha256": null,
      "expires_at": "2026-07-15T00:00:00Z"
    }
  }
}
```

### Encrypted content

```json
{
  "type": "file",
  "file_id": "fil_...",
  "payload_version": 1,
  "ciphertext": "base64url-ciphertext",
  "nonce": "base64url-nonce"
}
```

## ファイル共有

```bash
printf 'encrypted bytes' > /tmp/sample.bin
SIZE=$(wc -c < /tmp/sample.bin | tr -d ' ')
SHA=$(python -c "import hashlib; print(hashlib.sha256(open('/tmp/sample.bin','rb').read()).hexdigest())")

INIT=$(curl -sS http://127.0.0.1:8000/v1/files/init \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"filename\":\"sample.bin\",\"size\":$SIZE,\"sha256\":\"$SHA\"}")
```

返された`upload_url`へ認証ヘッダーなしで`application/octet-stream`をPUTし、その後`POST /v1/files/{file_id}/complete`を呼びます。upload ticketとdownload ticketは、無効なら403、期限切れなら410です。

file Pushの応答には非秘密の参照状態が含まれます。

```json
{
  "file_id": "fil_...",
  "file_ref": {
    "id": "fil_...",
    "state": "ready",
    "size": 12345,
    "expires_at": "2026-07-15T00:00:00Z"
  }
}
```

ファイルが`expired`または`deleted`へ変化すると、参照しているPushの`modified_at`も更新されます。クライアントは通常の`GET /v1/pushes?after=...`だけで状態変化を取得できます。

## Web Pushモック

公開設定を取得します。

```bash
curl -sS http://127.0.0.1:8000/v1/web-push-config
```

```json
{
  "subscription_registration": true,
  "delivery": false,
  "vapid_public_key": "base64url-public-key"
}
```

`POST /v1/web-push-subscriptions`は`device_id + endpoint`でupsertします。

```text
初回登録   201
再登録     200（p256dhとauthを更新）
```

## エラーとRequest ID

API固有エラーは次の形です。

```json
{
  "detail": {
    "code": "file_not_ready",
    "message": "The file is not available for download yet.",
    "request_id": "req_..."
  }
}
```

同じ値が`X-Request-ID`応答ヘッダーにも入ります。クライアントが`req_`で始まる`X-Request-ID`を送れば、サーバーはその値を引き継ぎます。FastAPI入力検証の422は標準`HTTPValidationError`形式を維持します。

## API一覧

| Method | Path | 用途 |
|---|---|---|
| GET | `/health` | ヘルスチェック |
| GET | `/v1/system/capabilities` | 機能、制限、transport取得 |
| GET | `/v1/web-push-config` | Web Push公開設定 |
| POST | `/v1/auth/bootstrap` | 開発用ユーザー・初期端末作成 |
| GET | `/v1/devices` | 端末一覧 |
| GET | `/v1/devices/me` | 現在端末 |
| POST | `/v1/devices/link` | 追加端末とToken発行 |
| PATCH | `/v1/devices/{id}` | 名称変更 |
| DELETE | `/v1/devices/{id}` | 端末失効 |
| POST | `/v1/pushes` | Push作成 |
| GET | `/v1/pushes` | カーソル同期 |
| GET | `/v1/pushes/{id}` | Push取得 |
| PATCH | `/v1/pushes/{id}` | dismiss／pin |
| DELETE | `/v1/pushes/{id}` | soft delete |
| POST | `/v1/files/init` | ファイル枠とupload ticket作成 |
| PUT | `/mock-storage/uploads/{ticket}` | binary upload |
| POST | `/v1/files/{id}/complete` | アップロード確定 |
| GET | `/v1/files/{id}` | ファイルメタデータ |
| POST | `/v1/files/{id}/download-ticket` | download ticket作成 |
| GET | `/mock-storage/downloads/{ticket}` | binary download |
| DELETE | `/v1/files/{id}` | ファイル削除 |
| POST | `/v1/web-push-subscriptions` | Subscription upsert |
| GET | `/v1/web-push-subscriptions` | 現端末のSubscription一覧 |
| DELETE | `/v1/web-push-subscriptions/{id}` | Subscription失効 |
| POST | `/v1/mock/cleanup` | TTL処理と容量逼迫時の早期削除を即時実行 |
| POST | `/v1/mock/reset` | DBとオブジェクトを全削除 |
| GET | `/v1/mock/stats` | 件数と保存量 |

## 管理API

管理Routerは既定で登録されません。ローカル開発で必要な場合だけ、次を設定して再起動します。

```bash
export RELAYMOCK_ENABLE_MOCK_ADMIN=true
export RELAYMOCK_ADMIN_TOKEN=local-admin
```

すべての管理操作で必須です。

```http
X-Mock-Admin: local-admin
```

Docker Composeは`127.0.0.1:8000`へだけbindし、この設定を明示しています。

## テストとOpenAPI生成

```bash
python -m pytest
make openapi
```

`make openapi`は管理Endpointも契約書へ含めるため、生成時だけ管理Routerを有効にします。

手動試験用に[`examples/relaymock.http`](examples/relaymock.http)を含めています。状態遷移と本番置換境界は[`DESIGN.md`](DESIGN.md)を参照してください。

## クライアント実装上の注意

- 最初にCapabilitiesを取得し、制限をハードコードしない。
- REST書き込みには`Idempotency-Key`を付ける。
- WebSocketを後から追加しても、最終整合性はカーソル同期で回復する。
- `upload_url`と`download_url`はBearer Credentialとして扱い、ログへ残さない。
- file Pushは`complete`後に作成する。
- fileの表示可否は`file_ref.state`で更新する。
- `include_deleted=true`を同期用途の既定値として削除墓標を取り込む。
- エラー画面へ`request_id`を表示できるようにする。
