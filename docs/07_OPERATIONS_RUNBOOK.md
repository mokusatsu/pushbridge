# 運用ランブック

状態: ブートストラップ段階。実アカウントでの手順実行後に環境固有値を追記する。

## 1. 環境

推奨:

- `dev`: 開発者共有。workers.dev可。test dataのみ。
- `staging`: production相当のCustom Domain、secrets、quota。
- `prod`: 本番。workers.dev無効、保護されたTerraform State、承認付きApply。

Cloudflare accountを環境ごとに分離できる場合は分離する。少なくともresource名、D1、R2、Worker、secrets、Stateを分離する。

## 2. 必要なアクセス

- Cloudflare Account ID
- Custom Domain用Zone ID
- 最小権限Cloudflare API Token
- Terraform remote backend credentials
- R2 presigned URL用の専用Access Key ID/Secret
- VAPID key
- session/ticket/link signing secrets
- GitHub Actions environment approval権限

Global API Keyは使用しない。

## 3. 初回Apply

```bash
cd cloudflare-iac
cp infra/terraform.tfvars.example infra/terraform.tfvars
```

最低限編集:

```hcl
account_id   = "<32 hex>"
project_name = "relaypush"
environment  = "dev"
```

Custom Domain例:

```hcl
custom_domain = {
  hostname = "push.example.com"
  zone_id  = "<zone id>"
}

enable_workers_dev = false

additional_app_hostnames = [
  "push.example.com"
]

cors_allowed_origins = [
  "https://push.example.com",
  "http://localhost:5173"
]
```

実行:

```bash
export CLOUDFLARE_API_TOKEN='...'
make preflight
make validate
make plan
```

Plan確認項目:

- 対象account/zone
- 予期しないdestroy/replaceなし
- resource names
- Worker bindings
- R2 jurisdiction/location
- D1 location/jurisdiction
- workers.dev/public exposure
- Turnstile domains
- Queueが意図せず有効でない

承認後:

```bash
make apply
make db-migrations-list
make db-migrate
```

Smoke:

```bash
curl -fsS https://<host>/healthz
curl -fsS https://<host>/api/bootstrap/status
```

期待:

- health/statusは200
- `/api/nonexistent`は404、ticketなしの`/realtime`は401またはWebSocket upgrade不足426
- D1/R2/DO/Turnstile bindingがstatusでtrue

## 4. 本番API切替

本番Workerへ差し替える前のgate:

- Passkey/session/CSRF
- device authorization/revoke
- rate limit
- cursor/idempotency
- authenticated WS ticket
- R2 key/TTL/size validation
- log redaction
- integration/security test

切替手順:

1. stagingへdeploy
2. migration apply
3. smoke/E2E
4. trafficを止めずに後方互換bundleをprod deploy
5. canary accountで確認
6. metrics監視
7. 問題時は前bundleへrollback。ただしmigration backward compatibilityを確認

Workerとmigrationを同時に破壊的変更しない。expand-migrate-contractを使う。

## 5. D1 migration

追加file:

```text
worker/migrations/0002_passkeys.sql
worker/migrations/0003_device_links.sql
```

確認:

```bash
make db-migrations-list
make db-migrate
```

規則:

- applied migrationを編集しない
- destructive migrationはbackupとrollback計画必須
- column rename/dropは段階移行
- index追加によるwrite増を計測
- migration後にforeign key checkと主要queryをsmoke test

## 6. Secret投入・rotation

### 6.1 原則

- Git/tfvarsへcommitしない
- CI logへechoしない
- Terraform管理ならStateに残ることを理解
- current/previous versionを用意して段階rotation

### 6.2 Session signing key

1. new keyを`current`へ
2. oldを`previous`としてverify可能に
3. newでsign開始
4. session lifetime経過または強制rotate
5. old除去

### 6.3 R2 credentials

1. 二つ目の最小権限credential作成
2. Workerへ追加
3. new credentialで署名開始
4. upload/download smoke
5. old credential revoke
6. incident logへsecret値を記録しない

### 6.4 VAPID

rotationが既存subscriptionへ与える影響を事前確認する。必要ならclientへ再subscriptionを促すversion migrationを用意する。

## 7. 日次確認

- Worker 5xx、429、503
- CPU p95/p99
- D1 rows read/write
- R2 bytes/object count
- file `pending` age
- Web Push 404/410/transient errors
- DO reconnect spike
- Queue retry/DLQ（有効時）
- account/device registration anomaly
- degradation level

## 8. 定期cleanup

Cronで処理する候補:

- expired/revoked sessions
- revoked Web Push subscriptions
- stale auth challenges/link codes/WS tickets
- expired unpinned Push
- old tombstones
- stale pending files
- expired file metadata
- orphan R2 objects
- old quota buckets
- account deletion jobs

大量deleteを一回のCronで処理しない。batchとcursorを使い、次回へ継続する。Worker CPU/time limitを超えない。

実Cronの発火証跡は、Terraform outputで対象account／Workerを特定し、Cloudflare
GraphQLのScheduled専用datasetから直近7日を照合する。API Tokenやログ本文は出力しない。

```bash
npm run cloudflare:remote:cron-evidence
```

