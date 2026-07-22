# Pushbridge PoC validation record

初回実施日: 2026-07-21<br>
再検証日: 2026-07-22

## 合格

| 対象 | 結果 |
| --- | --- |
| RelayMock pytest | 24件合格 |
| OpenAPI正本／RelayMock／PWAコピー | 一致 |
| PWA OpenAPI契約検査／TypeScript／production build | 合格 |
| PWA Vitest | 25件合格（サーバー削除後のIndexedDB Blob維持を含む） |
| RelayMock実HTTP smoke | Note／Link／File／subscriptionを含め合格 |
| Terraform fmt／validate | Terraform 1.14.3、Cloudflare Provider 5.22.0で合格 |
| D1 migration 0001〜0004 | Wrangler／Miniflareで合格、remote適用済み、schema version 4 |
| Worker Bootstrap／Bearer認証／端末／Note | localとService Auth経由remote smokeで合格 |
| Worker cursor同期／冪等性 | localとService Auth経由remote smokeで合格 |
| Worker Static Assets／SPA／Service Worker | localとService Auth経由remote smokeで合格 |
| Terraform remote backend診断 | stateと必須outputを取得成功 |
| Cloudflare Access | IPv4／IPv6 allowlistをAPIと許可外302で確認 |
| Worker File API／private R2 | 公式Workers Vitest pool 13件、local smoke、Service Auth経由remote smokeでupload/download、hash、410、File Pushを確認 |
| 実R2 fixture | 暗号化bytesのPUT／GET hash一致、終了後prefix listing 0件 |

2026-07-22の現実行環境はallowlist外であり、通常アクセスは302で保護される。Accessを無効化せず、対象Service TokenだけをTerraform管理の`non_identity`ポリシーで許可し、公開WorkerのPhase 2縦切りを完了した。テストFile/R2/Push/端末Bはsmoke終了時に回収し、残ったfixtureユーザーも直近候補1件に限定してD1からcascade回収、残存0件を確認した。

## 未実装または未確認

| 対象 | 状態 |
| --- | --- |
| R2 presigned direct upload | 未実装。現在はprivate R2 bindingのserver-ticket PoCで、Capabilitiesは`direct_upload=false` |
| Worker Web Push配送／受領確認 | 未実装。Capabilitiesは配送・登録ともfalse |
| Worker WebSocket realtime | 未実装。REST cursor同期が正本 |
| 実ブラウザーFile E2E | API remote smokeは完了。Playwrightによる画面・IndexedDB実測自動化は未完了 |
| Passkey／Turnstile検証／E2EE／レート制限 | 公開前の必須未実装項目 |

## 判定

Cloudflare dev環境ではNote／Link／FileとPWAのAPI縦切りが動作する。FileはWorker＋D1＋private R2＋PWAのlocal縦切り、実R2 fixture、公開Worker remote smokeまで成立した。Cloudflare移行PoC全体の完了判定にはWeb Push配送確認、保持期限処理、認証、E2EE、実ブラウザーE2Eが引き続き必要。
