# API・同期仕様案

状態: 実装前のv0.1契約  
Base path: `/v1`  
文字コード: UTF-8  
JSONのbinary値: base64url、paddingなし  
DB時刻: Unix epoch milliseconds  
HTTP時刻: RFC 3339またはepoch millisecondsのどちらかに統一し、実装開始時にADRで固定する

## 1. 共通原則

- Web/PWAはHttpOnly session cookieを使用する。
- 拡張機能は端末専用bearer tokenを使用する。
- クライアント入力の`user_id`は受け付けず、認証情報から決定する。
- 作成・変更系は`Idempotency-Key`を要求する。
- `Content-Type: application/json`を厳格に確認する。
- すべてのレスポンスに`X-Request-Id`を付ける。
- `Cache-Control: no-store`をAPIの既定とする。
- API errorは機械可読codeと安全なmessageを返す。
- 機密本文は暗号化済みpayloadだけを受け付ける。

## 2. エラー形式

```json
{
  "error": {
    "code": "device_revoked",
    "message": "The device is no longer authorized.",
    "request_id": "...",
    "retryable": false,
    "details": {}
  }
}
```

主要status/code:

| HTTP | code | 意味 |
|---:|---|---|
| 400 | `invalid_request` | schemaまたは値が不正 |
| 401 | `authentication_required` | session/tokenなし、失効 |
| 403 | `forbidden` | 認証済みだが権限なし |
| 403 | `device_revoked` | 端末失効 |
| 409 | `idempotency_conflict` | 同じkeyで異なるrequest |
| 409 | `state_conflict` | file completion等の状態競合 |
| 410 | `resource_expired` | 期限切れ |
| 413 | `payload_too_large` | 上限超過 |
| 422 | `invalid_ciphertext_metadata` | nonce/version等が不正 |
| 429 | `rate_limited` | user/device/IP quota |
| 503 | `degraded_mode` | 縮退で機能停止 |

429/503では可能なら`Retry-After`を付ける。

## 3. 認証API

実際のWebAuthn request/response schemaは標準ライブラリに合わせる。challengeは5分以下、一回限り、origin/rpId/user actionへbindingする。

### 3.1 Passkey登録開始

```text
POST /v1/auth/passkeys/registration/options
```

未ログインの初回登録ではTurnstile tokenを要求する。追加Passkeyでは再認証済みsessionを要求する。

Request:

```json
{
  "handle": "user-visible-handle",
  "turnstile_token": "..."
}
```

Response:

```json
{
  "challenge_id": "chl_...",
  "public_key": {}
}
```

### 3.2 Passkey登録完了

```text
POST /v1/auth/passkeys/registration/verify
```

Request:

```json
{
  "challenge_id": "chl_...",
  "credential": {},
  "device": {
    "kind": "pwa",
    "public_key": "base64url...",
    "name_ciphertext": "base64url..."
  }
}
```

Responseはuser、device、session metadataを返し、Web/PWAではCookieを設定する。

### 3.3 Login開始・完了

```text
POST /v1/auth/passkeys/authentication/options
POST /v1/auth/passkeys/authentication/verify
```

認証完了時にsessionを新規作成またはローテーションする。WebAuthn sign counterが利用可能なcredentialではclone兆候を検知する。

### 3.4 Session

```text
GET    /v1/session
POST   /v1/session/rotate
DELETE /v1/session
DELETE /v1/sessions/:session_id
```

`GET /v1/session`は秘密値を返さず、user ID、device ID、session expiry、re-auth状態だけを返す。

## 4. 端末API

```text
GET    /v1/devices
PATCH  /v1/devices/:device_id
DELETE /v1/devices/:device_id
```

`DELETE`はsoft revokeとし、次を同じトランザクションまたは整合性のある処理で行う。

- `devices.revoked_at`
- 当該deviceのsession/token revoke
- Web Push subscription revoke
- WebSocket切断通知
- 未使用link codeの失効

### 4.1 拡張機能リンク

```text
POST /v1/device-links/init
POST /v1/device-links/:link_id/approve
POST /v1/device-links/:link_id/exchange
```

`init`は拡張機能から、PKCE challengeと端末公開鍵を受け取る。`approve`はWebの再認証済みsessionから実行する。`exchange`は短寿命codeとverifierを交換し、端末専用tokenを返す。

長寿命tokenをURLへ載せない。link codeは一回限り、5分以下とする。

## 5. Push API

### 5.1 作成

```text
POST /v1/pushes
Idempotency-Key: <128文字以下の高エントロピー値>
```

Request:

```json
{
  "client_guid": "01J...",
  "source_device_id": "dev_...",
  "target": {
    "kind": "all_other_devices"
  },
  "type": "note",
  "payload_version": 1,
  "ciphertext": "base64url...",
  "nonce": "base64url...",
  "expires_at": 1780000000000
}
```

