# 受け入れ・テスト計画

## 1. テスト階層

| 階層 | 目的 | 推奨手段 |
|---|---|---|
| Unit | crypto envelope、cursor、validation、quota、auth policy | Vitest等 |
| Worker integration | D1/R2/DO binding、route、migration | Wrangler/Miniflare |
| Browser integration | WebAuthn mock、IndexedDB、Service Worker | Playwright |
| Extension integration | MV3 service worker、context menu、permissions | Chromium + Playwright/CDP |
| Cloud dev smoke | 実D1/R2/DO/Custom Domain | 専用dev account/environment |
| Load/capacity | request/write/CPU/reconnect | 再現可能なload script |
| Security | IDOR、replay、XSS、signed URL | automated + manual review |
| Recovery | backup/restore、key rotation、account deletion | runbook drill |

## 2. IaC受け入れ

### IAC-001 Format/validate

```bash
terraform -chdir=infra fmt -recursive -check -diff
terraform -chdir=infra init -backend=false
terraform -chdir=infra validate
```

期待:

- error 0
- unexpected warning 0
- provider lockfileを尊重

### IAC-002 Plan default

既定構成で予期しないdestroyなし。D1、R2、CORS、Lifecycle、Turnstile、Worker、Cron、workers.devだけが作成対象。

### IAC-003 Plan optional

Queue + DLQ + consumer + Custom Domainを有効化し、bindingと依存関係が正しい。

### IAC-004 Drift

Dashboardで意図的に安全な設定を変更し、Planがdriftを検出することをdev環境で確認。その後Terraformへ戻す。

### IAC-005 Secret hygiene

- `terraform.tfvars`、State、PlanをGitへ含めない
- CI logへsensitive outputなし
- Worker secretがplain text bindingになっていない

## 3. Migration受け入れ

### DB-001 Fresh database

全migrationを空DBへ適用。foreign key check違反0。

### DB-002 Incremental

`0001`適用済みDBへ`0002...`を順次適用。既存データを保持。

### DB-003 Idempotent discovery

Wranglerが適用済み/未適用migrationを正しく識別。

### DB-004 Index use

主要queryで`EXPLAIN QUERY PLAN`を確認。

- user cursor sync
- active devices
- file expiry
- session expiry

full scanが意図せず発生しない。

## 4. 認証受け入れ

### AUTH-001 Passkey registration

- 有効challengeで登録成功
- user/device/sessionを原子的または整合的に作成
- challenge消費

### AUTH-002 Replay

同じregistration responseを再送し拒否。

### AUTH-003 Origin/RP ID

不正origin、RP ID、challenge、credential typeを拒否。

### AUTH-004 Login/session

- login成功
- HttpOnly/Secure/SameSite属性
- session hashだけをDB保存
- logout後拒否
- expiry後拒否

### AUTH-005 CSRF

Cookie認証のstate-changing requestをcross-siteから実行して拒否。

### AUTH-006 Rate limit

登録/login challengeの大量試行を429。正規userが長期lockoutしない回復方針も確認。

## 5. 端末受け入れ

### DEV-001 List/rename

同一userの端末だけを表示・変更。

### DEV-002 IDOR

別userのdevice IDを指定し404または403。存在情報を過度に漏らさない。

### DEV-003 Revoke

端末失効後、次を拒否または停止。

- REST
- bearer token/session
- WebSocket
- Web Push subscription
- file download ticket
- new key envelope

目標反映時間: 10秒以内、可能なら即時。

### DEV-004 Device limit

11台目を初期上限で拒否し、既存端末削除導線を示す。

### DEV-005 Link replay

authorization code、PKCE verifier、approvalを再利用できない。

## 6. Pushと同期受け入れ

### PUSH-001 Note create

正しい暗号文Noteを作成し、返却cursorが進む。

### PUSH-002 Idempotency 100x

同一request/keyを100回並列送信してPush 1件。全responseが同じresourceを指す。

### PUSH-003 Idempotency conflict

