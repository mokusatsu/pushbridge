# Cloudflare validation record

検証日: 2026-07-22

## dev実環境

| 対象 | 実測結果 |
|---|---|
| Remote backend | R2 S3 backend、`pushbridge-terraform-state` / `pushbridge/dev/terraform.tfstate` / workspace `default` |
| Terraform state診断 | resource 9件、必須output欠落なし |
| Terraform Plan | Access drift復旧後に`No changes`、detailed exit code 0 |
| Worker | `pushbridge-dev`、実APIとPWA Static Assetsを配信 |
| D1 | migration `0001_initial.sql`、`0002_pushbridge_api.sql`適用済み |
| Access | workers.devホスト全体を未追跡tfvarsのIPv4／IPv6 allowlistで保護 |
| Remote smoke | 過去の許可元実行では合格。今回の保護復旧後実行はAccessで拒否されexit 1 |

検証中にTerraform stateのAccess IDがCloudflare API上に存在しないdriftを検出した。PlanがAccess 1 add / 0 change / 0 destroyだけであることを確認して再作成し、Cloudflare API一覧と許可外経路の302で保護を再確認した。20秒後もAPI上に存在し、再Planは差分なしだった。Accessを弱めた検証は行っていない。

## ローカル

| 検証 | 結果 |
|---|---|
| RelayMock pytest | 24件合格 |
| OpenAPI正本／RelayMock／PWAコピー | 一致 |
| PWA契約検査、TypeScript、Vitest、production build | 合格（Vitest 23件） |
| RelayMock実HTTP smoke | Note、Link、File、subscriptionを含め合格 |
| Terraform fmt / validate | Cloudflare Provider v5.22.0で合格 |
| Cloudflare local smoke | D1 migration、Worker API、2端末、Bearer認証、cursor、冪等性、PWA、SPA、Service Workerに合格 |

## 未実装・未確認

- Worker File APIと実R2本体操作
- Worker Web Push配送と端末別cached ACK
- Durable Object realtime通知
- Passkey、Turnstile検証、正式Session、E2EE、レート制限
- Custom Domainとproduction環境

Capabilitiesは実装・E2E未完了の機能を`false`のまま維持する。