Worker、D1、R2の直近24時間の基準値は、Terraform outputで対象を限定して取得する。
リクエスト本文、URL、利用者ID、object keyは出力しない。

```bash
npm run cloudflare:remote:metrics-evidence
```

Account deletionは`DELETE /v1/account`受理時に利用者、端末、session、token、subscriptionを即時失効させる。`account_deletion_jobs`の`pending`／`failed`はCronが再試行し、R2 objectを100件単位のcursorで削除した後だけD1 metadataを物理削除する。20回失敗すると`manual_intervention`へ移して自動loopを止める。完了jobにはID、時刻、件数だけを残し、コンテンツや資格情報は残さない。

## 9. 無料枠逼迫

### 70%

- warning発報
- usage計測の正確性確認
- 非必須fan-out停止

### 85%

- file 5MB
- retention 1dのみ
- 新規招待抑制

### 95%

- file init停止
- Note/Link継続
- status banner

### 上限直前

- 新規Push停止
- read、logout、device revoke、account deleteを優先
- Paid移行またはquota引下げ

## 10. 障害対応

### 10.1 Worker 5xx増加

1. deployment/compatibility date変更を確認
2. route別、request ID別に分類
3. D1/R2/DO依存を確認
4. 直前bundleへrollback可能か判断
5. migration非互換ならfeature flagで問題経路を停止
6. status表示

### 10.2 D1障害

- writeを無理にQueueへ逃がして二重正本にしない
- new writeを一時停止
- client outboxに同じIdempotency Keyで保持
- read cacheはstale表示
- 復旧後cursor sync

### 10.3 R2障害

- file init/complete/downloadを停止
- Note/Linkは継続
- pending uploadを後でcleanup
- signed URLを長寿命化して回避しない

### 10.4 DO/WebSocket障害

- REST APIを継続
- clientをpolling stormにしない
- controlled intervalでcursor sync
- 復旧後reconnect+jitter

### 10.5 Web Push障害

devの実Push Service配送は、Windows上のインストール済みMicrosoft Edgeと短命profileで
再現できる。Cloudflare Access Service Token、VAPID設定済みdev Workerが必要で、
endpoint、subscription鍵、Bearer token、File内容は出力しない。

```bash
npm run cloudflare:remote:web-push-e2e
```

このE2EはPWAウィンドウを閉じてから暗号化Fileを送り、Service Workerによる復号、
IndexedDB transaction完了後の`cached` ACK、サーバー削除後のoffline Blob保持を検証する。
最後にsubscription、テストaccount、一時browser profileを回収する。

- PWA open時同期は継続
- transient errorを有限回retry
- 404/410はsubscription revoke
- plaintextを増やしてdiagnoseしない

## 11. セキュリティインシデント

### Token/secret漏えい

1. 漏えい範囲を特定
2. 該当credentialをrotate/revoke
3. session/token generationを更新
4. signed URLは短寿命で失効待ち、必要ならR2 key/delete
5. log/artifactからsecret削除
6. access logsで悪用有無を確認
7. 利用者通知要否を法務/ポリシーに従い判断

### Cross-user access疑い

1. 該当routeをfeature flagで停止
2. request IDと匿名IDから範囲特定
3. D1/R2 accessを保全
4. 修正とnegative test
5. affected user判定
6. 通知と事後報告

ログへ本文がない前提でも、metadataが個人情報になり得ることに注意。

## 12. Backup/restore

### Backup

- D1 exportを暗号化storageへ
- Terraform State versioning
- source repository/tag
- R2は短期file中心のため、完全backupの要否を製品方針で決める
- E2EEなのでbackupも暗号文

### Restore drill

1. isolated environment
2. Terraformでinfra再作成
3. D1 import
4. Worker deploy
5. key/secret version整合
6. test accountでdecrypt/sync
7. RTO/RPOと問題を記録

ローカルでは、全migrationを適用した合成D1をexportし、別の隔離D1へrestoreして
schema、件数、暗号文の一致を検証できる。

```bash
npm run cloudflare:local:recovery-drill
```

このコマンドは`.runtime/`配下の一時領域と合成データだけを使用し、終了時に削除する。
本番D1のexportは自動実行しない。exportには暗号文とmetadataが含まれるため、実施時は
暗号化した保管先、保持期間、復旧先となる隔離D1を決め、外部状態変更として承認を得る。

## 13. Account削除

1. accountを即時lock
2. session/token/subscription revoke
3. socket disconnect
4. R2 delete job
5. D1 cascade/段階削除
6. retry state保存
7. 完了確認
8. contentを含まないaudit record

## 14. Destroy

本番で通常実行しない。

前提:

- new write停止
- D1 export
- 必要R2 object退避
- Custom Domain停止
- session/token失効
- destroy Planの個別承認

Cloudflare Provider v5.22.0の既存検証記録ではR2 CORS/LifecycleがTerraformからdestroyできない警告がある。手動削除とState整合を確認する。

## 15. リリース記録テンプレート

```text
Release:
Date/time UTC:
Commit/tag:
Terraform plan ID:
Migrations:
Compatibility date:
Secrets rotated:
Feature flags:
Smoke tests:
Metrics after deploy:
Rollback decision:
Operator:
```