同じkeyで異なるciphertextを送信し409。

### PUSH-004 Target authorization

別user device、revoked device、存在しないdeviceを拒否。

### SYNC-001 Ordering

同じmillisecondに複数Pushを作成し、`modified_at,id`で欠落・重複なし。

### SYNC-002 Pagination

500件deltaを100件ずつ取得し全件一度だけ取得。

### SYNC-003 Cursor tampering

改変cursor、別user cursor、future cursorを安全に処理。

### SYNC-004 Offline recovery

端末Bを切断し、Aが作成/更新/削除。B復帰後に最終状態を完全回復。

### SYNC-005 Tombstone

削除済みPushがoffline deviceへ伝わるまでtombstoneを保持。

### PUSH-005 State conflict

同じPushを二端末から同時更新し、ADRで定めた競合規則どおり。

## 7. WebSocket受け入れ

### WS-001 Ticket

有効ticketで接続。期限切れ、改変、再利用を拒否。

### WS-002 User isolation

user Aのeventがuser Bのsocketへ絶対に届かない。

### WS-003 Device revoke

接続中端末を失効するとsocketが閉じ、再接続できない。

### WS-004 Event loss

tickleを意図的に落としても次回syncで回復。

### WS-005 Duplicate event

同じtickleを複数回送ってもclient stateが重複しない。

### WS-006 Backpressure

遅いclient、大量eventでmemoryを増やし続けず、切断またはcoalesce。

### WS-007 Sleep/reconnect

PC sleep、network変更、browser suspend後にjitter付き再接続し、cursor sync。

## 8. E2EE受け入れ

### CRYPTO-001 Known vectors

HKDF/AES-GCM/wrapの固定test vector。

### CRYPTO-002 Cross-browser

Chrome系と対象PWA browser間でencrypt/decrypt互換。

### CRYPTO-003 AAD tamper

push ID、type、versionを変更すると認証失敗。

### CRYPTO-004 Wrong device/account

別account keyで復号不可。

### CRYPTO-005 Key envelope

新deviceは承認前にaccount keyを取得できず、承認後だけ取得。

### CRYPTO-006 Revoked device

失効deviceへ新key version envelopeを発行しない。

### CRYPTO-007 Recovery

全通常deviceを外したtest accountをrecovery keyで復元。誤ったkeyは復元不可。

### CRYPTO-008 Plaintext audit

D1 export、R2 object、Worker log、browser network logを確認し、title/body/URL/file name/plain fileなし。

## 9. File受け入れ

### FILE-001 Direct upload

Worker request bodyにfile本体を通さずR2へPUT。

### FILE-002 Size limit

25MB以下成功、超過拒否。暗号化後sizeを基準に一貫する。

### FILE-003 Arbitrary key

clientがR2 key/prefixを指定・変更できない。

### FILE-004 Complete mismatch

申告sizeとR2 metadata不一致で`ready`にしない。

### FILE-005 Expiry

D1 `expires_at`を過ぎると、R2 objectが物理的に残っていてもdownload ticket 410。

### FILE-006 Signed URL lifetime

PUT 1〜2分、GET約60秒。期限後失敗。

### FILE-007 Hash/wrong key

corrupt ciphertext、wrong keyで明確に失敗し、破損fileを保存しない。

### FILE-008 Dangerous types

HTML、SVG、実行形式をinline表示しない。file nameをDOMへ安全に表示。

### FILE-009 Interrupted upload

中断後`pending`がcleanupされ、quotaが永久消費されない。

### FILE-010 Delete/account delete

metadataとR2 objectを再試行可能に削除。

## 10. PWA受け入れ

### PWA-001 Install/offline

install可能。app shellはofflineで開く。APIはoffline表示をする。

### PWA-002 IndexedDB

暗号化済みhistory/outboxと受信ファイルBlobを保存。サーバーのTTL／pressure tombstone後も既存ローカル内容をnullで上書きせず参照できる。ローカル上限超過時は未pin、LRU、大容量の順でBlobだけを整理し、明示操作で個別または全消去できる。

