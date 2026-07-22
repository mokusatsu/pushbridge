// infra/cloudflare/worker/src/crypto.ts
async function sha256Hex(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digestInput = new Uint8Array(bytes.byteLength);
  digestInput.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", digestInput.buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function base64UrlEncode(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
function base64UrlDecode(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid base64url");
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - value.length % 4) % 4);
  const raw = atob(padded);
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}
function ownedBuffer(bytes) {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
async function hmac(key, value) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(value)));
}
async function aesKey(encodedKey, usages) {
  const raw = base64UrlDecode(encodedKey);
  if (raw.byteLength !== 32) throw new Error("WEB_PUSH_DATA_KEY must be a 32-byte base64url value");
  return crypto.subtle.importKey("raw", ownedBuffer(raw), { name: "AES-GCM" }, false, usages);
}
async function encryptText(value, encodedKey, aad2) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: new TextEncoder().encode(aad2) },
    await aesKey(encodedKey, ["encrypt"]),
    new TextEncoder().encode(value)
  );
  return { ciphertext: base64UrlEncode(new Uint8Array(ciphertext)), nonce: base64UrlEncode(nonce) };
}
async function decryptText(ciphertext, nonce, encodedKey, aad2) {
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: ownedBuffer(base64UrlDecode(nonce)), additionalData: new TextEncoder().encode(aad2) },
    await aesKey(encodedKey, ["decrypt"]),
    ownedBuffer(base64UrlDecode(ciphertext))
  );
  return new TextDecoder().decode(plaintext);
}

// infra/cloudflare/worker/src/response.ts
var JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff"
};
function json(value, init = {}) {
  const headers = new Headers(init.headers);
  for (const [name, headerValue] of Object.entries(JSON_HEADERS)) {
    if (!headers.has(name)) headers.set(name, headerValue);
  }
  return new Response(JSON.stringify(value), { ...init, headers });
}
function problem(status, code, message, requestId, headers = {}) {
  return json({ detail: { code, message, request_id: requestId } }, {
    status,
    headers: { ...Object.fromEntries(new Headers(headers)), "x-request-id": requestId }
  });
}
function getRequestId(request) {
  return request.headers.get("cf-ray") ?? request.headers.get("x-request-id") ?? crypto.randomUUID();
}
async function bodyJson(request, requestId) {
  try {
    return await request.json();
  } catch {
    throw problem(400, "invalid_json", "Request body must be valid JSON.", requestId);
  }
}

