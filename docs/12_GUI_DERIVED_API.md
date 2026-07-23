# GUI起点の情報設計とAPI逆算

更新日: 2026-07-21

## 1. 設計原則

利用者が最初に判断するのは、サーバー上の内部状態ではなく「この端末で今できること」である。タイムラインでは次の5分類を第一階層とする。

| 分類 | 判定 | 主な用途 |
| --- | --- | --- |
| 受信 | 現在端末宛かつ現在端末からの送信ではない | 通常の受信箱 |
| 送信済み | `source_device_id`が現在端末 | 送信結果の確認 |
| 保存済み | 端末内Blobあり、またはpin済み | オフライン利用と保護対象の確認 |
| 要確認 | 現在端末宛のファイルが未保存のまま本体削除 | 取りこぼしの説明 |
| すべて | IndexedDBに残る全履歴 | 監査と復旧 |

種類（Note／Link／File）は第二階層のフィルターとする。分類と種類を同じタブ列へ混在させない。

## 2. ファイル状態の表示

`file.state`をそのまま表示せず、サーバー状態と端末状態を合成する。

| サーバー本体 | 端末内Blob | 表示 | 操作 |
| --- | --- | --- | --- |
| ready | なし | サーバーから取得可能 | 保存 |
| ready | あり | この端末に保存済み | 端末から保存 |
| deleted／expired | あり | この端末に保存済み | 端末から保存 |
| deleted／expired | なし | この端末では取得不可 | 無効 |
| pending／uploaded | なし | 配信準備中 | 無効 |

「同期できず削除された」は`is_for_current_device != false`、端末内Blobなし、かつ`local_file_delivery=missed`または本体状態が`deleted/expired`のときだけ表示する。他端末宛ファイルには表示しない。

## 3. GUIから逆算したREST契約

### 3.1 端末内で導出できるもの

次は既存Push応答から決定できるため、専用APIを追加しない。

- 受信／送信分類: `source_device_id`、`is_for_current_device`、現在端末ID
- 保存済み: IndexedDB Blobの有無、`pinned`
- 要確認: `file_ref.state`とIndexedDB Blobの有無
- 検索: 端末内に保存済みのtitle、body、URL、ファイル名

### 3.2 サーバーから取得すべきもの

容量逼迫度は端末内データだけでは決定できないため、以下を追加した。

```http
GET /v1/storage/usage
Authorization: Bearer <device-token>
```

```json
{
  "used_bytes": 0,
  "reserved_bytes": 0,
  "quota_bytes": 8589934592,
  "reclaimable_bytes": 0,
  "pressure": "normal",
  "policy_id": "free-v1",
  "default_retention_days": 30,
  "early_eviction_possible": true
}
```

`pressure`は`normal`、`notice`、`constrained`、`emergency`の4段階とする。GUIは容量をCloudflareの請求値ではなく、このサービスの運用予算に対する値として表示する。

## 4. Worker PoCの対応範囲

Miniflare上のWorkerは次を実装済みである。

- CapabilitiesとWeb Push設定
- Bootstrapと端末Bearer Token
- 現在端末、端末一覧、追加端末リンク、名称変更、解除
- Note／Link作成、冪等再送、一覧／カーソル同期
- pin、dismiss、削除
- ストレージ使用量

ファイルupload、private R2本体管理、Web Push配送、WebSocket realtimeはWorkerへ実装し、dev実測済みである。File転送はWorker bindingの短寿命server-ticket方式なので、Capabilitiesは`direct_upload=false`を維持する。`web_push_delivery=true`は実Edgeのclosed-PWA配送とIndexedDB commit後ACKまで確認したdevだけで公開する。

## 5. 次にAPIへ追加すべき状態

ファイル配送へ進むときは、Push単位ではなく「ファイル×宛先端末」の配送状態が必要になる。

```text
pending -> notified -> fetching -> cached
                    -> failed_retryable
                    -> missed
```

この状態はサーバーがWeb Push送出成功だけで`cached`にしてはならない。Service WorkerがIndexedDBへのcommit後に受領確認を返す設計とする。確認がないまま本体が削除された端末だけを`missed`にできるため、「同期できず削除された」の意味が端末間で一貫する。
