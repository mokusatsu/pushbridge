import { sha256Hex } from "./crypto";
import { bodyJson, json, problem } from "./response";
import { iso } from "./runtime";
import type { AuthContext, Env, FileRow, Runtime } from "./types";

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const STORAGE_BUDGET_BYTES = 8 * 1024 * 1024 * 1024;
const UPLOAD_TICKET_TTL_MS = 2 * 60 * 1000;
const DOWNLOAD_TICKET_TTL_MS = 2 * 60 * 1000;
const ALIAS_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const TTL_SECONDS = new Set([86_400, 604_800, 2_592_000]);

interface TicketRow extends FileRow {
  ticket_expires_at: number;
  ticket_used_at: number | null;
}

function fileOut(row: FileRow): Record<string, unknown> {
  return {
    id: row.id,
    original_name: row.original_name,
    content_type: row.content_type,
    expected_size: Number(row.expected_size),
    actual_size: row.actual_size == null ? null : Number(row.actual_size),
    expected_sha256: row.expected_sha256,
    actual_sha256: row.actual_sha256,
    state: row.state,
    created_at: iso(row.created_at),
    completed_at: iso(row.completed_at),
    expires_at: iso(row.expires_at),
    deleted_at: iso(row.deleted_at),
    delete_reason: row.delete_reason,
    alias_expires_at: iso(row.alias_expires_at),
  };
}

async function ownedFile(env: Env, userId: string, fileId: string): Promise<FileRow | null> {
  return env.DB.prepare("SELECT * FROM files WHERE id = ? AND user_id = ?").bind(fileId, userId).first<FileRow>();
}

async function touchFilePushes(env: Env, fileId: string, now: number): Promise<void> {
  await env.DB.prepare("UPDATE pushes SET modified_at = ? WHERE file_id = ? AND deleted_at IS NULL")
    .bind(now, fileId).run();
}

async function cleanupExpiredReservations(env: Env, now: number): Promise<void> {
  const expired = await env.DB.prepare(`SELECT * FROM files
    WHERE state = 'pending' AND upload_reservation_expires_at <= ? ORDER BY upload_reservation_expires_at, id LIMIT 100`)
    .bind(now).all<FileRow>();
  for (const row of expired.results) {
    await env.FILES.delete(row.r2_key);
    await env.DB.prepare(`UPDATE files SET state = 'deleted', deleted_at = ?, delete_reason = 'retention_expired',
      upload_reservation_expires_at = NULL WHERE id = ? AND state = 'pending'`).bind(now, row.id).run();
  }
}

function ttlPrefix(seconds: number): string {
  return seconds === 86_400 ? "1d" : seconds === 604_800 ? "7d" : "30d";
}

