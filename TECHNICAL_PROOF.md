# Client/server technical proof

Date: 2026-07-21

## GUI起点の追加検証

- PWA: 受信／送信済み／保存済み／要確認／すべての分類、全文検索、種類フィルターを実装
- PWA: 内部`file.state`ではなく、端末内Blobと合成した利用可能性表示へ変更
- RelayMock: `GET /v1/storage/usage`を追加し、認証境界を含む24テスト成功
- Client: 23テスト、TypeScript、OpenAPI契約、production build成功
- Worker: D1 migration v2、Bootstrap、端末CRUD、Note作成、冪等再送、pin、カーソル同期、容量APIをMiniflareで確認
- Worker: 未実装のファイルuploadとWeb PushはCapabilitiesで無効化
- 実ブラウザー視覚確認: Work環境のブラウザーがローカルURLを遮断したため未実施。成功扱いにはしていない

## Result

The supplied Pushbridge 0.3.0 client and RelayMock 0.1.1 server were executed together over real HTTP on loopback. The integration smoke test passed without changing the public OpenAPI contract.

Verified flow:

1. Health and request-ID propagation
2. Capability discovery and Web Push public configuration
3. Development bootstrap and device authentication
4. Web Push subscription create and idempotent upsert
5. Note creation and `Idempotency-Key` replay
6. Incremental cursor synchronization
7. Binary file initialization, direct PUT, completion and direct GET
8. File Push creation with `file_ref.state=ready`
9. Pin transition
10. File deletion re-emitted through cursor sync as `file_ref.state=deleted`
11. Test-data cleanup

Server unit tests: 24 passed. A dependency-level Starlette deprecation warning was observed in FastAPI's TestClient import path; it does not originate in project code and did not affect the test result.

Client dependencies were available during the latest run. OpenAPI contract checking, TypeScript, 23 Vitest tests, and the production build all passed.

## Contract decision

`contract/openapi.json` is the canonical browser-visible API contract. Server and client copies were byte-identical at integration time. `scripts/verify-contract.py` prevents silent drift, and `scripts/sync-contract.py` performs an explicit reviewed synchronization.

## Cloudflare migration implication

The successful smoke flow defines the compatibility target for the Worker/D1/R2 adapter. Cloudflare implementation should replace storage and runtime internals without changing the client-visible sequence or response shapes. Durable Objects/WebSocket remain a tickle mechanism; REST cursor synchronization remains authoritative.

## Retention extension

- IndexedDB schema v2 preserves server-deleted/expired message payloads and received file Blobs.
- Ready files for the current device are downloaded during sync on a best-effort basis.
- Download uses the local Blob before requesting a server ticket.
- A configurable 512 MiB local cache uses deterministic unpinned/LRU/size eviction.
- RelayMock defaults files to 30 days and performs projected-capacity cleanup at 95% to an 85% target within an 8 GiB operating budget.
- RelayMock's expanded 24-test suite passes after these changes, including reservation overflow, pressure eviction, alias expiry, alias purge, and storage usage reporting.
- File-byte deletion now retains a 180-day lightweight alias, records the deletion reason, and scrubs the heavy Push payload/ciphertext.
- The generated Service Worker performs a mandatory background fetch into IndexedDB from a one-use URL carried by Web Push; cursor sync remains the fallback.
- A deleted/expired alias without a local Blob is represented as `同期できず削除された`.
- Client typecheck, 23 tests, contract check, and production build were rerun successfully.
- `apps/web-pwa/dist` contains the current GUI and retention implementation.

No Cloudflare account, external service, or remote repository was modified during this proof.
