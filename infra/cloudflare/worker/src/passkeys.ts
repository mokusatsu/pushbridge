import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { base64UrlDecode, base64UrlEncode, ownedBuffer, sha256Hex } from "./crypto";
import { deviceOut } from "./devices";
import { bodyJson, json, problem } from "./response";
import { iso } from "./runtime";
import type { AuthContext, DeviceRow, Env, Runtime } from "./types";

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const BROWSER_IDLE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const BROWSER_ABSOLUTE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_COOKIE = "__Host-pushbridge_session";

interface PasskeyConfig {
  rpID: string;
  rpName: string;
  origins: string[];
}

interface ChallengeRow {
  id: string;
  ceremony: "registration" | "authentication";
  challenge: string;
  user_id: string | null;
  pending_user_id: string | null;
  handle: string | null;
  device_name: string | null;
  device_kind: string | null;
  expires_at: number;
}

interface CredentialRow {
  credential_id: string;
  user_id: string;
  device_id: string;
  public_key: string;
  counter: number;
  transports_json: string;
  device_type: string;
  backed_up: number;
  handle?: string;
}

function expectedOrigins(value: string | undefined): string[] {
  if (!value) return [];
  let values: unknown = value.split(",");
  try {
    values = JSON.parse(value);
  } catch {
    // Comma-separated input remains supported for Wrangler/local development.
  }
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))];
}

export function passkeyConfig(env: Env): PasskeyConfig | null {
  const rpID = env.PASSKEY_RP_ID?.trim();
  const origins = expectedOrigins(env.PASSKEY_EXPECTED_ORIGINS);
  if (!rpID || origins.length === 0) return null;
  if (!origins.every((origin) => {
    try {
      const url = new URL(origin);
      return url.origin === origin && (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)));
    } catch {
      return false;
    }
  })) return null;
  return { rpID, origins, rpName: env.PASSKEY_RP_NAME?.trim() || "Pushbridge" };
}

function passkeyUnavailable(requestId: string): Response {
  return problem(503, "passkey_not_configured", "Passkey authentication is unavailable until an explicit RP ID and expected origin are configured.", requestId);
}

async function consumeAuthAttempt(request: Request, env: Env, action: string, requestId: string, runtime: Runtime): Promise<Response | null> {
  const source = request.headers.get("cf-connecting-ip") ?? "local-development";
  const sourceHash = await sha256Hex(source);
  const windowStartedAt = Math.floor(runtime.now() / 600_000) * 600_000;
  const row = await env.DB.prepare(`INSERT INTO auth_rate_limits (source_hash, action, window_started_at, attempts)
    VALUES (?, ?, ?, 1)
    ON CONFLICT(source_hash, action, window_started_at) DO UPDATE SET attempts = attempts + 1
    RETURNING attempts`).bind(sourceHash, action, windowStartedAt).first<{ attempts: number }>();
  const limit = Math.min(100, Math.max(1, Number(env.AUTH_RATE_LIMIT) || 20));
  return Number(row?.attempts) > limit
    ? problem(429, "rate_limited", "Too many authentication attempts. Retry later.", requestId, { "retry-after": "600" })
    : null;
}

async function verifyTurnstile(body: Record<string, unknown>, request: Request, env: Env, requestId: string): Promise<Response | null> {
  const required = env.REQUIRE_PASSKEY_TURNSTILE === "true" || (env.APP_ENVIRONMENT === "production" && env.REQUIRE_PASSKEY_TURNSTILE !== "false");
  if (!required) return null;
  const token = typeof body.turnstile_token === "string" ? body.turnstile_token : request.headers.get("cf-turnstile-response");
  if (!token || !env.TURNSTILE_SECRET_KEY) return problem(403, "turnstile_required", "A valid Turnstile response is required.", requestId);
  const form = new FormData();
  form.set("secret", env.TURNSTILE_SECRET_KEY);
  form.set("response", token);
  const remoteIp = request.headers.get("cf-connecting-ip");
  if (remoteIp) form.set("remoteip", remoteIp);
  const result = await (await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form })).json<{ success?: boolean }>();
  return result.success ? null : problem(403, "turnstile_failed", "Turnstile verification failed.", requestId);
}

function validHandle(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(value);
}

function deviceKind(value: unknown): "web" | "pwa" | "extension" {
  if (value === "web" || value === "extension" || value === "pwa") return value;
  return value === "browser_extension" ? "extension" : "pwa";
}

