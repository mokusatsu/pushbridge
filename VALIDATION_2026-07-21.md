# Pushbridge PoC validation record

初回実施日: 2026-07-21<br>
再検証日: 2026-07-22

## 合格

| 対象 | 結果 |
| --- | --- |
| RelayMock pytest | 24件合格 |
| OpenAPI正本／RelayMock／PWAコピー | 一致 |
| PWA OpenAPI契約検査／TypeScript／production build | 合格 |
| PWA Vitest | 23件合格 |
| RelayMock実HTTP smoke | Note／Link／File／subscriptionを含め合格 |
| Terraform fmt／validate | Terraform 1.14.3、Cloudflare Provider 5.22.0で合格 |
| D1 migration 0001＋0002 | Wrangler／Miniflareで合格、remote適用済み |
| Worker Bootstrap／Bearer認証／端末／Note | local合格。過去のAccess許可元remote smokeでも合格 |
| Worker cursor同期／冪等性 | local合格。過去のAccess許可元remote smokeでも合格 |
| Worker Static Assets／SPA／Service Worker | local合格。過去のAccess許可元remote smokeでも合格 |
| Terraform remote backend診断 | stateと必須outputを取得成功 |
| Cloudflare Access | IPv4／IPv6 allowlistをAPIと許可外302で確認 |

2026-07-22の現実行環境はallowlist外であり、Access復旧後のremote smokeは`healthz did not return the Worker JSON response`でexit 1となった。Accessを無効化せず、拒否を期待どおりの保護結果として記録した。

## 未実装または未確認

| 対象 | 状態 |
| --- | --- |
| Worker File API／実R2本体管理 | 未実装。Capabilitiesは`direct_upload=false` |
| Worker Web Push配送／受領確認 | 未実装。Capabilitiesは配送・登録ともfalse |
| Worker WebSocket realtime | 未実装。REST cursor同期が正本 |
| 実ブラウザーFile E2E | Worker File API未実装のため未確認 |
| Passkey／Turnstile検証／E2EE／レート制限 | 公開前の必須未実装項目 |

## 判定

Cloudflare dev環境ではNote／LinkとPWAの縦切りが動作する。FileはRelayMockだけで成立しており、Worker＋R2＋PWAの縦切りは未完成である。Cloudflare移行PoCの完了判定にはFile、配送確認、保持期限処理の実装とE2Eが必要。