特定端末の場合:

```json
{
  "target": {
    "kind": "device",
    "device_id": "dev_..."
  }
}
```

検証:

- `source_device_id`は現在の認証端末と一致する
- target deviceは同一userかつ有効
- `client_guid`とIdempotency Keyの関係を固定
- type、version、ciphertext size、nonce length
- expiry範囲
- quota
- degraded mode

Response `201`または冪等再実行時`200`:

```json
{
  "push": {
    "id": "push_...",
    "client_guid": "01J...",
    "source_device_id": "dev_...",
    "target_device_id": null,
    "type": "note",
    "payload_version": 1,
    "ciphertext": "base64url...",
    "nonce": "base64url...",
    "created_at": 1780000000000,
    "modified_at": 1780000000000,
    "expires_at": 1782592000000,
    "dismissed_at": null,
    "deleted_at": null,
    "pinned_at": null
  },
  "cursor": "opaque..."
}
```

D1 commit後、対象userの`UserHub`へ`sync_required`を通知する。DO通知失敗でPush作成をrollbackしない。

### 5.2 差分取得

```text
GET /v1/pushes?after=<opaque_cursor>&limit=100
```

Response:

```json
{
  "items": [],
  "next_cursor": "opaque...",
  "has_more": false,
  "server_time": 1780000000123
}
```

規則:

- default limit 100、max 200
- `after`なしは保持期間内の最新または初期同期ポリシーに従う
- tombstoneを返す
- targetが特定端末の場合、対象外端末へ本文を返さない
- 送信元端末には履歴を返すが通知対象から除外可能
- `modified_at,id`の安定順序

### 5.3 単体取得

```text
GET /v1/pushes/:push_id
```

同一userでも、特定端末宛Pushのpayload閲覧権限は製品方針をADRで固定する。推奨は、同一アカウント内E2EEでは全承認端末がアカウント鍵を持つため履歴閲覧可能とする一方、通知だけをtarget deviceへ限定すること。ただし「特定端末だけが復号できる」モードを将来追加する場合は鍵wrap設計が変わる。

### 5.4 状態更新

```text
PATCH /v1/pushes/:push_id
Idempotency-Key: ...
```

Request:

```json
{
  "dismissed": true,
  "pinned": false,
  "expected_modified_at": 1780000000000
}
```

競合時は`409 state_conflict`。最後の書き込み勝ちにする場合もADRで明示する。

### 5.5 削除

```text
DELETE /v1/pushes/:push_id
Idempotency-Key: ...
```

物理削除ではなく`deleted_at`を設定し、tombstoneを7日保持する。File参照がある場合、共有期限または他参照の有無に応じて削除予約する。

## 6. File API

### 6.1 初期化

```text
POST /v1/files/init
Idempotency-Key: ...
```

Request:

```json
{
  "encrypted_size": 1048576,
  "ciphertext_sha256": "base64url...",
  "retention": "1d",
  "content_type": "application/octet-stream"
}
```

Response:

```json
{
  "file": {
    "id": "file_...",
    "state": "pending",
    "expires_at": 1780086400000,
    "max_bytes": 26214400
  },
  "upload": {
    "method": "PUT",
    "url": "https://signed-r2-url...",
    "expires_at": 1780000120000,
    "required_headers": {
      "content-type": "application/octet-stream"
    }
  }
}
```

サーバー生成R2 keyの形式:

```text
ttl/1d/<user-hash>/<random-object-id>
```

### 6.2 完了

```text
POST /v1/files/:file_id/complete
Idempotency-Key: ...
```

WorkerはR2 metadataを読み、少なくともsizeをD1と照合する。可能ならETagやcustom metadataも確認する。client申告hashは受信側のend-to-end検証に使う。

### 6.3 Download ticket

```text
POST /v1/files/:file_id/download-ticket
```

Response:

```json
{
  "download": {
    "url": "https://signed-r2-url...",
    "expires_at": 1780000060000
  },
  "file": {
    "encrypted_size": 1048576,
    "ciphertext_sha256": "base64url..."
  }
}
```

`expires_at`を過ぎた場合はR2 objectの存在にかかわらず`410 resource_expired`。

### 6.4 中止

```text
DELETE /v1/files/:file_id
```

`pending`の中止、または所有者による削除予約。R2 Deleteは非同期再試行可能にする。

## 7. Web Push subscription API

```text
POST   /v1/web-push-subscriptions
DELETE /v1/web-push-subscriptions/:subscription_id
```

Requestはブラウザのsubscription情報を受け取るが、D1保存前にサーバー側暗号化する。endpoint全文をログに出さない。deviceあたりの件数上限を設ける。

