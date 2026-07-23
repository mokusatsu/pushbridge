# Pushbridge PoC validation record

初回実施日: 2026-07-21<br>
再検証日: 2026-07-23

## 合格

| 対象 | 結果 |
| --- | --- |
| RelayMock pytest | 25件合格 |
| OpenAPI正本／RelayMock／PWAコピー | 一致 |
| PWA OpenAPI契約検査／TypeScript／production build | 合格 |
| PWA Vitest | 40件合格（サーバー削除後のIndexedDB Blob維持、E2EE固定vector、AAD改変、wrong key、nonce再利用防止、Realtime backoff/jitterを含む） |
| Playwright実ブラウザー | Chromium desktop 2件／mobile 1件合格。二端末Note／Link／File、IndexedDB、server削除後offline reload、missed、Service Worker実更新、通知拒否、keyboard／ARIA／reduced-motionを検証 |
| Phase 5時系列証跡 | 実Chromiumのスクリーンショット5枚、匿名化API method/path/status 71件、IndexedDB状態5時点を自己完結HTMLへ記録。認証情報・body・Web Push endpoint・file bytesなし |
| RelayMock実HTTP smoke | Note／Link／File／subscriptionを含め合格 |
| Terraform fmt／validate | Terraform 1.14.3、Cloudflare Provider 5.22.0で合格 |
| D1 migration 0001〜0011 | Wrangler／Miniflareとremote適用に合格、schema version 11。適用後migration残件なしをremote読取確認 |
| Worker Bootstrap／Bearer認証／端末／Note | localとService Auth経由remote smokeで合格 |
| Worker cursor同期／冪等性 | localとService Auth経由remote smokeで合格 |
| Worker Static Assets／SPA／Service Worker | localとService Auth経由remote smokeで合格 |
| Terraform remote backend診断 | stateと必須outputを取得成功 |
| Cloudflare Access | IPv4／IPv6 allowlistをAPIと許可外302で確認 |
| Worker File API／private R2 | 公式Workers Vitest pool 13件、local smoke、Service Auth経由remote smokeでupload/download、hash、410、File Pushを確認 |
| 実R2 fixture | 暗号化bytesのPUT／GET hash一致、終了後prefix listing 0件 |
| Phase 3 local | migration 0005、Web Push暗号／VAPID署名、subscription暗号化、404/410失効、端末別配送台帳、Service Worker ACKをWorker 18件とlocal smokeで確認 |
| Phase 4 local | migration 0006〜0007、TTL／pressure cleanup、alias/tombstone、KiB-second履歴、R2/D1 fault injectionを含むWorker 18件とlocal smokeに合格 |
| Phase 6〜7 | Passkey/session/device-link/E2EEをWorker 26件、PWA 38件、local Chromiumで確認。remote Service Auth smokeで暗号化Note/File、P-256 envelope、private R2、端末B復号まで合格 |
| Phase 7 Terraform | 0 add / 1 change / 0 destroy / 0 replaceでWorkerだけをin-place更新。適用後Planは差分なし |
| Phase 8 local | migration 0011、30秒one-time ticket、URL非露出subprotocol、DO Hibernation tickle、signed cursor、revocation、接続/size/backpressure制限をWorker 33件とlocal Wrangler/Chromiumで確認 |
| Phase 8 dev | migration 0011とWorkerを0 add / 1 change / 0 destroyで適用。E2EE/realtime/Web Push capabilityはtrue、Service Auth remote smokeで暗号化Note/FileとDO tickle、公開ChromiumでService Worker／IndexedDB／server削除後Blob／offline reloadに合格。適用後Planは差分なし |

2026-07-22の現実行環境はallowlist外であり、通常アクセスは302で保護される。Accessを無効化せず、対象Service TokenだけをTerraform管理の`non_identity`ポリシーで許可し、公開WorkerのPhase 2縦切りを完了した。テストFile/R2/Push/端末Bはsmoke終了時に回収し、残ったfixtureユーザーも直近候補1件に限定してD1からcascade回収、残存0件を確認した。

## 未実装または未確認

| 対象 | 状態 |
| --- | --- |
| R2 presigned direct upload | 未実装。現在はprivate R2 bindingのserver-ticket PoCで、Capabilitiesは`direct_upload=false` |
| Worker Web Push配送／受領確認 | source／local test、dev migration、VAPID／data key binding、remote subscription CRUDは合格。実push service配送とPWA終了中cached ACKは未確認 |
| Worker WebSocket realtime | dev適用とremote smoke／公開Chromiumに合格。WebSocketはtickle専用で、REST cursor同期は引き続き正本 |
| 実ブラウザーFile E2E | local Playwrightで画面・IndexedDB・offline・missed・Service Worker更新と時系列HTMLを自動化済み。dev実Web Pushを受けたPWA終了中の自動保存は未確認 |
| Passkey／Turnstile／レート制限 | 実装とlocal統合testは合格。Custom Domain／RP ID未決定のためremote Passkeyは意図的に無効 |
| remote実ブラウザーService Worker | 2026-07-23に暗号化Note/File、IndexedDB、server削除後Blob保持、Service Worker activation、offline reloadまで合格 |

## 判定

Cloudflare dev環境はD1 schema version 11、Phase 8 E2EE/realtime Worker/PWA、Web Push／retention bindingsを適用済みでpost-apply Planは差分なし。Service Auth remote smokeと公開Chromiumで暗号化Note/File、private R2、端末B復号、DO tickle、Service Worker／IndexedDB／offlineまで成立した。残る実環境項目は実push service配送、実Cron、Custom Domain上のPasskeyである。
