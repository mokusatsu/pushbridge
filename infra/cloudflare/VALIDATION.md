# Validation record

検証日: 2026-07-13

## 実施済み

| 検証 | 結果 |
|---|---|
| Terraform `fmt -recursive -check` | Pass |
| Terraform `init -backend=false` | Pass |
| Cloudflare Provider schema load | `cloudflare/cloudflare` v5.22.0でPass |
| Terraform `validate -json` | `valid: true`, error 0, warning 0 |
| 既定構成のoffline Plan | 8 add / 0 change / 0 destroy |
| Queue + Custom Domain構成のoffline Plan | 12 add / 0 change / 0 destroy |
| Worker module構文 | Node.js 22 `node --check`でPass |
| PWA JavaScript構文 | Node.js 22 `node --check`でPass |
| Bootstrap Workerのmock request | health 200、status 200、未実装API/WS 501を確認 |
| D1 SQL構文 | SQLite in-memory DBへ全migration適用成功 |
| Wrangler D1 migration | Wrangler 4.110.0のlocal D1へ21コマンド適用成功 |
| Wrangler migration discovery | `0001_initial.sql`を正しく検出 |
| D1 foreign-key整合性 | `PRAGMA foreign_key_check`で違反0 |

Terraformのoffline PlanはダミーのAccount ID/API Tokenと`-refresh=false`を使用しています。Cloudflare APIへの作成要求は送信していません。

## Plan対象

既定構成:

- D1 database
- R2 bucket
- R2 CORS
- R2 Lifecycle
- Turnstile widget
- Worker + Static Assets + Durable Object migration
- Cron Trigger
- workers.dev subdomain setting

オプション有効構成では、さらに次を検証しました。

- Delivery Queue
- Dead Letter Queue
- Queue consumer
- Worker Custom Domain

## 未実施

実在するCloudflareアカウントへの`terraform apply`は、利用者のAccount ID、API Token、Zoneを使用する必要があるため実施していません。したがって、実アカウント固有のPlan制約、契約プラン差、既存リソースとの名称衝突、Custom Domain証明書発行までは未確認です。

ProviderはR2 CORS/LifecycleについてTerraformからdestroyできない警告をPlan時に返します。削除手順はREADMEに明記しています。