// infra/cloudflare/worker/src/runtime.ts
function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `rly_${btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")}`;
}
function createRuntime(overrides = {}) {
  return {
    now: overrides.now ?? (() => Date.now()),
    id: overrides.id ?? ((prefix) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`),
    token: overrides.token ?? randomToken
  };
}
function iso(epoch) {
  return epoch == null ? null : new Date(Number(epoch)).toISOString();
}

// infra/cloudflare/worker/src/deliveries.ts
var ACK_TOKEN_TTL_MS = 24 * 60 * 60 * 1e3;
function deliveryOut(row) {
  return {
    id: row.id,
    push_id: row.push_id,
    file_id: row.file_id,
    destination_device_id: row.destination_device_id,
    state: row.state,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    notified_at: iso(row.notified_at),
    fetching_at: iso(row.fetching_at),
    cached_at: iso(row.cached_at),
    failed_at: iso(row.failed_at),
    missed_at: iso(row.missed_at),
    failure_code: row.failure_code,
    attempt_count: Number(row.attempt_count)
  };
}
async function ensureFileDeliveries(env, push, runtime) {
  if (push.type !== "file" || !push.file_id) return;
  const targetKind = push.target_kind ?? (push.target_device_id ? "device" : "all_other_devices");
  let devices;
  if (targetKind === "device") {
    devices = await env.DB.prepare("SELECT id FROM devices WHERE id = ? AND user_id = ? AND revoked_at IS NULL").bind(push.target_device_id, push.user_id).all();
  } else if (targetKind === "all_devices") {
    devices = await env.DB.prepare("SELECT id FROM devices WHERE user_id = ? AND revoked_at IS NULL ORDER BY id").bind(push.user_id).all();
  } else {
    devices = await env.DB.prepare("SELECT id FROM devices WHERE user_id = ? AND id != ? AND revoked_at IS NULL ORDER BY id").bind(push.user_id, push.source_device_id).all();
  }
  const now = runtime.now();
  if (devices.results.length === 0) return;
  await env.DB.batch(devices.results.map((device) => env.DB.prepare(`INSERT OR IGNORE INTO file_deliveries
    (id, user_id, push_id, file_id, destination_device_id, state, created_at, updated_at, attempt_count)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, 0)`).bind(runtime.id("fdl"), push.user_id, push.id, push.file_id, device.id, now, now)));
}
async function issueDeliveryToken(env, deliveryId, runtime) {
  const token = runtime.token();
  const expiresAt = runtime.now() + ACK_TOKEN_TTL_MS;
  const result = await env.DB.prepare(`UPDATE file_deliveries SET ack_token_hash = ?, ack_token_expires_at = ?,
    updated_at = ?, attempt_count = attempt_count + 1
    WHERE id = ? AND state IN ('pending', 'notified', 'failed_retryable')`).bind(await sha256Hex(token), expiresAt, runtime.now(), deliveryId).run();
  return result.meta.changes === 1 ? { token, expiresAt } : null;
}
async function markDeliveryNotified(env, deliveryId, runtime) {
  const now = runtime.now();
  await env.DB.prepare(`UPDATE file_deliveries SET state = 'notified', notified_at = COALESCE(notified_at, ?),
    updated_at = ?, failure_code = NULL WHERE id = ? AND state IN ('pending', 'notified', 'failed_retryable')`).bind(now, now, deliveryId).run();
}
async function markDeliveryFailed(env, deliveryId, failureCode, runtime) {
  const now = runtime.now();
  await env.DB.prepare(`UPDATE file_deliveries SET state = 'failed_retryable', failed_at = ?, updated_at = ?,
    failure_code = ? WHERE id = ? AND state IN ('pending', 'notified', 'failed_retryable')`).bind(now, now, failureCode.slice(0, 100), deliveryId).run();
}
async function listFileDeliveries(env, auth, requestId, fileId) {
  const owned = await env.DB.prepare("SELECT id FROM files WHERE id = ? AND user_id = ?").bind(fileId, auth.user_id).first();
  if (!owned) return problem(404, "file_not_found", "File not found.", requestId);
  const rows = await env.DB.prepare(`SELECT * FROM file_deliveries WHERE file_id = ? AND user_id = ?
    ORDER BY destination_device_id, id`).bind(fileId, auth.user_id).all();
  return json(rows.results.map(deliveryOut), { headers: { "x-request-id": requestId } });
}
async function handlePublicDeliveryRoute(request, env, requestId, path, runtime) {
  const match = path.match(/^\/v1\/file-deliveries\/([^/]+)\/events$/);
  if (!match || request.method !== "POST") return null;
  const tokenHeader = request.headers.get("authorization") ?? "";
  const token = tokenHeader.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return problem(401, "delivery_token_required", "A delivery acknowledgement token is required.", requestId);
  const row = await env.DB.prepare("SELECT * FROM file_deliveries WHERE id = ? AND ack_token_hash = ?").bind(decodeURIComponent(match[1]), await sha256Hex(token)).first();
  if (!row) return problem(403, "invalid_delivery_token", "The delivery acknowledgement token is invalid.", requestId);
  if (row.ack_token_expires_at == null || row.ack_token_expires_at <= runtime.now()) {
    return problem(410, "delivery_token_expired", "The delivery acknowledgement token has expired.", requestId);
  }
  const body = await bodyJson(request, requestId);
  const next = typeof body.state === "string" ? body.state : "";
  if (!["fetching", "cached", "failed_retryable"].includes(next)) {
    return problem(422, "invalid_delivery_state", "state must be fetching, cached, or failed_retryable.", requestId);
  }
  if (row.state === "cached") return json(deliveryOut(row), { headers: { "idempotent-replayed": "true", "x-request-id": requestId } });
  if (row.state === "missed") return problem(409, "delivery_missed", "A missed delivery cannot be acknowledged.", requestId);
  const now = runtime.now();
  const failureCode = next === "failed_retryable" && typeof body.failure_code === "string" ? body.failure_code.slice(0, 100) : null;
  await env.DB.prepare(`UPDATE file_deliveries SET state = ?, updated_at = ?,
    fetching_at = CASE WHEN ? = 'fetching' THEN COALESCE(fetching_at, ?) ELSE fetching_at END,
    cached_at = CASE WHEN ? = 'cached' THEN COALESCE(cached_at, ?) ELSE cached_at END,
    failed_at = CASE WHEN ? = 'failed_retryable' THEN ? ELSE failed_at END,
    failure_code = CASE WHEN ? = 'failed_retryable' THEN ? WHEN ? = 'cached' THEN NULL ELSE failure_code END
    WHERE id = ?`).bind(next, now, next, now, next, now, next, now, next, failureCode, next, row.id).run();
  const updated = await env.DB.prepare("SELECT * FROM file_deliveries WHERE id = ?").bind(row.id).first();
  if (!updated) throw new Error("updated delivery is missing");
  return json(deliveryOut(updated), { headers: { "x-request-id": requestId } });
}
async function markUndeliveredMissed(env, fileId, reason, runtime) {
  const now = runtime.now();
  await env.DB.prepare(`UPDATE file_deliveries SET state = 'missed', updated_at = ?, missed_at = ?, failure_code = ?
    WHERE file_id = ? AND state != 'cached'`).bind(now, now, reason, fileId).run();
}

// infra/cloudflare/worker/src/cleanup.ts
var DAY_MS = 24 * 60 * 60 * 1e3;
var TOMBSTONE_TTL_MS = 7 * DAY_MS;
var TICKET_RECORD_TTL_MS = DAY_MS;
var DEFAULT_STORAGE_BUDGET_BYTES = 8 * 1024 * 1024 * 1024;
var DEFAULT_HIGH_WATERMARK_PERCENT = 95;
var DEFAULT_CLEANUP_TARGET_PERCENT = 85;
var MAX_DELETE_RETRY_MS = 60 * 60 * 1e3;
function integerSetting(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}
function storagePolicy(env) {
  const monthly = Number(env.STORAGE_MONTHLY_BYTE_DAY_BUDGET);
  const highWatermarkPercent = integerSetting(env.STORAGE_PRESSURE_HIGH_PERCENT, DEFAULT_HIGH_WATERMARK_PERCENT, 1, 100);
  const requestedTarget = integerSetting(env.STORAGE_CLEANUP_TARGET_PERCENT, DEFAULT_CLEANUP_TARGET_PERCENT, 1, 100);
  return {
    budgetBytes: integerSetting(env.STORAGE_BUDGET_BYTES, DEFAULT_STORAGE_BUDGET_BYTES, 1, Number.MAX_SAFE_INTEGER),
    highWatermarkPercent,
    cleanupTargetPercent: Math.min(requestedTarget, Math.max(0, highWatermarkPercent - 1)),
    monthlyByteDayBudget: Number.isSafeInteger(monthly) && monthly > 0 ? monthly : null
  };
}
async function storageTotals(env) {
  const row = await env.DB.prepare(`SELECT
    COALESCE(SUM(CASE WHEN state IN ('ready', 'delete_pending') THEN COALESCE(actual_size, expected_size) ELSE 0 END), 0) AS used_bytes,
    COALESCE(SUM(CASE WHEN state IN ('pending', 'uploaded') THEN expected_size ELSE 0 END), 0) AS reserved_bytes
    FROM files`).first();
  const usedBytes = Number(row?.used_bytes ?? 0);
  const reservedBytes = Number(row?.reserved_bytes ?? 0);
  return { usedBytes, reservedBytes, totalBytes: usedBytes + reservedBytes };
}
function utcDay(epoch) {
  return new Date(epoch).toISOString().slice(0, 10);
}
function dayStart(day) {
  return Date.parse(`${day}T00:00:00.000Z`);
}
async function recordUsageSample(env, now, bytes) {
  const today = utcDay(now);
  const latest = await env.DB.prepare("SELECT * FROM storage_usage_daily ORDER BY day DESC LIMIT 1").first();
  if (!latest) {
    await env.DB.prepare(`INSERT INTO storage_usage_daily
      (day, peak_bytes, kibibyte_seconds, last_sample_at, last_bytes, updated_at)
      VALUES (?, ?, 0, ?, ?, ?)`).bind(today, bytes, now, bytes, now).run();
    return;
  }
  const latestEnd = dayStart(latest.day) + DAY_MS;
  const elapsed = Math.max(0, Math.min(now, latestEnd) - Number(latest.last_sample_at));
  const elapsedSeconds = Math.floor(elapsed / 1e3);
  const lastKibibytes = Math.ceil(Number(latest.last_bytes) / 1024);
  await env.DB.prepare(`UPDATE storage_usage_daily SET
    peak_bytes = MAX(peak_bytes, ?), kibibyte_seconds = kibibyte_seconds + ?,
    last_sample_at = ?, last_bytes = ?, updated_at = ? WHERE day = ?`).bind(
    latest.day === today ? bytes : latest.last_bytes,
    elapsedSeconds * lastKibibytes,
    Math.min(now, latestEnd),
    latest.day === today ? bytes : latest.last_bytes,
    now,
    latest.day
  ).run();
  if (latest.day !== today) {
    let cursor = latestEnd;
    let filled = 0;
    while (cursor + DAY_MS <= dayStart(today) && filled < 400) {
      const day = utcDay(cursor);
      await env.DB.prepare(`INSERT OR IGNORE INTO storage_usage_daily
        (day, peak_bytes, kibibyte_seconds, last_sample_at, last_bytes, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)`).bind(day, latest.last_bytes, Math.ceil(Number(latest.last_bytes) / 1024) * 86400, cursor + DAY_MS, latest.last_bytes, now).run();
      cursor += DAY_MS;
      filled += 1;
    }
    await env.DB.prepare(`INSERT OR REPLACE INTO storage_usage_daily
      (day, peak_bytes, kibibyte_seconds, last_sample_at, last_bytes, updated_at)
      VALUES (?, ?, 0, ?, ?, ?)`).bind(today, bytes, now, bytes, now).run();
  }
}
async function effectiveBudget(env, policy, now) {
  if (policy.monthlyByteDayBudget == null) return policy.budgetBytes;
  const month = new Date(now).toISOString().slice(0, 7);
  const consumed = await env.DB.prepare(`SELECT COALESCE(SUM(kibibyte_seconds), 0) AS value
    FROM storage_usage_daily WHERE day >= ? AND day < ?`).bind(`${month}-01`, `${month}-32`).first();
  const current = new Date(now);
  const daysInMonth = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + 1, 0)).getUTCDate();
  const remainingDays = Math.max(1, daysInMonth - current.getUTCDate() + 1);
  const remainingByteDays = Math.max(0, policy.monthlyByteDayBudget - Number(consumed?.value ?? 0) * 1024 / 86400);
  return Math.min(policy.budgetBytes, Math.floor(remainingByteDays / remainingDays));
}
function retryDelay(attempts) {
  return Math.min(MAX_DELETE_RETRY_MS, 6e4 * 2 ** Math.min(6, Math.max(0, attempts)));
}
async function transitionExpiredFiles(env, now) {
  const reservations = await env.DB.prepare(`UPDATE files SET state = 'delete_pending', deleted_at = COALESCE(deleted_at, ?),
    delete_reason = 'retention_expired', r2_delete_retry_at = ?
    WHERE state = 'pending' AND upload_reservation_expires_at IS NOT NULL AND upload_reservation_expires_at <= ?`).bind(now, now, now).run();
  const files = await env.DB.prepare(`UPDATE files SET state = 'delete_pending', deleted_at = COALESCE(deleted_at, ?),
    delete_reason = 'retention_expired', r2_delete_retry_at = ?
    WHERE state IN ('pending', 'uploaded', 'ready') AND expires_at <= ?`).bind(now, now, now).run();
  return { reservations: Number(reservations.meta.changes), files: Number(files.meta.changes) };
}
async function transitionPressureCandidates(env, reclaimBytes, now) {
  if (reclaimBytes <= 0) return { files: 0, bytes: 0 };
  const candidates = await env.DB.prepare(`SELECT f.id, COALESCE(f.actual_size, f.expected_size) AS size,
    EXISTS(SELECT 1 FROM pushes p WHERE p.file_id = f.id AND p.pinned_at IS NOT NULL
      AND p.deleted_at IS NULL AND p.expired_at IS NULL) AS protected
    FROM files f WHERE f.state = 'ready'
    ORDER BY protected ASC, f.created_at ASC, size DESC, f.id ASC`).all();
  let bytes = 0;
  let files = 0;
  for (const candidate of candidates.results) {
    if (bytes >= reclaimBytes) break;
    const result = await env.DB.prepare(`UPDATE files SET state = 'delete_pending', deleted_at = COALESCE(deleted_at, ?),
      delete_reason = 'storage_pressure', r2_delete_retry_at = ? WHERE id = ? AND state = 'ready'`).bind(now, now, candidate.id).run();
    if (result.meta.changes === 1) {
      files += 1;
      bytes += Number(candidate.size);
    }
  }
  return { files, bytes };
}
async function processPendingDeletes(env, runtime, report) {
  const now = runtime.now();
  const rows = await env.DB.prepare(`SELECT * FROM files WHERE state = 'delete_pending'
    AND (r2_delete_retry_at IS NULL OR r2_delete_retry_at <= ?) ORDER BY deleted_at, id LIMIT 100`).bind(now).all();
  for (const row of rows.results) {
    try {
      await env.FILES.delete(row.r2_key);
    } catch {
      report.deleteFailures += 1;
      try {
        await env.DB.prepare(`UPDATE files SET r2_delete_attempts = r2_delete_attempts + 1,
          r2_delete_retry_at = ?, r2_delete_error_code = 'r2_delete_failed' WHERE id = ? AND state = 'delete_pending'`).bind(now + retryDelay(Number(row.r2_delete_attempts)), row.id).run();
      } catch {
        report.errors += 1;
      }
      continue;
    }
    try {
      const finalState = row.delete_reason === "retention_expired" && row.actual_size != null ? "expired" : "deleted";
      const results = await env.DB.batch([
        env.DB.prepare(`UPDATE files SET state = ?, original_name = 'expired-file.bin', content_type = 'application/octet-stream',
          expected_sha256 = NULL, actual_sha256 = NULL, upload_reservation_expires_at = NULL,
          r2_delete_retry_at = NULL, r2_delete_error_code = NULL WHERE id = ? AND state = 'delete_pending'`).bind(finalState, row.id),
        env.DB.prepare(`UPDATE pushes SET payload_json = NULL, ciphertext = '', nonce = '', modified_at = ?
          WHERE file_id = ?`).bind(now, row.id)
      ]);
      if (results[0].meta.changes === 1) {
        await markUndeliveredMissed(env, row.id, row.delete_reason ?? "retention_expired", runtime);
        report.deletedObjects += 1;
        if (row.delete_reason === "storage_pressure") {
          report.pressureEvictedFiles += 1;
          report.pressureEvictedBytes += Number(row.actual_size ?? row.expected_size);
        }
      }
    } catch {
      report.errors += 1;
      try {
        await env.DB.prepare(`UPDATE files SET r2_delete_attempts = r2_delete_attempts + 1,
          r2_delete_retry_at = ?, r2_delete_error_code = 'd1_finalize_failed' WHERE id = ? AND state = 'delete_pending'`).bind(now + retryDelay(Number(row.r2_delete_attempts)), row.id).run();
      } catch {
        report.errors += 1;
      }
    }
  }
}
async function cleanupMetadata(env, now, report) {
  const statements = [
    env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ? OR revoked_at IS NOT NULL").bind(now),
    env.DB.prepare("DELETE FROM bootstrap_rate_limits WHERE window_started_at < ?").bind(now - DAY_MS),
    env.DB.prepare("DELETE FROM file_tickets WHERE expires_at <= ?").bind(now - TICKET_RECORD_TTL_MS),
    env.DB.prepare("DELETE FROM storage_usage_daily WHERE day < ?").bind(utcDay(now - 400 * DAY_MS))
  ];
  for (const statement of statements) {
    try {
      await statement.run();
    } catch {
      report.errors += 1;
    }
  }
  try {
    const expired = await env.DB.prepare(`UPDATE pushes SET expired_at = ?, status = 'expired', modified_at = ?,
      payload_json = NULL, ciphertext = '', nonce = ''
      WHERE type != 'file' AND expires_at <= ? AND expired_at IS NULL AND deleted_at IS NULL AND pinned_at IS NULL`).bind(now, now, now).run();
    report.expiredPushes = Number(expired.meta.changes);
  } catch {
    report.errors += 1;
  }
  try {
    const aliases = await env.DB.prepare(`UPDATE pushes SET deleted_at = ?, status = 'deleted', modified_at = ?,
      payload_json = NULL, ciphertext = '', nonce = ''
      WHERE type = 'file' AND deleted_at IS NULL AND file_id IN
        (SELECT id FROM files WHERE alias_expires_at <= ? AND state IN ('expired', 'deleted'))`).bind(now, now, now).run();
    report.aliasTombstones = Number(aliases.meta.changes);
  } catch {
    report.errors += 1;
  }
  try {
    const tombstones = await env.DB.prepare("DELETE FROM pushes WHERE deleted_at IS NOT NULL AND deleted_at <= ?").bind(now - TOMBSTONE_TTL_MS).run();
    report.purgedTombstones = Number(tombstones.meta.changes);
  } catch {
    report.errors += 1;
  }
  try {
    const aliases = await env.DB.prepare(`DELETE FROM files WHERE alias_expires_at <= ?
      AND state IN ('expired', 'deleted') AND NOT EXISTS (SELECT 1 FROM pushes WHERE pushes.file_id = files.id)`).bind(now - TOMBSTONE_TTL_MS).run();
    report.purgedFileAliases = Number(aliases.meta.changes);
  } catch {
    report.errors += 1;
  }
}
async function cleanupExpiredMetadata(env, runtime, requiredBytes = 0) {
  const policy = storagePolicy(env);
  const initial = await storageTotals(env);
  const report = {
    ...initial,
    effectiveBudgetBytes: policy.budgetBytes,
    expiredReservations: 0,
    expiredFiles: 0,
    pressureEvictedFiles: 0,
    pressureEvictedBytes: 0,
    deletedObjects: 0,
    deleteFailures: 0,
    expiredPushes: 0,
    aliasTombstones: 0,
    purgedTombstones: 0,
    purgedFileAliases: 0,
    errors: 0
  };
  const now = runtime.now();
  try {
    await recordUsageSample(env, now, initial.totalBytes);
    report.effectiveBudgetBytes = await effectiveBudget(env, policy, now);
  } catch {
    report.errors += 1;
  }
  try {
    const expired = await transitionExpiredFiles(env, now);
    report.expiredReservations = expired.reservations;
    report.expiredFiles = expired.files;
  } catch {
    report.errors += 1;
  }
  await processPendingDeletes(env, runtime, report);
  let current = await storageTotals(env);
  const highWatermark = Math.floor(report.effectiveBudgetBytes * policy.highWatermarkPercent / 100);
  const cleanupTarget = Math.floor(report.effectiveBudgetBytes * policy.cleanupTargetPercent / 100);
  if (current.totalBytes + Math.max(0, requiredBytes) > highWatermark) {
    try {
      await transitionPressureCandidates(
        env,
        current.totalBytes + Math.max(0, requiredBytes) - cleanupTarget,
        now
      );
    } catch {
      report.errors += 1;
    }
    await processPendingDeletes(env, runtime, report);
    current = await storageTotals(env);
  }
  await cleanupMetadata(env, now, report);
  try {
    await recordUsageSample(env, now, current.totalBytes);
  } catch {
    report.errors += 1;
  }
  Object.assign(report, current);
  return report;
}

// infra/cloudflare/worker/src/devices.ts
function deviceOut(row, currentDeviceId) {
  return {
    id: row.id,
    user_id: row.user_id,
    kind: row.kind === "extension" ? "browser_extension" : row.kind,
    name: typeof row.name_ciphertext === "string" ? row.name_ciphertext : "Linked device",
    public_key: typeof row.public_key === "string" && row.public_key ? row.public_key : null,
    created_at: iso(row.created_at),
    last_seen_at: iso(row.last_seen_at ?? row.created_at),
    revoked_at: iso(row.revoked_at),
    is_current: row.id === currentDeviceId
  };
}
async function listDevices(env, auth) {
  const result = await env.DB.prepare("SELECT * FROM devices WHERE user_id = ? ORDER BY created_at").bind(auth.user_id).all();
  return result.results.map((row) => deviceOut(row, auth.device_id));
}
async function currentDevice(env, auth) {
  const row = await env.DB.prepare("SELECT * FROM devices WHERE id = ? AND user_id = ?").bind(auth.device_id, auth.user_id).first();
  if (!row) throw new Error("authenticated device is missing");
  return deviceOut(row, auth.device_id);
}
async function linkDevice(request, env, auth, requestId, runtime) {
  const body = await bodyJson(request, requestId);
  if (typeof body.name !== "string" || !body.name.trim()) return problem(422, "validation_error", "Device name is required.", requestId);
  const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM devices WHERE user_id = ? AND revoked_at IS NULL").bind(auth.user_id).first();
  if (Number(count?.count) >= 10) return problem(409, "device_limit", "The device limit has been reached.", requestId);
  const now = runtime.now();
  const deviceId = runtime.id("dev");
  const token = runtime.token();
  const expiresAt = now + 30 * 24 * 60 * 60 * 1e3;
  const kind = body.kind === "browser_extension" ? "extension" : typeof body.kind === "string" ? body.kind : "web";
  if (!["web", "pwa", "extension"].includes(kind)) return problem(422, "validation_error", "Invalid device kind.", requestId);
  const publicKey = typeof body.public_key === "string" ? body.public_key : "";
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO devices
      (id, user_id, kind, name_ciphertext, public_key, last_seen_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(deviceId, auth.user_id, kind, body.name.trim(), publicKey, now, now, now),
    env.DB.prepare("INSERT INTO sessions (token_hash, user_id, device_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)").bind(await sha256Hex(token), auth.user_id, deviceId, now, expiresAt)
  ]);
  const row = await env.DB.prepare("SELECT * FROM devices WHERE id = ?").bind(deviceId).first();
  if (!row) throw new Error("linked device was not created");
  return json({ device: deviceOut(row, auth.device_id), access_token: token, token_type: "bearer", expires_at: iso(expiresAt) }, { status: 201, headers: { "x-request-id": requestId } });
}
async function mutateDevice(request, env, auth, requestId, deviceId, runtime) {
  const row = await env.DB.prepare("SELECT * FROM devices WHERE id = ? AND user_id = ?").bind(deviceId, auth.user_id).first();
  if (!row) return problem(404, "not_found", "Device not found.", requestId);
  if (request.method === "DELETE") {
    if (deviceId === auth.device_id) return problem(409, "current_device", "The current device cannot revoke itself.", requestId);
    const now = runtime.now();
    await env.DB.batch([
      env.DB.prepare("UPDATE devices SET revoked_at = ?, updated_at = ? WHERE id = ?").bind(now, now, deviceId),
      env.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE device_id = ?").bind(now, deviceId)
    ]);
    return new Response(null, { status: 204, headers: { "x-request-id": requestId } });
  }
  const body = await bodyJson(request, requestId);
  if (typeof body.name !== "string" || !body.name.trim()) return problem(422, "validation_error", "Device name is required.", requestId);
  await env.DB.prepare("UPDATE devices SET name_ciphertext = ?, updated_at = ? WHERE id = ?").bind(body.name.trim(), runtime.now(), deviceId).run();
  const updated = await env.DB.prepare("SELECT * FROM devices WHERE id = ?").bind(deviceId).first();
  if (!updated) throw new Error("updated device is missing");
  return json(deviceOut(updated, auth.device_id), { headers: { "x-request-id": requestId } });
}

// infra/cloudflare/worker/src/auth.ts
async function authenticate(request, env, requestId, runtime) {
  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ") || header.length <= 7) {
    throw problem(401, "unauthorized", "A valid bearer token is required.", requestId, { "www-authenticate": "Bearer" });
  }
  const tokenHash = await sha256Hex(header.slice(7));
  const row = await env.DB.prepare(`
    SELECT s.user_id, s.device_id, s.expires_at, s.revoked_at AS session_revoked_at,
      u.handle, u.deleted_at AS user_deleted_at, d.revoked_at AS device_revoked_at
    FROM sessions s JOIN users u ON u.id = s.user_id JOIN devices d ON d.id = s.device_id
    WHERE s.token_hash = ?
  `).bind(tokenHash).first();
  if (!row || row.session_revoked_at != null || row.device_revoked_at != null || row.user_deleted_at != null || Number(row.expires_at) <= runtime.now()) {
    throw problem(401, "unauthorized", "The bearer token is expired, revoked, or invalid.", requestId, { "www-authenticate": "Bearer" });
  }
  return { user_id: row.user_id, device_id: row.device_id, handle: row.handle, cursor_key: tokenHash };
}
async function consumeBootstrapAttempt(request, env, requestId, runtime) {
  const source = request.headers.get("cf-connecting-ip") ?? "local-development";
  const sourceHash = await sha256Hex(source);
  const windowStartedAt = Math.floor(runtime.now() / 6e5) * 6e5;
  const row = await env.DB.prepare(`INSERT INTO bootstrap_rate_limits (source_hash, window_started_at, attempts)
    VALUES (?, ?, 1)
    ON CONFLICT(source_hash, window_started_at) DO UPDATE SET attempts = attempts + 1
    RETURNING attempts`).bind(sourceHash, windowStartedAt).first();
  const limit = Math.min(100, Math.max(1, Number(env.DEV_BOOTSTRAP_RATE_LIMIT) || 20));
  if (Number(row?.attempts) > limit) {
    return problem(429, "rate_limited", "Too many bootstrap attempts. Retry later.", requestId, { "retry-after": "600" });
  }
  return null;
}
async function verifyTurnstile(body, request, env, requestId) {
  if (env.REQUIRE_DEV_BOOTSTRAP_TURNSTILE !== "true") return null;
  const token = typeof body.turnstile_token === "string" ? body.turnstile_token : request.headers.get("cf-turnstile-response");
  if (!token || !env.TURNSTILE_SECRET_KEY) return problem(403, "turnstile_required", "A valid Turnstile response is required.", requestId);
  const form = new FormData();
  form.set("secret", env.TURNSTILE_SECRET_KEY);
  form.set("response", token);
  const remoteIp = request.headers.get("cf-connecting-ip");
  if (remoteIp) form.set("remoteip", remoteIp);
  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
  const result = await response.json();
  return result.success ? null : problem(403, "turnstile_failed", "Turnstile verification failed.", requestId);
}
async function bootstrap(request, env, requestId, runtime) {
  if (env.ENABLE_DEV_BOOTSTRAP !== "true" || env.APP_ENVIRONMENT === "production") {
    return problem(404, "not_found", "Endpoint not found.", requestId);
  }
  const limited = await consumeBootstrapAttempt(request, env, requestId, runtime);
  if (limited) return limited;
  const body = await bodyJson(request, requestId);
  const turnstileFailure = await verifyTurnstile(body, request, env, requestId);
  if (turnstileFailure) return turnstileFailure;
  if (!/^[A-Za-z0-9_.-]{1,80}$/.test(typeof body.handle === "string" ? body.handle : "") || typeof body.device_name !== "string" || !body.device_name.trim()) {
    return problem(422, "validation_error", "handle and device_name are required.", requestId);
  }
  const existing = await env.DB.prepare("SELECT id FROM users WHERE handle = ? AND deleted_at IS NULL").bind(body.handle).first();
  if (existing) return problem(409, "handle_exists", "This handle already exists.", requestId);
  const now = runtime.now();
  const userId = runtime.id("usr");
  const deviceId = runtime.id("dev");
  const token = runtime.token();
  const expiresAt = now + 30 * 24 * 60 * 60 * 1e3;
  const requestedKind = body.device_kind === "browser_extension" ? "extension" : typeof body.device_kind === "string" ? body.device_kind : "pwa";
  const kind = ["web", "pwa", "extension"].includes(requestedKind) ? requestedKind : "pwa";
  const publicKey = typeof body.public_key === "string" ? body.public_key : "";
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users (id, handle, created_at, updated_at) VALUES (?, ?, ?, ?)").bind(userId, body.handle, now, now),
    env.DB.prepare(`INSERT INTO devices
      (id, user_id, kind, name_ciphertext, public_key, last_seen_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(deviceId, userId, kind, body.device_name.trim(), publicKey, now, now, now),
    env.DB.prepare("INSERT INTO sessions (token_hash, user_id, device_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)").bind(await sha256Hex(token), userId, deviceId, now, expiresAt)
  ]);
  const device = { id: deviceId, user_id: userId, kind, name_ciphertext: body.device_name.trim(), public_key: publicKey, created_at: now, last_seen_at: now, revoked_at: null };
  return json({
    user: { id: userId, handle: body.handle, created_at: iso(now) },
    device: deviceOut(device, deviceId),
    access_token: token,
    token_type: "bearer",
    expires_at: iso(expiresAt)
  }, { status: 201, headers: { "x-request-id": requestId } });
}

