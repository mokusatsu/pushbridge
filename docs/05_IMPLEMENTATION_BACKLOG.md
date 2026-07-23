# 実装バックログ

優先度:

- **P0**: 認証済みNote同期の縦切りに必須
- **P1**: MVPに必須
- **P2**: 公開ベータ品質
- **P3**: MVP後

サイズは相対値`S/M/L/XL`であり、納期の約束ではない。

## 2026-07-23 現在の実装状況

| 項目 | 状態 |
|---|---|
| RP-001 モノレポ／共通check | 部分完了。React PWA、RelayMock、Cloudflare IaCを単一workspaceで検証可能 |
| RP-002 Worker TypeScript化 | PoC完了。route／auth／response等を`worker/src`へ分割し、Terraform投入用bundleを再現可能に生成 |
| RP-003 Cloudflare統合test | PoC完了。公式Workers Vitest poolでD1 migration、R2、DO、Web Push、retention、Passkey、E2EEと主要routeを33件検証 |
| RP-201 Push作成と冪等性 | PoC完了。cross-user target拒否、UTF-8 byte上限、同一key 100回再送を統合test済み |
| RP-202 cursor同期 | PoC完了。user／device／sessionに束縛した署名cursor、改変拒否、205件paginationを統合test済み |
| RP-203 dismiss／pin／delete | PoC実装済み。保持期限cleanupは不足 |
| RP-204 Link | PoC実装済み。安全なscheme検証を再確認する必要あり |
| RP-501 PWA shell | PoC実装済み。NoteのIndexedDB／offlineを確認済み |
| RP-601〜605 Worker File／R2 | Phase 2〜7 PoC実装済み。private R2 server-ticket、File Push、25 MiB境界、削除／410、client-side PBFE暗号化を統合test。presigned URLは未実装 |
| RP-502〜503 Web Push | Phase 3 source／local PoCとdev適用済み。subscription暗号化、VAPID、標準暗号、失効、限定retry、端末別ACKを検証。remote subscription CRUD合格、実push service配送は未完了 |
| RP-501／504 PWA File UX | Phase 5 local実装済み。upload進捗／cancel／retry、送信側の配送待ち／通知済み／取得中／保存済み／再試行中／取得不可を契約APIから表示。Playwright desktop／mobile、Service Worker実更新、単一時系列HTML証跡まで合格。dev実Web Push E2Eは未完了 |
| RP-301〜304 Realtime | Phase 8 dev実測完了。30秒one-time ticket、session/device束縛、URL非露出subprotocol、Hibernation API、接続/size/backpressure制限、signed cursor tickle、revocation、heartbeat、jitter、sleep復帰をWorker/Chromiumで検証 |
| RP-701〜704 Chromium拡張 | dev実測完了。Manifest V3最小権限、device-link、P-256端末鍵、E2EE Note/Link/File、private R2、current tab/context menu、端末選択、shortcut、one-time WebSocket、cursor同期、通知、再現可能zipを実装。Wrangler localと公開devの実Chromiumでpeer復号まで検証 |

Cloudflare devではTerraform、D1 migration 0001〜0011、TypeScript Worker bundle、PWA、Web Push／retention／E2EE／realtime binding、Accessを適用済み。Phase 8 Service Auth remote smoke、schema version 11、公開Chromium Service Worker／IndexedDB／offline、post-apply Plan差分なしを確認した。現在の優先順は永続browser profileでの実Web Push配送とPWA終了中cached ACK、拡張機能realtime/File、実Cron、Custom Domain/Passkeyである。一時Chromium/Edge profileのWeb Push probeは`PushManager.subscribe()`がpermission deniedとなり、実配送には到達していない。

Phase 4はmigration 0006〜0007、D1起点の`delete_pending`状態機械、TTL／pressure削除、180日alias／7日tombstone、日次KiB-second履歴、R2／D1 fault recoveryまでlocal PoCとdev適用を完了。実Cron観測は未完了。

## Epic E0 — リポジトリと開発基盤

### RP-001 [P0/S] モノレポ構成を確定

成果:

- `packages/worker`、`packages/shared`、`apps/web`、`apps/extension`等の構成
- package managerとlockfile
- build/test/lint/typecheck commands
- 既存`cloudflare-iac/`との境界

完了条件:

- clean checkoutから一つのcommandでinstallとtest
- Worker bundle pathをTerraformへ安定して渡せる
- remote codeを含めない

### RP-002 [P0/M] ブートストラップWorkerをTypeScript化

依存: RP-001

成果:

- 現在の`/healthz`、status、501挙動を維持
- binding型定義
- route abstraction
- error response utility

完了条件:

- 現在のmock testを回帰test化
- source mapとproduction log方針を記録

### RP-003 [P0/M] ローカルCloudflare統合test基盤

