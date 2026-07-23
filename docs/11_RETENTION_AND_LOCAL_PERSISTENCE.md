# Retention and local persistence

Status: accepted for the PoC on 2026-07-21. Worker local implementation and fault injection completed on 2026-07-22; dev migrations 0006〜0012 are applied. Cloudflare's scheduled-invocation dataset records successful `17 3 * * *` runs on 2026-07-22 and 2026-07-23. This document supersedes earlier 24-hour default-file-TTL assumptions in documents 01, 04, and 08.

## Product rule

- File bytes are retained for at most 30 days on the free plan; a lightweight file alias is retained for 180 days by default.
- A dedicated Cloudflare account is assumed; no capacity is reserved for unrelated services.
- Files may be removed earlier under storage pressure.
- The receiving client persists messages and received file bytes locally whenever browser storage permits.
- Server expiry or pressure eviction does not erase an already persisted local copy.
- Explicit client deletion is distinct from server deletion.

## Server policy used by RelayMock

| Setting | PoC default |
|---|---:|
| Selectable file TTL | 1, 7, or 30 days |
| Default file TTL | 30 days |
| Default lightweight alias TTL | 180 days, configurable per policy |
| Operational storage budget | 8 GiB |
| Pressure trigger | projected reserved + stored bytes above 95% |
| Cleanup target | 85% |
| Upload when cleanup is insufficient | HTTP 507 `storage_pressure` |

The mock counts `pending` and `uploaded` files at expected size and `ready` files at actual size. Expired objects are reclaimed first. Pressure cleanup then orders ready objects by unpinned before pinned, oldest creation time, larger size, and stable ID. Pinning is a priority hint on the free plan, not a guarantee.

When bytes are removed, the file row remains as a lightweight alias containing file ID, size, byte-expiry time, deletion time, deletion reason, and alias-expiry time. The file Push payload/ciphertext is scrubbed at that point. Deletion reasons are `retention_expired`, `storage_pressure`, and `user_deleted`. A file Push created without an explicit Push TTL inherits the alias expiry rather than the 30-day byte expiry. At 180 days the alias becomes a normal deletion tombstone; after the 7-day tombstone window, both the Push tombstone and unreferenced file alias row are purged.

RelayMock exercises instantaneous pressure. The Cloudflare adapter must additionally maintain daily peak byte-days because R2 storage billing is GB-month, not only current bytes. Its effective limit is the lower of the physical 8 GiB budget and remaining-month byte-day allowance. Cleanup runs from Cron and upload reservation; R2 Lifecycle is a delayed safety net.

## Client persistence model

IndexedDB database version 2 contains:

- `pushes`: message/link/file metadata and retained payload;
- `cachedFiles`: received Blob bytes keyed by file ID;
- `outbox`: offline sends and pending file Blobs;
- `devices` and `meta`: device cache and sync cursor.

When a sync tombstone or expired Push arrives, the client merges server state without replacing an existing title, body, URL, or file metadata with null. The timeline labels the item as server-deleted or expired and identifies the displayed payload as a device-local copy.

For a ready file addressed to the current device, the client obtains a download ticket during synchronization and stores the Blob in `cachedFiles`. Save uses IndexedDB first and therefore works after server eviction.

When Web Push is registered, file notifications carry a short-lived, one-use `file_download.download_url`, file coordinates, and the registered storage namespace. The Service Worker calls `fetch()` inside `push` event `waitUntil()` and writes the Blob to the same IndexedDB without waiting for a click or an open window. Cursor sync remains the retry/fallback path. This is mandatory-attempt delivery, not guaranteed delivery: the browser/OS may terminate background work, the URL may expire, the device may be offline, or quota may be unavailable. Web platform rules also do not permit silently writing an arbitrary file into the OS Downloads folder; “automatic download” here means IndexedDB persistence.

If the alias later reports `expired` or `deleted` and no local Blob exists, the timeline displays `同期できず削除された`. If a local Blob exists, it displays `端末内保存済み` and continues to offer save from IndexedDB.

## Local automatic cleanup

The default file-cache limit is 512 MiB and is user-configurable. After insertion, the client reduces cached file bytes to that limit using this deterministic order:

1. unpinned before pinned;
2. least recently accessed first;
3. larger file first;
4. file ID as stable tie breaker.

Only file Blobs are automatically removed. Message bodies and file metadata remain until explicit removal. The client requests persistent browser storage where supported and shows the result. Browsers can deny the request, users can clear site data, private browsing can be ephemeral, and non-persistent origins can be reclaimed.

## Delete semantics

| Event | Server | Current device |
|---|---|---|
| TTL/pressure cleanup | File becomes unavailable | Retained payload/Blob remains if already cached |
| Delete from active card | Push is deleted | Local message and Blob are also deleted after confirmation |
| Delete from archived card | No server call | Local message and Blob are permanently deleted |
| Clear saved files | No change | Cached Blobs only are deleted |
| Clear all local data | No change | Cursor, history, Blobs, devices, and outbox are deleted |

## Cloudflare migration requirements

- D1 is the ledger and source of deletion decisions; normal cleanup does not list all R2 objects.
- Upload initialization atomically reserves expected bytes before returning a ticket.
- D1 changes to `delete_pending` before R2 delete and stops issuing download tickets.
- A cursor-visible file-state change lets clients observe `deleted` without losing local content.
- Cron retries deletion and releases abandoned reservations; inventory reconciliation is infrequent and separate.
- Paid policies can disable early eviction and reject over-quota uploads without changing the client storage schema.

## Acceptance cases

1. A received note remains readable after a server tombstone is synchronized.
2. A received ready file is cached automatically and can be saved after server deletion.
3. A null/tombstone payload never overwrites richer local content.
4. Exceeding the local limit evicts unpinned least-recently-used files first.
5. Explicit local deletion removes both message and Blob.
6. Server pressure evicts ready files to the cleanup target and reports bytes.
7. An upload that cannot fit after cleanup receives 507.
8. File expiry scrubs the heavy Push payload but retains a cursor-visible alias with a deletion reason.
9. A Web Push file payload is fetched and written to IndexedDB without a notification click when browser execution succeeds.
10. A deleted alias with no local Blob is labeled `同期できず削除された`.