### PWA-003 Notification denied

通知拒否でもsend/history/syncが利用可能。

### PWA-004 Web Push

closed/background時にwake-upし、平文contentなし。

### PWA-005 iOS guidance

Home Screen追加が必要な環境へ適切な案内。

### PWA-006 Accessibility

keyboard navigation、focus、label、status announcement、contrastを確認。

## 11. Extension受け入れ

### EXT-001 Permissions

`<all_urls>`なし。`clipboardRead`はoptional。権限理由が文書化。

### EXT-002 Current tab/link/selection

user gestureで正しいpayloadを送信。

### EXT-003 Context menu

page、link、selection、image URLの各contextをschema検証。

### EXT-004 Token isolation

page context/content scriptへtokenを漏らさない。

### EXT-005 Notification

安全なURLだけをopen。PWAとの二重通知を抑制。

### EXT-006 Service Worker lifecycle

suspend/restart後に認証状態を復元し、reconnect後sync。

### EXT-007 Package

再現可能build。remote codeなし。store upload zipの内容を監査。

## 12. Quota・縮退受け入れ

### QUOTA-001 Per-account

Push 200/day、upload 100MB/dayの境界を並列requestでも超過しない。

### QUOTA-002 Degradation 85%

retention縮小、file size縮小、UI反映。

### QUOTA-003 Files disabled 95%

file initだけ停止し、Note/Link、history、device revokeは継続。

### QUOTA-004 Write protection

新規Push停止時もlogout、account deletion、既存readを可能な限り維持。

## 13. Security受け入れ

### SEC-001 IDOR matrix

全resource endpointで他user IDを試す。

### SEC-002 Log redaction

Authorization、Cookie、WS ticket、signed URL、Push content、endpointがlogにない。

### SEC-003 XSS

復号後title/body/file nameにHTML/JS payloadを入れて実行されない。

### SEC-004 URL scheme

`javascript:`、`data:`、不正unicode/whitespace obfuscationを拒否。

### SEC-005 CORS

許可外Origin、wildcard+credentials、R2 DELETEを拒否。

### SEC-006 Content-Type/size

JSON以外、deep/nested巨大payload、65KB超WebSocket messageを拒否。

### SEC-007 Dependency

lockfile、audit、license、remote scriptなし。

## 14. Cleanup・運用受け入れ

### OPS-001 Cron before migration

初回migration前にCronが走ってもservice全体を壊さない。

### OPS-002 Stale cleanup

expired session、revoked subscription、old tombstone、stale pending fileを処理。

### OPS-003 Retry

R2 delete/Web Push/account deletionの一時失敗を再試行し、永久loopしない。

### OPS-004 Backup/restore

dev環境でD1 exportから復元し、暗号文とmetadata整合性を確認。

### OPS-005 Secret rotation

session signing、subscription encryption、R2 credentialの少なくとも一種類でrotation drill。

## 15. 負荷受け入れ

初期beta想定:

- 200 active users
- 2,000 Push/day
- 1GB upload/day
- 10 devices/user上限

測定:

- Worker CPU p95 7ms以下を目標
- dynamic request/day 70k以下を運用目標
- D1 rows written/day 70k以下
- connected notification p95 2秒以下
- reconnect stormでerror急増なし
- R2 logical usage 7GB以下

数値は実測で調整する。Cloudflareの最新limitと契約に適合すること。

## 16. リリースゲート

### Internal alpha

- AUTH/PUSH/SYNC/WSのP0 test Pass
- 未認証endpointなし
- dev Cloudflare smoke Pass

### Invite beta

- E2EE、PWA、File、ExtensionのP1 test Pass
- account deletion
- quota/degradation
- log audit
- security review

### Public registration

- capacity test
- Paid移行判断
- abuse process
- privacy/terms
- backup/restore drill
- alert/on-call手順
- incident communication template