// infra/cloudflare/worker/src/files.ts
var MAX_FILE_BYTES = 25 * 1024 * 1024;
var UPLOAD_TICKET_TTL_MS = 2 * 60 * 1e3;
var DOWNLOAD_TICKET_TTL_MS = 2 * 60 * 1e3;
var ALIAS_TTL_MS = 180 * 24 * 60 * 60 * 1e3;
var TTL_SECONDS = /* @__PURE__ */ new Set([86400, 604800, 2592e3]);
function fileOut(row) {
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
    alias_expires_at: iso(row.alias_expires_at)
  };
}
async function ownedFile(env, userId, fileId) {
  return env.DB.prepare("SELECT * FROM files WHERE id = ? AND user_id = ?").bind(fileId, userId).first();
}
async function touchFilePushes(env, fileId, now) {
  await env.DB.prepare("UPDATE pushes SET modified_at = ? WHERE file_id = ? AND deleted_at IS NULL").bind(now, fileId).run();
}
function ttlPrefix(seconds) {
  return seconds === 86400 ? "1d" : seconds === 604800 ? "7d" : "30d";
}
async function initFile(request, env, auth, requestId, runtime) {
  const body = await bodyJson(request, requestId);
  const allowedFields = /* @__PURE__ */ new Set(["filename", "content_type", "size", "sha256", "expires_in"]);
  if (Object.keys(body).some((field) => !allowedFields.has(field))) {
    return problem(422, "unexpected_field", "The file initialization request contains an unsupported field.", requestId);
  }
  const filename = typeof body.filename === "string" ? body.filename.trim() : "";
  const contentType = typeof body.content_type === "string" ? body.content_type.trim() : "application/octet-stream";
  const size = typeof body.size === "number" && Number.isSafeInteger(body.size) ? body.size : -1;
  const expectedHash = typeof body.sha256 === "string" ? body.sha256.toLowerCase() : null;
  const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 2592e3;
  if (!filename || filename.length > 255) return problem(422, "invalid_filename", "filename must contain 1 to 255 characters.", requestId);
  if (!contentType || contentType.length > 200) return problem(422, "invalid_content_type", "content_type must contain 1 to 200 characters.", requestId);
  if (size < 0) return problem(422, "invalid_file_size", "size must be a non-negative integer.", requestId);
  if (size > MAX_FILE_BYTES) return problem(413, "file_too_large", `The file limit is ${MAX_FILE_BYTES} bytes.`, requestId);
  if (expectedHash != null && !/^[a-f0-9]{64}$/.test(expectedHash)) return problem(422, "invalid_sha256", "sha256 must be a hexadecimal SHA-256 digest.", requestId);
  if (!TTL_SECONDS.has(expiresIn)) return problem(422, "invalid_file_ttl", "expires_in must be 86400, 604800, or 2592000 seconds.", requestId);
  const now = runtime.now();
  const cleanup = await cleanupExpiredMetadata(env, runtime, size);
  if (cleanup.totalBytes + size > cleanup.effectiveBudgetBytes) {
    return problem(507, "storage_pressure", "Storage capacity is temporarily unavailable.", requestId);
  }
  const fileId = runtime.id("fil");
  const ticket = runtime.token();
  const tokenHash = await sha256Hex(ticket);
  const expiresAt = now + expiresIn * 1e3;
  const reservationExpiresAt = now + UPLOAD_TICKET_TTL_MS;
  const r2Key = `ttl/${ttlPrefix(expiresIn)}/${auth.user_id}/${fileId}/${crypto.randomUUID()}.bin`;
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO files
      (id, user_id, r2_key, original_name, content_type, expected_size, actual_size,
       expected_sha256, actual_sha256, state, created_at, completed_at, expires_at,
       deleted_at, delete_reason, alias_expires_at, upload_reservation_expires_at,
       r2_delete_attempts, r2_delete_retry_at, r2_delete_error_code)
      VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL, 'pending', ?, NULL, ?, NULL, NULL, ?, ?, 0, NULL, NULL)`).bind(fileId, auth.user_id, r2Key, filename, contentType, size, expectedHash, now, expiresAt, now + ALIAS_TTL_MS, reservationExpiresAt),
    env.DB.prepare(`INSERT INTO file_tickets
      (token_hash, user_id, file_id, purpose, created_at, expires_at, used_at)
      VALUES (?, ?, ?, 'upload', ?, ?, NULL)`).bind(tokenHash, auth.user_id, fileId, now, reservationExpiresAt)
  ]);
  const row = await ownedFile(env, auth.user_id, fileId);
  if (!row) throw new Error("created file is missing");
  const origin = new URL(request.url).origin;
  return json({
    file: fileOut(row),
    upload_url: `${origin}/mock-storage/uploads/${encodeURIComponent(ticket)}`,
    upload_method: "PUT",
    upload_expires_at: iso(reservationExpiresAt),
    upload_headers: { "content-type": "application/octet-stream" }
  }, { status: 201, headers: { "x-request-id": requestId } });
}
async function uploadFile(request, env, requestId, ticket, runtime) {
  const now = runtime.now();
  await cleanupExpiredMetadata(env, runtime);
  const tokenHash = await sha256Hex(ticket);
  const row = await env.DB.prepare(`SELECT f.*, t.expires_at AS ticket_expires_at, t.used_at AS ticket_used_at
    FROM file_tickets t JOIN files f ON f.id = t.file_id
    WHERE t.token_hash = ? AND t.purpose = 'upload'`).bind(tokenHash).first();
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
      upload_reservation_expires_at = NULL WHERE id = ? AND state = 'pending'`).bind(bytes.byteLength, actualHash, row.id),
    env.DB.prepare("UPDATE file_tickets SET used_at = ? WHERE token_hash = ? AND used_at IS NULL").bind(now, tokenHash),
    env.DB.prepare("UPDATE pushes SET modified_at = ? WHERE file_id = ? AND deleted_at IS NULL").bind(now, row.id)
  ]);
  const updated = await ownedFile(env, row.user_id, row.id);
  if (!updated) throw new Error("uploaded file is missing");
  return json(fileOut(updated), { headers: { "x-request-id": requestId } });
}
async function completeFile(env, auth, requestId, fileId, runtime) {
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
  if (actualHash !== row.actual_sha256 || row.expected_sha256 && actualHash !== row.expected_sha256) {
    return problem(422, "file_hash_mismatch", "Stored bytes do not match the initialized SHA-256.", requestId);
  }
  const now = runtime.now();
  await env.DB.prepare("UPDATE files SET state = 'ready', completed_at = ? WHERE id = ? AND state = 'uploaded'").bind(now, fileId).run();
  await touchFilePushes(env, fileId, now);
  const updated = await ownedFile(env, auth.user_id, fileId);
  if (!updated) throw new Error("completed file is missing");
  return json(fileOut(updated), { headers: { "x-request-id": requestId } });
}
async function getFile(env, auth, requestId, fileId) {
  const row = await ownedFile(env, auth.user_id, fileId);
  return row ? json(fileOut(row), { headers: { "x-request-id": requestId } }) : problem(404, "file_not_found", "File not found.", requestId);
}
async function issueDownloadTicket(env, userId, fileId, origin, runtime) {
  const row = await ownedFile(env, userId, fileId);
  if (!row || row.expires_at <= runtime.now() || row.state !== "ready") return null;
  const ticket = runtime.token();
  const now = runtime.now();
  const expiresAt = now + DOWNLOAD_TICKET_TTL_MS;
  await env.DB.prepare(`INSERT INTO file_tickets
    (token_hash, user_id, file_id, purpose, created_at, expires_at, used_at)
    VALUES (?, ?, ?, 'download', ?, ?, NULL)`).bind(await sha256Hex(ticket), userId, fileId, now, expiresAt).run();
  return { downloadUrl: `${origin}/mock-storage/downloads/${encodeURIComponent(ticket)}`, expiresAt };
}
async function createDownloadTicket(request, env, auth, requestId, fileId, runtime) {
  const row = await ownedFile(env, auth.user_id, fileId);
  if (!row) return problem(404, "file_not_found", "File not found.", requestId);
  if (row.expires_at <= runtime.now() || ["expired", "delete_pending", "deleted"].includes(row.state)) return problem(410, "file_expired", "The file is no longer available for download.", requestId);
  if (row.state !== "ready") return problem(409, "file_not_ready", "The file is not available for download yet.", requestId);
  const ticket = await issueDownloadTicket(env, auth.user_id, fileId, new URL(request.url).origin, runtime);
  if (!ticket) return problem(409, "file_not_ready", "The file is not available for download yet.", requestId);
  return json({ file_id: fileId, download_url: ticket.downloadUrl, expires_at: iso(ticket.expiresAt) }, {
    headers: { "x-request-id": requestId }
  });
}
async function downloadFile(env, requestId, ticket, runtime) {
  const row = await env.DB.prepare(`SELECT f.*, t.expires_at AS ticket_expires_at, t.used_at AS ticket_used_at
    FROM file_tickets t JOIN files f ON f.id = t.file_id
    WHERE t.token_hash = ? AND t.purpose = 'download'`).bind(await sha256Hex(ticket)).first();
  if (!row) return problem(403, "invalid_download_ticket", "The download ticket is invalid.", requestId);
  if (row.ticket_expires_at <= runtime.now()) return problem(410, "download_ticket_expired", "The download ticket has expired.", requestId);
  if (row.ticket_used_at != null) return problem(410, "download_ticket_used", "The download ticket has already been used.", requestId);
  if (row.state !== "ready" || row.expires_at <= runtime.now()) return problem(410, "file_expired", "The file is no longer available.", requestId);
  const object = await env.FILES.get(row.r2_key);
  if (!object) return problem(410, "object_missing", "The object bytes are missing.", requestId);
  const consumed = await env.DB.prepare("UPDATE file_tickets SET used_at = ? WHERE token_hash = ? AND used_at IS NULL").bind(runtime.now(), await sha256Hex(ticket)).run();
  if (consumed.meta.changes !== 1) return problem(410, "download_ticket_used", "The download ticket has already been used.", requestId);
  const headers = new Headers({
    "content-type": "application/octet-stream",
    "content-disposition": 'attachment; filename="pushbridge-file.bin"',
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    "x-request-id": requestId,
    "content-length": String(object.size),
    etag: object.httpEtag
  });
  return new Response(object.body, { headers });
}
async function deleteFile(env, auth, requestId, fileId, runtime) {
  let row = await ownedFile(env, auth.user_id, fileId);
  if (!row) return problem(404, "file_not_found", "File not found.", requestId);
  if (row.state === "deleted") return json(fileOut(row), { headers: { "x-request-id": requestId, "idempotent-replayed": "true" } });
  const now = runtime.now();
  await env.DB.batch([
    env.DB.prepare(`UPDATE files SET state = 'delete_pending', deleted_at = ?, delete_reason = 'user_deleted',
      r2_delete_retry_at = ? WHERE id = ?`).bind(now, now, fileId),
    env.DB.prepare("DELETE FROM file_tickets WHERE file_id = ? AND purpose = 'upload'").bind(fileId),
    env.DB.prepare("UPDATE pushes SET modified_at = ? WHERE file_id = ? AND deleted_at IS NULL").bind(now, fileId)
  ]);
  await cleanupExpiredMetadata(env, runtime);
  row = await ownedFile(env, auth.user_id, fileId);
  if (!row) throw new Error("deleted file is missing");
  if (row.state === "delete_pending") return problem(503, "file_delete_pending", "File deletion will be retried.", requestId);
  return json(fileOut(row), { headers: { "x-request-id": requestId } });
}
async function storageUsage(env, auth) {
  const row = await env.DB.prepare(`SELECT
    COALESCE(SUM(CASE WHEN state IN ('ready', 'delete_pending') THEN COALESCE(actual_size, expected_size) ELSE 0 END), 0) AS used_bytes,
    COALESCE(SUM(CASE WHEN state IN ('pending', 'uploaded') THEN expected_size ELSE 0 END), 0) AS reserved_bytes
    FROM files WHERE user_id = ?`).bind(auth.user_id).first();
  const usedBytes = Number(row?.used_bytes ?? 0);
  const reservedBytes = Number(row?.reserved_bytes ?? 0);
  const policy = storagePolicy(env);
  const global = await storageTotals(env);
  const ratio = global.totalBytes / policy.budgetBytes;
  return {
    used_bytes: usedBytes,
    reserved_bytes: reservedBytes,
    quota_bytes: policy.budgetBytes,
    reclaimable_bytes: usedBytes,
    pressure: ratio >= 0.95 ? "emergency" : ratio >= 0.85 ? "constrained" : ratio >= 0.7 ? "notice" : "normal",
    policy_id: "free-v1",
    default_retention_days: 30,
    early_eviction_possible: true
  };
}
async function handlePublicFileRoute(request, env, requestId, path, runtime) {
  const uploadMatch = path.match(/^\/mock-storage\/uploads\/([^/]+)$/);
  if (uploadMatch && request.method === "PUT") return uploadFile(request, env, requestId, decodeURIComponent(uploadMatch[1]), runtime);
  const downloadMatch = path.match(/^\/mock-storage\/downloads\/([^/]+)$/);
  if (downloadMatch && request.method === "GET") return downloadFile(env, requestId, decodeURIComponent(downloadMatch[1]), runtime);
  return null;
}
async function handleFileRoute(request, env, auth, requestId, path, runtime) {
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

// infra/cloudflare/worker/src/cursor.ts
async function encodeCursor(time, id, auth) {
  const payload = { v: 1, t: time, i: id, u: auth.user_id, d: auth.device_id };
  const encoded = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  return `${encoded}.${base64UrlEncode(await hmac(auth.cursor_key, encoded))}`;
}
async function decodeCursor(value, auth, requestId) {
  if (!value) return null;
  try {
    const [encoded, signature, extra] = value.split(".");
    if (!encoded || !signature || extra) throw new Error("invalid cursor shape");
    const expected = base64UrlEncode(await hmac(auth.cursor_key, encoded));
    if (signature.length !== expected.length) throw new Error("invalid cursor signature");
    let mismatch = 0;
    for (let index = 0; index < signature.length; index += 1) mismatch |= signature.charCodeAt(index) ^ expected.charCodeAt(index);
    if (mismatch !== 0) throw new Error("invalid cursor signature");
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(encoded)));
    const time = Number(payload.t);
    if (payload.v !== 1 || !Number.isSafeInteger(time) || typeof payload.i !== "string" || !payload.i || payload.u !== auth.user_id || payload.d !== auth.device_id) throw new Error("invalid cursor payload");
    return { time, id: payload.i };
  } catch {
    throw problem(400, "invalid_cursor", "The cursor is invalid or has been modified.", requestId);
  }
}