async function initFile(request: Request, env: Env, auth: AuthContext, requestId: string, runtime: Runtime): Promise<Response> {
  const body = await bodyJson(request, requestId);
  const allowedFields = new Set(["filename", "content_type", "size", "sha256", "expires_in"]);
  if (Object.keys(body).some((field) => !allowedFields.has(field))) {
    return problem(422, "unexpected_field", "The file initialization request contains an unsupported field.", requestId);
  }
  const filename = typeof body.filename === "string" ? body.filename.trim() : "";
  const contentType = typeof body.content_type === "string" ? body.content_type.trim() : "application/octet-stream";
  const size = typeof body.size === "number" && Number.isSafeInteger(body.size) ? body.size : -1;
  const expectedHash = typeof body.sha256 === "string" ? body.sha256.toLowerCase() : null;
  const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 2_592_000;
  if (!filename || filename.length > 255) return problem(422, "invalid_filename", "filename must contain 1 to 255 characters.", requestId);
  if (!contentType || contentType.length > 200) return problem(422, "invalid_content_type", "content_type must contain 1 to 200 characters.", requestId);
  if (size < 0) return problem(422, "invalid_file_size", "size must be a non-negative integer.", requestId);
  if (size > MAX_FILE_BYTES) return problem(413, "file_too_large", `The file limit is ${MAX_FILE_BYTES} bytes.`, requestId);
  if (expectedHash != null && !/^[a-f0-9]{64}$/.test(expectedHash)) return problem(422, "invalid_sha256", "sha256 must be a hexadecimal SHA-256 digest.", requestId);
  if (!TTL_SECONDS.has(expiresIn)) return problem(422, "invalid_file_ttl", "expires_in must be 86400, 604800, or 2592000 seconds.", requestId);

  const now = runtime.now();
  await cleanupExpiredReservations(env, now);
  const usage = await env.DB.prepare(`SELECT
    COALESCE(SUM(CASE WHEN state = 'ready' THEN actual_size ELSE 0 END), 0) AS used_bytes,
    COALESCE(SUM(CASE WHEN state IN ('pending', 'uploaded') THEN expected_size ELSE 0 END), 0) AS reserved_bytes
    FROM files`).first<{ used_bytes: number; reserved_bytes: number }>();
  if (Number(usage?.used_bytes ?? 0) + Number(usage?.reserved_bytes ?? 0) + size > STORAGE_BUDGET_BYTES) {
    return problem(507, "storage_pressure", "Storage capacity is temporarily unavailable.", requestId);
  }

  const fileId = runtime.id("fil");
  const ticket = runtime.token();
  const tokenHash = await sha256Hex(ticket);
  const expiresAt = now + expiresIn * 1000;
  const reservationExpiresAt = now + UPLOAD_TICKET_TTL_MS;
  const r2Key = `ttl/${ttlPrefix(expiresIn)}/${auth.user_id}/${fileId}/${crypto.randomUUID()}.bin`;
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO files
      (id, user_id, r2_key, original_name, content_type, expected_size, actual_size,
       expected_sha256, actual_sha256, state, created_at, completed_at, expires_at,
       deleted_at, delete_reason, alias_expires_at, upload_reservation_expires_at,
       r2_delete_attempts, r2_delete_retry_at, r2_delete_error_code)
      VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL, 'pending', ?, NULL, ?, NULL, NULL, ?, ?, 0, NULL, NULL)`)
      .bind(fileId, auth.user_id, r2Key, filename, contentType, size, expectedHash, now, expiresAt, now + ALIAS_TTL_MS, reservationExpiresAt),
    env.DB.prepare(`INSERT INTO file_tickets
      (token_hash, user_id, file_id, purpose, created_at, expires_at, used_at)
      VALUES (?, ?, ?, 'upload', ?, ?, NULL)`)
      .bind(tokenHash, auth.user_id, fileId, now, reservationExpiresAt),
  ]);
  const row = await ownedFile(env, auth.user_id, fileId);
  if (!row) throw new Error("created file is missing");
  const origin = new URL(request.url).origin;
  return json({
    file: fileOut(row),
    upload_url: `${origin}/mock-storage/uploads/${encodeURIComponent(ticket)}`,
    upload_method: "PUT",
    upload_expires_at: iso(reservationExpiresAt),
    upload_headers: { "content-type": "application/octet-stream" },
  }, { status: 201, headers: { "x-request-id": requestId } });
}

async function uploadFile(request: Request, env: Env, requestId: string, ticket: string, runtime: Runtime): Promise<Response> {
  const now = runtime.now();
  await cleanupExpiredReservations(env, now);
  const tokenHash = await sha256Hex(ticket);
  const row = await env.DB.prepare(`SELECT f.*, t.expires_at AS ticket_expires_at, t.used_at AS ticket_used_at
    FROM file_tickets t JOIN files f ON f.id = t.file_id
    WHERE t.token_hash = ? AND t.purpose = 'upload'`).bind(tokenHash).first<TicketRow>();
  if (!row) return problem(403, "invalid_upload_ticket", "The upload ticket is invalid.", requestId);
  if (row.ticket_expires_at <= now) return problem(410, "upload_ticket_expired", "The upload ticket has expired.", requestId);
  if (row.ticket_used_at != null) return problem(403, "upload_ticket_used", "The upload ticket has already been used.", requestId);
  if (row.expires_at <= now) return problem(410, "file_expired", "The file record has expired.", requestId);
  if (row.state !== "pending") return problem(409, "invalid_file_state", "The file is not waiting for an upload.", requestId);
  const contentLength = request.headers.get("content-length");
  if (contentLength != null && (!/^\d+$/.test(contentLength) || Number(contentLength) > row.expected_size || Number(contentLength) > MAX_FILE_BYTES)) {
    return problem(413, "upload_size_exceeded", "The uploaded body exceeds the declared or configured size.", requestId);
  }
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > row.expected_size || bytes.byteLength > MAX_FILE_BYTES) return problem(413, "upload_size_exceeded", "The uploaded body exceeds the declared or configured size.", requestId);
  if (bytes.byteLength !== row.expected_size) return problem(422, "upload_size_mismatch", `Expected ${row.expected_size} bytes but received ${bytes.byteLength}.`, requestId);
  const actualHash = await sha256Hex(new Uint8Array(bytes));
  if (row.expected_sha256 && actualHash !== row.expected_sha256) return problem(422, "upload_hash_mismatch", "The uploaded body does not match the declared SHA-256.", requestId);
  await env.FILES.put(row.r2_key, bytes, { customMetadata: { sha256: actualHash, fileId: row.id } });
  await env.DB.batch([
    env.DB.prepare(`UPDATE files SET actual_size = ?, actual_sha256 = ?, state = 'uploaded',
      upload_reservation_expires_at = NULL WHERE id = ? AND state = 'pending'`)
      .bind(bytes.byteLength, actualHash, row.id),
    env.DB.prepare("UPDATE file_tickets SET used_at = ? WHERE token_hash = ? AND used_at IS NULL").bind(now, tokenHash),
    env.DB.prepare("UPDATE pushes SET modified_at = ? WHERE file_id = ? AND deleted_at IS NULL").bind(now, row.id),
  ]);
  const updated = await ownedFile(env, row.user_id, row.id);
  if (!updated) throw new Error("uploaded file is missing");
  return json(fileOut(updated), { headers: { "x-request-id": requestId } });
}

async function completeFile(env: Env, auth: AuthContext, requestId: string, fileId: string, runtime: Runtime): Promise<Response> {
  const row = await ownedFile(env, auth.user_id, fileId);
  if (!row) return problem(404, "file_not_found", "File not found.", requestId);
  if (row.state === "ready") return json(fileOut(row), { headers: { "x-request-id": requestId, "idempotent-replayed": "true" } });
  if (row.expires_at <= runtime.now() || row.state === "expired") return problem(410, "file_expired", "The file has expired.", requestId);
  if (["delete_pending", "deleted"].includes(row.state)) return problem(409, "file_deleted", "A deleted file cannot be completed.", requestId);
  if (row.state !== "uploaded") return problem(409, "file_not_uploaded", "Upload the file bytes before completing the file.", requestId);
  const object = await env.FILES.get(row.r2_key);
  if (!object) return problem(422, "object_missing", "The uploaded object bytes are missing.", requestId);
  const bytes = await object.arrayBuffer();
  if (bytes.byteLength !== row.expected_size || bytes.byteLength !== row.actual_size) return problem(422, "file_size_mismatch", "Stored size does not match the initialized and uploaded size.", requestId);
  const actualHash = await sha256Hex(new Uint8Array(bytes));
  if (actualHash !== row.actual_sha256 || (row.expected_sha256 && actualHash !== row.expected_sha256)) {
    return problem(422, "file_hash_mismatch", "Stored bytes do not match the initialized SHA-256.", requestId);
  }
  const now = runtime.now();
  await env.DB.prepare("UPDATE files SET state = 'ready', completed_at = ? WHERE id = ? AND state = 'uploaded'").bind(now, fileId).run();
  await touchFilePushes(env, fileId, now);
  const updated = await ownedFile(env, auth.user_id, fileId);
  if (!updated) throw new Error("completed file is missing");
  return json(fileOut(updated), { headers: { "x-request-id": requestId } });
}

async function getFile(env: Env, auth: AuthContext, requestId: string, fileId: string): Promise<Response> {
  const row = await ownedFile(env, auth.user_id, fileId);
  return row ? json(fileOut(row), { headers: { "x-request-id": requestId } }) : problem(404, "file_not_found", "File not found.", requestId);
}

async function createDownloadTicket(request: Request, env: Env, auth: AuthContext, requestId: string, fileId: string, runtime: Runtime): Promise<Response> {
  const row = await ownedFile(env, auth.user_id, fileId);
  if (!row) return problem(404, "file_not_found", "File not found.", requestId);
  if (row.expires_at <= runtime.now() || ["expired", "delete_pending", "deleted"].includes(row.state)) return problem(410, "file_expired", "The file is no longer available for download.", requestId);
  if (row.state !== "ready") return problem(409, "file_not_ready", "The file is not available for download yet.", requestId);
  const ticket = runtime.token();
  const now = runtime.now();
  const expiresAt = now + DOWNLOAD_TICKET_TTL_MS;
  await env.DB.prepare(`INSERT INTO file_tickets
    (token_hash, user_id, file_id, purpose, created_at, expires_at, used_at)
    VALUES (?, ?, ?, 'download', ?, ?, NULL)`)
    .bind(await sha256Hex(ticket), auth.user_id, fileId, now, expiresAt).run();
  return json({ file_id: fileId, download_url: `${new URL(request.url).origin}/mock-storage/downloads/${encodeURIComponent(ticket)}`, expires_at: iso(expiresAt) }, {
    headers: { "x-request-id": requestId },
  });
}

async function downloadFile(env: Env, requestId: string, ticket: string, runtime: Runtime): Promise<Response> {
  const row = await env.DB.prepare(`SELECT f.*, t.expires_at AS ticket_expires_at, t.used_at AS ticket_used_at
    FROM file_tickets t JOIN files f ON f.id = t.file_id
    WHERE t.token_hash = ? AND t.purpose = 'download'`)
    .bind(await sha256Hex(ticket)).first<TicketRow>();
  if (!row) return problem(403, "invalid_download_ticket", "The download ticket is invalid.", requestId);
  if (row.ticket_expires_at <= runtime.now()) return problem(410, "download_ticket_expired", "The download ticket has expired.", requestId);
  if (row.state !== "ready" || row.expires_at <= runtime.now()) return problem(410, "file_expired", "The file is no longer available.", requestId);
  const object = await env.FILES.get(row.r2_key);
  if (!object) return problem(410, "object_missing", "The object bytes are missing.", requestId);
  const headers = new Headers({
    "content-type": "application/octet-stream",
    "content-disposition": "attachment; filename=\"pushbridge-file.bin\"",
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    "x-request-id": requestId,
    "content-length": String(object.size),
    etag: object.httpEtag,
  });
  return new Response(object.body, { headers });
}

async function deleteFile(env: Env, auth: AuthContext, requestId: string, fileId: string, runtime: Runtime): Promise<Response> {
  let row = await ownedFile(env, auth.user_id, fileId);
  if (!row) return problem(404, "file_not_found", "File not found.", requestId);
  if (row.state === "deleted") return json(fileOut(row), { headers: { "x-request-id": requestId, "idempotent-replayed": "true" } });
  const now = runtime.now();
  await env.DB.batch([
    env.DB.prepare(`UPDATE files SET state = 'delete_pending', deleted_at = ?, delete_reason = 'user_deleted',
      r2_delete_retry_at = ? WHERE id = ?`).bind(now, now, fileId),
    env.DB.prepare("DELETE FROM file_tickets WHERE file_id = ? AND purpose = 'upload'").bind(fileId),
    env.DB.prepare("UPDATE pushes SET modified_at = ? WHERE file_id = ? AND deleted_at IS NULL").bind(now, fileId),
  ]);
  try {
    await env.FILES.delete(row.r2_key);
    await env.DB.prepare(`UPDATE files SET state = 'deleted', r2_delete_retry_at = NULL,
      r2_delete_error_code = NULL WHERE id = ?`).bind(fileId).run();
  } catch {
    await env.DB.prepare(`UPDATE files SET r2_delete_attempts = r2_delete_attempts + 1,
      r2_delete_retry_at = ?, r2_delete_error_code = 'r2_delete_failed' WHERE id = ?`).bind(now + 60_000, fileId).run();
    return problem(503, "file_delete_pending", "File deletion will be retried.", requestId);
  }
  row = await ownedFile(env, auth.user_id, fileId);
  if (!row) throw new Error("deleted file is missing");
  return json(fileOut(row), { headers: { "x-request-id": requestId } });
}

export async function storageUsage(env: Env, auth: AuthContext): Promise<Record<string, unknown>> {
  const row = await env.DB.prepare(`SELECT
    COALESCE(SUM(CASE WHEN state = 'ready' THEN actual_size ELSE 0 END), 0) AS used_bytes,
    COALESCE(SUM(CASE WHEN state IN ('pending', 'uploaded') THEN expected_size ELSE 0 END), 0) AS reserved_bytes
    FROM files WHERE user_id = ?`).bind(auth.user_id).first<{ used_bytes: number; reserved_bytes: number }>();
  const usedBytes = Number(row?.used_bytes ?? 0);
  const reservedBytes = Number(row?.reserved_bytes ?? 0);
  const ratio = (usedBytes + reservedBytes) / STORAGE_BUDGET_BYTES;
  return {
    used_bytes: usedBytes,
    reserved_bytes: reservedBytes,
    quota_bytes: STORAGE_BUDGET_BYTES,
    reclaimable_bytes: usedBytes,
    pressure: ratio >= .95 ? "emergency" : ratio >= .85 ? "constrained" : ratio >= .7 ? "notice" : "normal",
    policy_id: "free-v1",
    default_retention_days: 30,
    early_eviction_possible: true,
  };
}

export async function handlePublicFileRoute(request: Request, env: Env, requestId: string, path: string, runtime: Runtime): Promise<Response | null> {
  const uploadMatch = path.match(/^\/mock-storage\/uploads\/([^/]+)$/);
  if (uploadMatch && request.method === "PUT") return uploadFile(request, env, requestId, decodeURIComponent(uploadMatch[1]), runtime);
  const downloadMatch = path.match(/^\/mock-storage\/downloads\/([^/]+)$/);
  if (downloadMatch && request.method === "GET") return downloadFile(env, requestId, decodeURIComponent(downloadMatch[1]), runtime);
  return null;
}

export async function handleFileRoute(request: Request, env: Env, auth: AuthContext, requestId: string, path: string, runtime: Runtime): Promise<Response | null> {
  if (path === "/v1/files/init" && request.method === "POST") return initFile(request, env, auth, requestId, runtime);
  const completeMatch = path.match(/^\/v1\/files\/([^/]+)\/complete$/);
  if (completeMatch && request.method === "POST") return completeFile(env, auth, requestId, decodeURIComponent(completeMatch[1]), runtime);
  const downloadTicketMatch = path.match(/^\/v1\/files\/([^/]+)\/download-ticket$/);
  if (downloadTicketMatch && request.method === "POST") return createDownloadTicket(request, env, auth, requestId, decodeURIComponent(downloadTicketMatch[1]), runtime);
  const metadataMatch = path.match(/^\/v1\/files\/([^/]+)$/);
  if (metadataMatch && request.method === "GET") return getFile(env, auth, requestId, decodeURIComponent(metadataMatch[1]));
  if (metadataMatch && request.method === "DELETE") return deleteFile(env, auth, requestId, decodeURIComponent(metadataMatch[1]), runtime);
  return null;
}
