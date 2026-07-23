# Pushbridge PoC validation record

初回実施日: 2026-07-21<br>
再検証日: 2026-07-24

## 合格

| 対象 | 結果 |
| --- | --- |
| RelayMock pytest | 26件合格 |
| OpenAPI正本／RelayMock／PWAコピー | 一致 |
| PWA OpenAPI契約検査／TypeScript／production build | 合格 |
| PWA Vitest | 43件合格（サーバー削除後のIndexedDB Blob維持、E2EE固定vector、AAD改変、wrong key、nonce再利用防止、危険URL非リンク化、Realtime backoff/jitter、R2送信先制限を含む） |
| Playwright実ブラウザー | Chromium desktop 3件／mobile 1件合格、Passkey 1件は専用テストへ分離。二端末Note／Link／File、account deletion、IndexedDB、server削除後offline reload、missed、Service Worker実更新、通知拒否、keyboard／ARIA／reduced-motionを検証 |
| Phase 5時系列証跡 | 実Chromiumのスクリーンショット5枚、匿名化API method/path/status 71件、IndexedDB状態5時点を自己完結HTMLへ記録。認証情報・body・Web Push endpoint・file bytesなし |
| RelayMock実HTTP smoke | Note／Link／File／subscriptionを含め合格 |
| Terraform fmt／validate | Terraform 1.14.3、Cloudflare Provider 5.22.0で合格 |
| D1 migration 0001〜0012 | Wrangler／Miniflareとremote適用に合格、schema version 12。適用後migration残件なしをremote読取確認 |
| Worker Bootstrap／Bearer認証／端末／Note | localとService Auth経由remote smokeで合格 |
| Worker cursor同期／冪等性 | localとService Auth経由remote smokeで合格 |
| Worker Static Assets／SPA／Service Worker | localとService Auth経由remote smokeで合格 |
| Terraform remote backend診断 | stateと必須outputを取得成功 |
| Cloudflare Access | IPv4／IPv6 CIDRとService TokenをTerraform管理。固定IPv4を`non_identity` Service Authへ変更し、IdPログイン／tokenヘッダーなしで主要3 endpointとremote Playwright／実Edge Web Pushが合格。変更は0 add / 1 change / 0 destroy、適用後Plan差分なし |
| Worker File API／private R2 | 公式Workers Vitest pool 13件、local smoke、Service Auth経由remote smokeでupload/download、hash、410、File Pushを確認 |
| 実R2 fixture | 暗号化bytesのPUT／GET hash一致、終了後prefix listing 0件 |
| Phase 3 local | migration 0005、Web Push暗号／VAPID署名、subscription暗号化、404/410失効、端末別配送台帳、Service Worker ACKをWorker 18件とlocal smokeで確認 |
| Phase 4 local | migration 0006〜0007、TTL／pressure cleanup、alias/tombstone、KiB-second履歴、R2/D1 fault injectionを含むWorker 18件とlocal smokeに合格 |
| Phase 6〜7 | Passkey/session/device-link/E2EEをWorker 26件、PWA 38件、local Chromiumで確認。remote Service Auth smokeで暗号化Note/File、P-256 envelope、private R2、端末B復号まで合格 |
| Phase 7 Terraform | 0 add / 1 change / 0 destroy / 0 replaceでWorkerだけをin-place更新。適用後Planは差分なし |
| Phase 8 local | migration 0011、30秒one-time ticket、URL非露出subprotocol、DO Hibernation tickle、signed cursor、revocation、接続/size/backpressure制限をWorker 33件とlocal Wrangler/Chromiumで確認 |
| Phase 8 dev | migration 0011とWorkerを0 add / 1 change / 0 destroyで適用。E2EE/realtime/Web Push capabilityはtrue、Service Auth remote smokeで暗号化Note/FileとDO tickle、公開ChromiumでService Worker／IndexedDB／server削除後Blob／offline reloadに合格。適用後Planは差分なし |
| Phase 9 Chromium拡張 local/dev | Manifest V3、最小権限、device-link、P-256端末鍵、E2EE Note/Link/File、private R2、current tab/context menu/端末選択/shortcut、one-time WebSocket、cursor同期、通知を実装。実Chromium＋専用Wrangler/D1と公開devの両方で暗号文非漏洩・別端末復号を確認。PWA側の実Web Pushはインストール済みEdgeで別途合格 |
| Phase 9 Store draft | privacy disclosure、日文listing、permission rationale、公開前checklist、実Chromium 1280x800 screenshot 3枚、再現可能zipを生成。公開privacy URL／support contact／Custom Domain未確定のため提出は未実施 |
| Account deletion local/dev | migration 0012、即時account/session/device/token/subscription失効、DO WebSocket切断、R2 100件cursor削除、D1物理削除、指数backoff、20回後manual intervention、PWA秘密鍵／IndexedDB消去、RelayMockを実装。Worker 37件、RelayMock 26件、PWA 41件、実Chromium account deletion、fresh D1 local E2Eに合格。devへ0012とWorker/PWAを適用し、remote smokeで削除完了と端末A/B両tokenの401失効を確認。post-apply Planは差分なし |
| 実Web Push closed-PWA E2E | インストール済みEdgeの実PushManager subscriptionを使用。PWAウィンドウを閉じた状態で暗号化Fileを受信し、Service Worker復号、IndexedDB commit後のcached ACK、サーバー削除後のoffline Blob保持を確認。subscription解除、テストaccount完全削除、一時profile削除まで合格 |
| 実Cron | Cloudflare GraphQLの`workersInvocationsScheduled`専用datasetで、`17 3 * * *`のscheduled invocationを確認。2026-07-22と2026-07-23はいずれもstatus `success`、実CPU時間あり。D1の間接的なusage行ではなくCloudflare側の発火記録 |
| bounded remote load | 固定IPv4からService Tokenなし、concurrency 10で同一Idempotency-Keyを50並行再送し一意Push 1件。health 100回はp95 59ms、認証cursor 100回はp95 238ms、全251 requestでerror 0。合成account完全削除とtoken 401まで確認 |
| R2 direct adapter dormant deploy | SigV4固定vector、署名済み`If-None-Match: *`、R2 hostname制限、認証済みcomplete hash／実bytes照合、30秒GET交換、拡張機能server-ticket fallbackをWorker 40件／PWA 43件で確認。専用資格情報なしのため`direct_upload=false`のままWorker/PWAを0 add / 1 change / 0 destroyでdevへ適用し、remote smokeとPlaywrightが合格。適用後Planは差分なし |
| D1 recovery drill | migration 0001〜0012を適用した隔離ローカルD1に合成user/device/暗号文Pushを作成し、Wrangler exportから別D1へrestore。schema version 12、各件数、暗号文一致、account deletion tableを検証し、一時成果物の削除まで合格 |
| Linux GitHub Actions | commit `09526d4`の[CI run #21](https://github.com/mokusatsu/pushbridge/actions/runs/30030269920)が2026-07-24にsuccess。Node 22で契約、RelayMock、PWA/Worker/拡張、Terraform fmt/validate、Wrangler local smoke、Passkey cookie-session E2Eまで合格 |
| Manual remote smoke workflow | `workflow_dispatch`専用workflowを追加。Access Service Tokenだけを使用し、API/D1/private R2/E2EE/realtime、公開PWA、Chromium拡張を検証。trace／video／screenshot／認証cookieのartifact保存なし。branchはpush済みだがworkflow fileがdefault branchに未到達のためGitHub未登録で、mergeとrepository secrets設定後に実行確認が必要 |

2026-07-24に固定IPv4ポリシーを認証ユーザー向け`allow`から非IDの`non_identity` Service Authへ修正した。Access自体を迂回する`bypass`は使用せず、固定IPとService Tokenのどちらでも非対話アクセスできる。固定IPv4経路ではAccess tokenヘッダーなしの主要3 endpoint、公開PWA Playwright、実Edge closed-PWA Web Pushに合格した。テストFile/R2/Push/端末/accountは各smoke終了時に回収する。

## 未実装または未確認

| 対象 | 状態 |
| --- | --- |
| R2 presigned direct upload | adapterはdevへdormant適用済み。専用R2 S3資格情報の設定、`direct_upload=true`の再適用、実R2 presigned PUT／GET E2Eが必要 |
| Worker Web Push配送／受領確認 | source／local test、dev migration、VAPID／data key binding、remote subscription CRUD、実Edge push service配送、PWA終了中IndexedDB commit後cached ACKまで合格 |
| Worker WebSocket realtime | dev適用とremote smoke／公開Chromiumに合格。WebSocketはtickle専用で、REST cursor同期は引き続き正本 |
| 実ブラウザーFile E2E | local Playwrightで画面・IndexedDB・offline・missed・Service Worker更新と時系列HTMLを自動化済み。dev実Web Pushを受けたPWA終了中の自動保存とサーバー削除後offline Blob保持も実Edgeで合格 |
| Passkey／Turnstile／レート制限 | 実装とlocal統合testは合格。Custom Domain／RP ID未決定のためremote Passkeyは意図的に無効 |
| remote実ブラウザーService Worker | 2026-07-23に暗号化Note/File、IndexedDB、server削除後Blob保持、Service Worker activation、offline reloadまで合格 |
| 監視通知の配送先 | 毎時synthetic workflowとoptional Cloudflare incident／Service Token期限notificationをIaC化。workflowはdefault branchへのmerge、通知メールとGitHub Actions secretsはrepositoryへの設定後に実行確認が必要 |

## 判定

Cloudflare dev環境はD1 schema version 12、Phase 9 E2EE/realtime/account deletion Worker/PWA、Web Push／retention bindingsを適用済みで、Service Auth remote smokeと実ブラウザーで暗号化Note/File、private R2、端末B復号、DO tickle、Service Worker／IndexedDB／offline、closed-PWA実Web Push、アカウント完全削除と両端末token失効まで成立した。Cloudflare Scheduled datasetでも実Cron成功を確認した。残る実環境項目は専用R2 S3資格情報を使うdirect uploadのdev E2E、通知配送先／GitHub secrets、Custom Domain上のPasskeyである。
