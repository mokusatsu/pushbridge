# Pushbridge Chromium extension

Manifest V3のdev向け技術検証です。現在のタブ、ページ／リンク／画像URL、選択テキスト、Note、Linkを端末間でE2EE送信できます。端末リンクにはPWAが発行する一回限りtokenを使い、P-256端末鍵でaccount key envelopeを受け取ります。

## 検証とパッケージ

リポジトリルートで実行します。

```console
npm run extension:check
npm run extension:e2e:local
npm run extension:package
```

`extension:check`はbuild、型検査、単体試験、実Chromiumへのunpacked loadを行います。`extension:e2e:local`は専用の一時D1/Wrangler環境でdevice-link、E2EE鍵配送、暗号化Note/Link、送信先指定、別端末での復号まで確認します。`extension:package`は`.runtime/`に再現可能なzipを生成します。

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

## 現在の範囲

Note/Link、current tab、context menu、device selector、keyboard shortcut、device-link、E2EEまでは実装済みです。File送信、受信一覧の完全同期、WebSocket realtime、PWAとの通知担当調停、Store提出用privacy metadataは未実装です。

実Web Pushは一時Chromium/Edge profileでService Workerと通知permissionまでは成立しましたが、`PushManager.subscribe()`が`AbortError: Registration failed - permission denied`となりました。実配送とPWA終了中のIndexedDB保存は、通常の永続browser profileで別途実測が必要です。
