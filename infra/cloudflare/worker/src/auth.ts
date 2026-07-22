import { sha256Hex } from "./crypto";
import { deviceOut } from "./devices";
import { bodyJson, json, problem } from "./response";
import { iso } from "./runtime";
import type { AuthContext, DeviceRow, Env, Runtime } from "./types";

interface SessionRow {
  user_id: string;
  device_id: string;
  expires_at: number;
  handle: string;
  session_revoked_at: number | null;
  device_revoked_at: number | null;
  user_deleted_at: number | null;
}

export async function authenticate(request: Request, env: Env, requestId: string, runtime: Runtime): Promise<AuthContext> {
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
  `).bind(tokenHash).first<SessionRow>();
  if (!row || row.session_revoked_at != null || row.device_revoked_at != null || row.user_deleted_at != null || Number(row.expires_at) <= runtime.now()) {
    throw problem(401, "unauthorized", "The bearer token is expired, revoked, or invalid.", requestId, { "www-authenticate": "Bearer" });
  }
  return { user_id: row.user_id, device_id: row.device_id, handle: row.handle, cursor_key: tokenHash };
}

async function consumeBootstrapAttempt(request: Request, env: Env, requestId: string, runtime: Runtime): Promise<Response | null> {
  const source = request.headers.get("cf-connecting-ip") ?? "local-development";
  const sourceHash = await sha256Hex(source);
  const windowStartedAt = Math.floor(runtime.now() / 600_000) * 600_000;
  const row = await env.DB.prepare(`INSERT INTO bootstrap_rate_limits (source_hash, window_started_at, attempts)
    VALUES (?, ?, 1)
    ON CONFLICT(source_hash, window_started_at) DO UPDATE SET attempts = attempts + 1
    RETURNING attempts`).bind(sourceHash, windowStartedAt).first<{ attempts: number }>();
  const limit = Math.min(100, Math.max(1, Number(env.DEV_BOOTSTRAP_RATE_LIMIT) || 20));
  if (Number(row?.attempts) > limit) {
    return problem(429, "rate_limited", "Too many bootstrap attempts. Retry later.", requestId, { "retry-after": "600" });
  }
  return null;
}

async function verifyTurnstile(body: Record<string, unknown>, request: Request, env: Env, requestId: string): Promise<Response | null> {
  if (env.REQUIRE_DEV_BOOTSTRAP_TURNSTILE !== "true") return null;
  const token = typeof body.turnstile_token === "string" ? body.turnstile_token : request.headers.get("cf-turnstile-response");
  if (!token || !env.TURNSTILE_SECRET_KEY) return problem(403, "turnstile_required", "A valid Turnstile response is required.", requestId);
  const form = new FormData();
  form.set("secret", env.TURNSTILE_SECRET_KEY);
  form.set("response", token);
  const remoteIp = request.headers.get("cf-connecting-ip");
  if (remoteIp) form.set("remoteip", remoteIp);
  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
  const result = await response.json<{ success?: boolean }>();
  return result.success ? null : problem(403, "turnstile_failed", "Turnstile verification failed.", requestId);
}

export async function bootstrap(request: Request, env: Env, requestId: string, runtime: Runtime): Promise<Response> {
  if (env.ENABLE_DEV_BOOTSTRAP !== "true" || env.APP_ENVIRONMENT === "production") {
    return problem(404, "not_found", "Endpoint not found.", requestId);
  }
  const limited = await consumeBootstrapAttempt(request, env, requestId, runtime);
  if (limited) return limited;
  const body = await bodyJson(request, requestId);
  const turnstileFailure = await verifyTurnstile(body, request, env, requestId);
  if (turnstileFailure) return turnstileFailure;
  if (!/^[A-Za-z0-9_.-]{1,80}$/.test(typeof body.handle === "string" ? body.handle : "")
    || typeof body.device_name !== "string" || !body.device_name.trim()) {
    return problem(422, "validation_error", "handle and device_name are required.", requestId);
  }
  const existing = await env.DB.prepare("SELECT id FROM users WHERE handle = ? AND deleted_at IS NULL").bind(body.handle).first();
  if (existing) return problem(409, "handle_exists", "This handle already exists.", requestId);

  const now = runtime.now();
  const userId = runtime.id("usr");
  const deviceId = runtime.id("dev");
  const token = runtime.token();
  const expiresAt = now + 30 * 24 * 60 * 60 * 1000;
  const requestedKind = body.device_kind === "browser_extension" ? "extension" : typeof body.device_kind === "string" ? body.device_kind : "pwa";
  const kind = ["web", "pwa", "extension"].includes(requestedKind) ? requestedKind : "pwa";
  const publicKey = typeof body.public_key === "string" ? body.public_key : "";
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users (id, handle, created_at, updated_at) VALUES (?, ?, ?, ?)").bind(userId, body.handle, now, now),
    env.DB.prepare(`INSERT INTO devices
      (id, user_id, kind, name_ciphertext, public_key, last_seen_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(deviceId, userId, kind, body.device_name.trim(), publicKey, now, now, now),
    env.DB.prepare("INSERT INTO sessions (token_hash, user_id, device_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
      .bind(await sha256Hex(token), userId, deviceId, now, expiresAt),
  ]);
  const device: DeviceRow = { id: deviceId, user_id: userId, kind, name_ciphertext: body.device_name.trim(), public_key: publicKey, created_at: now, last_seen_at: now, revoked_at: null };
  return json({
    user: { id: userId, handle: body.handle, created_at: iso(now) },
    device: deviceOut(device, deviceId),
    access_token: token,
    token_type: "bearer",
    expires_at: iso(expiresAt),
  }, { status: 201, headers: { "x-request-id": requestId } });
}
