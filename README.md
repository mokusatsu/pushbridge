# Pushbridge

Pushbullet型の端末間共有サービスを、まずローカルのWeb/PWAとREST APIで実証し、同じブラウザー向け契約を保ったままCloudflareへ移行するための統合ワークスペースです。
テスト用の変更。

## 現在の縦切り

- Web/PWA: React 19、TypeScript、Vite、IndexedDB
- 開発API: RelayMock 0.1.1、FastAPI、SQLite、ローカルオブジェクトストレージ
- API正本: `contract/openapi.json`
- Cloudflare移行先: Workers、D1、R2、Durable Objects、Static Assets
- Retention: ファイル本体は最大30日、軽量エイリアスは既定180日。容量逼迫時は本体を早期削除し、受信端末はWeb Push／同期時にIndexedDBへ自動保存
- 実Cloudflare環境へのデプロイ: 未実施

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

## セットアップと検証

```bash
make setup
make check
make smoke
```

`apps/web-pwa/dist`は生成物のためGit管理しません。通常のnpm接続環境で`npm ci && npm run build`を実行して生成してください。ソース、RelayMock、OpenAPI契約は`make check`で一括検証できます。

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
- Cloudflareへの`terraform apply`、D1 migration、R2操作はこのPOC検証では実行しません。
- API token、署名URL、Bearer token、Push本文、URL、ファイル名をログや成果物へ保存しません。
- 外部環境への変更は、人が内容を確認した別工程として扱います。

## 現在のCloudflare実装範囲

WorkerはMiniflare上でBootstrap、Bearer認証、端末管理、Note／Link作成、カーソル同期、pin／dismiss／削除、ストレージ使用量まで検証済みです。ファイルuploadと実Web Push配送は未実装で、Capabilitiesでも無効として返します。詳細な検証結果は`VALIDATION_2026-07-21.md`を参照してください。
