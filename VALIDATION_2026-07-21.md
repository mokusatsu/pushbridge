# Pushbridge PoC validation record

初回実施日: 2026-07-21<br>
再検証日: 2026-07-23

## 合格

| 対象 | 結果 |
| --- | --- |
| RelayMock pytest | 24件合格 |
| OpenAPI正本／RelayMock／PWAコピー | 一致 |
| PWA OpenAPI契約検査／TypeScript／production build | 合格 |
| PWA Vitest | 31件合格（サーバー削除後のIndexedDB Blob維持、upload進捗／cancel、端末別配送状態、30日TTL fallbackを含む） |
| Playwright実ブラウザー | Chromium desktop 2件／mobile 1件合格。二端末Note／Link／File、IndexedDB、server削除後offline reload、missed、Service Worker実更新、通知拒否、keyboard／ARIA／reduced-motionを検証 |
| Phase 5時系列証跡 | 実Chromiumのスクリーンショット5枚、匿名化API method/path/status 71件、IndexedDB状態5時点を自己完結HTMLへ記録。認証情報・body・Web Push endpoint・file bytesなし |
| RelayMock実HTTP smoke | Note／Link／File／subscriptionを含め合格 |
| Terraform fmt／validate | Terraform 1.14.3、Cloudflare Provider 5.22.0で合格 |
| D1 migration 0001〜0007 | Wrangler／Miniflareとremote適用に合格、schema version 7。remoteで配送台帳・使用量表／列を読取確認 |
| Worker Bootstrap／Bearer認証／端末／Note | localとService Auth経由remote smokeで合格 |
| Worker cursor同期／冪等性 | localとService Auth経由remote smokeで合格 |
| Worker Static Assets／SPA／Service Worker | localとService Auth経由remote smokeで合格 |
| Terraform remote backend診断 | stateと必須outputを取得成功 |
| Cloudflare Access | IPv4／IPv6 allowlistをAPIと許可外302で確認 |
| Worker File API／private R2 | 公式Workers Vitest pool 13件、local smoke、Service Auth経由remote smokeでupload/download、hash、410、File Pushを確認 |
| 実R2 fixture | 暗号化bytesのPUT／GET hash一致、終了後prefix listing 0件 |
| Phase 3 local | migration 0005、Web Push暗号／VAPID署名、subscription暗号化、404/410失効、端末別配送台帳、Service Worker ACKをWorker 18件とlocal smokeで確認 |
| Phase 4 local | migration 0006〜0007、TTL／pressure cleanup、alias/tombstone、KiB-second履歴、R2/D1 fault injectionを含むWorker 18件とlocal smokeに合格 |

2026-07-22の現実行環境はallowlist外であり、通常アクセスは302で保護される。Accessを無効化せず、対象Service TokenだけをTerraform管理の`non_identity`ポリシーで許可し、公開WorkerのPhase 2縦切りを完了した。テストFile/R2/Push/端末Bはsmoke終了時に回収し、残ったfixtureユーザーも直近候補1件に限定してD1からcascade回収、残存0件を確認した。

## 未実装または未確認

| 対象 | 状態 |
| --- | --- |
| R2 presigned direct upload | 未実装。現在はprivate R2 bindingのserver-ticket PoCで、Capabilitiesは`direct_upload=false` |
| Worker Web Push配送／受領確認 | source／local test、dev migration、VAPID／data key bindingは適用済み。Access資格情報不足で適用後HTTP smokeとChromium実配送は未確認 |
| Worker WebSocket realtime | 未実装。REST cursor同期が正本 |
| 実ブラウザーFile E2E | local Playwrightで画面・IndexedDB・offline・missed・Service Worker更新と時系列HTMLを自動化済み。dev実Web Pushを受けたPWA終了中の自動保存は未確認 |
| Passkey／Turnstile検証／E2EE／レート制限 | 公開前の必須未実装項目 |

## 判定

Cloudflare dev環境ではNote／Link／FileとPWAのPhase 2縦切りが動作し、Phase 3／4のD1 schema version 7、Worker、Web Push／retention bindingsも適用済みでpost-apply Planは差分なし。local PlaywrightでFile／IndexedDB／offline／missedまで成立した。適用後の公開HTTPと実Web Push／CronはAccess資格情報不足で未確認であり、公開前認証とE2EEも引き続き必要。
