# Chromium permission rationale

ステータス: 公開前draft

| Permission | 用途 | 使わない範囲 |
|---|---|---|
| `activeTab` | 利用者がtoolbar buttonまたはshortcutを操作した時だけ、現在ページのURL/titleをLinkとして送る | backgroundでの常時収集、全tab列挙、ページ本文取得 |
| `contextMenus` | page、link、image、selectionを利用者の明示操作で送る | content scriptによるページ監視 |
| `storage` | bearer token、端末ID、cursor、既定送信先、通知設定を当該Chrome profileへ保存 | sync storage、外部tracking |
| `notifications` | 送信結果と、利用者が有効にした受信Note/Link通知を表示 | 広告、marketing |
| `alarms` | MV3 service worker復帰時にE2EE envelope、REST cursor、WebSocket再接続を最大1分間隔で確認 | 高頻度tracking |
| dev Worker host | Pushbridge API、private File ticket、one-time WebSocketへ接続 | `<all_urls>`、任意host |

`host_permissions`と`connect-src`はbuild対象の単一Pushbridge originへ生成する。`<all_urls>`、`tabs`、`history`、`clipboardRead`、`clipboardWrite`、`webRequest`、`declarativeNetRequest`、native messaging、remote codeは要求しない。

File pickerはpermissionではなく標準`<input type="file">`を使い、利用者が選んだFileだけを読み取る。
