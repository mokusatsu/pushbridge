# Pushbridge Cloudflare IaC

Pushbullet相当サービスの低コスト基盤をCloudflareへ構築するTerraformスタックです。次を一括管理します。

- Workers Static AssetsによるWeb/PWA配信
- Module WorkerとDurable Object `UserHub`
- D1データベース
- 非公開R2バケット、CORS、短期Lifecycle
- Turnstileウィジェット
- 定期クリーンアップ用Cron Trigger
- workers.dev公開と、任意のCustom Domain
- 任意のCloudflare QueueおよびDead Letter Queue

同梱Workerはdev限定bootstrap、Bearer認証、端末管理、Note／Link／File、cursor同期、pin／dismiss／delete、storage usage、Web Push、Passkey session、device link、E2EE envelope、Durable Object WebSocket tickleを実装済みです。Fileは非公開R2 bindingを経由する一回限りの短寿命server-ticket adapterを使い、Capabilitiesは`direct_upload=false`と`transports.upload=["server-ticket"]`を返します。devはmigration 0001〜0010とPhase 7 Worker/PWAを適用済みで、E2EEを必須化しています。Phase 8 realtimeはlocal検証済みで、migration 0011とWorkerのdev適用待ちです。専用R2資格情報によるpresigned URLとCustom Domain上のPasskey有効化は未実装／未設定です。devホスト全体はCloudflare Accessの送信元IP allowlistで保護します。

Workerの正本は`worker/src/`のTypeScriptです。`npm run worker:build`がTerraformとWranglerの入力となる`worker/index.mjs`を生成します。外部source mapはローカル診断用に生成しますがGitやTerraform uploadには含めません。production logはrequest IDとエラー種別だけを記録し、title、body、URL、ファイル名、tokenを出力しません。

## ディレクトリ構成

```text
.
├── infra/                  Terraform
├── worker/
│   ├── index.mjs           安全なブートストラップWorker
│   └── migrations/         D1 SQL migrations（0004 File〜0011 Realtime）
├── app/
│   ├── dist/               Workers Static Assets
│   └── headers.conf        静的配信のセキュリティヘッダー
├── scripts/                Wrangler設定生成と事前確認
├── .github/workflows/      fmt / validate / JS構文確認
└── Makefile
```

## 固定バージョン

- Terraform: `>= 1.7, < 2.0`
- Cloudflare Provider: `~> 5.22.0`
- Wrangler: Makefileではメジャー版`4`
- Workers compatibility date: `2026-07-21`

Durable Object migrations are one-shot Worker upload inputs. For a fresh environment, copy the commented `durable_object_migration` example into the first apply only, then remove it after the migration tag advances. Keeping an already-applied migration in configuration makes Cloudflare reject later Worker uploads because provider v5 does not retain the migration payload in state.

Providerやcompatibility dateを更新するときは、Cloudflareの変更点を確認してから個別のPull Requestで進めてください。

## Cloudflare API Token

Global API Keyは使用せず、対象アカウントに限定したAPI Tokenを用意します。最低限の権限は次のとおりです。

| 権限 | 用途 |
|---|---|
| Workers Scripts Read / Write | Worker、Durable Object migration、Cron、workers.dev、Custom Domain |
| Workers Tail Read | Worker resourceで受理される権限。Tailを使わない運用では削減可否を環境で確認 |
| D1 Read / Write | D1作成と参照 |
| Workers R2 Storage Write | R2バケット作成 |
| Account Settings Read / Write | Turnstile設定 |
| Turnstile Sites Read / Write | Turnstile widget |
| Access: Apps and Policies Read / Write | Workerホスト全体の送信元IP制限 |
| Queues Read / Write | `enable_queue = true`の場合のみ |

トークンはシェルまたはCI Secretから渡します。

```bash
export CLOUDFLARE_API_TOKEN='...'
```

## 最初のデプロイ

リポジトリルートから、makeなしでも状態診断とローカル統合検証を実行できます。