async function consumeChallenge(env: Env, id: unknown, ceremony: ChallengeRow["ceremony"], runtime: Runtime): Promise<ChallengeRow | null> {
  if (typeof id !== "string" || !id) return null;
  return env.DB.prepare(`UPDATE auth_challenges SET consumed_at = ?
    WHERE id = ? AND ceremony = ? AND consumed_at IS NULL AND expires_at > ? RETURNING *`)
    .bind(runtime.now(), id, ceremony, runtime.now()).first<ChallengeRow>();
}

function transports(value: string): AuthenticatorTransportFuture[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is AuthenticatorTransportFuture =>
      ["ble", "cable", "hybrid", "internal", "nfc", "smart-card", "usb"].includes(String(item))) : [];
  } catch {
    return [];
  }
}

async function issueBrowserSession(env: Env, userId: string, deviceId: string, requestId: string, runtime: Runtime): Promise<{ headers: Headers; csrfToken: string; expiresAt: number }> {
  const sessionId = runtime.id("ses");
  const token = runtime.token();
  const csrfToken = runtime.token();
  const now = runtime.now();
  const idleExpiresAt = now + BROWSER_IDLE_TTL_MS;
  const absoluteExpiresAt = now + BROWSER_ABSOLUTE_TTL_MS;
  await env.DB.prepare(`INSERT INTO sessions
    (token_hash, user_id, device_id, created_at, expires_at, session_kind, session_id, csrf_token_hash, last_seen_at, idle_expires_at, absolute_expires_at)
    VALUES (?, ?, ?, ?, ?, 'browser', ?, ?, ?, ?, ?)`)
    .bind(await sha256Hex(token), userId, deviceId, now, idleExpiresAt, sessionId, await sha256Hex(csrfToken), now, idleExpiresAt, absoluteExpiresAt).run();
  const headers = new Headers({
    "set-cookie": `${SESSION_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${BROWSER_IDLE_TTL_MS / 1000}`,
    "x-request-id": requestId,
  });
  return { headers, csrfToken, expiresAt: idleExpiresAt };
}

export async function registrationOptions(request: Request, env: Env, requestId: string, runtime: Runtime): Promise<Response> {
  const config = passkeyConfig(env);
  if (!config) return passkeyUnavailable(requestId);
  const limited = await consumeAuthAttempt(request, env, "registration_options", requestId, runtime);
  if (limited) return limited;
  const body = await bodyJson(request, requestId);
  const turnstileFailure = await verifyTurnstile(body, request, env, requestId);
  if (turnstileFailure) return turnstileFailure;
  if (!validHandle(body.handle) || typeof body.device_name !== "string" || !body.device_name.trim()) {
    return problem(422, "validation_error", "handle and device_name are required.", requestId);
  }
  if (await env.DB.prepare("SELECT id FROM users WHERE handle = ? AND deleted_at IS NULL").bind(body.handle).first()) {
    return problem(409, "handle_exists", "This handle already exists.", requestId);
  }
  const pendingUserId = runtime.id("usr");
  const options = await generateRegistrationOptions({
    rpID: config.rpID,
    rpName: config.rpName,
    userID: new TextEncoder().encode(pendingUserId),
    userName: body.handle,
    userDisplayName: body.handle,
    attestationType: "none",
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
  });
  const challengeId = runtime.id("chl");
  const now = runtime.now();
  await env.DB.prepare(`INSERT INTO auth_challenges
    (id, ceremony, challenge, pending_user_id, handle, device_name, device_kind, created_at, expires_at)
    VALUES (?, 'registration', ?, ?, ?, ?, ?, ?, ?)`)
    .bind(challengeId, options.challenge, pendingUserId, body.handle, body.device_name.trim(), deviceKind(body.device_kind), now, now + CHALLENGE_TTL_MS).run();
  return json({ challenge_id: challengeId, public_key: options, expires_at: iso(now + CHALLENGE_TTL_MS) }, { headers: { "x-request-id": requestId } });
}

