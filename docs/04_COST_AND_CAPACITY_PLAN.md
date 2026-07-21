# 費用・容量・縮退計画

料金・制限の参照日: 2026-07-13  
**本番適用前にCloudflare公式料金ページで再確認すること。**

## 1. 方針

- 無料枠を「使い切る」のではなく、70%前後から制御する。
- Static Assetsへ逃がせるrequestはWorkerへ通さない。
- D1は1 Push 1行とし、端末ごとの複製を避ける。
- FileはR2へ直接転送し、Worker CPU/memory/request bodyを消費しない。
- File TTLは最大30日を標準とし、容量逼迫時は早期削除する。詳細は`11_RETENTION_AND_LOCAL_PERSISTENCE.md`を優先する。
- Queueを通常の端末間配送へ使わない。
- 無料枠上限直前まで粘るより、一般公開時はWorkers Paidの最低料金へ早めに移行する。

## 2. 参照時点の主な無料枠スナップショット

この表は既存設計時の記録であり、契約プラン・地域・Cloudflareの変更により変わり得る。

| サービス | 記録した無料枠 | 設計への反映 |
|---|---:|---|
| Workers | 100,000 requests/day、CPU 10ms/request | APIだけをWorkerへ通す |
| Static Assets | request無料・実質無制限として設計 | SPA/PWAを静的配信 |
| D1 | 5M rows read/day、100k rows written/day、5GB | 1 Push 1行、index厳選 |
| R2 | 10GB-month、Class A 1M、Class B 10M | 最大30日、8GiB運用予算、pressure cleanup、direct transfer |
| R2 egress | freeとして設計 | bandwidthよりstorageを管理 |
| Durable Objects | 100k requests/day、13,000 GB-s/day | Hibernation、message削減 |
| Queues | 10k operations/day | 通常配送に使わない |
| Turnstile | unlimited challengesの無料枠 | registration/recoveryだけ |

公式URLは`10_REFERENCE_INDEX.md`および`cloudflare-iac/REFERENCES.md`を参照する。

## 3. 推奨する初期quota

| 項目 | 初期値 |
|---|---:|
| 1 accountのdevice数 | 10 |
| 1 accountのPush/day | 200 |
| service全体のPush/day | 5,000 soft cap |
| file size | 25MB |
| upload/account/day | 100MB |
| file標準TTL | 最大30日（best effort） |
| 選択可能TTL | 1日／7日／30日 |
| Web Push subscription | 3/accountまたは1/device |
| 同時WebSocket | 10/account、2/device |
| Push本文暗号文サイズ | 64KB以下を候補 |
| history page size | default 100、max 200 |

quota値はhard-codeせず、Worker bindingまたは設定テーブルから変更可能にする。ただし攻撃者が変更できない管理経路に限定する。

## 4. R2容量モデル

単純な平均保存量:

```text
平均保存量GB ≈ 1日あたりupload GB × 平均TTL日数
```

例:

| Upload/day | 平均TTL | 概算平均保存量 |
|---:|---:|---:|
| 0.1GB | 1日 | 0.1GB |
| 1GB | 1日 | 1GB |
| 2GB | 3日 | 6GB |
| 4GB | 3日 | 12GB、無料枠超過見込み |

無料枠10GBを仮定する場合、運用目標は7GB、warningは7GB、file制限開始は8.5GB程度とする。Lifecycle削除遅延、multipart残骸、計測遅延の余白を取る。

## 5. D1 writeモデル

1 Pushのlife cycleで発生し得るwrite:

- Push insert
- relevant index更新
- quota increment
- dismiss/pin/delete update
- tombstone cleanup
- session/device last-seen更新を同requestごとに行う場合の追加write

実際の`rows_written`はindexを含むため、論理SQL文数より多い。概算として8〜12 rows written/Pushを初期仮定にする。

```text
2,000 Push/day × 10 rows ≈ 20,000 rows written/day
5,000 Push/day × 10 rows ≈ 50,000 rows written/day
```

注意:

- `last_seen_at`を毎request更新しない。5〜15分単位でcoalesceする。
- WebSocket heartbeatごとにD1 writeしない。
- 既読をPushごとのrowで持たずdevice cursorで持つ。
- quota incrementはatomic upsertだが、必要なら時間bucketでcoalesceする。

## 6. Worker requestモデル

Note作成の代表例:

- 1 request: `POST /pushes`
- 接続中端末: DO notification
- 受信端末: tickle後に`GET /pushes?after=`

1 Pushあたり概ね2〜端末数に応じたdynamic requestsになる。Web Pushが必要なら追加送信処理が発生する。

request削減:

- WebSocketイベントにcursor hintを含め、複数変更を短時間debounce
- 受信側は100〜300ms coalesceして一回sync
- PWA起動時の重複syncを抑制
- static assetsをWorkerから切り離す
- service status/quotaを短時間client cache
- history paginationを無限pollingしない

