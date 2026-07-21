# 決定事項・未決事項

## 1. 既に固定する決定

| ID | 決定 | 理由 |
|---|---|---|
| D-001 | 対象はWeb、PWA、ブラウザ拡張機能 | ネイティブOS権限が必要な機能を切り離す |
| D-002 | MVPは自分の端末間送信 | abuse、fan-out、鍵配布、費用を抑える |
| D-003 | D1が永続データの正本 | WebSocket欠落から回復可能にする |
| D-004 | WebSocketはtickle中心 | 接続を唯一の配送経路にしない |
| D-005 | 書き込みはREST | 認可、冪等性、監査を一本化 |
| D-006 | FileはR2 direct transfer | Worker CPU/memory/帯域を抑える |
| D-007 | D-015により廃止 | 24時間案から最大30日へ変更 |
| D-008 | QueueはMVP通常配送に使わない | 無料operations消費を抑える |
| D-009 | Chromium拡張を先行 | Manifest V3と対象利用者の広さ |
| D-010 | クリップボードは明示操作 | browser permissionとprivacy |
| D-011 | IaCはTerraformを正本 | driftと再現性 |
| D-012 | 現Workerは安全なbootstrap | 未認証service公開を避ける |
| D-013 | E2EEを公開beta前の要件とする | server/storage漏えいの影響を抑える |
| D-014 | 無料枠逼迫時はFileから縮退 | Note/Linkを中核機能として維持 |
| D-015 | File標準TTLは最大30日、容量逼迫時は早期削除 | 専用Cloudflareアカウントの無料枠を使い、端末内永続化で体験を補完する |

## 2. 開発開始時にADRで決める事項

### OQ-001 リポジトリ構成

候補:

- 単一repoにIaC、Worker、Web、Extension、shared crypto
- IaCをsubdirectoryとして維持

推奨: 単一repo。API typesとcrypto payloadを共有し、version mismatchを減らす。

### OQ-002 Workerのframework

候補:

- 素のTypeScript router
- Hono等の軽量framework

評価:

- bundle size
- Cloudflare runtime compatibility
- schema validation
- testability
- middlewareの透明性

重いframeworkやNode専用dependencyは避ける。

### OQ-003 ID形式

候補:

- UUIDv7
- ULID
- crypto-random prefixed ID

要件:

- clientまたはserver生成
- 時系列sortとの関係
- 予測困難性
- D1 text index効率
- clock skew

### OQ-004 Timestamp表現

D1はepoch millisecondsで既に設計。APIでepoch millisecondsをそのまま使うかRFC3339にするかを固定する。client比較とJSON round-tripの単純さからepoch millisecondsが有力。

### OQ-005 Cursor token方式

候補:

- base64url JSON + HMAC
- authenticated encryption token
- opaque server-side cursor record

推奨: stateless signed token。user/sessionへbindし、key versionを含める。

### OQ-006 WebSocket ticketのone-time保証

候補:

- D1 challenge row
- UserHub DO storage
- short-lived KV（現在IaCに未導入）
- signed token + session generationのみで厳密one-timeを諦める

推奨: UserHubまたはD1でJTI consumeを管理。追加request/writeの測定後に決定。

### OQ-007 Passkey user discovery

候補:

- discoverable credential中心でusername入力なし
- handle入力後allowCredentials

privacyとUXを比較する。`users.handle`が現在必須uniqueなので、handleの用途と公開範囲を決める。

### OQ-008 Account recovery

候補:

- recovery keyのみ
- recovery key + 複数Passkey
- email magic linkはaccount accessだけ復旧し、E2EE keyは復旧しない

低コストとsecurityから、複数Passkey + recovery keyを推奨。メール送信基盤をMVP必須にしない。

### OQ-009 `target_device_id`の意味

二つのモデルがある。

1. 通知先だけ特定し、同一accountの全承認deviceが履歴を復号可能
2. cryptographic recipientも特定し、対象deviceだけ復号可能

MVP推奨は1。account key一つで単純。2はdevice-specific key wrappingと履歴UXを複雑化する。

### OQ-010 E2EE key wrapping

ECDH + HKDF + AES-GCM/AES-KWの詳細、public key encoding、AAD、version migrationをsecurity review前にADR化する。

### OQ-011 Recovery key format

- word list
- base58/base64url
- QR
- print PDFの有無

