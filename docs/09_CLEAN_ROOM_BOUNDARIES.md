# クリーンルーム調査・実装境界

## 1. 目的

Pushbulletに近い機能を再実装する際、公開された外形仕様と一般的な製品要求から独自実装を行い、非公開コード、ブランド資産、認証回避、サービス偽装を避ける。

これは法律意見ではない。公開前には提供地域と実際の調査方法に応じて法務確認する。

## 2. 許容する情報源

- 公開API documentation
- 公開help/support pages
- 公開marketing pages
- 公開privacy/terms
- 自分が正当に利用できるaccountでの通常操作
- browser developer toolsで自分のrequestを観察する場合も、利用規約と法令の範囲内で低頻度に限定
- 一般公開されたprotocol/standards
- 独自に作成したuser storyとacceptance test

## 3. 調査担当の成果

実装者へ渡すのは中立的な機能仕様にする。

例:

- Pushはnote/link/fileの型を持つ
- 特定deviceまたは全deviceを宛先にできる
- 同じclient-generated IDの再送で重複しない
- dismiss/deleteが他deviceへ同期される
- connection loss後に差分同期で回復できる
- file uploadとPush作成は分離できる

固有の非公開実装、内部variable名、copyしたsourceは渡さない。

## 4. 禁止する行為

- 非公開source codeの取得・使用
- 難読化bundleの復号やdeobfuscationを目的とした解析
- 未公開source mapの探索・利用
- authentication、rate limit、paywallの回避
- 他人のaccount/token/dataへのaccess
- 通常利用を超える大量自動request
- vulnerability exploitation
- Pushbulletのlogo、icon、name、固有UI copy、文言の流用
- Pushbullet公式endpointを装うこと
- Pushbullet tokenをRelayPushの認証情報として恒常利用すること
- 「公式」「互換公式client」と誤認させる表示

## 5. 独自化する項目

- service名とbrand
- domain
- API pathとversion
- ID prefix/format
- payload envelope
- UI layout、copy、icon
- auth/session
- data model
- encryption
- limits/pricing
- extension store listing

## 6. Pushbullet importを後で作る場合

ベストエフォートの利用者主導移行に限定する。

- 利用者自身が旧access tokenを入力
- tokenはclient memory内だけで扱う
- serverへ送らない
- browser extensionのoptional host permissionを移行時だけ要求
- rate limitと利用規約に従う
- Note/Linkを優先
- Fileは取得可能かつRelayPush上限内だけ再暗号化・再upload
- tokenを保存しない
- 移行完了後にpermission解除を案内
- 旧serviceへwrite/deleteしない
- 失敗項目を透明にreport

公開APIが廃止・制限された場合は、利用者がexportした標準fileからのimportへ切り替える。

## 7. 互換性表現

許容しやすい表現:

- 「端末間でリンク、テキスト、短期ファイルを送信」
- 「Pushbulletの代替を探す利用者向け」
- 比較表で客観的に差異を説明

避ける表現:

- 「Pushbullet公式後継」
- 「Pushbullet API完全互換」実態がない場合
- logoやtrade dressを似せる
- official partnerを示唆

## 8. Acceptance specの管理

調査記録と実装repoを分離する必要がある場合、次の二層にする。

1. Research notes: access制限、source attribution、法務review
2. Neutral specification: 実装者が利用可能

このパッケージはNeutral specification側を意図している。

## 9. 公開前checklist

- name/logo/domainのtrademark確認
- extension store metadataの誤認防止
- terms/privacy/data retention
- third-party licenses
- Pushbulletへのimport機能の利用規約確認
- API documentationの引用量とattribution
- security contactとtakedown process
- 利用者データ削除手順
