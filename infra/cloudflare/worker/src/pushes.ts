import { decodeCursor, encodeCursor } from "./cursor";
import { ensureFileDeliveries } from "./deliveries";
import { bodyJson, json, problem } from "./response";
import { iso } from "./runtime";
import type { AuthContext, Env, PushRow, Runtime } from "./types";
import { deliverFilePush } from "./web-push";
import { tickleUser } from "./realtime";

const encoder = new TextEncoder();
const PUSH_SELECT = `SELECT
  p.*,
  f.state AS file_ref_state,
  COALESCE(f.actual_size, f.expected_size) AS file_ref_size,
  f.expires_at AS file_ref_expires_at,
  f.deleted_at AS file_ref_deleted_at,
  f.delete_reason AS file_ref_delete_reason,
  f.alias_expires_at AS file_ref_alias_expires_at
  FROM pushes p LEFT JOIN files f ON f.id = p.file_id`;

export function pushOut(row: PushRow, currentDeviceId: string): Record<string, unknown> {
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
      alias_expires_at: iso(row.file_ref_alias_expires_at),
    } : null,
    payload_version: row.payload_version ?? 1,
    key_version: row.key_version ?? null,
    encryption_salt: row.encryption_salt ?? null,
    payload: row.payload_json ? JSON.parse(row.payload_json) : null,
    ciphertext: row.payload_version >= 2 ? row.ciphertext : null,
    nonce: row.payload_version >= 2 ? row.nonce : null,
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

function payloadEquals(row: PushRow, type: string, targetKind: string, targetDeviceId: string | null, fileId: string | null,
  payloadVersion: number, keyVersion: number | null, encryptionSalt: string | null, ciphertext: string, nonce: string, payloadJson: string | null): boolean {
  return row.type === type
    && row.target_kind === targetKind
    && (row.target_device_id ?? null) === targetDeviceId
    && (row.file_id ?? null) === fileId
    && Number(row.payload_version) === payloadVersion
    && (row.key_version ?? null) === keyVersion
    && (row.encryption_salt ?? null) === encryptionSalt
    && String(row.ciphertext ?? "") === ciphertext
    && String(row.nonce ?? "") === nonce
    && (row.payload_json ?? null) === payloadJson;
}

export async function createPush(request: Request, env: Env, auth: AuthContext, requestId: string, runtime: Runtime): Promise<Response> {
  const body = await bodyJson(request, requestId);
  const type = typeof body.type === "string" ? body.type : "";
  if (!["note", "link", "file"].includes(type)) return problem(422, "unsupported_push_type", "Push type must be note, link, or file.", requestId);
  const idempotencyKey = request.headers.get("idempotency-key");
  if (idempotencyKey && idempotencyKey.length > 200) return problem(422, "invalid_idempotency_key", "Idempotency-Key must be 200 characters or fewer.", requestId);
  if (idempotencyKey && typeof body.client_guid === "string" && idempotencyKey !== body.client_guid) {
    return problem(422, "idempotency_key_mismatch", "Idempotency-Key and client_guid must match.", requestId);
  }
  const clientGuid = typeof body.client_guid === "string" ? body.client_guid : idempotencyKey ?? runtime.id("job");
  const payloadVersion = body.payload_version === 2 ? 2 : 1;
  if (env.REQUIRE_E2EE === "true" && payloadVersion !== 2) return problem(422, "e2ee_required", "Encrypted payload_version 2 is required.", requestId);
  const encrypted = payloadVersion === 2;
  const payload = body.payload && typeof body.payload === "object" && !Array.isArray(body.payload) ? body.payload : {};
  const payloadJson = encrypted ? null : JSON.stringify(payload);
  const keyVersion = encrypted && typeof body.key_version === "number" && Number.isSafeInteger(body.key_version) && body.key_version >= 1 ? body.key_version : null;
  const encryptionSalt = encrypted && typeof body.encryption_salt === "string" ? body.encryption_salt : null;
  const ciphertext = encrypted && typeof body.ciphertext === "string" ? body.ciphertext : "";
  const nonce = encrypted && typeof body.nonce === "string" ? body.nonce : "";
  if (encrypted && (!keyVersion || !encryptionSalt || !ciphertext || !nonce
    || ![encryptionSalt, ciphertext, nonce].every((value) => /^[A-Za-z0-9_-]+$/.test(value)))) {
    return problem(422, "invalid_encrypted_payload", "key_version, encryption_salt, nonce, and ciphertext are required for payload_version 2.", requestId);
  }
  const encodedSize = encoder.encode(encrypted ? `${encryptionSalt}.${nonce}.${ciphertext}` : payloadJson ?? "").byteLength;
  if (encodedSize > 2_000_000) return problem(413, "payload_too_large", "Push payload is too large.", requestId);
  if (!encrypted && type === "link") {
    const url = (payload as Record<string, unknown>).url;
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return problem(422, "invalid_link", "Link URLs must use http or https.", requestId);
  }
  const fileId = type === "file" && typeof body.file_id === "string" ? body.file_id : null;
  if (type === "file" && !fileId) return problem(422, "file_id_required", "A file push requires file_id.", requestId);

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

  const replay = await env.DB.prepare(`${PUSH_SELECT} WHERE p.user_id = ? AND p.client_guid = ?`).bind(auth.user_id, clientGuid).first<PushRow>();
  if (replay) {
    if (!payloadEquals(replay, type, targetKind, targetDeviceId, fileId, payloadVersion, keyVersion, encryptionSalt, ciphertext, nonce, payloadJson)) {
      return problem(409, "idempotency_conflict", "The Idempotency-Key was already used with a different request.", requestId);
    }
    await ensureFileDeliveries(env, replay, runtime);
    await deliverFilePush(env, replay.id, new URL(request.url).origin, runtime);
    return json(pushOut(replay, auth.device_id), { headers: { "idempotent-replayed": "true", "x-request-id": requestId } });
  }

  let fileAliasExpiresAt: number | null = null;
  if (fileId) {
    const file = await env.DB.prepare("SELECT state, expires_at, alias_expires_at FROM files WHERE id = ? AND user_id = ?")
      .bind(fileId, auth.user_id).first<{ state: string; expires_at: number; alias_expires_at: number }>();
    if (!file) return problem(404, "file_not_found", "The referenced file does not exist for this account.", requestId);
    if (file.state !== "ready" || Number(file.expires_at) <= runtime.now()) return problem(409, "file_not_ready", "The referenced file is expired, deleted, or not ready.", requestId);
    fileAliasExpiresAt = Number(file.alias_expires_at);
  }

  const now = runtime.now();
  const expiresIn = typeof body.expires_in === "number" && Number.isFinite(body.expires_in) ? body.expires_in : 2_592_000;
  const expiresAt = fileAliasExpiresAt ?? now + Math.min(Math.max(1, expiresIn), 2_592_000) * 1000;
  const pushId = runtime.id("psh");
  try {
    await env.DB.prepare(`INSERT INTO pushes
      (id, user_id, source_device_id, target_device_id, target_kind, type, file_id, payload_version, key_version, encryption_salt,
       ciphertext, nonce, payload_json, client_guid, created_at, modified_at, expires_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`)
      .bind(pushId, auth.user_id, auth.device_id, targetDeviceId, targetKind, type, fileId, payloadVersion, keyVersion,
        encryptionSalt, ciphertext, nonce, payloadJson, clientGuid, now, now, expiresAt).run();
  } catch {
    const raced = await env.DB.prepare(`${PUSH_SELECT} WHERE p.user_id = ? AND p.client_guid = ?`).bind(auth.user_id, clientGuid).first<PushRow>();
    if (!raced || !payloadEquals(raced, type, targetKind, targetDeviceId, fileId, payloadVersion, keyVersion, encryptionSalt, ciphertext, nonce, payloadJson)) throw new Error("push insert failed");
    await ensureFileDeliveries(env, raced, runtime);
    await deliverFilePush(env, raced.id, new URL(request.url).origin, runtime);
    return json(pushOut(raced, auth.device_id), { headers: { "idempotent-replayed": "true", "x-request-id": requestId } });
  }
  const row = await env.DB.prepare(`${PUSH_SELECT} WHERE p.id = ?`).bind(pushId).first<PushRow>();
  if (!row) throw new Error("created push is missing");
  await ensureFileDeliveries(env, row, runtime);
  await deliverFilePush(env, row.id, new URL(request.url).origin, runtime);
  await tickleUser(env, auth.user_id, { entityId: row.id, modifiedAt: Number(row.modified_at), reason: "push.created" });
  return json(pushOut(row, auth.device_id), { status: 201, headers: { "x-request-id": requestId } });
}

