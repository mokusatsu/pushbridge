# Pushbridge

Pushbullet型の端末間共有サービスを、まずローカルのWeb/PWAとREST APIで実証し、同じブラウザー向け契約を保ったままCloudflareへ移行するための統合ワークスペースです。

## 現在の縦切り

- Web/PWA: React 19、TypeScript、Vite、IndexedDB
- 開発API: RelayMock 0.1.1、FastAPI、SQLite、ローカルオブジェクトストレージ
- API正本: `contract/openapi.json`
- Cloudflare移行先: Workers、D1、R2、Durable Objects、Static Assets
- Retention: ファイル本体は最大30日、軽量エイリアスは既定180日。容量逼迫時は本体を早期削除し、受信端末はWeb Push／同期時にIndexedDBへ自動保存
- 実Cloudflare dev環境: Terraform remote stateでWorker、D1、非公開R2、Durable Object、Turnstile、Cron、Static Assets、Accessを管理。D1 migration 0001／0002適用済み

ローカル結合では、Bootstrap、端末取得、Noteの冪等送信、カーソル同期、ファイルの直接PUT/GET、`file_ref`状態再同期、Web Push Subscription upsertを検証します。

## 構成

```text
apps/web-pwa/       Web/PWAクライアント
services/relaymock/ ローカル開発API
contract/           公開API契約の正本
infra/cloudflare/   Cloudflare Terraform/IaCの既存ブートストラップ
docs/               製品、API、セキュリティ、運用設計
scripts/            統合検証スクリプト
```

`apps/web-pwa/openapi/relaymock.openapi.json`と`services/relaymock/openapi.json`は配布・検査用コピーです。変更は最初に`contract/openapi.json`へ反映し、`make sync-contract`で同期してください。

## 必要環境

- Python 3.11以上
- Node.js 22.12以上
- npm
- Bash
- Terraform 1.7以上

## セットアップと検証

```bash
make setup
make check
make smoke
```

Windowsやmakeのない環境では、同じ全チェックとCloudflareローカル縦切りをnpmから実行できます。

```powershell
python -m venv .runtime/venv
.\.runtime\venv\Scripts\python.exe -m pip install -e "services/relaymock[dev]"
npm ci
npm ci --prefix apps/web-pwa
$env:PYTHON_BIN = (Resolve-Path .runtime\venv\Scripts\python.exe).Path
npm run check
npm run cloudflare:local:smoke
npm run cloudflare:remote:smoke
```

PWAのproduction buildは`infra/cloudflare/app/dist`へ直接生成され、Terraform Worker Static AssetsとローカルWranglerの双方が同じ成果物を配信します。

`cloudflare:remote:smoke`はAccess許可済みの実行元から、公開dev Workerに一意なテストユーザーを作成し、端末2台・Bearer認証・Note・冪等性・cursor同期・PWAを検証します。検証用Pushと端末Bは終了時に削除／失効します。

既に起動中のAPIを使う場合:

```bash
cd apps/web-pwa
API_ORIGIN=http://127.0.0.1:8000 npm run smoke:api
```

## Cloudflare移行境界

ブラウザーは相対URL`/api/v1`だけに依存します。Cloudflare移行ではRelayMock内部を次のように置換し、OpenAPIのwire contractは維持します。

| POC | Cloudflare |
|---|---|
| FastAPI router | Worker route |
| SQLite | D1 |
| local object storage | private R2 |
| upload/download ticket | 短寿命署名URL |
| REST polling | REST cursor sync＋DO/WebSocket tickle |

Durable ObjectsとWebSocketは変更通知に限定し、欠落回復と最終整合性はRESTカーソル同期が担います。R2オブジェクトはWorkerメモリを経由させません。

保持期間、容量逼迫時の自動削除、端末内永続受信箱の確定仕様は`docs/11_RETENTION_AND_LOCAL_PERSISTENCE.md`を参照してください。GUIから逆算した分類、状態表示、ストレージAPIは`docs/12_GUI_DERIVED_API.md`を参照してください。過去文書に残る24時間TTL案より、これらを優先します。

## 安全境界

- `services/relaymock`のBootstrapとmock管理APIはローカル開発専用です。
- Cloudflareへの変更はdevだけを対象にし、Planのadd/change/destroyを確認してから適用します。D1／R2／Workerの置換または削除が出たPlanは適用しません。
- API token、署名URL、Bearer token、Push本文、URL、ファイル名をログや成果物へ保存しません。
- 外部環境への変更は、人が内容を確認した別工程として扱います。

## 現在のCloudflare実装範囲

WorkerはWranglerローカル環境でD1 migration、Bootstrap、Bearer認証、2端末管理、Note／Link作成、Idempotency-Key、カーソル同期、pin／dismiss／削除、ストレージ使用量まで検証します。実PWA、SPA fallback、Service Workerも同じsmokeに含みます。ファイルuploadと実Web Push配送は未実装で、Capabilitiesでも無効として返します。state復旧の実測結果は`docs/13_CLOUDFLARE_STATE_RECOVERY.md`を参照してください。