// infra/cloudflare/worker/src/web-push.ts
var encoder = new TextEncoder();
var MAX_WEB_PUSH_PLAINTEXT_BYTES = 3993;
var WEB_PUSH_RECORD_SIZE = 4096;
var DELIVERY_ATTEMPT_LIMIT = 3;
var TRANSIENT_SEND_ATTEMPTS = 2;
function concatenate(...arrays) {
  const result = new Uint8Array(arrays.reduce((total, value) => total + value.byteLength, 0));
  let offset = 0;
  for (const value of arrays) {
    result.set(value, offset);
    offset += value.byteLength;
  }
  return result;
}
function uint32(value) {
  const result = new Uint8Array(4);
  new DataView(result.buffer).setUint32(0, value, false);
  return result;
}
async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey("raw", ownedBuffer(ikm), "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({
    name: "HKDF",
    hash: "SHA-256",
    salt: ownedBuffer(salt),
    info: ownedBuffer(info)
  }, key, length * 8));
}
function validateWebPushKey(name, encoded, expectedLength) {
  const value = base64UrlDecode(encoded);
  if (value.byteLength !== expectedLength) throw new Error(`${name} has an invalid length`);
  return value;
}
async function encryptWebPushPayload(plaintext, receiverPublicKey, authenticationSecret) {
  if (plaintext.byteLength > MAX_WEB_PUSH_PLAINTEXT_BYTES) throw new Error("Web Push payload exceeds the RFC 8291 limit");
  const uaPublic = validateWebPushKey("p256dh", receiverPublicKey, 65);
  if (uaPublic[0] !== 4) throw new Error("p256dh is not an uncompressed P-256 point");
  const authSecret = validateWebPushKey("auth", authenticationSecret, 16);
  const applicationKeys = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const applicationPublic = new Uint8Array(await crypto.subtle.exportKey("raw", applicationKeys.publicKey));
  const receiverKey = await crypto.subtle.importKey(
    "raw",
    ownedBuffer(uaPublic),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );
  const sharedSecret = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "ECDH", public: receiverKey },
    applicationKeys.privateKey,
    256
  ));
  const keyInfo = concatenate(encoder.encode("WebPush: info\0"), uaPublic, applicationPublic);
  const inputKeyMaterial = await hkdf(authSecret, sharedSecret, keyInfo, 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const contentEncryptionKey = await hkdf(salt, inputKeyMaterial, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, inputKeyMaterial, encoder.encode("Content-Encoding: nonce\0"), 12);
  const aesKey2 = await crypto.subtle.importKey("raw", ownedBuffer(contentEncryptionKey), "AES-GCM", false, ["encrypt"]);
  const record = concatenate(plaintext, new Uint8Array([2]));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: ownedBuffer(nonce) },
    aesKey2,
    ownedBuffer(record)
  ));
  return concatenate(salt, uint32(WEB_PUSH_RECORD_SIZE), new Uint8Array([applicationPublic.byteLength]), applicationPublic, ciphertext);
}
function vapidPrivateKey(publicKey, privateKey) {
  if (publicKey.byteLength !== 65 || publicKey[0] !== 4 || privateKey.byteLength !== 32) {
    throw new Error("VAPID keys must be an uncompressed P-256 public key and a 32-byte private key");
  }
  return {
    kty: "EC",
    crv: "P-256",
    x: base64UrlEncode(publicKey.slice(1, 33)),
    y: base64UrlEncode(publicKey.slice(33, 65)),
    d: base64UrlEncode(privateKey),
    ext: true,
    key_ops: ["sign"]
  };
}
async function createVapidAuthorization(endpoint, publicKeyEncoded, privateKeyEncoded, subject, now) {
  const endpointUrl = new URL(endpoint);
  if (endpointUrl.protocol !== "https:") throw new Error("Web Push endpoint must use HTTPS");
  if (!subject.startsWith("mailto:") && !subject.startsWith("https://")) throw new Error("VAPID_SUBJECT must be a mailto or HTTPS URI");
  const publicKey = validateWebPushKey("VAPID_PUBLIC_KEY", publicKeyEncoded, 65);
  const privateKey = validateWebPushKey("VAPID_PRIVATE_KEY", privateKeyEncoded, 32);
  const header = base64UrlEncode(encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = base64UrlEncode(encoder.encode(JSON.stringify({
    aud: endpointUrl.origin,
    exp: Math.floor(now / 1e3) + 12 * 60 * 60,
    sub: subject
  })));
  const unsigned = `${header}.${claims}`;
  const signingKey = await crypto.subtle.importKey(
    "jwk",
    vapidPrivateKey(publicKey, privateKey),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  const signature = new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    signingKey,
    encoder.encode(unsigned)
  ));
  return `vapid t=${unsigned}.${base64UrlEncode(signature)}, k=${publicKeyEncoded}`;
}
async function sendWebPush(request, env, now, fetcher = fetch) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) throw new Error("VAPID configuration is incomplete");
  const body = await encryptWebPushPayload(encoder.encode(JSON.stringify(request.payload)), request.p256dh, request.auth);
  const authorization = await createVapidAuthorization(
    request.endpoint,
    env.VAPID_PUBLIC_KEY,
    env.VAPID_PRIVATE_KEY,
    env.VAPID_SUBJECT,
    now
  );
  const response = await fetcher(request.endpoint, {
    method: "POST",
    redirect: "manual",
    headers: {
      authorization,
      "content-encoding": "aes128gcm",
      "content-type": "application/octet-stream",
      ttl: "60",
      urgency: "high"
    },
    body: ownedBuffer(body)
  });
  if (response.status >= 200 && response.status < 300) return { status: response.status, outcome: "delivered" };
  if (response.status === 404 || response.status === 410) return { status: response.status, outcome: "gone" };
  return { status: response.status, outcome: "retryable" };
}
function asText(value) {
  return typeof value === "string" ? value : new TextDecoder().decode(value);
}
function subscriptionAad(row, field) {
  return `pushbridge:web-push:${row.user_id}:${row.device_id}:${row.id}:${field}`;
}
async function decryptSubscription(row, dataKey) {
  return {
    endpoint: await decryptText(asText(row.endpoint_ciphertext), row.endpoint_nonce, dataKey, subscriptionAad(row, "endpoint")),
    p256dh: await decryptText(asText(row.p256dh_ciphertext), row.p256dh_nonce, dataKey, subscriptionAad(row, "p256dh")),
    auth: await decryptText(asText(row.auth_ciphertext), row.auth_nonce, dataKey, subscriptionAad(row, "auth"))
  };
}
function deliveryPayload(row, subscription, origin, downloadUrl, deliveryToken, deliveryTokenExpiresAt) {
  return {
    version: 1,
    kind: "file",
    storage_namespace: subscription.storage_namespace,
    file_download: {
      push_id: row.push_id,
      file_id: row.file_id,
      size: Number(row.actual_size ?? row.expected_size),
      mime_type: "application/octet-stream",
      download_url: downloadUrl
    },
    file_delivery: {
      delivery_id: row.id,
      token: deliveryToken,
      token_expires_at: new Date(deliveryTokenExpiresAt).toISOString(),
      events_url: `${origin}/api/v1/file-deliveries/${encodeURIComponent(row.id)}/events`
    }
  };
}
async function recordSubscriptionSuccess(env, subscriptionId, runtime) {
  await env.DB.prepare(`UPDATE web_push_subscriptions SET consecutive_failures = 0, last_failure_code = NULL,
    last_success_at = ?, updated_at = ? WHERE id = ?`).bind(runtime.now(), runtime.now(), subscriptionId).run();
}
async function recordSubscriptionFailure(env, subscriptionId, code, revoke, runtime) {
  await env.DB.prepare(`UPDATE web_push_subscriptions SET consecutive_failures = consecutive_failures + 1,
    last_failure_code = ?, updated_at = ?, revoked_at = CASE WHEN ? THEN COALESCE(revoked_at, ?) ELSE revoked_at END
    WHERE id = ?`).bind(code, runtime.now(), revoke ? 1 : 0, runtime.now(), subscriptionId).run();
}
async function sendWithLimitedRetry(request, env, runtime, fetcher) {
  let result = { status: 0, outcome: "retryable" };
  for (let attempt = 0; attempt < TRANSIENT_SEND_ATTEMPTS; attempt += 1) {
    try {
      result = await sendWebPush(request, env, runtime.now(), fetcher);
    } catch {
      result = { status: 0, outcome: "retryable" };
    }
    if (result.outcome !== "retryable") return result;
  }
  return result;
}
function webPushDeliveryConfigured(env) {
  return Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT && env.WEB_PUSH_DATA_KEY);
}
async function deliverFilePush(env, pushId, origin, runtime, fetcher = fetch) {
  if (!webPushDeliveryConfigured(env)) return;
  const deliveries = await env.DB.prepare(`SELECT d.*, f.actual_size, f.expected_size
    FROM file_deliveries d JOIN files f ON f.id = d.file_id
    WHERE d.push_id = ? AND d.state IN ('pending', 'failed_retryable') AND d.attempt_count < ?
    ORDER BY d.id`).bind(pushId, DELIVERY_ATTEMPT_LIMIT).all();
  for (const delivery of deliveries.results) {
    const subscriptions = await env.DB.prepare(`SELECT * FROM web_push_subscriptions
      WHERE user_id = ? AND device_id = ? AND revoked_at IS NULL ORDER BY created_at, id`).bind(delivery.user_id, delivery.destination_device_id).all();
    if (subscriptions.results.length === 0) continue;
    const deliveryToken = await issueDeliveryToken(env, delivery.id, runtime);
    if (!deliveryToken) continue;
    let delivered = false;
    let failureCode = "web_push_failed";
    for (const subscription of subscriptions.results) {
      try {
        const ticket = await issueDownloadTicket(env, delivery.user_id, delivery.file_id, origin, runtime);
        if (!ticket) {
          failureCode = "file_not_ready";
          break;
        }
        const secrets = await decryptSubscription(subscription, env.WEB_PUSH_DATA_KEY);
        const result = await sendWithLimitedRetry({
          ...secrets,
          payload: deliveryPayload(delivery, subscription, origin, ticket.downloadUrl, deliveryToken.token, deliveryToken.expiresAt)
        }, env, runtime, fetcher);
        if (result.outcome === "delivered") {
          delivered = true;
          await recordSubscriptionSuccess(env, subscription.id, runtime);
        } else {
          const gone = result.outcome === "gone";
          failureCode = gone ? "web_push_subscription_gone" : `web_push_http_${result.status || "network"}`;
          await recordSubscriptionFailure(env, subscription.id, failureCode, gone, runtime);
        }
      } catch {
        failureCode = "web_push_crypto_error";
        await recordSubscriptionFailure(env, subscription.id, failureCode, false, runtime);
      }
    }
    if (delivered) await markDeliveryNotified(env, delivery.id, runtime);
    else await markDeliveryFailed(env, delivery.id, failureCode, runtime);
  }
}

