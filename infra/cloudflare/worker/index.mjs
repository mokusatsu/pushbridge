const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
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
    headers: { ...headers, "x-request-id": requestId },
  });
}

function getRequestId(request) {
  return request.headers.get("cf-ray") ?? request.headers.get("x-request-id") ?? crypto.randomUUID();
}

function id(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function iso(epoch) {
  return epoch == null ? null : new Date(Number(epoch)).toISOString();
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `rly_${btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")}`;
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function bodyJson(request, requestId) {
  try {
    return await request.json();
  } catch {
    throw problem(400, "invalid_json", "Request body must be valid JSON.", requestId);
  }
}

async function authenticate(request, env, requestId) {
  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) {
    throw problem(401, "unauthorized", "A valid bearer token is required.", requestId, { "www-authenticate": "Bearer" });
  }
  const tokenHash = await sha256Hex(header.slice(7));
  const row = await env.DB.prepare(`
    SELECT s.user_id, s.device_id, s.expires_at, u.handle, d.revoked_at
    FROM sessions s JOIN users u ON u.id = s.user_id JOIN devices d ON d.id = s.device_id
    WHERE s.token_hash = ?
  `).bind(tokenHash).first();
  if (!row || row.revoked_at != null || Number(row.expires_at) <= Date.now()) {
    throw problem(401, "unauthorized", "The bearer token is expired or invalid.", requestId, { "www-authenticate": "Bearer" });
  }
  return row;
}

function retention(env) {
  try {
    return JSON.parse(env.FILE_RETENTION_POLICY ?? "{}");
  } catch {
    return {};
  }
}

function capabilities(env) {
  const policy = retention(env);
  const defaultSeconds = Number(policy.default ?? policy.default_seconds ?? policy.default_days * 86400) || 2_592_000;
  return {
    api_version: "0.2.0-worker-poc",
    environment_id: env.APP_ENVIRONMENT ?? "cloudflare-worker",
    features: {
      realtime: false,
      web_push_delivery: false,
      web_push_subscription_registration: false,
      e2ee: false,
      direct_upload: false,
      device_registration: true,
    },
    limits: {
      max_file_bytes: 26_214_400,
      max_push_payload_bytes: 2_000_000,
      file_ttl_seconds: [86_400, 604_800, 2_592_000],
      default_push_ttl_seconds: 2_592_000,
      default_file_ttl_seconds: defaultSeconds,
      file_alias_ttl_seconds: Number(policy.alias_days) * 86400 || 15_552_000,
      max_devices: 10,
    },
    transports: { realtime: ["poll"], upload: [] },
    recommended_poll_interval_seconds: 30,
  };
}

function deviceOut(row, currentDeviceId) {
  return {
    id: row.id,
    user_id: row.user_id,
    kind: row.kind === "extension" ? "browser_extension" : row.kind,
    name: typeof row.name_ciphertext === "string" ? row.name_ciphertext : "Linked device",
    public_key: row.public_key ? String(row.public_key) || null : null,
    created_at: iso(row.created_at),
    last_seen_at: iso(row.last_seen_at ?? row.created_at),
    revoked_at: iso(row.revoked_at),
    is_current: row.id === currentDeviceId,
  };
}

function pushOut(row, currentDeviceId) {
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

async function bootstrap(request, env, requestId) {
  const body = await bodyJson(request, requestId);
  if (!/^[A-Za-z0-9_.-]{1,80}$/.test(body.handle ?? "") || typeof body.device_name !== "string" || !body.device_name.trim()) {
    return problem(422, "validation_error", "handle and device_name are required.", requestId);
  }
  const existing = await env.DB.prepare("SELECT id FROM users WHERE handle = ? AND deleted_at IS NULL").bind(body.handle).first();
  if (existing) return problem(409, "handle_exists", "This handle already exists.", requestId);

  const now = Date.now();
  const userId = id("usr");
  const deviceId = id("dev");
  const token = randomToken();
  const expiresAt = now + 30 * 24 * 60 * 60 * 1000;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users (id, handle, created_at, updated_at) VALUES (?, ?, ?, ?)").bind(userId, body.handle, now, now),
    env.DB.prepare(`INSERT INTO devices
      (id, user_id, kind, name_ciphertext, public_key, last_seen_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(deviceId, userId, body.device_kind === "browser_extension" ? "extension" : body.device_kind ?? "pwa", body.device_name.trim(), body.public_key ?? "", now, now, now),
    env.DB.prepare("INSERT INTO sessions (token_hash, user_id, device_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
      .bind(await sha256Hex(token), userId, deviceId, now, expiresAt),
  ]);
  return json({
    user: { id: userId, handle: body.handle, created_at: iso(now) },
    device: deviceOut({ id: deviceId, user_id: userId, kind: body.device_kind ?? "pwa", name_ciphertext: body.device_name.trim(), public_key: body.public_key ?? "", created_at: now, last_seen_at: now, revoked_at: null }, deviceId),
    access_token: token,
    token_type: "bearer",
    expires_at: iso(expiresAt),
  }, { status: 201, headers: { "x-request-id": requestId } });
}

async function listDevices(env, auth) {
  const result = await env.DB.prepare("SELECT * FROM devices WHERE user_id = ? ORDER BY created_at").bind(auth.user_id).all();
  return result.results.map((row) => deviceOut(row, auth.device_id));
}

async function linkDevice(request, env, auth, requestId) {
  const body = await bodyJson(request, requestId);
  if (typeof body.name !== "string" || !body.name.trim()) return problem(422, "validation_error", "Device name is required.", requestId);
  const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM devices WHERE user_id = ? AND revoked_at IS NULL").bind(auth.user_id).first();
  if (Number(count.count) >= 10) return problem(409, "device_limit", "The device limit has been reached.", requestId);
  const now = Date.now();
  const deviceId = id("dev");
  const token = randomToken();
  const expiresAt = now + 30 * 24 * 60 * 60 * 1000;
  const kind = body.kind === "browser_extension" ? "extension" : body.kind ?? "web";
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO devices
      (id, user_id, kind, name_ciphertext, public_key, last_seen_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(deviceId, auth.user_id, kind, body.name.trim(), body.public_key ?? "", now, now, now),
    env.DB.prepare("INSERT INTO sessions (token_hash, user_id, device_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
      .bind(await sha256Hex(token), auth.user_id, deviceId, now, expiresAt),
  ]);
  const row = await env.DB.prepare("SELECT * FROM devices WHERE id = ?").bind(deviceId).first();
  return json({ device: deviceOut(row, auth.device_id), access_token: token, token_type: "bearer", expires_at: iso(expiresAt) }, { status: 201, headers: { "x-request-id": requestId } });
}

async function mutateDevice(request, env, auth, requestId, deviceId) {
  const row = await env.DB.prepare("SELECT * FROM devices WHERE id = ? AND user_id = ?").bind(deviceId, auth.user_id).first();
  if (!row) return problem(404, "not_found", "Device not found.", requestId);
  if (request.method === "DELETE") {
    if (deviceId === auth.device_id) return problem(409, "current_device", "The current device cannot revoke itself.", requestId);
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("UPDATE devices SET revoked_at = ?, updated_at = ? WHERE id = ?").bind(now, now, deviceId),
      env.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE device_id = ?").bind(now, deviceId),
    ]);
    return new Response(null, { status: 204, headers: { "x-request-id": requestId } });
  }
  const body = await bodyJson(request, requestId);
  if (typeof body.name !== "string" || !body.name.trim()) return problem(422, "validation_error", "Device name is required.", requestId);
  await env.DB.prepare("UPDATE devices SET name_ciphertext = ?, updated_at = ? WHERE id = ?").bind(body.name.trim(), Date.now(), deviceId).run();
  return deviceOut(await env.DB.prepare("SELECT * FROM devices WHERE id = ?").bind(deviceId).first(), auth.device_id);
}

async function createPush(request, env, auth, requestId) {
  const body = await bodyJson(request, requestId);
  if (!['note', 'link'].includes(body.type)) {
    return problem(422, "unsupported_push_type", "The Worker PoC currently accepts note and link pushes.", requestId);
  }
  const idempotencyKey = request.headers.get("idempotency-key");
  if (idempotencyKey && idempotencyKey.length > 200) {
    return problem(422, "invalid_idempotency_key", "Idempotency-Key must be 200 characters or fewer.", requestId);
  }
  if (idempotencyKey && body.client_guid && idempotencyKey !== body.client_guid) {
    return problem(422, "idempotency_key_mismatch", "Idempotency-Key and client_guid must match.", requestId);
  }
  const clientGuid = body.client_guid ?? idempotencyKey ?? id("job");
  const replay = await env.DB.prepare("SELECT * FROM pushes WHERE user_id = ? AND client_guid = ?").bind(auth.user_id, clientGuid).first();
  const payload = body.payload ?? {};
  if (JSON.stringify(payload).length > 2_000_000) return problem(413, "payload_too_large", "Push payload is too large.", requestId);
  const target = body.target ?? { kind: "all_other_devices" };
  if (!['all_other_devices', 'all_devices', 'device'].includes(target.kind)) return problem(422, "invalid_target", "Invalid target kind.", requestId);
  if (target.kind === "device" && !target.device_id) return problem(422, "invalid_target", "device_id is required for a device target.", requestId);
  if (replay) {
    const sameRequest = replay.type === body.type
      && replay.target_kind === target.kind
      && (replay.target_device_id ?? null) === (target.device_id ?? null)
      && JSON.stringify(JSON.parse(replay.payload_json ?? "{}")) === JSON.stringify(payload);
    if (!sameRequest) return problem(409, "idempotency_conflict", "The Idempotency-Key was already used with a different request.", requestId);
    return json(pushOut(replay, auth.device_id), { headers: { "idempotent-replayed": "true", "x-request-id": requestId } });
  }
  const now = Date.now();
  const expiresAt = now + Math.min(Number(body.expires_in) || 2_592_000, 2_592_000) * 1000;
  const pushId = id("psh");
  await env.DB.prepare(`INSERT INTO pushes
    (id, user_id, source_device_id, target_device_id, target_kind, type, payload_version,
     ciphertext, nonce, payload_json, client_guid, created_at, modified_at, expires_at, status)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 'active')`)
    .bind(pushId, auth.user_id, auth.device_id, target.device_id ?? null, target.kind, body.type, "", "", JSON.stringify(payload), clientGuid, now, now, expiresAt).run();
  const row = await env.DB.prepare("SELECT * FROM pushes WHERE id = ?").bind(pushId).first();
  return json(pushOut(row, auth.device_id), { status: 201, headers: { "x-request-id": requestId } });
}

function decodeCursor(value) {
  if (!value) return null;
  const split = value.lastIndexOf(":");
  if (split < 1) return null;
  const time = Date.parse(value.slice(0, split));
  return Number.isFinite(time) ? { time, id: value.slice(split + 1) } : null;
}

async function listPushes(url, env, auth) {
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 100));
  const cursor = decodeCursor(url.searchParams.get("after"));
  const result = cursor
    ? await env.DB.prepare("SELECT * FROM pushes WHERE user_id = ? AND (modified_at > ? OR (modified_at = ? AND id > ?)) ORDER BY modified_at, id LIMIT ?")
      .bind(auth.user_id, cursor.time, cursor.time, cursor.id, limit + 1).all()
    : await env.DB.prepare("SELECT * FROM pushes WHERE user_id = ? ORDER BY modified_at, id LIMIT ?").bind(auth.user_id, limit + 1).all();
  const rows = result.results.slice(0, limit);
  const last = rows.at(-1);
  return {
    items: rows.map((row) => pushOut(row, auth.device_id)),
    next_cursor: last ? `${iso(last.modified_at)}:${last.id}` : null,
    has_more: result.results.length > limit,
  };
}

async function mutatePush(request, env, auth, requestId, pushId) {
  const row = await env.DB.prepare("SELECT * FROM pushes WHERE id = ? AND user_id = ?").bind(pushId, auth.user_id).first();
  if (!row) return problem(404, "not_found", "Push not found.", requestId);
  const now = Date.now();
  if (request.method === "DELETE") {
    await env.DB.prepare("UPDATE pushes SET deleted_at = ?, modified_at = ?, status = 'deleted' WHERE id = ?").bind(now, now, pushId).run();
  } else {
    const body = await bodyJson(request, requestId);
    const dismissedAt = body.dismissed === true ? now : body.dismissed === false ? null : row.dismissed_at;
    const pinnedAt = body.pinned === true ? now : body.pinned === false ? null : row.pinned_at;
    const status = dismissedAt ? "dismissed" : "active";
    await env.DB.prepare("UPDATE pushes SET dismissed_at = ?, pinned_at = ?, modified_at = ?, status = ? WHERE id = ?")
      .bind(dismissedAt, pinnedAt, now, status, pushId).run();
  }
  return pushOut(await env.DB.prepare("SELECT * FROM pushes WHERE id = ?").bind(pushId).first(), auth.device_id);
}

async function storageUsage(env, auth) {
  const row = await env.DB.prepare(`SELECT
    COALESCE(SUM(CASE WHEN state = 'ready' THEN encrypted_size ELSE 0 END), 0) AS used_bytes,
    COALESCE(SUM(CASE WHEN state = 'pending' THEN encrypted_size ELSE 0 END), 0) AS reserved_bytes
    FROM files WHERE user_id = ?`).bind(auth.user_id).first();
  const quota = 8 * 1024 * 1024 * 1024;
  const total = Number(row.used_bytes) + Number(row.reserved_bytes);
  const ratio = total / quota;
  return {
    used_bytes: Number(row.used_bytes), reserved_bytes: Number(row.reserved_bytes), quota_bytes: quota,
    reclaimable_bytes: Number(row.used_bytes),
    pressure: ratio >= .95 ? "emergency" : ratio >= .85 ? "constrained" : ratio >= .7 ? "notice" : "normal",
    policy_id: "free-v1", default_retention_days: 30, early_eviction_possible: true,
  };
}

async function cleanupExpiredMetadata(env) {
  const now = Date.now();
  for (const statement of [
    env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ? OR revoked_at IS NOT NULL").bind(now),
    env.DB.prepare("UPDATE files SET state = 'expired' WHERE expires_at <= ? AND state = 'ready'").bind(now),
  ]) {
    try { await statement.run(); } catch (error) { console.warn("cleanup skipped", String(error)); }
  }
}

export class UserHub {
  constructor(state, env) { this.state = state; this.env = env; }
  async fetch() { return json({ error: "not_implemented" }, { status: 501 }); }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const requestId = getRequestId(request);
    try {
      if (request.method === "GET" && url.pathname === "/healthz") return json({ ok: true, service: env.APP_NAME, environment: env.APP_ENVIRONMENT, requestId });
      if (request.method === "GET" && url.pathname === "/health") return json({ status: "ok", service: env.APP_NAME ?? "pushbridge", environment: env.APP_ENVIRONMENT ?? "unknown", request_id: requestId });
      if (request.method === "GET" && url.pathname === "/api/bootstrap/status") return json({ ok: true, requestId, bootstrap: false, message: "Cloudflare application API is active.", bindings: { d1: Boolean(env.DB), r2: Boolean(env.FILES), durableObject: Boolean(env.USER_HUB), queue: Boolean(env.DELIVERY_QUEUE) }, policy: { fileRetention: retention(env) } });

      const path = url.pathname.replace(/^\/api\/v1/, "/v1");
      if (request.method === "GET" && path === "/v1/system/capabilities") return json(capabilities(env), { headers: { "x-request-id": requestId } });
      if (request.method === "GET" && path === "/v1/web-push-config") return json({ subscription_registration: false, delivery: false, vapid_public_key: "" }, { headers: { "x-request-id": requestId } });
      if (request.method === "POST" && path === "/v1/auth/bootstrap") return bootstrap(request, env, requestId);

      if (!path.startsWith("/v1/")) return json({ error: "not_found", requestId }, { status: 404 });
      const auth = await authenticate(request, env, requestId);
      if (request.method === "GET" && path === "/v1/devices") return json(await listDevices(env, auth), { headers: { "x-request-id": requestId } });
      if (request.method === "GET" && path === "/v1/devices/me") {
        const row = await env.DB.prepare("SELECT * FROM devices WHERE id = ? AND user_id = ?").bind(auth.device_id, auth.user_id).first();
        return json(deviceOut(row, auth.device_id), { headers: { "x-request-id": requestId } });
      }
      if (request.method === "POST" && path === "/v1/devices/link") return linkDevice(request, env, auth, requestId);
      const deviceMatch = path.match(/^\/v1\/devices\/([^/]+)$/);
      if (deviceMatch && (request.method === "PATCH" || request.method === "DELETE")) {
        const result = await mutateDevice(request, env, auth, requestId, decodeURIComponent(deviceMatch[1]));
        return result instanceof Response ? result : json(result, { headers: { "x-request-id": requestId } });
      }
      if (request.method === "POST" && path === "/v1/pushes") return createPush(request, env, auth, requestId);
      if (request.method === "GET" && path === "/v1/pushes") return json(await listPushes(url, env, auth), { headers: { "x-request-id": requestId } });
      if (request.method === "GET" && /^\/v1\/pushes\/[^/]+$/.test(path)) {
        const pushId = decodeURIComponent(path.slice("/v1/pushes/".length));
        const row = await env.DB.prepare("SELECT * FROM pushes WHERE id = ? AND user_id = ?").bind(pushId, auth.user_id).first();
        return row ? json(pushOut(row, auth.device_id), { headers: { "x-request-id": requestId } }) : problem(404, "not_found", "Push not found.", requestId);
      }
      const pushMatch = path.match(/^\/v1\/pushes\/([^/]+)$/);
      if (pushMatch && (request.method === "PATCH" || request.method === "DELETE")) {
        const result = await mutatePush(request, env, auth, requestId, decodeURIComponent(pushMatch[1]));
        return result instanceof Response ? result : json(result, { headers: { "x-request-id": requestId } });
      }
      if (request.method === "GET" && path === "/v1/storage/usage") return json(await storageUsage(env, auth), { headers: { "x-request-id": requestId } });
      return problem(501, "not_implemented", "This application endpoint is not implemented in the Worker PoC.", requestId);
    } catch (error) {
      if (error instanceof Response) return error;
      console.error("request failed", error);
      return problem(500, "internal_error", "The Worker PoC encountered an internal error.", requestId);
    }
  },
  async scheduled(_event, env, ctx) { ctx.waitUntil(cleanupExpiredMetadata(env)); },
  async queue(batch) { for (const message of batch.messages) message.ack(); },
};
