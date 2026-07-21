# ローカル検証記録

実施日: 2026-07-21

## 合格

| 対象 | 結果 |
| --- | --- |
| RelayMock pytest | 24件合格 |
| OpenAPI正本／RelayMock／PWAコピー | 一致 |
| PWA OpenAPI契約検査 | 合格 |
| PWA TypeScript | 合格 |
| PWA Vitest | 23件合格 |
| PWA production build | 合格 |
| RelayMock実HTTPスモーク | 合格 |
| Worker JavaScript構文検査 | 合格 |
| D1 migration 0001＋0002 | Miniflareで合格 |
| Worker Bootstrap／Bearer認証 | 合格 |
| Worker端末link／rename | 合格 |
| Worker Note作成／冪等再送／pin | 合格 |
| Workerカーソル同期 | 合格 |
| Workerストレージ使用量 | 合格 |
| Miniflare R2 put/get | 合格 |

## 未実装または環境上未確認

| 対象 | 状態 |
| --- | --- |
| Workerファイルupload／R2本体管理 | 未実装。Capabilitiesは`direct_upload=false` |
| Worker Web Push配送／受領確認 | 未実装。Capabilitiesは配送・登録ともfalse |
| Worker WebSocket realtime | 未実装。REST pollが正本 |
| Terraform validate | Terraform CLIが環境にないため未実施 |
| `wrangler dev` | 前回確認時に仮想環境のネットワークインターフェース取得で失敗。Miniflare直接実行で代替 |
| 実ブラウザー画面撮影 | クラウドブラウザーが`127.0.0.1`を`ERR_BLOCKED_BY_CLIENT`で遮断 |

## 判定

RelayMockを使うローカルPWAは、ファイルを含む主要フローを検証可能である。WorkerはNote／Linkと端末管理についてクライアント置換の技術実証段階へ進んだ。ファイルとWeb Pushは未実装であり、Cloudflare移行完了とは判定しない。