```bash
npm run cloudflare:state:diagnose
npm run check
npm run cloudflare:local:smoke
npm run cloudflare:remote:smoke
npm run cloudflare:remote:e2e
```

state診断はbackend type、bucket、key、workspace、resource/output名だけを表示し、state本文やsecret値は表示しません。`backend_reachable_state_object_missing`の場合は`terraform apply`へ進まず、Cloudflare実環境との照合とimport計画を先に行ってください。

remote smokeは`PUSHBRIDGE_REMOTE_ORIGIN`未指定時に`https://pushbridge-dev.mokusatsu.workers.dev`を検証します。Cloudflare AccessのService Authを使う場合は`CF-Access-Client-Id`と`CF-Access-Client-Secret`を各HTTPリクエストへ付与する必要があります。テスト用Pushと2台目の端末は終了時に片付けますが、bootstrapした識別可能な`smoke_*`ユーザーと端末AはAPI仕様上残ります。

`cloudflare:remote:e2e`は実Chromiumで公開PWA、E2EE、IndexedDB、Service Worker、offline reloadを検証します。Service Worker script取得はservice-tokenヘッダーを継承しないため、実行元IPがAccess allowlist外の場合は`/sw.js`が403になります。Accessを迂回せず、allowlist済み端末から実行してください。

remote stateが失われた環境の実測結果とimport対応表は、リポジトリルートの`docs/13_CLOUDFLARE_STATE_RECOVERY.md`に記録しています。

```bash
cp infra/terraform.tfvars.example infra/terraform.tfvars
# account_id、ドメイン、許容Originなどを編集

make preflight
make validate
make plan
make apply
make db-migrate
```

TerraformはCloudflareリソースとWorkerを配備します。D1テーブル定義は監査しやすいSQL migrationとして分離しており、`make db-migrate`がTerraform outputから一時Wrangler設定を生成してリモートD1へ適用します。

### 動作確認

Custom Domainを設定した場合:

```bash
curl -fsS https://push.example.com/healthz
curl -fsS https://push.example.com/api/bootstrap/status
```

workers.devだけを使う場合は、Cloudflare Dashboardに表示されるスクリプトURLを使用します。Turnstileの許可ドメインには、正確なworkers.devホスト名を`additional_app_hostnames`で追加してください。

### 送信元IP制限

Workerの環境変数ではStatic Assetsを保護できないため、Cloudflare Accessを使ってホスト全体を制限します。IPv4アドレス1個は`/32`で指定します。

```hcl
access_ip_allowlist = {
  hostname = "pushbridge-dev.<your-workers-subdomain>.workers.dev"
  cidrs = [
    "203.0.113.10/32",
    "2001:db8::1234/128",
  ]
}
```

この設定ではCloudflareが観測する接続元IPを継続的に評価します。許可IP以外からはPWA、Service Worker、APIのいずれにも到達できません。制限を無効にする場合は`access_ip_allowlist = null`を明示します。

自動smokeなど非対話クライアントは、Accessアプリを迂回させずService Authポリシーで個別のService Tokenを許可します。DashboardのAction `Allow`ではなく`Service Auth`を使い、TerraformにはClient IDやSecretではなくService TokenのリソースUUIDだけを未追跡`*.auto.tfvars`へ設定します。

```hcl
access_service_token_ids = ["00000000-0000-0000-0000-000000000000"]
```

Client IDとClient SecretはTerraformへ渡さず、実行時に`CF-Access-Client-Id`／`CF-Access-Client-Secret`ヘッダーとして送ります。リポジトリのremote smokeには標準環境変数`CF_ACCESS_CLIENT_ID`／`CF_ACCESS_CLIENT_SECRET`で渡せます。

## 主な変数

### Custom Domain

```hcl
custom_domain = {
  hostname = "push.example.com"
  zone_id  = "0123456789abcdef0123456789abcdef"
}

enable_workers_dev = false
```

