# RelayMock 0.1.1結合実装レポート

## 対象

- 更新元：Pushbridge Web／PWA 0.2.0
- 接続契約：RelayMock REST API 0.1.1
- 更新成果物：Pushbridge Web／PWA 0.3.0
- 実施日：2026-07-14

## 照合結果

RelayMock 0.1.1は、0.2.0作成時に提示したAPI側のP0／P1要求をほぼすべて反映しています。APIパスやデータモデルの追加変更は不要です。

一方、0.2.0のPWAは厳格な応答Schemaを使用していたため、0.1.1で追加された`PushOut.file_ref`を未知フィールドとして拒否し、file Pushを含む同期が失敗する状態でした。また、新Capabilities名、Web Push config、Request ID、厳格なFilePayload v1も未反映でした。これらを0.3.0で修正しました。

## 実施内容

### APIアダプター

- `PushOut.file_ref`の受理と正規化
- Payload表示情報と`file_ref`状態情報の結合
- file状態変化を通常のカーソル同期へ反映
- RelayMock 0.1.0応答への後方互換
- 6種類の`PushCreate oneOf`に適合するBody構築
- file Payloadからサーバー管理項目`state`を除去
- `GET /v1/system/capabilities`の0.1.1フィールド対応
- `GET /v1/web-push-config`対応
- Subscription初回201／再登録200対応
- `detail.request_id`と`X-Request-ID`の解析

### Runtime／UI

- 最大ファイル、最大Payload、TTL、端末上限、同期間隔の動的反映
- file状態に応じたダウンロードボタン制御
- SettingsへのWeb Push Subscription登録／一覧／解除
- VAPID公開鍵のBase64 URLおよび65-byte P-256検証
- APIエラーと送信箱エラーへのRequest ID表示
- RelayMockの`delivery=false`明示
- 端末上限表示と追加操作の抑止

### 開発・検証ツール

- OpenAPI 0.1.1契約検査`tools/contract-check.mjs`
- 実HTTPスモーク試験を0.1.1へ更新
- Request ID echo、Token no-store、冪等再送、Subscription upsertを検査
- file upload、download、`file_ref` ready状態を検査
- File削除後のPushカーソル再投入を検査
- 0.1.1 OpenAPI、README、設計書を成果物へ同梱

## 検証コマンド

```bash
npm ci
npm run check
```

個別実行：

```bash
npm run check:contract
npm run typecheck
npm test
npm run build
```

実RelayMock起動後の結合試験：

```bash
API_ORIGIN=http://127.0.0.1:8000 npm run smoke:api
```

## ローカル検証結果

| 項目 | 結果 |
|---|---|
| OpenAPI 0.1.1契約検査 | 成功 |
| TypeScript型検査 | 成功 |
| Vitest | 5ファイル、19テスト成功 |
| PWA本番ビルド | 成功 |
| 本番依存関係audit | 既知の脆弱性0件 |
| 静的PWA／Service Worker配信 | HTTP 200で確認 |
| `/api/v1/*`から`/v1/*`へのrewrite | Echo stubで確認 |
| `/mock-storage/*` raw PUT | Bodyを変えず転送することを確認 |
| `/health`転送 | 確認 |
| Service WorkerのAPIキャッシュ除外 | 生成物を確認 |

ビルド結果の主要サイズ：

```text
dist/index.html                 0.88 kB
dist/sw.js                      3.36 kB
dist/assets/index-*.css        21.95 kB
dist/assets/index-*.js        351.54 kB
```

## 実サーバー試験で確認する項目

- Capabilities 0.1.1と推奨同期間隔
- Web Push configのVAPID公開鍵
- Bootstrapの`Cache-Control: no-store`と`Pragma: no-cache`
- クライアントRequest IDのecho
- Subscription初回201、再登録200
- Push初回201、同内容再送200と`Idempotent-Replayed: true`
- binary uploadとdownload
- `file_ref.state=ready`
- File削除後のPushカーソル再投入と`file_ref.state=deleted`

## 残る制約

- 添付されたのはAPI仕様であり、RelayMockの実行コードや起動済みEndpointではないため、この成果物作成環境では実HTTPスモーク試験を実行していません。
- Web Push Subscriptionのブラウザー実登録には、有効な非圧縮P-256 VAPID公開鍵とビルド済みPWAが必要です。
- RelayMockはSubscriptionを保存しますが実配送しません。
- E2EE、パスキー、本番認証、Cloudflare実装は後続フェーズです。

## API側の追加変更

ブロッキングな追加変更はありません。非必須の契約強化候補として、VAPID公開鍵の形式制約と、空文字だけのNoteを禁止する`minLength`を[`docs/relaymock-comparison.md`](docs/relaymock-comparison.md)に記載しています。
