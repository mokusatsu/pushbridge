import { decodeCursor, encodeCursor } from "./cursor";
import { bodyJson, json, problem } from "./response";
import { iso } from "./runtime";
import type { AuthContext, Env, PushRow, Runtime } from "./types";

const encoder = new TextEncoder();

export function pushOut(row: PushRow, currentDeviceId: string): Record<string, unknown> {
  const targetKind = row.target_kind ?? (row.target_device_id ? "device" : "all_other_devices");
  return {
    id: row.id,
    user_id: row.user_id,
    source_device_id: row.source_device_id,
    target: { kind: targetKind, device_id: targetKind === "device" ? row.target_device_id : null },
    type: row.type,
    file_id: row.file_id ?? null,
    file_ref: null,
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
    is_for_current_device: targetKind === "all_devices"
      || (targetKind === "all_other_devices" && row.source_device_id !== currentDeviceId)
      || (targetKind === "device" && row.target_device_id === currentDeviceId),
  };
}

function payloadEquals(row: PushRow, type: string, targetKind: string, targetDeviceId: string | null, payloadJson: string): boolean {
  return row.type === type
    && row.target_kind === targetKind
    && (row.target_device_id ?? null) === targetDeviceId
    && (row.payload_json ?? "{}") === payloadJson;
}

export async function createPush(request: Request, env: Env, auth: AuthContext, requestId: string, runtime: Runtime): Promise<Response> {
  const body = await bodyJson(request, requestId);
  const type = typeof body.type === "string" ? body.type : "";
  if (!["note", "link"].includes(type)) return problem(422, "unsupported_push_type", "The Worker currently accepts note and link pushes.", requestId);
  const idempotencyKey = request.headers.get("idempotency-key");
  if (idempotencyKey && idempotencyKey.length > 200) return problem(422, "invalid_idempotency_key", "Idempotency-Key must be 200 characters or fewer.", requestId);
  if (idempotencyKey && typeof body.client_guid === "string" && idempotencyKey !== body.client_guid) {
    return problem(422, "idempotency_key_mismatch", "Idempotency-Key and client_guid must match.", requestId);
  }
  const clientGuid = typeof body.client_guid === "string" ? body.client_guid : idempotencyKey ?? runtime.id("job");
  const payload = body.payload && typeof body.payload === "object" && !Array.isArray(body.payload) ? body.payload : {};
  const payloadJson = JSON.stringify(payload);
  if (encoder.encode(payloadJson).byteLength > 2_000_000) return problem(413, "payload_too_large", "Push payload is too large.", requestId);
  if (type === "link") {
    const url = (payload as Record<string, unknown>).url;
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return problem(422, "invalid_link", "Link URLs must use http or https.", requestId);
  }

  const target = body.target && typeof body.target === "object" && !Array.isArray(body.target) ? body.target as Record<string, unknown> : { kind: "all_other_devices" };
  const targetKind = typeof target.kind === "string" ? target.kind : "all_other_devices";
  if (!["all_other_devices", "all_devices", "device"].includes(targetKind)) return problem(422, "invalid_target", "Invalid target kind.", requestId);
  const targetDeviceId = targetKind === "device" && typeof target.device_id === "string" ? target.device_id : null;
  if (targetKind === "device" && !targetDeviceId) return problem(422, "invalid_target", "device_id is required for a device target.", requestId);
  if (targetDeviceId) {
    const targetDevice = await env.DB.prepare("SELECT id FROM devices WHERE id = ? AND user_id = ? AND revoked_at IS NULL")
      .bind(targetDeviceId, auth.user_id).first();
    if (!targetDevice) return problem(422, "invalid_target", "The target device is unavailable.", requestId);
  }

  const replay = await env.DB.prepare("SELECT * FROM pushes WHERE user_id = ? AND client_guid = ?").bind(auth.user_id, clientGuid).first<PushRow>();
  if (replay) {
    if (!payloadEquals(replay, type, targetKind, targetDeviceId, payloadJson)) {
      return problem(409, "idempotency_conflict", "The Idempotency-Key was already used with a different request.", requestId);
    }
    return json(pushOut(replay, auth.device_id), { headers: { "idempotent-replayed": "true", "x-request-id": requestId } });
  }

  const now = runtime.now();
  const expiresIn = typeof body.expires_in === "number" && Number.isFinite(body.expires_in) ? body.expires_in : 2_592_000;
  const expiresAt = now + Math.min(Math.max(1, expiresIn), 2_592_000) * 1000;
  const pushId = runtime.id("psh");
  try {
    await env.DB.prepare(`INSERT INTO pushes
      (id, user_id, source_device_id, target_device_id, target_kind, type, payload_version,
       ciphertext, nonce, payload_json, client_guid, created_at, modified_at, expires_at, status)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 'active')`)
      .bind(pushId, auth.user_id, auth.device_id, targetDeviceId, targetKind, type, "", "", payloadJson, clientGuid, now, now, expiresAt).run();
  } catch {
    const raced = await env.DB.prepare("SELECT * FROM pushes WHERE user_id = ? AND client_guid = ?").bind(auth.user_id, clientGuid).first<PushRow>();
    if (!raced || !payloadEquals(raced, type, targetKind, targetDeviceId, payloadJson)) throw new Error("push insert failed");
    return json(pushOut(raced, auth.device_id), { headers: { "idempotent-replayed": "true", "x-request-id": requestId } });
  }
  const row = await env.DB.prepare("SELECT * FROM pushes WHERE id = ?").bind(pushId).first<PushRow>();
  if (!row) throw new Error("created push is missing");
  return json(pushOut(row, auth.device_id), { status: 201, headers: { "x-request-id": requestId } });
}

