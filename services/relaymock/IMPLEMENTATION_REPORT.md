# Web／PWA要求反映レポート

対象バージョン: RelayMock REST API 0.1.1

## P0

| 要求 | 実装 |
|---|---|
| 冪等再送200のOpenAPI | `POST /v1/pushes`へ200、`PushOut`、`Idempotent-Replayed: true`を追加 |
| 共通エラー | `ApiErrorDetail`、`ApiError`、`components.responses`を追加。Operationごとに実Statusを宣言 |
| Upload binary body | `application/octet-stream`、`format: binary`をrequest bodyへ追加 |
| Download binary response | binary contentと`Content-Disposition`、`Content-Length`、`ETag`を追加 |
| PushCreate条件制約 | plaintext／encrypted × note／link／fileの6種類を`oneOf`化。PushTargetも3種類を`oneOf`化 |
| 日時／URL format | 日時を`date-time`、ticket URLを`uri-reference`化 |
| 管理Header | OpenAPIで`X-Mock-Admin`必須。管理Routerは既定で無効 |

## P1

| 要求 | 実装 |
|---|---|
| Capabilities | `GET /v1/system/capabilities`を追加 |
| Payload v1 | `NotePayloadV1`、`LinkPayloadV1`、`FilePayloadV1`を追加 |
| File状態同期 | `PushOut.file_ref`を追加し、File状態変更時に参照Pushの`modified_at`を更新 |
| Web Push設定 | `GET /v1/web-push-config`を追加 |
| Subscription upsert | 初回201、同じ端末・endpointの再登録200 |
| Token no-store | Bootstrapとdevice linkへ`Cache-Control: no-store`、`Pragma: no-cache` |
| Request ID | 全応答へ`X-Request-ID`、APIエラー本文へ同じ`request_id` |

## 追加した主なテスト

- OpenAPIのStatus、共通Response、binary Schema、oneOf、format、管理Header
- CapabilitiesとWeb Push設定
- Subscriptionの201／200 upsert
- PushCreate不正組み合わせの422
- File期限切れがPushカーソルへ再投入されること
- Ticket期限切れ410
- binary download Header
- Token no-store
- Request ID本文・Header一致
- 管理Routerの既定無効

最終結果: pytest 20件成功、Uvicorn実HTTP smoke test成功、OpenAPI内ローカル`$ref`欠落0件。