entropy、入力ミス検出、localization、browser password managerとの相性を比較する。

### OQ-012 Web Push送信実装

Cloudflare Workers runtimeでのWeb Push暗号化とVAPID署名について:

- dependencyのruntime compatibility
- CPU 10ms内の実測
- notificationごとのrequest数
- Queue再試行

CPUが厳しい場合はPaid移行または外部push送信componentを検討するが、最初はWorkers内で小規模測定する。

### OQ-013 Web Push endpoint暗号化鍵

server-side encryption keyの保管先:

- Worker secret
- Cloudflare Secrets Store
- external KMS

MVPはversioned Worker secret候補。本番State/rotation要件で再評価。

### OQ-014 R2 presign方式

既存IaCはR2 API credentialを作らない。選択肢:

- S3-compatible presigned URLをWorkerで生成
- Worker bindingでuploadをproxy（小容量devのみ）
- 専用upload service

本番はpresigned URLを推奨。credential作成とrotationを手動runbookまたは別管理IaCにする。

### OQ-015 File hash

- ciphertext SHA-256: transport/integrity確認
- plaintext SHA-256: client-side重複・検証に便利だがcontent fingerprint leakageの可能性

推奨: serverにはciphertext hashのみ。plaintext hashが必要なら暗号化payload内に置く。

### OQ-016 File retention options

IaCは1d/3d/7d prefixを用意している。製品MVPで1dのみ公開するか、10MB以下で3dを許可するかをusage test後に決める。7dはadmin/paid向け候補。

### OQ-017 Pin保持期間

pinを無期限にするとD1 storageが増える。候補:

- 365日上限
- 件数上限
- paid feature
- local-only archive

MVPは100件/account、365日を候補。

### OQ-018 Search

E2EEのためserver全文検索は不可。IndexedDB local indexを採用する。複数端末でindexは各端末再構築。cache wipe/retentionを決める。

### OQ-019 Notification ownership

同じbrowserでPWAとExtensionが二重通知し得る。device設定に`notification_owner`を追加するか、subscription登録時に片方をrevokeするかを決める。

### OQ-020 Observability stack

- Cloudflare native observability
- Analytics Engine
- 外部Sentry等

privacy、費用、source map、data residencyを比較。MVPはnative + structured logs候補。

### OQ-021 Admin surface

不正利用とquota操作用admin UI/APIをどこまで作るか。最初はread-only metricsとmanual config bindingでもよいが、account suspension、degradation override、deletion retryは安全な管理経路が必要。

### OQ-022 Data residency

D1/R2のlocation/jurisdictionはTerraform変数化済み。対象利用者地域、法的要件、latencyからprod値を決める。既存bucket/databaseのjurisdiction変更はreplace/data migrationリスクがある。

### OQ-023 Domain/RP ID

Passkeyを導入するとdomain変更がcredentialに影響する。公開前に長期利用するRP IDを固定する。`workers.dev`を本番RP IDにしないことを推奨。

### OQ-024 Terraform secret管理

`worker_secrets`はStateへ入る。Cloudflare Secrets Store連携、別secret deployment step、Terraform管理のどれを採用するか決める。少なくともprod Stateのaccess controlとauditは必須。

### OQ-025 R2 CORS/Lifecycle destroy warning

Provider更新で解消したかを再確認し、解消していなければdestroy runbookとCI guardを維持する。

### OQ-026 FreeからPaidへの移行条件

既存案は60%を3日連続、public registration、SLO保証。事業上のbudgetとsupport方針に合わせ最終承認者を決める。

### OQ-027 Terms/privacy/abuse

招待制でもprivacy notice、data retention、account deletion、prohibited use、law enforcement responseの最低文書が必要。公開前に法務確認する。

## 3. MVP後まで保留する事項

- Contacts discovery
- user間Chatの鍵管理
- Channelsのsubscriber fan-out
- Public API token UI
- OAuth consent screen
- Pushbullet import
- Firefox/Safari extension
- paid plans
- long-term file storage

## 4. Decision logの運用

各ADRに含める。

```text
Title
Status: proposed/accepted/superseded
Date
Context
Decision
Alternatives
Security impact
Cost impact
Migration/rollback
Test evidence
```

セキュリティ、暗号、Passkey RP ID、data residency、ID/cursorはコードより先にADRをacceptする。