export async function listPushes(url: URL, env: Env, auth: AuthContext, requestId: string): Promise<Record<string, unknown>> {
  const requestedLimit = Number(url.searchParams.get("limit"));
  const limit = Math.min(100, Math.max(1, Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.floor(requestedLimit) : 100));
  const cursor = await decodeCursor(url.searchParams.get("after"), auth, requestId);
  const includeDeleted = url.searchParams.get("include_deleted") !== "false";
  const deletedClause = includeDeleted ? "" : " AND deleted_at IS NULL";
  const result = cursor
    ? await env.DB.prepare(`SELECT * FROM pushes WHERE user_id = ?${deletedClause} AND (modified_at > ? OR (modified_at = ? AND id > ?)) ORDER BY modified_at, id LIMIT ?`)
      .bind(auth.user_id, cursor.time, cursor.time, cursor.id, limit + 1).all<PushRow>()
    : await env.DB.prepare(`SELECT * FROM pushes WHERE user_id = ?${deletedClause} ORDER BY modified_at, id LIMIT ?`).bind(auth.user_id, limit + 1).all<PushRow>();
  const rows = result.results.slice(0, limit);
  const last = rows.at(-1);
  return {
    items: rows.map((row) => pushOut(row, auth.device_id)),
    next_cursor: last ? await encodeCursor(last.modified_at, last.id, auth) : null,
    has_more: result.results.length > limit,
  };
}

export async function getPush(env: Env, auth: AuthContext, requestId: string, pushId: string): Promise<Response> {
  const row = await env.DB.prepare("SELECT * FROM pushes WHERE id = ? AND user_id = ?").bind(pushId, auth.user_id).first<PushRow>();
  return row ? json(pushOut(row, auth.device_id), { headers: { "x-request-id": requestId } }) : problem(404, "not_found", "Push not found.", requestId);
}

export async function mutatePush(request: Request, env: Env, auth: AuthContext, requestId: string, pushId: string, runtime: Runtime): Promise<Response> {
  const row = await env.DB.prepare("SELECT * FROM pushes WHERE id = ? AND user_id = ?").bind(pushId, auth.user_id).first<PushRow>();
  if (!row) return problem(404, "not_found", "Push not found.", requestId);
  const modifiedAt = Math.max(runtime.now(), Number(row.modified_at) + 1);
  if (request.method === "DELETE") {
    await env.DB.prepare("UPDATE pushes SET deleted_at = ?, modified_at = ?, status = 'deleted' WHERE id = ? AND user_id = ?")
      .bind(modifiedAt, modifiedAt, pushId, auth.user_id).run();
  } else {
    const body = await bodyJson(request, requestId);
    const dismissedAt = body.dismissed === true ? modifiedAt : body.dismissed === false ? null : row.dismissed_at;
    const pinnedAt = body.pinned === true ? modifiedAt : body.pinned === false ? null : row.pinned_at;
    const status = dismissedAt ? "dismissed" : "active";
    await env.DB.prepare("UPDATE pushes SET dismissed_at = ?, pinned_at = ?, modified_at = ?, status = ? WHERE id = ? AND user_id = ?")
      .bind(dismissedAt, pinnedAt, modifiedAt, status, pushId, auth.user_id).run();
  }
  const updated = await env.DB.prepare("SELECT * FROM pushes WHERE id = ?").bind(pushId).first<PushRow>();
  if (!updated) throw new Error("updated push is missing");
  return json(pushOut(updated, auth.device_id), { headers: { "x-request-id": requestId } });
}