export async function registrationVerify(request: Request, env: Env, requestId: string, runtime: Runtime): Promise<Response> {
  const config = passkeyConfig(env);
  if (!config) return passkeyUnavailable(requestId);
  const body = await bodyJson(request, requestId);
  const challenge = await consumeChallenge(env, body.challenge_id, "registration", runtime);
  if (!challenge || !challenge.pending_user_id || !challenge.handle || !challenge.device_name) {
    return problem(400, "invalid_challenge", "The registration challenge is invalid, expired, or already used.", requestId);
  }
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: body.credential as unknown as RegistrationResponseJSON,
      expectedChallenge: challenge.challenge,
      expectedOrigin: config.origins,
      expectedRPID: config.rpID,
      requireUserVerification: true,
    });
  } catch {
    return problem(400, "passkey_verification_failed", "The passkey registration response could not be verified.", requestId);
  }
  if (!verification.verified) return problem(400, "passkey_verification_failed", "The passkey registration response could not be verified.", requestId);
  if (await env.DB.prepare("SELECT id FROM users WHERE handle = ? AND deleted_at IS NULL").bind(challenge.handle).first()) {
    return problem(409, "handle_exists", "This handle already exists.", requestId);
  }
  const now = runtime.now();
  const deviceId = runtime.id("dev");
  const credential = verification.registrationInfo.credential;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users (id, handle, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .bind(challenge.pending_user_id, challenge.handle, now, now),
    env.DB.prepare(`INSERT INTO devices
      (id, user_id, kind, name_ciphertext, public_key, last_seen_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(deviceId, challenge.pending_user_id, challenge.device_kind ?? "pwa", challenge.device_name, credential.id, now, now, now),
    env.DB.prepare(`INSERT INTO passkey_credentials
      (credential_id, user_id, device_id, public_key, counter, transports_json, device_type, backed_up, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(credential.id, challenge.pending_user_id, deviceId, base64UrlEncode(credential.publicKey), credential.counter,
        JSON.stringify(credential.transports ?? []), verification.registrationInfo.credentialDeviceType,
        verification.registrationInfo.credentialBackedUp ? 1 : 0, now, now),
  ]);
  const session = await issueBrowserSession(env, challenge.pending_user_id, deviceId, requestId, runtime);
  const device: DeviceRow = { id: deviceId, user_id: challenge.pending_user_id, kind: challenge.device_kind ?? "pwa", name_ciphertext: challenge.device_name, public_key: credential.id, created_at: now, last_seen_at: now, revoked_at: null };
  return json({
    user: { id: challenge.pending_user_id, handle: challenge.handle, created_at: iso(now) },
    device: deviceOut(device, deviceId),
    csrf_token: session.csrfToken,
    expires_at: iso(session.expiresAt),
  }, { status: 201, headers: session.headers });
}

export async function authenticationOptions(request: Request, env: Env, requestId: string, runtime: Runtime): Promise<Response> {
  const config = passkeyConfig(env);
  if (!config) return passkeyUnavailable(requestId);
  const limited = await consumeAuthAttempt(request, env, "authentication_options", requestId, runtime);
  if (limited) return limited;
  const body = await bodyJson(request, requestId);
  let userId: string | null = null;
  let allowCredentials: Array<{ id: string; transports?: AuthenticatorTransportFuture[] }> | undefined;
  if (body.handle != null) {
    if (!validHandle(body.handle)) return problem(422, "validation_error", "handle is invalid.", requestId);
    const user = await env.DB.prepare("SELECT id FROM users WHERE handle = ? AND deleted_at IS NULL").bind(body.handle).first<{ id: string }>();
    if (user) {
      userId = user.id;
      const rows = await env.DB.prepare("SELECT credential_id, transports_json FROM passkey_credentials WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at")
        .bind(user.id).all<Pick<CredentialRow, "credential_id" | "transports_json">>();
      allowCredentials = rows.results.map((row) => ({ id: row.credential_id, transports: transports(row.transports_json) }));
    } else {
      allowCredentials = [];
    }
  }
  const options = await generateAuthenticationOptions({ rpID: config.rpID, allowCredentials, userVerification: "required" });
  const challengeId = runtime.id("chl");
  const now = runtime.now();
  await env.DB.prepare(`INSERT INTO auth_challenges (id, ceremony, challenge, user_id, created_at, expires_at)
    VALUES (?, 'authentication', ?, ?, ?, ?)`)
    .bind(challengeId, options.challenge, userId, now, now + CHALLENGE_TTL_MS).run();
  return json({ challenge_id: challengeId, public_key: options, expires_at: iso(now + CHALLENGE_TTL_MS) }, { headers: { "x-request-id": requestId } });
}