`zone_name`も利用できますが、曖昧さを避けるため本番では`zone_id`を推奨します。

### Queue

MVPではQueueを通さず、D1を正本、Durable Objectをリアルタイム通知に使うため、既定は無効です。

```hcl
enable_queue = true
```

有効にすると次を作成します。

- `<project>-<environment>-delivery`
- `<project>-<environment>-delivery-dlq`
- Worker Queue producer binding `DELIVERY_QUEUE`
- Worker consumer

### R2短期保存

既定のオブジェクトキーと物理削除期限:

```hcl
file_retention_seconds = {
  "ttl/1d/"  = 172800
  "ttl/7d/"  = 691200
  "ttl/30d/" = 2678400
}
```

アプリはアップロード時に必ずいずれかのプレフィックスを選び、D1の`expires_at`で1日／7日／30日の論理期限を強制してください。R2 Lifecycleは各論理期限の1日後に設定した削除漏れ対策です。容量逼迫時はLifecycleを待たず、D1台帳から選んだ対象をWorkerが直接削除します。

R2 CORSにはCustom Domain originが自動追加されます。開発用Originや別ホストは`cors_allowed_origins`で追加します。バケットは公開されません。

### Worker bindings

Terraformが次を作ります。

| Binding | Type |
|---|---|
| `DB` | D1 |
| `FILES` | R2 |
| `USER_HUB` | Durable Object namespace |
| `DELIVERY_QUEUE` | Queue。任意 |
| `TURNSTILE_SITE_KEY` | plain text |
| `TURNSTILE_SECRET_KEY` | secret text |
| `APP_NAME` / `APP_ENVIRONMENT` | plain text |
| `FILE_RETENTION_POLICY` | JSON text |

追加値:

```hcl
vapid_public_key  = "<base64url uncompressed P-256 public key>"
vapid_private_key = "<base64url 32-byte P-256 private key>"
vapid_subject     = "https://pushbridge-dev.example.workers.dev"
web_push_data_key = "<base64url 32-byte AES data key>"
```

`VAPID_SUBJECT`は`mailto:`またはHTTPS URIにします。秘密値は未追跡`terraform.tfvars`から渡し、Planやログへ展開しません。予約済みのplain-text名はTerraformの値が優先されます。

dev専用鍵をまだ作成していない場合、Windows／Linux共通で次を実行すると、4変数を値を表示せず無視対象のリポジトリ直下`env.txt`へ追記します。既存の同名変数が1件でもあれば上書きせず失敗します。

```bash
npm run cloudflare:web-push:generate -- --subject=https://pushbridge-dev.example.workers.dev
```

4変数を`env.txt`へ保存した後、次を実行すると値を表示せず無視対象`infra/cloudflare/infra/web-push.auto.tfvars`を生成します。

```bash
npm run cloudflare:web-push:render
```

## Terraform Stateの保護

Turnstile secretと`worker_secrets`はTerraform Stateへ保存されます。

- StateをGitへコミットしない
- ローカルStateを共有ストレージへ置かない
- CIのPlan/ログでsensitive値を展開しない
- 本番はアクセス制御されたリモートBackendを使う
- State Backend用資格情報をアプリ用資格情報と分離する

`infra/backend.tf.example`と`infra/backend-r2.hcl.example`は、別途作成した専用R2バケットをTerraform S3 backendとして使う例です。同じStateでBackendバケット自身を作ることはできないため、先に別の管理手段で用意します。

## D1 migration

新しいSQLを連番で追加します。

```text
worker/migrations/0002_add_conversations.sql
worker/migrations/0003_add_channels.sql
worker/migrations/0004_file_api.sql
worker/migrations/0005_web_push_subscriptions.sql
worker/migrations/0006_retention_cleanup.sql
worker/migrations/0007_storage_usage_units.sql
worker/migrations/0008_passkey_auth.sql
worker/migrations/0009_device_links.sql
worker/migrations/0010_e2ee.sql
```

適用前に一覧を確認できます。