依存: RP-001

成果:

- Wrangler/MiniflareでD1、R2、DO binding test
- migration自動適用
- test用clock/ID generator

完了条件:

- CIで外部Cloudflare accountなしに主要testが動く

### RP-004 [P0/S] ADRテンプレートと初期ADR

成果:

- ID方式
- timestamp方式
- session方式
- cursor token方式
-暗号primitive/versioning

## Epic E1 — Passkey、Session、端末

### RP-101 [P0/M] Passkey用D1 migration

依存: RP-003

追加候補:

- `passkey_credentials`
- `auth_challenges`
- `device_link_requests`
- 必要なら`session_generations`

完了条件:

- challenge expiry/one-time use index
- credential ID unique
- user削除cascade
- local migrationとforeign key test

### RP-102 [P0/L] Passkey登録

依存: RP-101

成果:

- registration options/verify
- Turnstile Siteverify
- initial user/device/session作成

完了条件:

- challenge replay拒否
- wrong origin/RP ID拒否
- malformed credential拒否
- secret/contentがlogされない

### RP-103 [P0/L] Passkey login/logout/session rotation

依存: RP-102

成果:

- authentication options/verify
- HttpOnly cookie
- CSRF/Origin防御
- logout、session一覧、個別revoke

完了条件:

- session fixation test
- revoked/expired session拒否
- rotation race test

### RP-104 [P0/M] 端末CRUDと失効

依存: RP-103

成果:

- list/rename/revoke
- active device limits
- session/token/subscription一括失効

完了条件:

- 他user device IDOR拒否
- self revokeのUX/挙動を定義

### RP-105 [P1/L] 拡張機能device-link flow

依存: RP-104, RP-701

成果:

- PKCE init/approve/exchange
- device-specific token
- one-time short-lived code

完了条件:

- interception/replay test
- approval UIでscopeとdevice info表示

## Epic E2 — Push CRUDとカーソル同期

### RP-201 [P0/M] Push作成と冪等性

依存: RP-103, RP-104

成果:

- `POST /v1/pushes`
- user/device authorization
- `UNIQUE(user_id, client_guid)`利用
- quota increment

完了条件:

- 同じkeyを100回送って1件
- 異なるbodyで同じkeyは409
- cross-user target拒否

### RP-202 [P0/L] カーソル同期

依存: RP-201

成果:

- `GET /v1/pushes?after=`
- opaque signed cursor
- pagination
- tombstone

完了条件:

- 同一`modified_at`の順序が安定
- cursor tamper拒否
- 200件超deltaのpagination test

### RP-203 [P1/M] dismiss/pin/delete

依存: RP-202

成果:

- optimistic concurrency
- tombstone retention
- cron cleanup

完了条件:

- 端末間反映
- delete後のoffline device同期

### RP-204 [P1/S] Link payloadと安全なopen

依存: RP-201

完了条件:

- `http/https` allowlist
- `javascript:`等拒否
- URL自体は暗号文内

### RP-205 [P2/M] Local-first outbox

依存: RP-201, RP-501

成果:

- IndexedDB pending/sent/failed
- same idempotency key retry
- conflict UI

## Epic E3 — リアルタイム

### RP-301 [P0/M] WebSocket ticket

状態: dev適用・remote検証完了。D1 migration 0011でhashだけを保存し、30秒・一回限り・発行session token hash／user／deviceへ束縛する。ticketはURL queryへ載せずWebSocket subprotocolで渡し、replay拒否と実接続を確認済み。

依存: RP-103, RP-104

成果:

- 30秒以下、一回限りticket
- user/device/session generation binding

完了条件:

- replay拒否
- expired ticket拒否
- URL log redaction

### RP-302 [P0/L] 認証済みUserHub

状態: dev適用・remote検証完了。`/realtime`から既存`UserHub`へルーティングし、Hibernation attachment、user 10接続／device 2接続、65,536 byte、backpressure、revoked session/device切断を統合test済み。Access Service Tokenから得た短期cookieでremote smokeも接続する。

依存: RP-301

成果:

- `/ws` route
- ticket consume
- attachmentへdevice metadata
- Hibernation API
- connection limits

完了条件:

- user間fan-out隔離
- revoked device切断
- message size/backpressure test

### RP-303 [P0/M] D1 commit後tickle

状態: dev適用・remote検証完了。Push commit後に`sync_required`とdevice別署名cursor hintを送る。DO障害を注入してもD1 Pushが201で残り、REST cursor同期が回復経路であることを確認。remote smokeで一回限りtickleを実測済み。

依存: RP-201, RP-302

成果:

- `sync_required` event
- cursor hint
- debounce/coalesce

完了条件:

- DO failureでもPush write成功
- event欠落後cursor syncで回復

