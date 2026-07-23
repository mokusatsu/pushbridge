# Chrome Web Store submission checklist

## 自動検証済み

- [x] Manifest V3
- [x] `<all_urls>`なし
- [x] remote codeなし
- [x] content scriptなし
- [x] build対象単一originだけをhost permission/CSPへ生成
- [x] typecheck、unit test、unpacked Chromium load
- [x] local Wrangler/D1/R2/DO E2E
- [x] dev D1/private R2/DO remote E2E
- [x] E2EE Note/Link/Fileとpeer復号
- [x] one-time WebSocket ticket、cursor同期、通知toggle
- [x] deterministic zip
- [x] env.txt値をsource/packageへ含めない

## 公開前に人が確定する

- [ ] 公開privacy policy URL
- [ ] support/security contact
- [ ] developer identity
- [ ] Custom Domainとproduction API origin
- [ ] account deletion手順
- [ ] privacy practices questionnaire
- [ ] data retentionとCloudflare subprocessorsの最終review
- [ ] 商標、名称、icon、listing文面review
- [ ] 自動生成した未接続popup/File/optionsの実スクリーンショットから最終選定
- [ ] production buildのzip hash記録

公開前項目が未完了のため、現在のzipをStoreへ提出しない。