```bash
make db-migrations-list
make db-migrate
```

D1リソースを置換するとデータを失うため、名前・jurisdiction変更を含むPlanは必ず確認し、バックアップ後に実行してください。

## Durable Object migration

`worker.tf`の初期migrationは次です。

```hcl
migrations = {
  new_tag            = "v1"
  new_sqlite_classes = ["UserHub"]
}
```

新しいDurable Object class、rename、deleteが必要になった場合は、CloudflareのDurable Object migration手順に従って`old_tag`、`new_tag`、migration stepsを明示的に更新します。既存classを単に一覧から消さないでください。

## Workerアプリへの差し替え

`worker/index.mjs`を本番APIに置き換えます。最低限、公開前に次を実装してください。

1. Passkeyまたは同等の認証
2. 端末別セッションと失効
3. Turnstile Siteverify
4. D1のユーザー境界を強制する認可
5. `Idempotency-Key`による重複排除
6. Durable Object接続用の短寿命ワンタイムチケット
7. R2署名URLのサイズ、TTL、キーPrefix制限
8. E2EE ciphertextだけを保存する入力検証
9. アカウント・端末・IP単位のレート制限
10. Web Push subscriptionの暗号化保存

`UserHub`はWebSocket Hibernation APIを使用します。認証済み`POST /api/v1/realtime-ticket`が30秒・一回限り・session/device束縛ticketを発行し、ブラウザーはticketをURL queryへ入れず`pushbridge-ticket.<ticket>` subprotocolで`/realtime`へ接続します。D1 commit後の`sync_required`は同期のきっかけだけで、正本と欠落回復はREST cursor同期です。

## R2 presigned URLの資格情報

このスタックはR2バケット、CORS、Lifecycle、Worker bindingを作成しますが、S3互換presigned URL用のR2 Access Key ID / Secret Access Keyは作成しません。アプリWorkerから署名URLを発行する場合は、専用の最小権限R2 API Tokenを別途作成し、その資格情報を保護された`worker_secrets`またはCloudflare Secrets Storeへ登録してください。

資格情報が未準備の開発段階では、WorkerのR2 bindingを使った小容量アップロードで動作確認し、本番化前にブラウザからR2へ直接送る方式へ切り替えます。

## 更新とDrift

TerraformをCloudflare設定の正本とします。Dashboardで次を直接変更すると、次回Planで差分になります。

- Worker bindings、vars、secrets
- Static Assets
- workers.dev / Custom Domain
- Cron
- R2 CORS / Lifecycle
- Turnstile domains
- Queue consumer settings

緊急変更をDashboardで行った場合は、速やかにTerraformへ反映してから再度Planしてください。

## 削除

`terraform destroy`はD1とR2を含む破壊操作です。本番では通常の運用手順に含めないでください。

削除時には次を先に行います。

1. 新規書き込み停止
2. D1 exportと必要なR2 objectの退避
3. Custom Domain停止
4. Worker session/token失効
5. Terraform Planの破壊対象確認
6. R2 CORS/LifecycleをCloudflare DashboardまたはAPIで削除
7. 承認後にのみdestroy

Cloudflare Provider v5.22.0では`cloudflare_r2_bucket_cors`と`cloudflare_r2_bucket_lifecycle`がTerraformからdestroyできない旨の警告を返します。Terraform Stateから他のリソースを削除できても、これらの設定は手動削除が必要です。手動削除後は次回Planで再作成されないよう、Terraform側のリソースも同じ変更で除去してください。

## ローカルチェック

```bash
make check
make validate
```

GitHub ActionsもTerraform format、provider初期化、validate、JavaScript構文確認を実行します。CloudflareへのPlan/ApplyはAPI Tokenを持つ保護された別Workflowへ分離してください。

この配布物に対して実施済みの検証と未実施事項は[`VALIDATION.md`](./VALIDATION.md)、参照した公式仕様は[`REFERENCES.md`](./REFERENCES.md)に記録しています。