// infra/cloudflare/worker/src/pushes.ts
var encoder2 = new TextEncoder();
var PUSH_SELECT = `SELECT
  p.*,
  f.state AS file_ref_state,
  COALESCE(f.actual_size, f.expected_size) AS file_ref_size,
  f.expires_at AS file_ref_expires_at,
  f.deleted_at AS file_ref_deleted_at,
  f.delete_reason AS file_ref_delete_reason,
  f.alias_expires_at AS file_ref_alias_expires_at
  FROM pushes p LEFT JOIN files f ON f.id = p.file_id`;
function pushOut(row, currentDeviceId) {
  const targetKind = row.target_kind ?? (row.target_device_id ? "device" : "all_other_devices");
  return {
    id: row.id,
    user_id: row.user_id,
    source_device_id: row.source_device_id,
    target: { kind: targetKind, device_id: targetKind === "device" ? row.target_device_id : null },
    type: row.type,
    file_id: row.file_id ?? null,
    file_ref: row.file_id && row.file_ref_state ? {
      id: row.file_id,
      state: row.file_ref_state,
      size: row.file_ref_size == null ? null : Number(row.file_ref_size),
      expires_at: iso(row.file_ref_expires_at),
      deleted_at: iso(row.file_ref_deleted_at),
      delete_reason: row.file_ref_delete_reason ?? null,
      alias_expires_at: iso(row.file_ref_alias_expires_at)
    } : null,
    payload_version: row.payload_version ?? 1,
    payload: row.payload_json ? JSON.parse(row.payload_json) : {},
    ciphertext: null,
    nonce: null,
    client_guid: row.client_guid,
    pinned: row.pinned_at != null,
    status: row.status ?? (row.deleted_at ? "deleted" : row.dismissed_at ? "dismissed" : "active"),
    created_at: iso(row.created_at),
    modified_at: iso(row.modified_at),
    expires_at: iso(row.expires_at),
    expired_at: iso(row.expired_at),
    dismissed_at: iso(row.dismissed_at),
    deleted_at: iso(row.deleted_at),
    is_for_current_device: targetKind === "all_devices" || targetKind === "all_other_devices" && row.source_device_id !== currentDeviceId || targetKind === "device" && row.target_device_id === currentDeviceId
  };
}
function payloadEquals(row, type, targetKind, targetDeviceId, fileId, payloadJson) {
  return row.type === type && row.target_kind === targetKind && (row.target_device_id ?? null) === targetDeviceId && (row.file_id ?? null) === fileId && (row.payload_json ?? "{}") === payloadJson;
}
async function createPush(request, env, auth, requestId, runtime) {
  const body = await bodyJson(request, requestId);
  const type = typeof body.type === "string" ? body.type : "";
  if (!["note", "link", "file"].includes(type)) return problem(422, "unsupported_push_type", "Push type must be note, link, or file.", requestId);
  const idempotencyKey = request.headers.get("idempotency-key");
  if (idempotencyKey && idempotencyKey.length > 200) return problem(422, "invalid_idempotency_key", "Idempotency-Key must be 200 characters or fewer.", requestId);
  if (idempotencyKey && typeof body.client_guid === "string" && idempotencyKey !== body.client_guid) {
    return problem(422, "idempotency_key_mismatch", "Idempotency-Key and client_guid must match.", requestId);
  }
  const clientGuid = typeof body.client_guid === "string" ? body.client_guid : idempotencyKey ?? runtime.id("job");
  const payload = body.payload && typeof body.payload === "object" && !Array.isArray(body.payload) ? body.payload : {};
  const payloadJson = JSON.stringify(payload);
  if (encoder2.encode(payloadJson).byteLength > 2e6) return problem(413, "payload_too_large", "Push payload is too large.", requestId);
  if (type === "link") {
    const url = payload.url;
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return problem(422, "invalid_link", "Link URLs must use http or https.", requestId);
  }
  const fileId = type === "file" && typeof body.file_id === "string" ? body.file_id : null;
  if (type === "file" && !fileId) return problem(422, "file_id_required", "A file push requires file_id.", requestId);
  const target = body.target && typeof body.target === "object" && !Array.isArray(body.target) ? body.target : { kind: "all_other_devices" };
  const targetKind = typeof target.kind === "string" ? target.kind : "all_other_devices";
  if (!["all_other_devices", "all_devices", "device"].includes(targetKind)) return problem(422, "invalid_target", "Invalid target kind.", requestId);
  const targetDeviceId = targetKind === "device" && typeof target.device_id === "string" ? target.device_id : null;
  if (targetKind === "device" && !targetDeviceId) return problem(422, "invalid_target", "device_id is required for a device target.", requestId);
  if (targetDeviceId) {
    const targetDevice = await env.DB.prepare("SELECT id FROM devices WHERE id = ? AND user_id = ? AND revoked_at IS NULL").bind(targetDeviceId, auth.user_id).first();
    if (!targetDevice) return problem(422, "invalid_target", "The target device is unavailable.", requestId);
  }
  const replay = await env.DB.prepare(`${PUSH_SELECT} WHERE p.user_id = ? AND p.client_guid = ?`).bind(auth.user_id, clientGuid).first();
  if (replay) {
    if (!payloadEquals(replay, type, targetKind, targetDeviceId, fileId, payloadJson)) {
      return problem(409, "idempotency_conflict", "The Idempotency-Key was already used with a different request.", requestId);
    }
    await ensureFileDeliveries(env, replay, runtime);
    await deliverFilePush(env, replay.id, new URL(request.url).origin, runtime);
    return json(pushOut(replay, auth.device_id), { headers: { "idempotent-replayed": "true", "x-request-id": requestId } });
  }
  let fileAliasExpiresAt = null;
  if (fileId) {
    const file = await env.DB.prepare("SELECT state, expires_at, alias_expires_at FROM files WHERE id = ? AND user_id = ?").bind(fileId, auth.user_id).first();
    if (!file) return problem(404, "file_not_found", "The referenced file does not exist for this account.", requestId);
    if (file.state !== "ready" || Number(file.expires_at) <= runtime.now()) return problem(409, "file_not_ready", "The referenced file is expired, deleted, or not ready.", requestId);
    fileAliasExpiresAt = Number(file.alias_expires_at);
  }
  const now = runtime.now();
  const expiresIn = typeof body.expires_in === "number" && Number.isFinite(body.expires_in) ? body.expires_in : 2592e3;
  const expiresAt = fileAliasExpiresAt ?? now + Math.min(Math.max(1, expiresIn), 2592e3) * 1e3;
  const pushId = runtime.id("psh");
  try {
    await env.DB.prepare(`INSERT INTO pushes
      (id, user_id, source_device_id, target_device_id, target_kind, type, file_id, payload_version,
       ciphertext, nonce, payload_json, client_guid, created_at, modified_at, expires_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 'active')`).bind(pushId, auth.user_id, auth.device_id, targetDeviceId, targetKind, type, fileId, "", "", payloadJson, clientGuid, now, now, expiresAt).run();
  } catch {
    const raced = await env.DB.prepare(`${PUSH_SELECT} WHERE p.user_id = ? AND p.client_guid = ?`).bind(auth.user_id, clientGuid).first();
    if (!raced || !payloadEquals(raced, type, targetKind, targetDeviceId, fileId, payloadJson)) throw new Error("push insert failed");
    await ensureFileDeliveries(env, raced, runtime);
    await deliverFilePush(env, raced.id, new URL(request.url).origin, runtime);
    return json(pushOut(raced, auth.device_id), { headers: { "idempotent-replayed": "true", "x-request-id": requestId } });
  }
  const row = await env.DB.prepare(`${PUSH_SELECT} WHERE p.id = ?`).bind(pushId).first();
  if (!row) throw new Error("created push is missing");
  await ensureFileDeliveries(env, row, runtime);
  await deliverFilePush(env, row.id, new URL(request.url).origin, runtime);
  return json(pushOut(row, auth.device_id), { status: 201, headers: { "x-request-id": requestId } });
}
async function listPushes(url, env, auth, requestId) {
  const requestedLimit = Number(url.searchParams.get("limit"));
  const limit = Math.min(100, Math.max(1, Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.floor(requestedLimit) : 100));
  const cursor = await decodeCursor(url.searchParams.get("after"), auth, requestId);
  const includeDeleted = url.searchParams.get("include_deleted") !== "false";
  const deletedClause = includeDeleted ? "" : " AND p.deleted_at IS NULL";
  const result = cursor ? await env.DB.prepare(`${PUSH_SELECT} WHERE p.user_id = ?${deletedClause} AND (p.modified_at > ? OR (p.modified_at = ? AND p.id > ?)) ORDER BY p.modified_at, p.id LIMIT ?`).bind(auth.user_id, cursor.time, cursor.time, cursor.id, limit + 1).all() : await env.DB.prepare(`${PUSH_SELECT} WHERE p.user_id = ?${deletedClause} ORDER BY p.modified_at, p.id LIMIT ?`).bind(auth.user_id, limit + 1).all();
  const rows = result.results.slice(0, limit);
  const last = rows.at(-1);
  return {
    items: rows.map((row) => pushOut(row, auth.device_id)),
    next_cursor: last ? await encodeCursor(last.modified_at, last.id, auth) : null,
    has_more: result.results.length > limit
  };
}
async function getPush(env, auth, requestId, pushId) {
  const row = await env.DB.prepare(`${PUSH_SELECT} WHERE p.id = ? AND p.user_id = ?`).bind(pushId, auth.user_id).first();
  return row ? json(pushOut(row, auth.device_id), { headers: { "x-request-id": requestId } }) : problem(404, "not_found", "Push not found.", requestId);
}
async function mutatePush(request, env, auth, requestId, pushId, runtime) {
  const row = await env.DB.prepare(`${PUSH_SELECT} WHERE p.id = ? AND p.user_id = ?`).bind(pushId, auth.user_id).first();
  if (!row) return problem(404, "not_found", "Push not found.", requestId);
  const modifiedAt = Math.max(runtime.now(), Number(row.modified_at) + 1);
  if (request.method === "DELETE") {
    await env.DB.prepare("UPDATE pushes SET deleted_at = ?, modified_at = ?, status = 'deleted' WHERE id = ? AND user_id = ?").bind(modifiedAt, modifiedAt, pushId, auth.user_id).run();
  } else {
    const body = await bodyJson(request, requestId);
    const dismissedAt = body.dismissed === true ? modifiedAt : body.dismissed === false ? null : row.dismissed_at;
    const pinnedAt = body.pinned === true ? modifiedAt : body.pinned === false ? null : row.pinned_at;
    const status = dismissedAt ? "dismissed" : "active";
    await env.DB.prepare("UPDATE pushes SET dismissed_at = ?, pinned_at = ?, modified_at = ?, status = ? WHERE id = ? AND user_id = ?").bind(dismissedAt, pinnedAt, modifiedAt, status, pushId, auth.user_id).run();
  }
  const updated = await env.DB.prepare(`${PUSH_SELECT} WHERE p.id = ?`).bind(pushId).first();
  if (!updated) throw new Error("updated push is missing");
  return json(pushOut(updated, auth.device_id), { headers: { "x-request-id": requestId } });
}