### RP-304 [P1/M] 拡張機能/PWA reconnect policy

状態: PWA dev実測完了。30秒heartbeat、指数backoff+jitter、60秒上限、visibility復帰時の同期／再接続、250ms sync debounceを実装し、local二端末と公開Chromiumで暗号化Note/File、Service Worker、IndexedDB、offline reloadを確認。

依存: RP-302, RP-501, RP-701

成果:

- heartbeat
- exponential backoff+jitter
- browser sleep recovery
- duplicate notification prevention

## Epic E4 — E2EE

### RP-401 [P1/L] Client crypto package

依存: RP-001, RP-004

成果:

- P-256 device keys
- HKDF-SHA-256
- AES-256-GCM
- base64url utilities
- versioned envelope

完了条件:

- test vectors
- cross-browser test
- nonce reuse防止test

### RP-402 [P1/L] Account key bootstrapとdevice envelope

依存: RP-104, RP-401

成果:

- initial `K_account`
- wrap/unwrap
- D1 envelope CRUD
- new device key transfer

完了条件:

- serverにplaintext account keyなし
- revoked deviceへ新envelopeを出さない

### RP-403 [P1/L] Recovery key

依存: RP-402

成果:

- generation/display/confirm
- restore flow
- rotation

完了条件:

- serverにrecovery keyなし
- loss UXを明示

### RP-404 [P1/M] Push payload暗号化統合

依存: RP-201, RP-401, RP-402

完了条件:

- D1/logへtitle/body/URL平文なし
- unsupported payload versionの扱い
- AAD tamper検出

## Epic E5 — Web/PWAとWeb Push

### RP-501 [P1/L] 実用PWA shell

依存: RP-001

成果:

- auth views
- device selector
- send/history/settings
- IndexedDB
- install/offline

完了条件:

- notification拒否でも利用可能
- keyboard/mobile accessibility

### RP-502 [P1/M] Web Push subscription管理

依存: RP-103, RP-104, RP-501

成果:

- subscribe/unsubscribe
- VAPID public key
- endpoint server-side encryption
- per-device limit

完了条件:

- endpointがlogにない
- 404/410でrevoke

### RP-503 [P1/L] Web Push wake-up送信

依存: RP-201, RP-502

成果:

- minimal payload
- connected/non-connected判定方針
- transient retry

完了条件:

- plaintext contentなし
- duplicate notification制御
- iOS Home Screen手順

### RP-504 [P2/M] PWA local searchとcache管理

依存: RP-404, RP-501

成果:

- decrypted local index
- logout/revoke時cache wipe
- retention cleanup

## Epic E6 — File共有

### RP-601 [P1/M] R2 signing credential運用

状態: server-ticket PoCではWorker bindingだけを使用し、資格情報をクライアントへ渡さない。専用最小権限credential、presigned URL、rotation runbookは未完了。

成果:

- dedicated minimal R2 API token作成手順
- secret injection
- rotation runbook

完了条件:

- credentialがTerraform/Git/logへ漏れない構成

### RP-602 [P1/L] File init/direct upload/complete

状態: `init`／PUT ticket／`complete`、固定TTL、Worker生成prefix、size/hash/存在検査を実装済み。dev PoCはWorker body中継のserver-ticketであり、direct upload完成とは扱わない。

依存: RP-103, RP-104, RP-601

成果:

- quota/TTL/prefix validation
- short-lived PUT URL
- pending/ready state
- size check

完了条件:

- arbitrary R2 key署名不可
- oversized/mismatched upload拒否
- Workerがbody中継しない

### RP-603 [P1/L] Client file encryption

状態: 未実装。Phase 2の実R2検査にはローカルで暗号化したfixtureだけを使用し、製品E2EE完成とは扱わない。

依存: RP-401, RP-602

成果:

- 25MB whole-file AES-GCM
- progress/cancel
- ciphertext hash
- memory error handling

完了条件:

- R2にplaintextなし
- wrong key/hash failure UI

### RP-604 [P1/M] Download ticket/expiry/delete

状態: 短寿命download ticket、利用者境界、attachment配信、期限切れ410、論理削除を実装済み。定期retry処理はRP-605へ残る。

依存: RP-602, RP-603

完了条件:

- logical expiry後は410
- GET URL約60秒
- HTML/SVG inline実行なし
- R2 delete retry

### RP-605 [P2/M] Cleanup job強化

状態: upload reservation時のstale pending回収とR2 delete retry状態のスキーマを実装済み。Cron cleanup、容量逼迫、alias/tombstone完全回収は未実装。

依存: RP-602

成果:

- stale pending
- expired metadata
- orphan object detection
- account deletion cleanup

## Epic E7 — Chromium拡張機能

### RP-701 [P1/L] Manifest V3 shell

依存: RP-001

