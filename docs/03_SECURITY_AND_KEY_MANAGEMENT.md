# セキュリティ・鍵管理計画

状態: 実装前のセキュリティ設計  
対象: Web/PWA、Chromium拡張機能、Cloudflare Worker/D1/R2/Durable Objects

## 1. セキュリティ目標

- 他ユーザーのPush、端末、ファイル、鍵包へアクセスできない。
- 失効した端末はREST、WebSocket、Web Push、R2 downloadの全経路から直ちに排除される。
- D1/R2の漏えいだけではPush本文、URL、ファイル名、ファイル内容を復号できない。
- Worker log、Terraform State、CI logから機密コンテンツが漏れない。
- WebSocket欠落や重複、API再試行によってデータ損失・重複作成が起きない。
- R2署名URLが漏れても、影響を短寿命かつ暗号化済みobjectに限定する。
- 拡張機能は最小権限とし、閲覧履歴や全ページ内容を常時収集しない。

## 2. 非目標・残余リスク

- 端末自体がマルウェアに侵害された場合の平文保護は保証しない。
- E2EE後はサーバー側マルウェアscan、全文検索、平文moderationを行えない。
- 全端末と復旧キーを失った利用者の暗号文は復旧できない設計を基本とする。
- ブラウザPush serviceはendpoint metadataを処理する。payloadの最小化で影響を抑える。
- Web/PWAだけではOS全体の通知ミラーや自動clipboard同期を安全かつ同等には再現しない。

## 3. 脅威モデル

主要な攻撃者:

1. 未認証の外部利用者
2. 正規アカウントを持つ悪意ある利用者
3. 失効済み端末を保持する者
4. 署名URLやsession tokenを一時的に取得した者
5. XSSまたは悪意ある拡張機能依存関係
6. Cloudflare設定・Terraform State・CI secretへアクセスした内部者
7. D1/R2 snapshotのみを取得した攻撃者

主要な攻撃面:

- Passkey challenge replay
- device-link code interception
- session fixation/CSRF
- IDOR
- WebSocket ticket replay
- R2 key traversalや任意key署名
- signed URL reuse
- webhook/API token abuse
- file content sniffing
- service worker supply-chain compromise
- extension permission overreach
- log/telemetry leakage

## 4. 認証

### 4.1 Passkey

WebAuthn/Passkeyを第一認証とする。

- RP IDと許可Originを環境ごとに固定
- challengeは128bit以上の予測困難値
- 有効期間5分以下
- 一回限り消費
- ceremony type、user、origin、RP IDへbinding
- user verificationを要求する方針を本番ADRで固定
- credential ID、public key、sign count、transports、backup eligibility/stateを保存
- registration/login完了後にchallengeを原子的に消費

初回登録、復旧、招待受諾にはTurnstileとIP/user-agent rate limitを追加する。Turnstile成功だけを認証とみなさない。

### 4.2 Session

Web/PWA:

- Cookie: `HttpOnly; Secure; SameSite=Lax`を基本
- session tokenは256bit以上のランダム値
- D1にはhashだけを保存
- idle/absolute expiryを分けることを推奨
- login、権限昇格、端末変更時にrotate
- logoutとdevice revokeで即時無効化
- state-changing requestでOrigin検証とCSRF token

拡張機能:

- 端末専用bearer token
- scopeは最小限
- token hashだけをD1へ保存
- 端末失効時にtokenも失効
- browser storageでは可能な範囲でアクセスを限定し、ログやURLへ出さない

## 5. 端末リンク

拡張機能はPKCE付きauthorization code方式を使う。

- 拡張機能がP-256 device key pairとPKCE verifier/challengeを生成
- Webの既存sessionで新端末を明示承認
- authorization codeは5分以下、一回限り
- codeはdevice public key、PKCE challenge、user、requested scopesへbinding
- exchange後にcodeを原子的に消費
- tokenをURL fragment/queryへ長期間残さない
- 承認画面に端末種別、要求scope、生成時刻を表示

## 6. 認可

すべてのDB queryは認証済み`user_id`をwhere条件に含める。リソースIDだけでqueryしない。

例:

```sql
SELECT *
FROM pushes
WHERE id = ? AND user_id = ?;
```

追加規則:

- `source_device_id`は認証端末と一致
- target deviceは同一userかつ`revoked_at IS NULL`
- Fileは同一user、`state='ready'`、`expires_at > now`
- Web Push subscriptionは現在端末にのみ登録・削除可能
- 管理操作は再認証を要求する
- API tokenはscopeを毎request確認

