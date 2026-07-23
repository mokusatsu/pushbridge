# Pushbridge Chromium extension

Manifest V3のdev向け技術検証です。現在のタブ、ページ／リンク／画像URL、選択テキスト、Note、Link、Fileを端末間でE2EE送信できます。端末リンクにはPWAが発行する一回限りtokenを使い、P-256端末鍵でaccount key envelopeを受け取ります。受信変更はone-time WebSocket ticketでtickleを受け、REST cursor同期で欠落回復します。

## 検証とパッケージ

リポジトリルートで実行します。

```console
npm run extension:check
npm run extension:e2e:local
npm run extension:package
npm run extension:store:evidence
```

`extension:check`はbuild、型検査、単体試験、実Chromiumへのunpacked loadを行います。`extension:e2e:local`は専用の一時D1/Wrangler環境でdevice-link、E2EE鍵配送、暗号化Note/Link/File、private R2 byte、送信先指定、one-time WebSocket、cursor同期、受信通知、別端末での復号まで確認します。`PUSHBRIDGE_EXTENSION_E2E_ORIGIN`とCloudflare Access service-token環境変数を設定した`npm run extension:e2e:remote`は、同じ縦切りをdev D1/R2/DOへ実行します。テスト用Push、File、端末、bootstrapアカウントは終了時にaccount deletion jobで回収します。`extension:package`は`.runtime/`に再現可能なzipを生成します。`extension:store:evidence`は未接続状態の実Chromium extension pageを1280x800で3枚撮影し、account dataを含まないStore候補画像を更新します。

手動確認では、`npm run extension:build`後にChromiumの拡張機能管理画面から`apps/chromium-extension/dist`を「パッケージ化されていない拡張機能」として読み込みます。dev APIを利用するには、同じブラウザーprofileでCloudflare Accessへログイン済みである必要があります。

## 権限と保存境界

- `activeTab`: ユーザー操作時だけ現在ページのURLとタイトルを読む
- `contextMenus`: ページ、リンク、選択テキスト、画像URLを送る
- `storage`: 端末ID、送信先、bearer tokenを当該Chrome profileへ保存する
- `notifications`: ショートカット／context menu送信の結果を表示する
- `alarms`: 未着のE2EE account-key envelopeを低頻度で再確認する
- host permission: build対象のdev WorkerまたはローカルE2E originだけ

`<all_urls>`、閲覧履歴、clipboard、常駐content script、remote codeは使いません。非extractableの端末private keyとaccount keyは拡張機能originのIndexedDBに保存します。これはブラウザーprofileを端末のセキュリティ境界とする設計であり、OSの侵害やChrome profileへの不正アクセスを防ぐものではありません。

設定画面の「ローカル接続情報を削除」はprofile内のtokenと鍵だけを消します。現在端末は自身をserverから解除できないAPI制約があるため、server側の端末は別の接続済み端末から解除してください。

## RealtimeとFile

WebSocket ticketはURL queryへ載せず、`pushbridge-ticket.*` subprotocolで一回だけ消費します。20秒heartbeat、指数backoff、1分alarm復旧を使い、tickleは書き込みではなくcursor同期のきっかけに限定します。同期中に複数tickleが届いてもdirty flagで追加drainし、通知IDはPush IDに固定して重複を避けます。設定画面でこの拡張機能の受信通知を切り替えられるため、PWAを通知担当にする場合はオフにできます。

Fileは拡張page内でPWAと同じ`PBFE` AES-256-GCM containerへ暗号化し、serverには`encrypted.bin`、`application/octet-stream`、暗号文sizeだけを渡します。ファイル名、MIME type、メモは暗号化Push metadataに含め、private R2の一回限りserver-ticket経路でuploadします。暗号化後の上限は25 MiBです。

Store提出用privacy disclosure、日文listing、permission rationale、候補画像はdraft済みです。公開ストア提出と受信Fileの拡張内保存UIは未実装です。2026-07-23に公開devへ対するremote extension E2Eも合格しています。

実Web Pushは一時Chromium/Edge profileでService Workerと通知permissionまでは成立しましたが、`PushManager.subscribe()`が`AbortError: Registration failed - permission denied`となりました。実配送とPWA終了中のIndexedDB保存は、通常の永続browser profileで別途実測が必要です。
