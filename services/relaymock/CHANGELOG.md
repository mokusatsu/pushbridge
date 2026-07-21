# Changelog

## 0.1.1 — 2026-07-14

Web／PWAクライアントからの契約修正要求を反映。

### P0

- `POST /v1/pushes`の冪等再送200とHeaderをOpenAPIへ追加
- 共通`ApiError`、共通Error Response、Operation別Statusを追加
- uploadのbinary request body、downloadのbinary responseとHeaderを追加
- `PushCreate`と`PushTarget`を相互排他的な`oneOf`へ変更
- 全日時を`date-time`、ticket URLを`uri-reference`へ変更
- 管理HeaderをOpenAPIで必須化
- 管理Routerを既定で無効化

### P1

- `GET /v1/system/capabilities`
- Payload v1 Schema
- `PushOut.file_ref`とfile状態変更のカーソル同期
- `GET /v1/web-push-config`
- Web Push Subscriptionの冪等upsert
- Token応答の`no-store`
- 全応答とAPIエラーのRequest ID契約

### 検証

- pytest 20件
- Uvicorn実HTTP smoke test
- OpenAPI内の全ローカル`$ref`解決確認
