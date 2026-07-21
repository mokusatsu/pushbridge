# RelayMock 0.1.1 APIアダプター

サーバー固有のURLとwire modelは主に次のファイルへ閉じ込めています。

```text
src/api/client.ts
src/api/localApi.ts
src/api/schemas.ts
src/api/errors.ts
src/services/webPush.ts
```

React画面、IndexedDB、送信箱は`src/types.ts`の正規モデルを使用します。

## URL変換

```text
ブラウザー /api/v1/*       -> RelayMock /v1/*
ブラウザー /mock-storage/* -> RelayMock /mock-storage/*
ブラウザー /health         -> RelayMock /health
```

ローカルプロキシだけが`/api`を除去します。Cloudflare移行後はWorkerがブラウザー向け`/api/v1`を直接提供できます。

## 主なwire変換

```text
UI title/body/url                  -> PushCreate.payload
UI FileAttachment                 -> FilePayloadV1.file
PushOut payload + file_ref        -> PushRecord + FileAttachment
PushListOut                       -> ChangeEvent[]
next_cursor=null                  -> 現在Cursorを維持
FileInitOut flat upload fields    -> FileInitResponse.upload
DownloadTicketOut.download_url    -> DownloadTicket.download.url
DeviceOut.revoked_at              -> Device.active
ApiError.detail.request_id        -> ApiError.requestId
```

## 厳格なPushCreate

RelayMock 0.1.1の`PushCreate`は6種類の`oneOf`です。`buildRelayMockPushBody()`が種類ごとに送信形を分けます。

- noteは`payload`にtitleまたはbodyを含める
- linkは`payload.url`を必須にする
- fileはトップレベル`file_id`と`payload.file`を持つ
- note／linkへ`file_id`を送らない
- 平文送信へ`ciphertext`／`nonce`を送らない
- fileのサーバー管理状態`state`を`FilePayloadV1`へ送らない
- `source_device_id`はBearer Tokenからサーバーが決めるため送らない

将来E2EEを導入する場合は、同じアダプター内で`payload`を`ciphertext + nonce`へ置換します。

## Cursor同期

```ts
const result = await api.getChanges(cursor, 100);
const next = result.next_cursor ?? cursor;
await db.applyChanges(result.items, next);
```

`include_deleted=true`を常に付与します。`has_more=true`の間は同じ同期処理で次ページを取得し、カーソルが進まない応答は契約違反として停止します。

## `file_ref`

0.1.1では`PushOut.file_ref`を優先します。

```text
payload.file  -> ファイル名、MIME型、SHA-256などの表示情報
file_ref      -> ID、state、size、expires_atのサーバー状態
```

`file_ref`のstateとsizeはPayloadより優先します。状態変更は参照Pushの`modified_at`更新として再同期されるため、全ファイルを別途照会しません。

旧0.1.0互換として、`file_ref`がなく表示メタデータも不足する場合だけ`GET /files/{file_id}`へフォールバックします。

## Capabilities

最初に`GET /v1/system/capabilities`を取得します。次を画面とRuntimeへ反映します。

```text
features.web_push_delivery
features.web_push_subscription_registration
features.direct_upload
limits.max_file_bytes
limits.max_push_payload_bytes
limits.file_ttl_seconds
limits.default_push_ttl_seconds
limits.default_file_ttl_seconds
limits.max_devices
recommended_poll_interval_seconds
```

Endpointが404の場合だけ0.1.0互換値を利用します。未知の追加フィールドは将来互換のため無視します。

## Web Push

`GET /v1/web-push-config`を取得し、ブラウザーが作成したSubscriptionをAPIへ送ります。

```text
PushSubscription.endpoint -> endpoint
getKey('p256dh')           -> base64url p256dh
getKey('auth')             -> base64url auth
```

VAPID公開鍵は、非圧縮P-256の65-byte鍵であることをブラウザー呼び出し前に検証します。同一endpointの200 upsertと初回201は同じ成功経路で処理します。

## Error normalizationとRequest ID

次の両方を`ApiError`へ正規化します。

```json
{
  "detail": {
    "code": "file_not_ready",
    "message": "...",
    "request_id": "req_..."
  }
}
```

```json
{
  "detail": [
    {
      "loc": ["body", "handle"],
      "msg": "...",
      "type": "..."
    }
  ]
}
```

通常のREST要求はクライアント生成`X-Request-ID`を付与します。エラー時は応答Header、本文、クライアント値の順にRequest IDを確定し、画面へ表示します。

Ticket PUT／GETへ独自Headerを追加しないのは、将来のR2署名付きURLで署名対象やCORS条件を不用意に変えないためです。
