# Chromium extension privacy disclosure

ステータス: 公開前draft。Store入力と公開privacy policyの正本に転記する前に法務・運用reviewを行う。

## 利用目的

この拡張機能は、利用者が明示的に選んだNote、Link、現在のタブ、選択テキスト、画像URL、Fileを、同じPushbridgeアカウントの端末間で送受信するためだけにデータを処理する。

## 端末内だけに保存する情報

- non-extractable P-256端末private key
- E2EE account key
- 端末専用bearer token
- 接続端末ID、既定送信先、cursor、通知設定

private keyとaccount keyは拡張originのIndexedDB、設定とtokenは`chrome.storage.local`へ保存する。設定画面の「ローカル接続情報を削除」で削除できる。server側端末の解除は別の接続済み端末から行う。

## Pushbridge serverへ送る情報

- account/device ID、送信先、種別、時刻、暗号文size、保持期限などのrouting metadata
- E2EE暗号化済みNote/Link/File metadata
- E2EE暗号化済みFile本体
- device public keyとaccount-key envelope

Note本文、Link URL、元File名、MIME type、File平文は送信前に端末内で暗号化する。serverには暗号化Fileのopaque名`encrypted.bin`と`application/octet-stream`だけを渡す。

## ユーザー操作時だけ読む情報

- `activeTab`: toolbar buttonまたはshortcutで現在タブを送る時だけURLとtitleを読む
- `contextMenus`: 利用者が選択したpage/link/image URLまたは選択テキストだけを読む
- `file` input: 利用者が明示的に選んだFileだけを読む

常駐content script、閲覧履歴API、clipboard APIは使わない。

## 第三者提供と収益化

広告、tracking、analytics、データ販売、信用評価には使用しない。CloudflareはPushbridge serverの実行基盤として暗号文とrouting metadataを処理する。法令対応を除き、別目的で第三者へ共有しない。

## 保持と削除

- 暗号化File本体: 利用者が選択した1日、7日、30日
- 軽量alias: 既定180日
- tombstone: alias失効後7日
- 端末内鍵/token: 利用者がローカル接続情報を削除するまで

容量逼迫時は暗号化File本体が保持期限前に削除される場合がある。server側account deletion、正式な問い合わせ窓口、公開privacy policy URLは公開前に確定する。