## 7. Durable Objectモデル

`UserHub`はuser単位。

コストを抑える規則:

- WebSocket Hibernation API
- heartbeatは必要最小限
- client pingへDBアクセスしない
- DO storageへ履歴を複製しない
- eventは小さい`sync_required`中心
- 大きいciphertextを全socketへ常にfan-outしない
- browser sleep後の再接続stormにjitter
- device/account接続上限

## 8. Queue operationモデル

既存設計では、単純なmessage処理にwrite、read、delete相当で約3 operationsを想定している。無料枠10k operations/dayなら単純目安は約3,333 delivered messages/dayとなるため、通常PushをすべてQueueへ通さない。

Queueを使う条件:

- 1 eventが多数subscriberへfan-outされる
- Web Push providerの一時失敗を再試行する
- account deletionやR2 cleanupを非同期化する
- request latencyから切り離す必要がある

Queue disabledでもMVPが成立することを維持する。

## 9. サービス規模の目安

| 形態 | 仮定 | 見込み |
|---|---|---|
| 家族/小チーム | 20 users、200 Push/day、100MB upload/day | 無料枠内の可能性が高い |
| 招待制beta | 200 users、2,000 Push/day、1GB upload/day、TTL 1日 | 無料枠内を狙える |
| 一般公開初期 | 1,000 users、10,000 Push/day | request/write監視が必要、Paid推奨 |
| 大規模Channel | 数千subscriberへ即時通知 | Queue/Pushコストが支配、別tier必要 |

これは保証値ではない。device数、再接続頻度、Web Push失敗率、index、client挙動で大きく変わる。

## 10. 縮退レベル

### Level 0: Normal

- 25MB file
- 1d/3d retention
- Note/Link/File
- Web Push通常

### Level 1: Warning、70%

- 管理者通知
- 非重要metrics頻度削減
- Channel等のfan-out遅延
- 新規招待発行を抑制可能

### Level 2: Constrained、85%

- 3d/7d retention停止
- file上限5MB
- upload/dayを半減
- previewや非必須通知を停止

### Level 3: Files disabled、95%

- 新規file initを`503 degraded_mode`
- Note/Link継続
- 既存file downloadは期限内なら優先
- account操作とhistory read維持

### Level 4: Write protection、上限直前

- 新規Push write停止
- login、device revoke、account deletion、既存history readを優先
- 明確なstatus UIと`Retry-After`

## 11. 縮退判定の実装

Cloudflareのusage APIやobservabilityから直接自動判定できる範囲を確認し、少なくともapplication-level counterを持つ。

候補:

- D1 `service_usage_daily`
- Worker Analytics EngineまたはCloudflare observability
- R2 bucket usageの定期取得
- `quota_daily`集計
- manual override binding

設定例:

```json
{
  "level": 2,
  "files_enabled": true,
  "max_file_bytes": 5242880,
  "allowed_retentions": ["1d"],
  "reason": "r2_capacity"
}
```

自動判定が不確実な場合、fail-openではなく機能別に安全なdefaultを決める。例えばusage取得失敗だけで全readを止めないが、新規大容量uploadは保守的に制限する。

## 12. Paid移行のtrigger

次のいずれかでWorkers Paid移行を推奨する。

- dynamic requestsが3日連続で無料枠60%超
- D1 writesが3日連続で60%超
- Worker CPU p95が無料枠制限へ近づく
- 不特定多数へregistrationを開放
- 即時通知をSLOとして保証
- support対応が無料枠停止リスクを上回る

既存設計ではWorkers Paidの最低料金を月額5 USDとして記録しているが、本番契約前に最新料金を確認する。D1/R2/DO/Queuesの超過分は別途確認する。

## 13. 監視指標

日次:

- Worker dynamic requests
- Worker CPU p50/p95/p99
- error rate、429、503
- D1 rows read/written
- D1 storage
- R2 stored bytes、object count、Class A/B ops
- file init/complete ratio
- pending files age
- DO WebSocket connections/reconnect rate
- Web Push send/success/404/410/transient failure
- Queue ops、retry、DLQ depth
- active users/devices
- Push countとupload bytes/account

SLO候補:

- Note/Link create success 99.9%/30d（計画停止除外）
- cursor sync p95 < 1s for small delta
- connected device notification p95 < 2s
- file init p95 < 1s、upload本体はnetwork依存
- device revoke反映 < 10s、理想は即時

## 14. 費用レビュー手順

毎月またはprovider更新時:

1. Cloudflare公式料金とlimitsを確認
2. 実usageと当初モデルを比較
3. 1 Pushあたりrequest/writeを再計算
4. File TTL/size quotaを調整
5. 縮退thresholdを更新
6. Paidと他storage/providerのbreak-evenを試算
7. 文書の日付と参照リンクを更新