// infra/cloudflare/worker/src/subscriptions.ts
function registrationEnabled(env) {
  return Boolean(env.VAPID_PUBLIC_KEY && env.WEB_PUSH_DATA_KEY);
}
function deliveryEnabled(env) {
  return registrationEnabled(env) && webPushDeliveryConfigured(env);
}
function validPublicKey(value) {
  try {
    const bytes = base64UrlDecode(value);
    return bytes.byteLength === 65 && bytes[0] === 4;
  } catch {
    return false;
  }
}
function webPushConfig(env, requestId) {
  const registration = registrationEnabled(env) && validPublicKey(env.VAPID_PUBLIC_KEY ?? "");
  return json({
    subscription_registration: registration,
    delivery: registration && deliveryEnabled(env),
    vapid_public_key: registration ? env.VAPID_PUBLIC_KEY : ""
  }, { headers: { "x-request-id": requestId } });
}
function asText2(value) {
  return typeof value === "string" ? value : new TextDecoder().decode(value);
}
function aad(row, field) {
  return `pushbridge:web-push:${row.user_id}:${row.device_id}:${row.id}:${field}`;
}
async function subscriptionOut(row, env) {
  const key = env.WEB_PUSH_DATA_KEY;
  if (!key) throw new Error("WEB_PUSH_DATA_KEY is unavailable");
  return {
    id: row.id,
    device_id: row.device_id,
    endpoint: await decryptText(asText2(row.endpoint_ciphertext), row.endpoint_nonce, key, aad(row, "endpoint")),
    created_at: iso(row.created_at),
    revoked_at: iso(row.revoked_at)
  };
}
function parseSubscription(body, requestId) {
  const allowed = /* @__PURE__ */ new Set(["endpoint", "p256dh", "auth", "storage_namespace", "local_cache_max_bytes"]);
  if (Object.keys(body).some((field) => !allowed.has(field))) throw problem(422, "unexpected_field", "The subscription contains an unsupported field.", requestId);
  const endpoint = typeof body.endpoint === "string" ? body.endpoint : "";
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw problem(422, "invalid_subscription_endpoint", "endpoint must be an absolute HTTPS URL.", requestId);
  }
  if (url.protocol !== "https:" || endpoint.length > 4096) throw problem(422, "invalid_subscription_endpoint", "endpoint must be an absolute HTTPS URL.", requestId);
  const p256dh = typeof body.p256dh === "string" ? body.p256dh : "";
  const auth = typeof body.auth === "string" ? body.auth : "";
  try {
    if (base64UrlDecode(p256dh).byteLength !== 65 || base64UrlDecode(auth).byteLength !== 16) throw new Error("invalid key length");
  } catch {
    throw problem(422, "invalid_subscription_keys", "p256dh and auth must be valid Web Push base64url keys.", requestId);
  }
  const storageNamespace = body.storage_namespace == null ? null : typeof body.storage_namespace === "string" ? body.storage_namespace.trim() : "";
  if (storageNamespace != null && (!storageNamespace || storageNamespace.length > 200)) throw problem(422, "invalid_storage_namespace", "storage_namespace must contain 1 to 200 characters.", requestId);
  const localCacheMaxBytes = body.local_cache_max_bytes == null ? null : typeof body.local_cache_max_bytes === "number" && Number.isSafeInteger(body.local_cache_max_bytes) ? body.local_cache_max_bytes : -1;
  if (localCacheMaxBytes != null && (localCacheMaxBytes < 0 || localCacheMaxBytes > 2147483647)) throw problem(422, "invalid_local_cache_limit", "local_cache_max_bytes is outside the supported range.", requestId);
  return { endpoint, p256dh, auth, storageNamespace, localCacheMaxBytes };
}
async function createSubscription(request, env, authContext, requestId, runtime) {
  if (!registrationEnabled(env)) return problem(409, "web_push_registration_disabled", "Web Push subscription registration is disabled.", requestId);
  const input = parseSubscription(await bodyJson(request, requestId), requestId);
  const key = env.WEB_PUSH_DATA_KEY;
  const endpointHash = await sha256Hex(input.endpoint);
  const existing = await env.DB.prepare(`SELECT * FROM web_push_subscriptions
    WHERE user_id = ? AND device_id = ? AND endpoint_hash = ?`).bind(authContext.user_id, authContext.device_id, endpointHash).first();
  const now = runtime.now();
  const id = existing?.id ?? runtime.id("sub");
  const rowKey = { id, user_id: authContext.user_id, device_id: authContext.device_id };
  const endpoint = await encryptText(input.endpoint, key, aad(rowKey, "endpoint"));
  const p256dh = await encryptText(input.p256dh, key, aad(rowKey, "p256dh"));
  const auth = await encryptText(input.auth, key, aad(rowKey, "auth"));
  if (existing) {
    await env.DB.prepare(`UPDATE web_push_subscriptions SET endpoint_ciphertext = ?, endpoint_nonce = ?,
      p256dh_ciphertext = ?, p256dh_nonce = ?, auth_ciphertext = ?, auth_nonce = ?, storage_namespace = ?,
      local_cache_max_bytes = ?, updated_at = ?, revoked_at = NULL WHERE id = ?`).bind(
      endpoint.ciphertext,
      endpoint.nonce,
      p256dh.ciphertext,
      p256dh.nonce,
      auth.ciphertext,
      auth.nonce,
      input.storageNamespace,
      input.localCacheMaxBytes,
      now,
      id
    ).run();
  } else {
    await env.DB.prepare(`INSERT INTO web_push_subscriptions
      (id, user_id, device_id, endpoint_ciphertext, endpoint_hash, endpoint_nonce, p256dh_ciphertext,
       p256dh_nonce, auth_ciphertext, auth_nonce, storage_namespace, local_cache_max_bytes,
       created_at, updated_at, revoked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`).bind(
      id,
      authContext.user_id,
      authContext.device_id,
      endpoint.ciphertext,
      endpointHash,
      endpoint.nonce,
      p256dh.ciphertext,
      p256dh.nonce,
      auth.ciphertext,
      auth.nonce,
      input.storageNamespace,
      input.localCacheMaxBytes,
      now,
      now
    ).run();
  }
  const row = await env.DB.prepare("SELECT * FROM web_push_subscriptions WHERE id = ?").bind(id).first();
  if (!row) throw new Error("created subscription is missing");
  return json(await subscriptionOut(row, env), { status: existing ? 200 : 201, headers: { "x-request-id": requestId } });
}
async function listSubscriptions(env, authContext, requestId) {
  if (!registrationEnabled(env)) return problem(409, "web_push_registration_disabled", "Web Push subscription registration is disabled.", requestId);
  const rows = await env.DB.prepare(`SELECT * FROM web_push_subscriptions
    WHERE user_id = ? AND device_id = ? AND revoked_at IS NULL ORDER BY created_at, id`).bind(authContext.user_id, authContext.device_id).all();
  return json(await Promise.all(rows.results.map((row) => subscriptionOut(row, env))), { headers: { "x-request-id": requestId } });
}
async function revokeSubscription(env, authContext, requestId, subscriptionId, runtime) {
  const result = await env.DB.prepare(`UPDATE web_push_subscriptions SET revoked_at = ?, updated_at = ?
    WHERE id = ? AND user_id = ? AND device_id = ? AND revoked_at IS NULL`).bind(runtime.now(), runtime.now(), subscriptionId, authContext.user_id, authContext.device_id).run();
  if (result.meta.changes === 0) return problem(404, "subscription_not_found", "Active subscription not found for the current device.", requestId);
  return new Response(null, { status: 204, headers: { "x-request-id": requestId, "cache-control": "no-store" } });
}
async function handleSubscriptionRoute(request, env, authContext, requestId, path, runtime) {
  if (path === "/v1/web-push-subscriptions" && request.method === "POST") return createSubscription(request, env, authContext, requestId, runtime);
  if (path === "/v1/web-push-subscriptions" && request.method === "GET") return listSubscriptions(env, authContext, requestId);
  const match = path.match(/^\/v1\/web-push-subscriptions\/([^/]+)$/);
  if (match && request.method === "DELETE") return revokeSubscription(env, authContext, requestId, decodeURIComponent(match[1]), runtime);
  return null;
}