export async function authenticationVerify(request: Request, env: Env, requestId: string, runtime: Runtime): Promise<Response> {
  const config = passkeyConfig(env);
  if (!config) return passkeyUnavailable(requestId);
  const body = await bodyJson(request, requestId);
  const challenge = await consumeChallenge(env, body.challenge_id, "authentication", runtime);
  if (!challenge) return problem(400, "invalid_challenge", "The authentication challenge is invalid, expired, or already used.", requestId);
  const response = body.credential as unknown as AuthenticationResponseJSON;
  if (!response || typeof response.id !== "string") return problem(422, "validation_error", "credential is required.", requestId);
  const credential = await env.DB.prepare(`SELECT p.*, u.handle FROM passkey_credentials p
    JOIN users u ON u.id = p.user_id WHERE p.credential_id = ? AND p.revoked_at IS NULL AND u.deleted_at IS NULL`)
    .bind(response.id).first<CredentialRow>();
  if (!credential || (challenge.user_id && credential.user_id !== challenge.user_id)) {
    return problem(400, "passkey_verification_failed", "The passkey authentication response could not be verified.", requestId);
  }
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: config.origins,
      expectedRPID: config.rpID,
      credential: {
        id: credential.credential_id,
        publicKey: new Uint8Array(ownedBuffer(base64UrlDecode(credential.public_key))),
        counter: Number(credential.counter),
        transports: transports(credential.transports_json),
      },
      requireUserVerification: true,
    });
  } catch {
    return problem(400, "passkey_verification_failed", "The passkey authentication response could not be verified.", requestId);
  }
  if (!verification.verified) return problem(400, "passkey_verification_failed", "The passkey authentication response could not be verified.", requestId);
  const now = runtime.now();
  await env.DB.prepare(`UPDATE passkey_credentials SET counter = ?, device_type = ?, backed_up = ?, updated_at = ?, last_used_at = ?
    WHERE credential_id = ?`).bind(verification.authenticationInfo.newCounter, verification.authenticationInfo.credentialDeviceType,
      verification.authenticationInfo.credentialBackedUp ? 1 : 0, now, now, credential.credential_id).run();
  const session = await issueBrowserSession(env, credential.user_id, credential.device_id, requestId, runtime);
  return json({ csrf_token: session.csrfToken, expires_at: iso(session.expiresAt) }, { headers: session.headers });
}

export async function listBrowserSessions(env: Env, auth: AuthContext, requestId: string): Promise<Response> {
  const rows = await env.DB.prepare(`SELECT session_id, token_hash, device_id, created_at, last_seen_at, expires_at, revoked_at
    FROM sessions WHERE user_id = ? AND session_kind = 'browser' ORDER BY created_at DESC`).bind(auth.user_id).all<Record<string, unknown>>();
  return json(rows.results.map((row) => ({
    current: row.token_hash === auth.session_token_hash,
    id: row.session_id,
    device_id: row.device_id,
    created_at: iso(Number(row.created_at)),
    last_seen_at: iso(row.last_seen_at == null ? null : Number(row.last_seen_at)),
    expires_at: iso(Number(row.expires_at)),
    revoked: row.revoked_at != null,
  })), { headers: { "x-request-id": requestId } });
}

export async function logoutBrowserSession(env: Env, auth: AuthContext, requestId: string, runtime: Runtime): Promise<Response> {
  await env.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND session_kind = 'browser'")
    .bind(runtime.now(), auth.session_token_hash).run();
  return new Response(null, { status: 204, headers: {
    "set-cookie": `${SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`,
    "x-request-id": requestId,
  } });
}

export async function revokeBrowserSession(sessionId: string, env: Env, auth: AuthContext, requestId: string, runtime: Runtime): Promise<Response> {
  if (!/^ses_[a-f0-9]{32}$/.test(sessionId)) {
    return problem(422, "validation_error", "session_id is required.", requestId);
  }
  const result = await env.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE session_id = ? AND user_id = ? AND session_kind = 'browser' AND revoked_at IS NULL")
    .bind(runtime.now(), sessionId, auth.user_id).run();
  return result.meta.changes === 1 ? new Response(null, { status: 204, headers: { "x-request-id": requestId } })
    : problem(404, "session_not_found", "Session not found.", requestId);
}
