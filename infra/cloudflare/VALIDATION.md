# Cloudflare validation record

検証日: 2026-07-23

## dev実環境

| 対象 | 実測結果 |
|---|---|
| Remote backend | R2 S3 backend、`pushbridge-terraform-state` / `pushbridge/dev/terraform.tfstate` / workspace `default` |
| Terraform state診断 | resource 9件、必須output欠落なし |
| Terraform Plan | Phase 7適用は0 add / 1 change / 0 destroy / 0 replace（`cloudflare_workers_script.app`だけ）。適用後`require_e2ee=true`で`No changes`、detailed exit code 0 |
| Worker | `pushbridge-dev`、実APIとPWA Static Assetsを配信 |
| D1 | devはmigration `0001_initial.sql`〜`0010_e2ee.sql`適用済み、schema version 10。適用後migration残件なしをremote読取確認 |
| Access | workers.devホスト全体を未追跡tfvarsのIPv4／IPv6 allowlistで保護し、自動smoke用Service Token 1件を`non_identity`で許可 |
| Remote smoke | Service Auth経由で合格。health/D1、2端末Bearer、P-256 envelope、暗号化Note/File、private R2 byte一致、one-use ticket、端末B復号、cursor、冪等性、Web Push subscription CRUDを確認 |
| Remote R2 fixture | 暗号化fixtureのPUT／GET byte hash一致を確認し、prefix listでfixture残存0件を確認 |

Phase 8 pre-apply planはWorker更新のほか、実環境Accessにのみ存在する追加IPv6 `/128`の削除を検出したため適用を停止した。ユーザーが動的IPv6変更に伴いDashboardへ手動追加した値だと確認したため、未追跡`terraform.tfvars`へ同じ`/128`を反映した。refresh付き最終Planは`cloudflare_workers_script.app`だけが0 add / 1 change / 0 destroyで、Access resource差分なし。outputのallowlistにはIPv4 1件・IPv6 2件が記録される。migration 0011はremoteで未適用と確認し、外部変更は承認待ち。

検証中にTerraform stateのAccess IDがCloudflare API上に存在しないdriftを検出した。PlanがAccess 1 add / 0 change / 0 destroyだけであることを確認して再作成し、Cloudflare API一覧と許可外経路の302で保護を再確認した。Phase 2最終適用はAccess Service Authと最新Worker/PWAの0 add / 2 change / 0 destroyで、適用後のPlanは差分なしだった。実環境allowlistには単一IPv4 `/32`と単一IPv6 `/128`を未追跡tfvarsで設定し、Accessを弱めた検証は行っていない。Dashboardで誤ってAction `Allow`として作成されたService Tokenポリシーは302を返したため、Terraformで`non_identity`へ正規化した。

R2 fixtureは暗号化済みbytesだけを使用した。WranglerとCloudflare REST Object APIの双方でPUT／GET hash一致を確認し、終了処理後のprefix listingは0件だった。一方、delete直後の単一object GETがHTTP 200を返す挙動も観測したため、削除確認はlistingとPhase 2 Worker binding経路のテストを併用する。製品データは使用していない。

## ローカル

| 検証 | 結果 |
|---|---|
| RelayMock pytest | 25件合格 |
| OpenAPI正本／RelayMock／PWAコピー | 一致 |
| PWA契約検査、TypeScript、Vitest、production build | 合格（Vitest 40件。E2EE固定vector、AAD改変、wrong key、nonce再利用防止、Realtime backoff/jitterを含む） |
| Playwright実ブラウザー | Chromiumでdesktop 2件／mobile 1件合格。二端末Note／Link／File、IndexedDB、server削除後offline reload、missed、Service Worker実更新、通知拒否、keyboard／ARIA／reduced-motionを検証 |
| Phase 5時系列証跡 | 実スクリーンショット5枚、匿名化API 71件、IndexedDB状態5時点を`apps/web-pwa/evidence/phase5-browser-evidence.html`へ記録。secret／body／endpoint／file bytesなし |
| Worker TypeScript、bundle、公式Workers Vitest pool | 合格（33件。Web Push、retention fault injection、Passkey/session、device link、E2EE、one-time WebSocket ticket/DOを含む） |
| RelayMock実HTTP smoke | Note、Link、File、subscriptionを含め合格 |
| Terraform fmt / validate | Cloudflare Provider v5.22.0で合格 |
| Cloudflare local smoke | D1 migration 0001〜0011、private R2、2端末、Bearer、暗号化Note/File、P-256 envelope、端末B復号、one-time WebSocket ticket／DO tickle、PWA／SPA／Service Worker ACK codeに合格。Passkey PlaywrightもRealtime接続込みで合格 |

Worker統合testではPhase 1の失効session、署名cursor改変、`include_deleted`、cross-user IDOR、UTF-8 byte上限、同一timestamp 205件pagination、同一Idempotency-Key 100回再送、bootstrap rate limit、production／Turnstile feature flagに加え、Fileの0 byte／通常／25 MiB、上限超過、任意R2 key拒否、size/hash不一致、別利用者IDOR、期限切れ410、complete冪等性、中断reservation回収、別端末cursor同期を検証した。PWAはIndexedDB Blobがサーバー削除後も残ることと、未保存の`delete_pending/deleted` aliasが`missed`になることを検証する。production logはrequest IDとerror種別だけを記録し、tokenやpayloadを出力しない。

## 未実装・未確認

- 専用最小権限R2 credentialによるpresigned direct upload。現在は`direct_upload=false`のserver-ticket PoC
- Web Push source、dev migration 0005、VAPID／data key bindingは適用済み。subscription CRUDはremote合格。実push service配送とPWA終了中のpush-event IndexedDB commit/cached ACKは未確認
- Retention source、dev migration 0006〜0007、local fault injectionは完了。実Cron重複とR2実削除失敗時の運用観測は未確認
- Durable Object realtimeはlocal Worker/Chromiumで合格。migration 0011とWorkerのdev適用、allowlist済み実行元からのremote WebSocket実測は承認待ち
- Passkey／正式Sessionはlocal Chromiumで合格。Custom Domain／RP ID未決定のためremote capabilityは意図的にfalse
- E2EEはlocalとremoteで合格。remote実Chromiumは暗号化Note/File、IndexedDB保存、server削除後Blob保持まで進み、Service Worker scriptだけAccess 403。service token headerはService Workerへ継承されないため、allowlist済みIPからの最終実測が必要
- Turnstile検証経路は実装・統合test済みだが、Access保護下のdevでは自動smokeを維持するため必須化していない
- 現在のCloudflare test toolchainには解消可能な更新がないdev-only npm audit advisoryが残る
- Custom Domainとproduction環境

現在のdev CapabilitiesはE2EEとWeb Push deliveryを`true`、Passkey cookie sessionとrealtimeを`false`、uploadを`server-ticket`／`direct_upload=false`としている。Phase 8適用後、remote WebSocket E2E成功を確認してからrealtimeを`true`として記録する。