export async function listPushes(url: URL, env: Env, auth: AuthContext, requestId: string): Promise<Record<string, unknown>> {
  const requestedLimit = Number(url.searchParams.get("limit"));
  const limit = Math.min(100, Math.max(1, Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.floor(requestedLimit) : 100));
  const cursor = await decodeCursor(url.searchParams.get("after"), auth, requestId);
  const includeDeleted = url.searchParams.get("include_deleted") !== "false";
  const deletedClause = includeDeleted ? "" : " AND p.deleted_at IS NULL";
  const result = cursor
    ? await env.DB.prepare(`${PUSH_SELECT} WHERE p.user_id = ?${deletedClause} AND (p.modified_at > ? OR (p.modified_at = ? AND p.id > ?)) ORDER BY p.modified_at, p.id LIMIT ?`)
      .bind(auth.user_id, cursor.time, cursor.time, cursor.id, limit + 1).all<PushRow>()
    : await env.DB.prepare(`${PUSH_SELECT} WHERE p.user_id = ?${deletedClause} ORDER BY p.modified_at, p.id LIMIT ?`).bind(auth.user_id, limit + 1).all<PushRow>();
  const rows = result.results.slice(0, limit);
  const last = rows.at(-1);
  return {
    items: rows.map((row) => pushOut(row, auth.device_id)),
    next_cursor: last ? await encodeCursor(last.modified_at, last.id, auth) : null,
    has_more: result.results.length > limit,
  };
}

export async function getPush(env: Env, auth: AuthContext, requestId: string, pushId: string): Promise<Response> {
  const row = await env.DB.prepare(`${PUSH_SELECT} WHERE p.id = ? AND p.user_id = ?`).bind(pushId, auth.user_id).first<PushRow>();
  return row ? json(pushOut(row, auth.device_id), { headers: { "x-request-id": requestId } }) : problem(404, "not_found", "Push not found.", requestId);
}

export async function mutatePush(request: Request, env: Env, auth: AuthContext, requestId: string, pushId: string, runtime: Runtime): Promise<Response> {
  const row = await env.DB.prepare(`${PUSH_SELECT} WHERE p.id = ? AND p.user_id = ?`).bind(pushId, auth.user_id).first<PushRow>();
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
  const updated = await env.DB.prepare(`${PUSH_SELECT} WHERE p.id = ?`).bind(pushId).first<PushRow>();
  if (!updated) throw new Error("updated push is missing");
  await tickleUser(env, auth.user_id, { entityId: updated.id, modifiedAt: Number(updated.modified_at), reason: "push.changed" });
  return json(pushOut(updated, auth.device_id), { headers: { "x-request-id": requestId } });
}