// infra/cloudflare/worker/src/system.ts
function retention(env) {
  try {
    return JSON.parse(env.FILE_RETENTION_POLICY ?? "{}");
  } catch {
    return {};
  }
}
function capabilities(env) {
  const policy = retention(env);
  const defaultSeconds = Number(policy.default ?? policy.default_seconds ?? policy.default_days * 86400) || 2592e3;
  return {
    api_version: "0.2.0-worker-poc",
    environment_id: env.APP_ENVIRONMENT ?? "cloudflare-worker",
    features: {
      realtime: false,
      web_push_delivery: webPushDeliveryConfigured(env),
      web_push_subscription_registration: Boolean(env.VAPID_PUBLIC_KEY && env.WEB_PUSH_DATA_KEY),
      e2ee: false,
      direct_upload: false,
      device_registration: true
    },
    limits: {
      max_file_bytes: 26214400,
      max_push_payload_bytes: 2e6,
      file_ttl_seconds: [86400, 604800, 2592e3],
      default_push_ttl_seconds: 2592e3,
      default_file_ttl_seconds: defaultSeconds,
      file_alias_ttl_seconds: Number(policy.alias_days) * 86400 || 15552e3,
      max_devices: 10
    },
    transports: { realtime: ["poll"], upload: ["server-ticket"] },
    recommended_poll_interval_seconds: 30
  };
}