Web Push payload例:

```json
{
  "type": "sync_required",
  "cursor_hint": "opaque...",
  "reason": "push_created"
}
```

ファイルPushかつWeb Pushが有効な端末では、通知クリックを待たずIndexedDBへ取得するため、暗号化されたWeb Push payloadへ短寿命・一回限りの背景download URLを追加する。

```json
{
  "type": "sync_required",
  "reason": "file_created",
  "storage_namespace": "device-local-namespace",
  "file_download": {
    "push_id": "psh_...",
    "file_id": "fil_...",
    "size": 12345,
    "mime_type": "application/octet-stream",
    "download_url": "https://same-origin.example/one-time/..."
  }
}
```

このURLは当該端末だけに発行し、短寿命・一回限り・ログ非記録とする。Service Workerの実行はブラウザーに中断され得るため、通常のカーソル同期も同じ取得を再試行する。ファイル名と本文はWeb Push payloadへ入れない。

平文の本文、URL、ファイル名を既定で入れない。

## 8. WebSocket

### 8.1 Ticket発行

```text
POST /v1/realtime-ticket
```

Response:

```json
{
  "ticket": "opaque-one-time-token",
  "expires_at": "2026-05-27T12:27:10.000Z",
  "url": "/realtime"
}
```

ブラウザーは`new WebSocket(url, ["pushbridge.v1", "pushbridge-ticket." + ticket])`で接続する。ticketをURL queryへ載せない。サーバーは`pushbridge.v1`を選択して応答する。

Ticket claims:

- user ID
- device ID
- issued at / expiry
- nonce/jti
- protocol version
- optional session generation

一回限り消費を保証する。stateful table、DO storage、短寿命nonce storeのいずれかを採用する。

### 8.2 Server events

```json
{
  "event_version": 1,
  "event_id": "...",
  "type": "connected"
}
```

```json
{
  "event_version": 1,
  "event_id": "...",
  "type": "sync_required",
  "cursor_hint": "opaque...",
  "reason": "push_created"
}
```

```json
{
  "type": "device_revoked",
  "device_id": "dev_..."
}
```

```json
{
  "type": "service_degraded",
  "level": "files_disabled"
}
```

### 8.3 Client events

```json
{ "type": "ping" }
```

書き込みはWebSocketで受け付けずRESTに限定する。将来最適化する場合も認可・冪等性をRESTと共通化する。

## 9. Quota/status API

```text
GET /v1/service-status
GET /v1/quota
```

Response例:

```json
{
  "degradation": {
    "level": "normal",
    "files_enabled": true,
    "max_file_bytes": 26214400,
    "allowed_retentions": ["1d", "3d"]
  },
  "quota": {
    "pushes_used_today": 12,
    "pushes_limit_today": 200,
    "upload_bytes_used_today": 1048576,
    "upload_bytes_limit_today": 104857600
  }
}
```

## 10. Cursor token

推奨payload:

```json
{
  "v": 1,
  "modified_at": 1780000000000,
  "id": "push_...",
  "user_scope": "derived-or-bound"
}
```

HMACで署名するか、session/userへbindした暗号化tokenにする。userを跨いだ再利用を拒否する。無効なcursorは`400 invalid_cursor`。

## 11. Payload envelope

暗号化前の論理payload例:

```json
{
  "v": 1,
  "type": "note",
  "title": "...",
  "body": "...",
  "file": null,
  "created_by_device": "dev_..."
}
```

File:

```json
{
  "v": 1,
  "type": "file",
  "title": "...",
  "body": "...",
  "file": {
    "id": "file_...",
    "name": "report.pdf",
    "mime": "application/pdf",
    "size": 12345,
    "key": "base64url K_file or wrapped key",
    "sha256": "base64url plaintext or ciphertext digest according to ADR"
  }
}
```

サーバーへ送るのはenvelope全体を暗号化した`ciphertext`と`nonce`。暗号方式・AADは`docs/03_SECURITY_AND_KEY_MANAGEMENT.md`に従う。

## 12. CORSとCSRF

- API CORSは正確な許可Originのみ。
- Cookie認証のstate-changing requestはOrigin/Referer検証とCSRF tokenを要求する。
- bearer tokenの拡張機能ではCORS allowlistとtoken scopeを併用する。
- R2 CORSはGET/HEAD/PUTだけ。DELETEは直接許可しない。
- preflight cacheを適度に使うが、Origin wildcardとcredentialsを組み合わせない。

## 13. Versioning

- URL major version: `/v1`
- encrypted payload: `payload_version`
- WebSocket: `protocol`
- key wrapping: `key_version`と`algorithm`
- breaking changeは新versionを併存させ、既存暗号文を読み出せる期間を設ける。