端末失効時は`session generation`または`device.updated_at/revoked_at`をticket/token検証へ反映し、長寿命cacheによる遅延を避ける。

## 7. WebSocket

- `/realtime`は短寿命ticket必須
- ticketは30秒以下、一回限り
- user/device/protocol/session generationへbinding
- URL queryへ載せず、WebSocket subprotocol `pushbridge-ticket.<ticket>`で一度だけ送る
- originを検証
- DO内で接続にdevice metadataをattachmentとして保持
- 1 deviceあたりの同時接続数、1 userあたり上限を設ける
- message size上限
- JSON schema検証
- write operationを受け付けない
- backpressure監視
- device revoke時に該当socketを切断
- ping payloadをログしない

WebSocketは通知経路であり、権威ある履歴ではない。再接続後は必ずD1 cursor syncを行う。

## 8. E2EE鍵階層

### 8.1 Device key

各端末でP-256 ECDH key pairを生成する。private keyは端末外へ平文で出さない。Web Cryptoで`extractable: false`が利用可能な保存方式を優先するが、復旧・browser storage制約とのトレードオフをADRに記録する。

D1 `devices.public_key`には公開鍵のみ保存する。

### 8.2 Account key

初回端末がランダム256bitの`K_account`を生成する。

- サーバーは平文`K_account`を保存しない
- 各device public keyとのECDH shared secretからKEKをHKDFで導出
- AES-GCMまたはAES-KWで`K_account`をwrap
- `device_key_envelopes`へ`algorithm`、`key_version`、`wrapped_key`を保存
- 新端末追加時、既存の承認済み端末が新しいenvelopeを生成

推奨context string:

```text
relaypush/device-key-envelope/v1
```

### 8.3 Recovery key

復旧キーは高エントロピーのランダム値を人間が保管可能な形式へ変換する。選択肢:

- 24語前後のrecovery phrase
- QRとprintable code
- password manager向けbase64url

復旧キーから直接`K_account`を暗号化するか、復旧用KEKを導出する。低エントロピーpasswordだけに依存しない。運営者は復旧キーを保持しない。

### 8.4 Push encryption

Pushごとに鍵を導出する。

```text
K_push = HKDF-SHA-256(
  IKM  = K_account,
  salt = push_id bytes,
  info = "relaypush/push-payload/v1"
)
```

AES-256-GCMを使用する。nonceは96bitランダムまたは安全なcounter方式。ランダム方式では衝突確率を考慮し、同じ`K_push`で複数回暗号化しない設計が最も単純。

AAD候補:

```json
{
  "push_id": "push_...",
  "user_id": "usr_...",
  "type": "note",
  "payload_version": 1
}
```

暗号化payloadにtitle、body、URL、file name、MIME、file keyを含める。

### 8.5 File encryption

MVP:

- fileごとにランダム256bit`K_file`
- file全体をAES-GCMで暗号化
- 25MB上限
- ciphertext hashを計算
- `K_file`とfile metadataをPush payload内へ入れて`K_push`で保護

大容量版:

- 5MiB程度のchunk
- chunkごとに一意nonce
- AADにfile ID、chunk index、total chunks、plain size
- R2 Multipart Upload
- manifestを暗号化payload内で保護

nonce reuseを絶対に避ける。暗号実装は独自primitiveを作らずWeb Cryptoを利用し、既知vectorとcross-browser testを追加する。

## 9. サーバー側秘密

| Secret | 用途 | 保管 |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | Terraform/CI | CI secret、ローカルenv |
| `SESSION_SIGNING_KEY` | cookie/cursor/ticket署名候補 | Worker secret/Secrets Store |
| `DEVICE_LINK_SECRET` | link code署名候補 | Worker secret |
| `VAPID_PRIVATE_KEY` | Web Push | Worker secret |
| `R2_ACCESS_KEY_ID` | presigned URL | Worker secret |
| `R2_SECRET_ACCESS_KEY` | presigned URL | Worker secret |
| Turnstile secret | Siteverify | Terraform binding、State保護 |
| subscription encryption key | Web Push endpoint暗号化 | Worker secret、versioned |

本番ではsecretをTerraform変数に入れるとStateへ残る。可能ならCloudflare Secrets Storeや別のsecret injectionを検討し、Terraformがsecret valueを管理する場合はState backendを厳格に保護する。

## 10. Web Push subscription保護

Web Push endpointは送信に必要なのでE2EEでサーバーから不可視にはできない。代わりにapplication-level encryption at restを使う。

- versioned server encryption key
- AES-GCM
- row ID/device IDをAADへ含める
- endpoint、p256dh、authを暗号化保存
- plaintextをlogしない
- 404/410 responseでsubscription revoke
- key rotationは旧versionをread、新versionでwriteし、background re-encrypt

