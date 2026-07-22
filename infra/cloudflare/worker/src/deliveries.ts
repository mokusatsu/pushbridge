import { sha256Hex } from "./crypto";
import { bodyJson, json, problem } from "./response";
import { iso } from "./runtime";
import type { AuthContext, Env, FileDeliveryRow, PushRow, Runtime } from "./types";

const ACK_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

function deliveryOut(row: FileDeliveryRow): Record<string, unknown> {
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
    attempt_count: Number(row.attempt_count),
  };
}

export async function ensureFileDeliveries(env: Env, push: PushRow, runtime: Runtime): Promise<void> {
  if (push.type !== "file" || !push.file_id) return;
  const targetKind = push.target_kind ?? (push.target_device_id ? "device" : "all_other_devices");
  let devices;
  if (targetKind === "device") {
    devices = await env.DB.prepare("SELECT id FROM devices WHERE id = ? AND user_id = ? AND revoked_at IS NULL")
      .bind(push.target_device_id, push.user_id).all<{ id: string }>();
  } else if (targetKind === "all_devices") {
    devices = await env.DB.prepare("SELECT id FROM devices WHERE user_id = ? AND revoked_at IS NULL ORDER BY id")
      .bind(push.user_id).all<{ id: string }>();
  } else {
    devices = await env.DB.prepare("SELECT id FROM devices WHERE user_id = ? AND id != ? AND revoked_at IS NULL ORDER BY id")
      .bind(push.user_id, push.source_device_id).all<{ id: string }>();
  }
  const now = runtime.now();
  if (devices.results.length === 0) return;
  await env.DB.batch(devices.results.map((device) => env.DB.prepare(`INSERT OR IGNORE INTO file_deliveries
    (id, user_id, push_id, file_id, destination_device_id, state, created_at, updated_at, attempt_count)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, 0)`)
    .bind(runtime.id("fdl"), push.user_id, push.id, push.file_id, device.id, now, now)));
}

export async function issueDeliveryToken(env: Env, deliveryId: string, runtime: Runtime): Promise<{ token: string; expiresAt: number } | null> {
  const token = runtime.token();
  const expiresAt = runtime.now() + ACK_TOKEN_TTL_MS;
  const result = await env.DB.prepare(`UPDATE file_deliveries SET ack_token_hash = ?, ack_token_expires_at = ?,
    updated_at = ?, attempt_count = attempt_count + 1
    WHERE id = ? AND state IN ('pending', 'notified', 'failed_retryable')`)
    .bind(await sha256Hex(token), expiresAt, runtime.now(), deliveryId).run();
  return result.meta.changes === 1 ? { token, expiresAt } : null;
}

export async function markDeliveryNotified(env: Env, deliveryId: string, runtime: Runtime): Promise<void> {
  const now = runtime.now();
  await env.DB.prepare(`UPDATE file_deliveries SET state = 'notified', notified_at = COALESCE(notified_at, ?),
    updated_at = ?, failure_code = NULL WHERE id = ? AND state IN ('pending', 'notified', 'failed_retryable')`)
    .bind(now, now, deliveryId).run();
}

export async function markDeliveryFailed(env: Env, deliveryId: string, failureCode: string, runtime: Runtime): Promise<void> {
  const now = runtime.now();
  await env.DB.prepare(`UPDATE file_deliveries SET state = 'failed_retryable', failed_at = ?, updated_at = ?,
    failure_code = ? WHERE id = ? AND state IN ('pending', 'notified', 'failed_retryable')`)
    .bind(now, now, failureCode.slice(0, 100), deliveryId).run();
}

export async function listFileDeliveries(env: Env, auth: AuthContext, requestId: string, fileId: string): Promise<Response> {
  const owned = await env.DB.prepare("SELECT id FROM files WHERE id = ? AND user_id = ?").bind(fileId, auth.user_id).first();
  if (!owned) return problem(404, "file_not_found", "File not found.", requestId);
  const rows = await env.DB.prepare(`SELECT * FROM file_deliveries WHERE file_id = ? AND user_id = ?
    ORDER BY destination_device_id, id`).bind(fileId, auth.user_id).all<FileDeliveryRow>();
  return json(rows.results.map(deliveryOut), { headers: { "x-request-id": requestId } });
}

export async function handlePublicDeliveryRoute(
  request: Request,
  env: Env,
  requestId: string,
  path: string,
  runtime: Runtime,
): Promise<Response | null> {
  const match = path.match(/^\/v1\/file-deliveries\/([^/]+)\/events$/);
  if (!match || request.method !== "POST") return null;
  const tokenHeader = request.headers.get("authorization") ?? "";
  const token = tokenHeader.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return problem(401, "delivery_token_required", "A delivery acknowledgement token is required.", requestId);
  const row = await env.DB.prepare("SELECT * FROM file_deliveries WHERE id = ? AND ack_token_hash = ?")
    .bind(decodeURIComponent(match[1]), await sha256Hex(token)).first<FileDeliveryRow>();
  if (!row) return problem(403, "invalid_delivery_token", "The delivery acknowledgement token is invalid.", requestId);
  if (row.ack_token_expires_at == null || row.ack_token_expires_at <= runtime.now()) {
    return problem(410, "delivery_token_expired", "The delivery acknowledgement token has expired.", requestId);
  }
  const body = await bodyJson(request, requestId);
  const next = typeof body.state === "string" ? body.state : "";
  if (!['fetching', 'cached', 'failed_retryable'].includes(next)) {
    return problem(422, "invalid_delivery_state", "state must be fetching, cached, or failed_retryable.", requestId);
  }
  if (row.state === "cached") return json(deliveryOut(row), { headers: { "idempotent-replayed": "true", "x-request-id": requestId } });
  if (row.state === "missed") return problem(409, "delivery_missed", "A missed delivery cannot be acknowledged.", requestId);
  const now = runtime.now();
  const failureCode = next === "failed_retryable" && typeof body.failure_code === "string"
    ? body.failure_code.slice(0, 100)
    : null;
  await env.DB.prepare(`UPDATE file_deliveries SET state = ?, updated_at = ?,
    fetching_at = CASE WHEN ? = 'fetching' THEN COALESCE(fetching_at, ?) ELSE fetching_at END,
    cached_at = CASE WHEN ? = 'cached' THEN COALESCE(cached_at, ?) ELSE cached_at END,
    failed_at = CASE WHEN ? = 'failed_retryable' THEN ? ELSE failed_at END,
    failure_code = CASE WHEN ? = 'failed_retryable' THEN ? WHEN ? = 'cached' THEN NULL ELSE failure_code END
    WHERE id = ?`)
    .bind(next, now, next, now, next, now, next, now, next, failureCode, next, row.id).run();
  const updated = await env.DB.prepare("SELECT * FROM file_deliveries WHERE id = ?").bind(row.id).first<FileDeliveryRow>();
  if (!updated) throw new Error("updated delivery is missing");
  return json(deliveryOut(updated), { headers: { "x-request-id": requestId } });
}

export async function markUndeliveredMissed(env: Env, fileId: string, reason: string, runtime: Runtime): Promise<void> {
  const now = runtime.now();
  await env.DB.prepare(`UPDATE file_deliveries SET state = 'missed', updated_at = ?, missed_at = ?, failure_code = ?
    WHERE file_id = ? AND state != 'cached'`).bind(now, now, reason, fileId).run();
}