状態: local PoC完了。Manifest V3 service worker、popup/options、固定dev/local host permission、`<all_urls>`／remote code／content scriptなし、build／実Chromium load／再現可能zipを検証。

成果:

- popup
- service worker
- options
- minimal permissions
- build/package

完了条件:

- `<all_urls>`なし
- remote codeなし
- permission rationale

### RP-702 [P1/L] Note/Link送信UI

依存: RP-105, RP-201, RP-701

状態: local PoC完了。one-time device-link、P-256端末鍵、account-key envelope、E2EE Note/Link、current tab、selection/page/link/image context menu、端末selector、shortcutを実装し、Wrangler＋実Chromiumで暗号文に平文がないことと別端末復号を確認。

成果:

- current tab
- selection
- context menu
- device selector
- shortcut

### RP-703 [P1/M] 通知・WebSocket

依存: RP-304, RP-701

状態: dev実測完了。URL非露出one-time ticket、20秒heartbeat、指数backoff、alarm復旧、同期中tickleの追加drain、REST cursor正本、Push ID固定通知、通知担当toggleを実装し、Wrangler localと公開devの実Chromiumで別端末作成から通知・復号履歴まで確認。

成果:

- browser notification
- reconnect
- PWAとの通知担当設定

### RP-704 [P1/M] File送信

依存: RP-603, RP-701

状態: dev実測完了。PWA互換PBFE container、端末内AES-256-GCM、opaque server metadata、private R2 server-ticket、1/7/30日TTL、暗号化Push metadataを実装し、Wrangler localと公開devの実ChromiumでR2暗号文非漏洩・download byte・peer復号を確認。

### RP-705 [P2/S] Optional clipboard

依存: RP-701

完了条件:

- `clipboardRead`はoptional
- user gesture
- 自動上書きなし

### RP-706 [P2/M] Store submission package

状態: draft package完了。privacy disclosure、日文listing、permission rationale、公開前checklist、実Chromium 1280x800 screenshot 3枚、再現可能zipを生成。公開privacy URL、support contact、Custom Domain、developer identityが未確定のためStore提出は未実施。

成果:

- privacy disclosure
- screenshots/text
- permission explanation
- reproducible zip

## Epic E8 — Quota、監視、運用

### RP-801 [P1/M] Application quota

依存: RP-201, RP-602

成果:

- atomic daily counters
- user/device/IP limit
- clear 429

### RP-802 [P1/M] Degradation controller

依存: RP-801

成果:

- normal/warning/constrained/files-disabled/write-protection
- admin override
- `/service-status`

### RP-803 [P2/M] Metrics dashboard/alerts

成果:

- Worker CPU/request/error
- D1 rows
- R2 bytes/ops
- DO reconnect
- Web Push result
- Queue/DLQ

### RP-804 [P2/M] Backup/restore drill

成果:

- D1 export
- R2 inventory
- Terraform State recovery
- restore test記録

### RP-805 [P2/M] Account deletion workflow

依存: RP-104, RP-604, RP-605

完了条件:

- immediate logical lock
- resumable physical deletion
- audit without content

## Epic E9 — リリース品質

### RP-901 [P0/M] 二端末Note E2E

依存: RP-303

scenario:

- user registration
- device A/B
- A creates Note
- B receives tickle and syncs
- disconnect B
- A creates more
- reconnect B and recover all
- idempotent retry
- revoke B

### RP-902 [P1/L] File E2E

依存: RP-604

### RP-903 [P2/L] Security test suite

依存: E1-E7

対象は`06_ACCEPTANCE_AND_TEST_PLAN.md`。

### RP-904 [P2/M] Load/capacity test

- 5,000 Push/day equivalent
- reconnect storm
- D1 rows measurement
- Worker CPU p95
- R2 lifecycle observation

### RP-905 [P2/M] Production readiness review

- security review
- privacy terms
- abuse process
- cost trigger
- rollback
- runbook sign-off

## Epic E10 — MVP後

### RP-1001 [P3/XL] Contacts/1:1 Chat
### RP-1002 [P3/L] Firefox extension
### RP-1003 [P3/XL] ChannelsとQueue fan-out
### RP-1004 [P3/L] Personal Access Token/Webhook
### RP-1005 [P3/XL] OAuth client support
### RP-1006 [P3/L] Pushbullet migration assistant

## 推奨PR順序

1. RP-001〜004
2. RP-101〜104
3. RP-201〜202
4. RP-301〜303
5. RP-901
6. RP-203〜204
7. RP-401〜404
8. RP-501〜503
9. RP-601〜604
10. RP-701〜704
11. RP-801〜805
12. RP-902〜905

この順序は「認証済みNote同期」を最速で検証し、その上へE2EE、PWA、File、拡張機能を積むためのもの。