## 11. R2と署名URL

- R2 bucketはprivate
- object keyは`ttl/<class>/<user-hash>/<random-id>`
- user入力をkey pathへ連結しない
- PUT有効期間1〜2分
- GET有効期間約60秒
- signed URLはbearer tokenとして扱う
- upload完了時にsize/stateを検証
- D1 expiry後は署名しない
- deleteはWorker/Queueから実行
- CORSは正確なOrigin
- `Content-Type: application/octet-stream`
- fileはinline表示しない

signed URLの再利用を完全に防げない方式では、短寿命、暗号化済みobject、ランダムkey、論理期限でリスクを限定する。

## 12. XSSとWeb security

- CSP: `default-src 'self'`
- inline script禁止
- Trusted Types導入を検討
- DOMへ暗号化前payloadを挿入するときはtext nodeを使用
- URL open前にschemeをallowlist (`https`, 必要なら`http`)
- `javascript:`, `data:`などを拒否
- HTML previewを生成しない
- Service Workerのcache poisoning対策
- dependency lockfileと更新監査
- source mapの公開方針を決める
- account keyを不要に長時間JavaScript heapへ保持しない

## 13. 拡張機能security

- Manifest V3
- remote code禁止
- CSPを厳格化
- `<all_urls>`を要求しない
- `activeTab`を利用
- optional `clipboardRead`
- content scriptは必要な操作時だけ
- extension pageとcontent script間messageをschema検証
- sender ID/tab/originを確認
- tokenをpage contextへ注入しない
- notification clickで開くURLを検証
- browser store審査用の権限理由を文書化

## 14. Abuse対策

- 招待制ベータ
- registration/recoveryでTurnstile
- IP、account、device単位rate limit
- 1 account 10 devices
- 200 Push/day/account
- 100MB upload/day/account
- 25MB/file
- Web Push subscription数上限
- suspicious device-link attemptsでcooldown
- API token scopeとexpiry
- Channels公開時は別quotaとmoderation方針

E2EE環境では内容moderationが難しいため、MVPを自分の端末間に限定すること自体が重要なabuse controlになる。

## 15. ログ方針

許可:

```text
request_id
route template
HTTP status
worker CPU time
D1 rows read/written
latency
匿名化user/device identifier
error class
quota/degradation state
```

禁止:

```text
Push title/body
URL
file name
file contents
cipher key/recovery key
session/token
Web Push endpoint
signed R2 URL
full authorization header
WebAuthn attestation objectの無制限dump
```

IDは運用上必要なら日次salt付きhashで匿名化する。query string全体をlogしない。WebSocket ticketはURLへ含めず、subprotocol headerも記録しない。

## 16. Secret rotation

- secretにversionを持たせる
- verify/decryptはcurrentとpreviousを許容
- sign/encryptはcurrentだけ
- staged rollout後にpreviousを廃止
- session signing key rotation時は全session失効の可否を判断
- VAPID key rotationはsubscription再登録が必要になり得るため運用手順を用意
- R2 access keyは二組を重ねてrotate
- Terraform/CI tokenは最小権限と定期rotation

## 17. Account削除

削除request後に:

1. accountを`deleting`状態へ
2. 新規session/Push/Fileを拒否
3. 全device/session/token/subscriptionを失効
4. WebSocket切断
5. R2 objectsを列挙・削除
6. D1 metadataを削除または法的保持方針に従う
7. job失敗を再試行
8. 完了証跡には件数だけを残し、内容を残さない

即時の論理アクセス停止と、最終的な物理削除を分ける。

## 18. セキュリティテスト最低項目

- IDOR全endpoint
- revoked device/token/session
- CSRF/Origin
- challenge/code/ticket replay
- idempotency conflict
- cursor tampering
- R2 key substitution
- expired signed URL
- file size mismatch
- ciphertext/nonce version validation
- WebSocket cross-user fan-out
- WebSocket message flood/backpressure
- XSS payload in decrypted title/body/file name
- malicious URL scheme
- SVG/HTML download handling
- extension message spoofing
- logsにsecret/contentがないこと
- account deletion partial failure

## 19. 要レビュー事項

暗号方式は一般的primitiveを用いた実装案だが、公開ベータ前に少なくとも次を独立レビューする。

- device envelopeのECDH/HKDF/AES方式
- recovery key UXとentropy
- nonce生成
- key version migration
- cross-browser Web Crypto互換
- XSS時のkey exposure
- Web Push endpoint encryption
- session/cursor/ticket署名分離
