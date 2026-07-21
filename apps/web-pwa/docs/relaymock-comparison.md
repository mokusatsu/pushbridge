# RelayMock 0.1.1とWeb／PWA 0.3.0の照合結果

## 結論

RelayMock 0.1.1は、前回提示した必須・推奨API変更をほぼすべて取り込みました。主要APIパス、カーソル規則、冪等性、Ticket転送、エラー形式を追加変更する必要はありません。

Web／PWA側では、0.1.1で新しく必須になった`file_ref`、Capabilities、Web Push設定、Request ID、厳格なPayload v1へ対応しました。特に、旧0.2.0の厳格なZod応答Schemaは未知の`file_ref`を拒否するため、修正前のままではfile Pushを含む同期が失敗します。この互換問題は0.3.0で解消しています。

## 前回API要求の反映状況

| 前回要求 | RelayMock 0.1.1 | Web／PWA 0.3.0 |
|---|---|---|
| 冪等再送200とHeader | 実装・OpenAPI記述済み | 200／201を成功として処理 |
| 共通401／403／404／409／410／413 | 共通`ApiError`として定義 | Status、code、messageを正規化 |
| binary upload／download契約 | `application/octet-stream`記述済み | Blob PUT／GETで処理 |
| `PushCreate`条件制約 | 6種類の`oneOf` | 種類別に正確なBodyを構築 |
| date-time／uri-reference | 反映済み | 相対・絶対Ticket URLに対応 |
| 管理Header必須化 | `X-Mock-Admin`必須、Router既定無効 | 管理APIには依存しない |
| Capabilities | `/v1/system/capabilities`追加 | 上限と推奨値を動的反映 |
| Canonical Payload v1 | note／link／fileを正式Schema化 | UIモデルとの相互変換 |
| File状態同期 | `PushOut.file_ref`とカーソル再投入 | ダウンロード可否を同期更新 |
| Web Push設定 | `/v1/web-push-config`追加 | PushManagerとSubscription CRUDを結合 |
| Subscription upsert | 初回201、再登録200 | 同じ成功経路で処理 |
| Token no-store | Bootstrap／linkへ付与 | スモーク試験で検証 |
| Request ID | 全応答HeaderとAPIエラー本文 | 要求へ付与し、エラー画面へ表示 |

## Web／PWA側へ適用した追加変更

### 1. Capabilitiesを正本化

以下の固定値依存を廃止しました。

- ファイル上限
- Push Payload上限
- Push／ファイル既定TTL
- ファイルTTL候補
- 最大端末数
- 推奨ポーリング間隔
- Web Push登録可否

0.1.0 Endpointが404の場合だけ互換値へ戻ります。

### 2. `file_ref`を状態の正本として利用

`payload.file`は表示情報、`file_ref`はサーバー状態として結合します。

```text
file_ref.state = pending / uploaded -> ダウンロード不可
file_ref.state = ready              -> ダウンロード可
file_ref.state = expired / deleted  -> 期限切れまたは削除表示
```

File状態が変わるとPushがカーソルへ再投入されるため、クライアント側のファイル全件ポーリングは不要です。

### 3. 厳格なPayload v1

file送信Bodyから旧クライアント独自の`state`を除去しました。0.1.1の`additionalProperties=false`へ適合します。

```json
{
  "type": "file",
  "file_id": "fil_...",
  "payload": {
    "file": {
      "name": "document.pdf",
      "mime_type": "application/pdf",
      "size": 12345,
      "sha256": null,
      "expires_at": "2026-07-15T00:00:00Z"
    }
  }
}
```

### 4. Request ID

通常REST要求へ`req_...`を付け、APIエラーのHeaderまたは本文から同じIDを取得します。送信箱に残る最終エラーにもRequest IDが保存されるため、後からサーバーログと照合できます。

### 5. Web Push結合

ビルド済みPWAでは次を実行できます。

1. `/v1/web-push-config`取得
2. Notification権限取得
3. Service Worker登録確認
4. VAPID鍵検証
5. `PushManager.subscribe()`
6. Subscription APIへupsert
7. 一覧表示と解除

RelayMockの`delivery=false`も画面上に明示します。

### 6. 契約の自動回帰検査

`npm run check:contract`は同梱OpenAPIについて、少なくとも次を検査します。

- API version 0.1.1
- CapabilitiesとWeb Push config
- 6種類の`PushCreate oneOf`
- `PushOut.file_ref`
- binary Ticket契約
- 冪等再送200
- Token no-store Header
- Subscription 201／200
- 管理Header必須化
- 全レスポンスの`X-Request-ID`

## API側の追加必須変更

**ブロッキングな追加変更はありません。** 現在の0.1.1契約でWeb／PWAの結合実装を進められます。

## 非必須の契約強化候補

### A. VAPID公開鍵の形式制約

OpenAPI上の`vapid_public_key`は現在単なるstringです。実装値はBase64 URL形式の非圧縮P-256公開鍵（65 bytes）である必要があります。サーバーテストで実鍵の長さと先頭バイト`0x04`を検証し、OpenAPIへ説明またはpattern例を加えると誤設定を早期検出できます。

PWA側は登録時に検証し、不正値の場合はPushManagerを呼ばず明示エラーにします。

### B. 空文字だけのNote

`NotePayloadV1`はtitleまたはbodyという「プロパティの存在」を要求しますが、各文字列に`minLength`がないため、Schema上は`{"title":""}`が有効です。RelayMock実装が空文字を許可しない方針なら、titleとbodyへ`minLength: 1`を追加してください。PWAはtrim後に両方が空なら送信を止めています。

いずれも現行PWAとの結合を妨げる問題ではありません。