// infra/cloudflare/worker/src/router.ts
function createRouter(runtime) {
  return async (request, env) => {
    const url = new URL(request.url);
    const requestId = getRequestId(request);
    try {
      if (request.method === "GET" && url.pathname === "/healthz") {
        return json({ ok: true, service: env.APP_NAME, environment: env.APP_ENVIRONMENT, requestId });
      }
      if (request.method === "GET" && url.pathname === "/health") {
        return json({ status: "ok", service: env.APP_NAME ?? "pushbridge", environment: env.APP_ENVIRONMENT ?? "unknown", request_id: requestId });
      }
      if (request.method === "GET" && url.pathname === "/api/bootstrap/status") {
        return json({
          ok: true,
          requestId,
          bootstrap: false,
          dev_bootstrap_enabled: env.ENABLE_DEV_BOOTSTRAP === "true" && env.APP_ENVIRONMENT !== "production",
          message: "Cloudflare application API is active.",
          bindings: { d1: Boolean(env.DB), r2: Boolean(env.FILES), durableObject: Boolean(env.USER_HUB), queue: Boolean(env.DELIVERY_QUEUE) },
          policy: { fileRetention: retention(env) }
        });
      }
      const path = url.pathname.replace(/^\/api\/v1/, "/v1");
      const publicFileResponse = await handlePublicFileRoute(request, env, requestId, url.pathname, runtime);
      if (publicFileResponse) return publicFileResponse;
      const publicDeliveryResponse = await handlePublicDeliveryRoute(request, env, requestId, path, runtime);
      if (publicDeliveryResponse) return publicDeliveryResponse;
      if (request.method === "GET" && path === "/v1/system/capabilities") return json(capabilities(env), { headers: { "x-request-id": requestId } });
      if (request.method === "GET" && path === "/v1/web-push-config") return webPushConfig(env, requestId);
      if (request.method === "POST" && path === "/v1/auth/bootstrap") return bootstrap(request, env, requestId, runtime);
      if (!path.startsWith("/v1/")) return problem(404, "not_found", "Endpoint not found.", requestId);
      const auth = await authenticate(request, env, requestId, runtime);
      if (request.method === "GET" && path === "/v1/devices") return json(await listDevices(env, auth), { headers: { "x-request-id": requestId } });
      if (request.method === "GET" && path === "/v1/devices/me") return json(await currentDevice(env, auth), { headers: { "x-request-id": requestId } });
      if (request.method === "POST" && path === "/v1/devices/link") return linkDevice(request, env, auth, requestId, runtime);
      const deviceMatch = path.match(/^\/v1\/devices\/([^/]+)$/);
      if (deviceMatch && (request.method === "PATCH" || request.method === "DELETE")) {
        return mutateDevice(request, env, auth, requestId, decodeURIComponent(deviceMatch[1]), runtime);
      }
      if (request.method === "POST" && path === "/v1/pushes") return createPush(request, env, auth, requestId, runtime);
      if (request.method === "GET" && path === "/v1/pushes") return json(await listPushes(url, env, auth, requestId), { headers: { "x-request-id": requestId } });
      const pushMatch = path.match(/^\/v1\/pushes\/([^/]+)$/);
      if (pushMatch && request.method === "GET") return getPush(env, auth, requestId, decodeURIComponent(pushMatch[1]));
      if (pushMatch && (request.method === "PATCH" || request.method === "DELETE")) {
        return mutatePush(request, env, auth, requestId, decodeURIComponent(pushMatch[1]), runtime);
      }
      if (request.method === "GET" && path === "/v1/storage/usage") return json(await storageUsage(env, auth), { headers: { "x-request-id": requestId } });
      const deliveryListMatch = path.match(/^\/v1\/files\/([^/]+)\/deliveries$/);
      if (deliveryListMatch && request.method === "GET") return listFileDeliveries(env, auth, requestId, decodeURIComponent(deliveryListMatch[1]));
      const fileResponse = await handleFileRoute(request, env, auth, requestId, path, runtime);
      if (fileResponse) return fileResponse;
      const subscriptionResponse = await handleSubscriptionRoute(request, env, auth, requestId, path, runtime);
      if (subscriptionResponse) return subscriptionResponse;
      return problem(501, "not_implemented", "This application endpoint is not implemented.", requestId);
    } catch (error) {
      if (error instanceof Response) return error;
      console.error("request failed", { requestId, error: error instanceof Error ? error.name : "unknown" });
      return problem(500, "internal_error", "The Worker encountered an internal error.", requestId);
    }
  };
}

// infra/cloudflare/worker/src/user-hub.ts
var UserHub = class {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    void this.state;
    void this.env;
  }
  state;
  env;
  async fetch() {
    return json({ error: "not_implemented" }, { status: 501 });
  }
};

// infra/cloudflare/worker/src/index.ts
function createWorker(overrides = {}) {
  const runtime = createRuntime(overrides);
  const route = createRouter(runtime);
  return {
    fetch(request, env) {
      return route(request, env);
    },
    scheduled(_controller, env, ctx) {
      ctx.waitUntil(cleanupExpiredMetadata(env, runtime));
    },
    queue(batch) {
      for (const message of batch.messages) message.ack();
    }
  };
}
var index_default = createWorker();
export {
  UserHub,
  createWorker,
  index_default as default
};
