# Pushbridge — 暗号化された端末間共有

ステータス: 公開前draft

## 短い説明

現在のページ、Note、Link、短期Fileを、自分のPushbridge端末へE2EE送信します。

## 詳細

Pushbridge Chromium拡張は、Webページを離れずに自分の端末へ情報を送るためのクライアントです。

- 現在のタブ、リンク、画像URL、選択テキストをcontext menuから送信
- Note、Link、Fileを任意の接続済み端末へ送信
- P-256端末鍵とAES-256-GCMによるend-to-end encryption
- File名、MIME type、本文、URL、File本体を送信前に暗号化
- one-time WebSocket ticketとREST cursor同期による受信通知
- `<all_urls>`、閲覧履歴、clipboard、常駐content script、広告SDKなし

利用には、自分で管理するPushbridgeアカウントと、PWAから発行した一回限りdevice-link tokenが必要です。

PushbridgeはPushbulletその他の第三者サービスの公式client、後継製品、提携製品ではありません。

## Category

Productivity

## 審査前に確定が必要な項目

- 公開privacy policy URL
- support/security contact
- Custom Domain
- Store上のdeveloper名
- account deletion案内URL
