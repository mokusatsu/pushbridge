# Cloudflare validation record

検証日: 2026-07-23

## dev実環境

| 対象 | 実測結果 |
|---|---|
| Remote backend | R2 S3 backend、`pushbridge-terraform-state` / `pushbridge/dev/terraform.tfstate` / workspace `default` |
| Terraform state診断 | resource 9件、必須output欠落なし |
| Terraform Plan | Phase 2適用後は`No changes`。Phase 3〜5適用直前Planは0 add / 1 change / 0 destroy（Worker code／Static Assets／Web Push・storage bindingsのin-place更新だけ） |
| Worker | `pushbridge-dev`、実APIとPWA Static Assetsを配信 |
| D1 | devはmigration `0001_initial.sql`〜`0007_storage_usage_units.sql`適用済み、schema version 7。`file_deliveries`／`storage_usage_daily.kibibyte_seconds`をremote読取確認 |
| Access | workers.devホスト全体を未追跡tfvarsのIPv4／IPv6 allowlistで保護し、自動smoke用Service Token 1件を`non_identity`で許可 |
| Remote smoke | Phase 2はService Auth経由で合格。Phase 3〜5適用後はローカルにAccess Client ID／Secretがなく、healthzがAccessへ302のためfixture作成前に停止 |
| Remote R2 fixture | 暗号化fixtureのPUT／GET byte hash一致を確認し、prefix listでfixture残存0件を確認 |

検証中にTerraform stateのAccess IDがCloudflare API上に存在しないdriftを検出した。PlanがAccess 1 add / 0 change / 0 destroyだけであることを確認して再作成し、Cloudflare API一覧と許可外経路の302で保護を再確認した。Phase 2最終適用はAccess Service Authと最新Worker/PWAの0 add / 2 change / 0 destroyで、適用後のPlanは差分なしだった。実環境allowlistには単一IPv4 `/32`と単一IPv6 `/128`を未追跡tfvarsで設定し、Accessを弱めた検証は行っていない。Dashboardで誤ってAction `Allow`として作成されたService Tokenポリシーは302を返したため、Terraformで`non_identity`へ正規化した。

R2 fixtureは暗号化済みbytesだけを使用した。WranglerとCloudflare REST Object APIの双方でPUT／GET hash一致を確認し、終了処理後のprefix listingは0件だった。一方、delete直後の単一object GETがHTTP 200を返す挙動も観測したため、削除確認はlistingとPhase 2 Worker binding経路のテストを併用する。製品データは使用していない。

## ローカル

| 検証 | 結果 |
|---|---|
| RelayMock pytest | 24件合格 |
| OpenAPI正本／RelayMock／PWAコピー | 一致 |
| PWA契約検査、TypeScript、Vitest、production build | 合格（Vitest 30件。XHR upload進捗／cancel、配送状態表示を含む） |
| Playwright実ブラウザー | Edgeでdesktop 1件／mobile 1件合格。二端末Note／Link／File、IndexedDB、server削除後offline reload、missed、通知拒否、keyboard／ARIA／reduced-motionを検証 |
| Worker TypeScript、bundle、公式Workers Vitest pool | 合格（18件。Web Push暗号／失効／配送台帳、TTL／pressure cleanup、R2/D1 fault injectionを含む） |
| RelayMock実HTTP smoke | Note、Link、File、subscriptionを含め合格 |
| Terraform fmt / validate | Cloudflare Provider v5.22.0で合格 |
| Cloudflare local smoke | D1 migration 0001〜0007、private R2 File API、2端末、Bearer認証、File Push cursor同期、download hash、配送pending→missed、削除410、PWA、SPA、Service Worker ACK codeに合格 |

Worker統合testではPhase 1の失効session、署名cursor改変、`include_deleted`、cross-user IDOR、UTF-8 byte上限、同一timestamp 205件pagination、同一Idempotency-Key 100回再送、bootstrap rate limit、production／Turnstile feature flagに加え、Fileの0 byte／通常／25 MiB、上限超過、任意R2 key拒否、size/hash不一致、別利用者IDOR、期限切れ410、complete冪等性、中断reservation回収、別端末cursor同期を検証した。PWAはIndexedDB Blobがサーバー削除後も残ることと、未保存の`delete_pending/deleted` aliasが`missed`になることを検証する。production logはrequest IDとerror種別だけを記録し、tokenやpayloadを出力しない。

## 未実装・未確認

- 専用最小権限R2 credentialによるpresigned direct upload。現在は`direct_upload=false`のserver-ticket PoC
- Web Push source、dev migration 0005、VAPID／data key bindingは適用済み。PWAは送信側の端末別配送状態とupload進捗／cancel／retryを表示し、通常cursor同期のFile保存／offline再表示はPlaywrightで合格した。Access資格情報不足のため実Web PushとPWA終了中のpush-event IndexedDB commit/cached ACKは未確認
- Retention source、dev migration 0006〜0007、local fault injectionは完了。実Cron重複とR2実削除失敗時の運用観測は未確認
- Durable Object realtime通知
- Passkey、正式Session、E2EE
- Turnstile検証経路は実装・統合test済みだが、Access保護下のdevでは自動smokeを維持するため必須化していない
- 現在のCloudflare test toolchainには解消可能な更新がないdev-only npm audit advisoryが残る
- Custom Domainとproduction環境

Capabilitiesは実装・E2E未完了の機能を`false`のまま維持する。
