// infra/cloudflare/worker/src/cleanup.ts
async function cleanupExpiredMetadata(env, runtime) {
  const now = runtime.now();
  const statements = [
    env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ? OR revoked_at IS NOT NULL").bind(now),
    env.DB.prepare("DELETE FROM bootstrap_rate_limits WHERE window_started_at < ?").bind(now - 24 * 60 * 60 * 1e3),
    env.DB.prepare("UPDATE files SET state = 'expired' WHERE expires_at <= ? AND state = 'ready'").bind(now)
  ];
  for (const statement of statements) {
    try {
      await statement.run();
    } catch (error) {
      console.warn("cleanup statement failed", { error: error instanceof Error ? error.name : "unknown" });
    }
  }
}

// infra/cloudflare/worker/src/crypto.ts
async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
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
async function storageUsage(env, auth) {
  const row = await env.DB.prepare(`SELECT
    COALESCE(SUM(CASE WHEN state = 'ready' THEN encrypted_size ELSE 0 END), 0) AS used_bytes,
    COALESCE(SUM(CASE WHEN state = 'pending' THEN encrypted_size ELSE 0 END), 0) AS reserved_bytes
    FROM files WHERE user_id = ?`).bind(auth.user_id).first();
  const quota = 8 * 1024 * 1024 * 1024;
  const usedBytes = Number(row?.used_bytes ?? 0);
  const reservedBytes = Number(row?.reserved_bytes ?? 0);
  const ratio = (usedBytes + reservedBytes) / quota;
  return {
    used_bytes: usedBytes,
    reserved_bytes: reservedBytes,
    quota_bytes: quota,
    reclaimable_bytes: usedBytes,
    pressure: ratio >= 0.95 ? "emergency" : ratio >= 0.85 ? "constrained" : ratio >= 0.7 ? "notice" : "normal",
    policy_id: "free-v1",
    default_retention_days: 30,
    early_eviction_possible: true
  };
}
async function handleFileRoute() {
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

// infra/cloudflare/worker/src/pushes.ts
var encoder = new TextEncoder();
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
    is_for_current_device: targetKind === "all_devices" || targetKind === "all_other_devices" && row.source_device_id !== currentDeviceId || targetKind === "device" && row.target_device_id === currentDeviceId
  };
}
function payloadEquals(row, type, targetKind, targetDeviceId, payloadJson) {
  return row.type === type && row.target_kind === targetKind && (row.target_device_id ?? null) === targetDeviceId && (row.payload_json ?? "{}") === payloadJson;
}
async function createPush(request, env, auth, requestId, runtime) {
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
  if (encoder.encode(payloadJson).byteLength > 2e6) return problem(413, "payload_too_large", "Push payload is too large.", requestId);
  if (type === "link") {
    const url = payload.url;
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return problem(422, "invalid_link", "Link URLs must use http or https.", requestId);
  }
  const target = body.target && typeof body.target === "object" && !Array.isArray(body.target) ? body.target : { kind: "all_other_devices" };
  const targetKind = typeof target.kind === "string" ? target.kind : "all_other_devices";
  if (!["all_other_devices", "all_devices", "device"].includes(targetKind)) return problem(422, "invalid_target", "Invalid target kind.", requestId);
  const targetDeviceId = targetKind === "device" && typeof target.device_id === "string" ? target.device_id : null;
  if (targetKind === "device" && !targetDeviceId) return problem(422, "invalid_target", "device_id is required for a device target.", requestId);
  if (targetDeviceId) {
    const targetDevice = await env.DB.prepare("SELECT id FROM devices WHERE id = ? AND user_id = ? AND revoked_at IS NULL").bind(targetDeviceId, auth.user_id).first();
    if (!targetDevice) return problem(422, "invalid_target", "The target device is unavailable.", requestId);
  }
  const replay = await env.DB.prepare("SELECT * FROM pushes WHERE user_id = ? AND client_guid = ?").bind(auth.user_id, clientGuid).first();
  if (replay) {
    if (!payloadEquals(replay, type, targetKind, targetDeviceId, payloadJson)) {
      return problem(409, "idempotency_conflict", "The Idempotency-Key was already used with a different request.", requestId);
    }
    return json(pushOut(replay, auth.device_id), { headers: { "idempotent-replayed": "true", "x-request-id": requestId } });
  }
  const now = runtime.now();
  const expiresIn = typeof body.expires_in === "number" && Number.isFinite(body.expires_in) ? body.expires_in : 2592e3;
  const expiresAt = now + Math.min(Math.max(1, expiresIn), 2592e3) * 1e3;
  const pushId = runtime.id("psh");
  try {
    await env.DB.prepare(`INSERT INTO pushes
      (id, user_id, source_device_id, target_device_id, target_kind, type, payload_version,
       ciphertext, nonce, payload_json, client_guid, created_at, modified_at, expires_at, status)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 'active')`).bind(pushId, auth.user_id, auth.device_id, targetDeviceId, targetKind, type, "", "", payloadJson, clientGuid, now, now, expiresAt).run();
  } catch {
    const raced = await env.DB.prepare("SELECT * FROM pushes WHERE user_id = ? AND client_guid = ?").bind(auth.user_id, clientGuid).first();
    if (!raced || !payloadEquals(raced, type, targetKind, targetDeviceId, payloadJson)) throw new Error("push insert failed");
    return json(pushOut(raced, auth.device_id), { headers: { "idempotent-replayed": "true", "x-request-id": requestId } });
  }
  const row = await env.DB.prepare("SELECT * FROM pushes WHERE id = ?").bind(pushId).first();
  if (!row) throw new Error("created push is missing");
  return json(pushOut(row, auth.device_id), { status: 201, headers: { "x-request-id": requestId } });
}
async function listPushes(url, env, auth, requestId) {
  const requestedLimit = Number(url.searchParams.get("limit"));
  const limit = Math.min(100, Math.max(1, Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.floor(requestedLimit) : 100));
  const cursor = await decodeCursor(url.searchParams.get("after"), auth, requestId);
  const includeDeleted = url.searchParams.get("include_deleted") !== "false";
  const deletedClause = includeDeleted ? "" : " AND deleted_at IS NULL";
  const result = cursor ? await env.DB.prepare(`SELECT * FROM pushes WHERE user_id = ?${deletedClause} AND (modified_at > ? OR (modified_at = ? AND id > ?)) ORDER BY modified_at, id LIMIT ?`).bind(auth.user_id, cursor.time, cursor.time, cursor.id, limit + 1).all() : await env.DB.prepare(`SELECT * FROM pushes WHERE user_id = ?${deletedClause} ORDER BY modified_at, id LIMIT ?`).bind(auth.user_id, limit + 1).all();
  const rows = result.results.slice(0, limit);
  const last = rows.at(-1);
  return {
    items: rows.map((row) => pushOut(row, auth.device_id)),
    next_cursor: last ? await encodeCursor(last.modified_at, last.id, auth) : null,
    has_more: result.results.length > limit
  };
}
async function getPush(env, auth, requestId, pushId) {
  const row = await env.DB.prepare("SELECT * FROM pushes WHERE id = ? AND user_id = ?").bind(pushId, auth.user_id).first();
  return row ? json(pushOut(row, auth.device_id), { headers: { "x-request-id": requestId } }) : problem(404, "not_found", "Push not found.", requestId);
}
async function mutatePush(request, env, auth, requestId, pushId, runtime) {
  const row = await env.DB.prepare("SELECT * FROM pushes WHERE id = ? AND user_id = ?").bind(pushId, auth.user_id).first();
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
  const updated = await env.DB.prepare("SELECT * FROM pushes WHERE id = ?").bind(pushId).first();
  if (!updated) throw new Error("updated push is missing");
  return json(pushOut(updated, auth.device_id), { headers: { "x-request-id": requestId } });
}

// infra/cloudflare/worker/src/subscriptions.ts
function webPushConfig(requestId) {
  return json({ subscription_registration: false, delivery: false, vapid_public_key: "" }, { headers: { "x-request-id": requestId } });
}
async function handleSubscriptionRoute() {
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
      web_push_delivery: false,
      web_push_subscription_registration: false,
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
    transports: { realtime: ["poll"], upload: [] },
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
      if (request.method === "GET" && path === "/v1/system/capabilities") return json(capabilities(env), { headers: { "x-request-id": requestId } });
      if (request.method === "GET" && path === "/v1/web-push-config") return webPushConfig(requestId);
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
      const fileResponse = await handleFileRoute();
      if (fileResponse) return fileResponse;
      const subscriptionResponse = await handleSubscriptionRoute();
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
