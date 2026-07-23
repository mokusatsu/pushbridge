import { env, exports as workerExports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { cleanupExpiredMetadata } from "../src/cleanup";
import { processAccountDeletionJobs } from "../src/account";
import { issueDeliveryToken } from "../src/deliveries";
import { createWorker } from "../src/index";
import type { Env } from "../src/types";
import { base64UrlEncode } from "../src/crypto";
import { sha256Hex } from "../src/crypto";
import { deliverFilePush } from "../src/web-push";
import { UserHub } from "../src/user-hub";

interface BootstrapResult {
  user: { id: string };
  device: { id: string };
  access_token: string;
}

interface PushResult {
  id: string;
}

interface PushPage {
  items: Array<{ id: string; file_ref?: { id: string; state: string } | null }>;
  next_cursor: string | null;
  has_more: boolean;
}

interface FileResult {
  id: string;
  state: string;
  expected_size: number;
  actual_size: number | null;
}

interface FileInitResult {
  file: FileResult;
  upload_url: string;
}

const worker = (workerExports as unknown as { default: { fetch(request: Request): Promise<Response> } }).default;
let sequence = 0;
const DEVICE_PUBLIC_KEY = `p256.${"A".repeat(87)}`;

function unique(prefix: string): string {
  sequence += 1;
  return `${prefix}_${sequence}_${crypto.randomUUID().slice(0, 8)}`;
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`https://worker.test${path}`, init);
}

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  return worker.fetch(request(path, init));
}

function nextWebSocketMessage(socket: WebSocket, timeoutMs = 2_000): Promise<MessageEvent> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.removeEventListener("message", onMessage);
      reject(new Error("Timed out waiting for WebSocket message"));
    }, timeoutMs);
    const onMessage = (event: MessageEvent) => {
      clearTimeout(timeout);
      socket.removeEventListener("message", onMessage);
      resolve(event);
    };
    socket.addEventListener("message", onMessage);
  });
}

function nextWebSocketClose(socket: WebSocket, timeoutMs = 2_000): Promise<CloseEvent> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.removeEventListener("close", onClose);
      reject(new Error("Timed out waiting for WebSocket close"));
    }, timeoutMs);
    const onClose = (event: CloseEvent) => {
      clearTimeout(timeout);
      socket.removeEventListener("close", onClose);
      resolve(event);
    };
    socket.addEventListener("close", onClose);
  });
}

async function issueRealtimeTicket(token: string): Promise<{ ticket: string; expires_at: string }> {
  const response = await call("/api/v1/realtime-ticket", { method: "POST", headers: auth(token) });
  expect(response.status).toBe(201);
  return response.json<{ ticket: string; expires_at: string }>();
}

async function openRealtime(ticket: string): Promise<{ response: Response; socket?: WebSocket; connected?: Record<string, unknown> }> {
  const response = await call("/realtime", {
    headers: { upgrade: "websocket", "sec-websocket-protocol": `pushbridge.v1, pushbridge-ticket.${ticket}` },
  });
  const socket = response.webSocket ?? undefined;
  if (!socket) return { response };
  const message = nextWebSocketMessage(socket);
  socket.accept();
  return { response, socket, connected: JSON.parse(String((await message).data)) as Record<string, unknown> };
}

async function bootstrap(sourceIp = `198.51.100.${sequence + 1}`): Promise<BootstrapResult> {
  const response = await call("/api/v1/auth/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": sourceIp },
    body: JSON.stringify({ handle: unique("user"), device_name: "Test device", device_kind: "pwa", public_key: DEVICE_PUBLIC_KEY }),
  });
  expect(response.status).toBe(201);
  return response.json<BootstrapResult>();
}

function auth(token: string, extra: HeadersInit = {}): Headers {
  const headers = new Headers(extra);
  headers.set("authorization", `Bearer ${token}`);
  return headers;
}

async function createNote(token: string, clientGuid = unique("idem"), target: Record<string, unknown> = { kind: "all_other_devices" }): Promise<Response> {
  return call("/api/v1/pushes", {
    method: "POST",
    headers: auth(token, { "content-type": "application/json", "idempotency-key": clientGuid }),
    body: JSON.stringify({ type: "note", client_guid: clientGuid, target, payload_version: 1, payload: { title: "fixture", body: "fixture" } }),
  });
}

async function digestHex(bytes: Uint8Array): Promise<string> {
  const input = new Uint8Array(bytes.byteLength);
  input.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", input.buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function initFile(token: string, bytes: Uint8Array, filename = "fixture.bin", expiresIn = 86_400): Promise<{ response: Response; result?: FileInitResult }> {
  const response = await call("/api/v1/files/init", {
    method: "POST",
    headers: auth(token, { "content-type": "application/json" }),
    body: JSON.stringify({ filename, content_type: "application/octet-stream", size: bytes.byteLength, sha256: await digestHex(bytes), expires_in: expiresIn }),
  });
  return { response, result: response.ok ? await response.clone().json<FileInitResult>() : undefined };
}

async function createReadyFile(token: string, size: number, filename = "retention.bin"): Promise<{ id: string; r2Key: string }> {
  const bytes = new Uint8Array(size);
  bytes.fill(size % 251);
  const initialized = await initFile(token, bytes, filename);
  expect(initialized.response.status).toBe(201);
  expect((await uploadFile(initialized.result!.upload_url, bytes)).status).toBe(200);
  expect((await call(`/api/v1/files/${initialized.result!.file.id}/complete`, { method: "POST", headers: auth(token) })).status).toBe(200);
  const row = await env.DB.prepare("SELECT r2_key FROM files WHERE id = ?").bind(initialized.result!.file.id).first<{ r2_key: string }>();
  return { id: initialized.result!.file.id, r2Key: row!.r2_key };
}

async function uploadFile(uploadUrl: string, bytes: Uint8Array): Promise<Response> {
  const body = new Uint8Array(bytes.byteLength);
  body.set(bytes);
  return call(new URL(uploadUrl).pathname, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: body.buffer });
}

describe("Worker runtime integration", () => {
  it("issues one-use Passkey challenges with an explicit RP configuration", async () => {
    const config = await call("/api/v1/auth/config");
    expect(config.status).toBe(200);
    expect(await config.json()).toEqual({
      passkey_enabled: true,
      rp_name: "Pushbridge Test",
      turnstile_required: false,
      turnstile_site_key: null,
    });
    const handler = createWorker();
    const fetchHandler = handler.fetch as unknown as (request: Request<unknown, any>, workerEnv: Env, ctx: ExecutionContext) => Promise<Response>;
    const optionsRequest = request("/api/v1/auth/passkeys/registration/options", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle: unique("bad_rp"), device_name: "Bad RP" }),
    });
    expect((await fetchHandler(optionsRequest.clone(), {
      ...env, PASSKEY_RP_ID: "other.test", PASSKEY_EXPECTED_ORIGINS: '["https://worker.test"]',
    }, {} as ExecutionContext)).status).toBe(503);
    expect((await fetchHandler(optionsRequest.clone(), {
      ...env, PASSKEY_RP_ID: "https://worker.test", PASSKEY_EXPECTED_ORIGINS: '["https://worker.test"]',
    }, {} as ExecutionContext)).status).toBe(503);
    expect((await fetchHandler(optionsRequest.clone(), {
      ...env, PASSKEY_RP_ID: "127.0.0.1", PASSKEY_EXPECTED_ORIGINS: '["http://127.0.0.1:8787"]',
    }, {} as ExecutionContext)).status).toBe(503);
    const handle = unique("passkey");
    const optionsResponse = await call("/api/v1/auth/passkeys/registration/options", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "198.51.100.210" },
      body: JSON.stringify({ handle, device_name: "Passkey PWA", device_kind: "pwa" }),
    });
    expect(optionsResponse.status).toBe(200);
    const options = await optionsResponse.json<{
      challenge_id: string;
      public_key: { rp: { id: string }; user: { name: string }; authenticatorSelection: { residentKey: string; userVerification: string } };
    }>();
    expect(options.public_key.rp.id).toBe("worker.test");
    expect(options.public_key.user.name).toBe(handle);
    expect(options.public_key.authenticatorSelection).toMatchObject({ residentKey: "required", userVerification: "required" });
    const stored = await env.DB.prepare("SELECT challenge, consumed_at FROM auth_challenges WHERE id = ?")
      .bind(options.challenge_id).first<{ challenge: string; consumed_at: number | null }>();
    expect(stored).toMatchObject({ challenge: expect.any(String), consumed_at: null });

    const invalid = await call("/api/v1/auth/passkeys/registration/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challenge_id: options.challenge_id, credential: {} }),
    });
    expect(invalid.status).toBe(400);
    expect((await invalid.json<{ detail: { code: string } }>()).detail.code).toBe("passkey_verification_failed");
    const replay = await call("/api/v1/auth/passkeys/registration/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challenge_id: options.challenge_id, credential: {} }),
    });
    expect(replay.status).toBe(400);
    expect((await replay.json<{ detail: { code: string } }>()).detail.code).toBe("invalid_challenge");
  });

  it("supports cookie sessions while enforcing exact Origin and CSRF on mutations", async () => {
    const bearer = await bootstrap("198.51.100.211");
    const token = `browser_${unique("token")}`;
    const csrf = `csrf_${unique("token")}`;
    const now = Date.now();
    await env.DB.prepare(`INSERT INTO sessions
      (token_hash, user_id, device_id, created_at, expires_at, session_kind, session_id, csrf_token_hash, last_seen_at, idle_expires_at, absolute_expires_at)
      VALUES (?, ?, ?, ?, ?, 'browser', ?, ?, ?, ?, ?)`)
      .bind(await sha256Hex(token), bearer.user.id, bearer.device.id, now, now + 60_000, unique("ses"), await sha256Hex(csrf), now, now + 60_000, now + 120_000).run();
    const cookie = { cookie: `__Host-pushbridge_session=${token}` };
    expect((await call("/api/v1/devices", { headers: cookie })).status).toBe(200);

    const linkBody = JSON.stringify({ name: "Cookie peer", kind: "pwa" });
    expect((await call("/api/v1/devices/link", { method: "POST", headers: { ...cookie, "content-type": "application/json" }, body: linkBody })).status).toBe(403);
    expect((await call("/api/v1/devices/link", { method: "POST", headers: { ...cookie, origin: "https://evil.test", "x-csrf-token": csrf, "content-type": "application/json" }, body: linkBody })).status).toBe(403);
    expect((await call("/api/v1/devices/link", { method: "POST", headers: { ...cookie, origin: "https://worker.test", "content-type": "application/json" }, body: linkBody })).status).toBe(403);
    expect((await call("/api/v1/devices/link", { method: "POST", headers: { ...cookie, origin: "https://worker.test", "x-csrf-token": csrf, "content-type": "application/json" }, body: linkBody })).status).toBe(201);

    const sessions = await call("/api/v1/auth/sessions", { headers: cookie });
    expect(sessions.status).toBe(200);
    expect(await sessions.json<Array<{ current: boolean }>>()).toContainEqual(expect.objectContaining({ current: true }));
    const logout = await call("/api/v1/auth/logout", { method: "POST", headers: { ...cookie, origin: "https://worker.test", "x-csrf-token": csrf } });
    expect(logout.status).toBe(204);
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await call("/api/v1/devices", { headers: cookie })).status).toBe(401);
  });

  it("rotates browser sessions without accepting the old cookie or CSRF token", async () => {
    const bearer = await bootstrap("198.51.100.212");
    const token = `browser_${unique("token")}`;
    const csrf = `csrf_${unique("token")}`;
    const now = Date.now();
    const sessionId = `ses_${crypto.randomUUID().replaceAll("-", "")}`;
    await env.DB.prepare(`INSERT INTO sessions
      (token_hash, user_id, device_id, created_at, expires_at, session_kind, session_id, csrf_token_hash, last_seen_at, idle_expires_at, absolute_expires_at)
      VALUES (?, ?, ?, ?, ?, 'browser', ?, ?, ?, ?, ?)`)
      .bind(await sha256Hex(token), bearer.user.id, bearer.device.id, now, now + 60_000, sessionId,
        await sha256Hex(csrf), now, now + 60_000, now + 120_000).run();
    const cookie = `__Host-pushbridge_session=${token}`;
    expect((await call("/api/v1/devices", { headers: { cookie } })).status).toBe(200);
    const cursorSecret = await env.DB.prepare("SELECT cursor_secret FROM devices WHERE id = ?")
      .bind(bearer.device.id).first<{ cursor_secret: string }>();

    const rotated = await call("/api/v1/auth/session/rotate", {
      method: "POST",
      headers: { cookie, origin: "https://worker.test", "x-csrf-token": csrf },
    });
    expect(rotated.status).toBe(200);
    const rotatedBody = await rotated.json<{ csrf_token: string }>();
    expect(rotatedBody.csrf_token).not.toBe(csrf);
    const setCookie = rotated.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("Secure; HttpOnly; SameSite=Strict");
    const rotatedCookie = setCookie.split(";", 1)[0];
    expect(rotatedCookie).not.toBe(cookie);
    expect((await call("/api/v1/devices", { headers: { cookie } })).status).toBe(401);
    expect((await call("/api/v1/devices", { headers: { cookie: rotatedCookie } })).status).toBe(200);
    expect((await call("/api/v1/device-links", {
      method: "POST",
      headers: { cookie: rotatedCookie, origin: "https://worker.test", "x-csrf-token": csrf, "content-type": "application/json" },
      body: JSON.stringify({ name: "Old CSRF peer", kind: "pwa" }),
    })).status).toBe(403);
    expect((await call("/api/v1/device-links", {
      method: "POST",
      headers: { cookie: rotatedCookie, origin: "https://worker.test", "x-csrf-token": rotatedBody.csrf_token, "content-type": "application/json" },
      body: JSON.stringify({ name: "Rotated peer", kind: "pwa" }),
    })).status).toBe(201);
    const cursorAfter = await env.DB.prepare("SELECT cursor_secret FROM devices WHERE id = ?")
      .bind(bearer.device.id).first<{ cursor_secret: string }>();
    expect(cursorAfter?.cursor_secret).toBe(cursorSecret?.cursor_secret);
  });

  it("allows only one winner when the same browser session is revoked concurrently", async () => {
    const bearer = await bootstrap("198.51.100.218");
    const now = Date.now();
    const currentToken = `browser_${unique("current")}`;
    const currentCsrf = `csrf_${unique("current")}`;
    const currentId = `ses_${crypto.randomUUID().replaceAll("-", "")}`;
    const targetId = `ses_${crypto.randomUUID().replaceAll("-", "")}`;
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO sessions
        (token_hash, user_id, device_id, created_at, expires_at, session_kind, session_id, csrf_token_hash, last_seen_at, idle_expires_at, absolute_expires_at)
        VALUES (?, ?, ?, ?, ?, 'browser', ?, ?, ?, ?, ?)`)
        .bind(await sha256Hex(currentToken), bearer.user.id, bearer.device.id, now, now + 60_000, currentId,
          await sha256Hex(currentCsrf), now, now + 60_000, now + 120_000),
      env.DB.prepare(`INSERT INTO sessions
        (token_hash, user_id, device_id, created_at, expires_at, session_kind, session_id, csrf_token_hash, last_seen_at, idle_expires_at, absolute_expires_at)
        VALUES (?, ?, ?, ?, ?, 'browser', ?, ?, ?, ?, ?)`)
        .bind(await sha256Hex(`browser_${unique("target")}`), bearer.user.id, bearer.device.id, now, now + 60_000, targetId,
          await sha256Hex(`csrf_${unique("target")}`), now, now + 60_000, now + 120_000),
    ]);
    const revoke = () => call(`/api/v1/auth/sessions/${targetId}`, {
      method: "DELETE",
      headers: { cookie: `__Host-pushbridge_session=${currentToken}`, origin: "https://worker.test", "x-csrf-token": currentCsrf },
    });
    const responses = await Promise.all([revoke(), revoke()]);
    expect(responses.map((response) => response.status).sort()).toEqual([204, 404]);
  });

  it("redeems device links exactly once and rejects expiry and concurrent replay", async () => {
    const owner = await bootstrap("198.51.100.213");
    const create = async (name: string) => {
      const response = await call("/api/v1/device-links", {
        method: "POST",
        headers: auth(owner.access_token, { "content-type": "application/json" }),
        body: JSON.stringify({ name, kind: "pwa", public_key: DEVICE_PUBLIC_KEY }),
      });
      expect(response.status).toBe(201);
      return response.json<{ id: string; link_token: string; status: string }>();
    };
    const redeem = (linkToken: string) => call("/api/v1/device-links/redeem", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "198.51.100.214" },
      body: JSON.stringify({ link_token: linkToken }),
    });

    const link = await create("One-use peer");
    expect((await call(`/api/v1/device-links/${link.id}`, { headers: auth(owner.access_token) })).status).toBe(200);
    const first = await redeem(link.link_token);
    expect(first.status).toBe(201);
    const linked = await first.json<{ device: { id: string }; access_token: string }>();
    expect((await call("/api/v1/devices/me", { headers: auth(linked.access_token) })).status).toBe(200);
    expect((await redeem(link.link_token)).status).toBe(410);
    expect(await (await call(`/api/v1/device-links/${link.id}`, { headers: auth(owner.access_token) })).json())
      .toEqual(expect.objectContaining({ status: "consumed", device_id: linked.device.id }));

    const expired = await create("Expired peer");
    await env.DB.prepare("UPDATE device_links SET expires_at = ? WHERE id = ?").bind(Date.now() - 1, expired.id).run();
    expect((await redeem(expired.link_token)).status).toBe(410);

    const raced = await create("Concurrent peer");
    const results = await Promise.all([redeem(raced.link_token), redeem(raced.link_token)]);
    expect(results.map((response) => response.status).sort()).toEqual([201, 410]);
    const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM devices WHERE user_id = ? AND name_ciphertext = ?")
      .bind(owner.user.id, "Concurrent peer").first<{ count: number }>();
    expect(Number(count?.count)).toBe(1);
  });

  it("enforces independent IP, account, and device mutation rate limits", async () => {
    const now = Date.now();
    const windowStartedAt = Math.floor(now / 600_000) * 600_000;
    const sourceIp = "198.51.100.215";
    await env.DB.prepare(`INSERT INTO auth_rate_limits (source_hash, action, window_started_at, attempts)
      VALUES (?, 'registration_options', ?, 20)`)
      .bind(await sha256Hex(sourceIp), windowStartedAt).run();
    const ipLimited = await call("/api/v1/auth/passkeys/registration/options", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": sourceIp },
      body: JSON.stringify({ handle: unique("ip_rate"), device_name: "Rate test" }),
    });
    expect(ipLimited.status).toBe(429);
    expect((await ipLimited.json<{ detail: { code: string } }>()).detail.code).toBe("rate_limited");

    const owner = await bootstrap("198.51.100.216");
    const user = await env.DB.prepare("SELECT handle FROM users WHERE id = ?").bind(owner.user.id).first<{ handle: string }>();
    await env.DB.prepare(`INSERT INTO auth_rate_limits (source_hash, action, window_started_at, attempts)
      VALUES (?, 'account_authentication', ?, 20)`)
      .bind(await sha256Hex(`account:${owner.user.id}`), windowStartedAt).run();
    const accountLimited = await call("/api/v1/auth/passkeys/authentication/options", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "198.51.100.217" },
      body: JSON.stringify({ handle: user!.handle }),
    });
    expect(accountLimited.status).toBe(429);
    expect((await accountLimited.json<{ detail: { code: string } }>()).detail.code).toBe("account_rate_limited");

    await env.DB.prepare(`INSERT INTO auth_rate_limits (source_hash, action, window_started_at, attempts)
      VALUES (?, 'device_mutation', ?, 300)`)
      .bind(await sha256Hex(`device:${owner.device.id}`), windowStartedAt).run();
    const deviceLimited = await call("/api/v1/device-links", {
      method: "POST",
      headers: auth(owner.access_token, { "content-type": "application/json" }),
      body: JSON.stringify({ name: "Rate-limited peer", kind: "pwa" }),
    });
    expect(deviceLimited.status).toBe(429);
    expect((await deviceLimited.json<{ detail: { code: string } }>()).detail.code).toBe("device_rate_limited");
  });

  it("stores opaque account/recovery envelopes and refuses revoked or cross-account device targets", async () => {
    const owner = await bootstrap("198.51.100.219");
    const recovery = { v: 1, alg: "A256GCM-HKDF-SHA256", key_version: 1, kind: "recovery", salt: "fixture", nonce: "fixture", ciphertext: "fixture" };
    const currentEnvelope = { v: 1, alg: "A256GCM-HKDF-SHA256", key_version: 1, recipient_device_id: owner.device.id,
      ephemeral_public_key: "p256.fixture", salt: "fixture", nonce: "fixture", ciphertext: "fixture" };
    const initialized = await call("/api/v1/e2ee/account-key", {
      method: "POST",
      headers: auth(owner.access_token, { "content-type": "application/json" }),
      body: JSON.stringify({ key_version: 1, recovery_envelope: recovery, device_envelope: currentEnvelope }),
    });
    expect(initialized.status).toBe(201);
    expect((await call("/api/v1/e2ee/account-key", {
      method: "POST",
      headers: auth(owner.access_token, { "content-type": "application/json" }),
      body: JSON.stringify({ key_version: 1, recovery_envelope: recovery, device_envelope: currentEnvelope }),
    })).status).toBe(409);
    expect(await (await call("/api/v1/e2ee/status", { headers: auth(owner.access_token) })).json())
      .toEqual(expect.objectContaining({ initialized: true, current_key_version: 1, current_device_has_envelope: true }));
    expect(await (await call("/api/v1/e2ee/device-envelope", { headers: auth(owner.access_token) })).json())
      .toEqual(expect.objectContaining({ key_version: 1, envelope: currentEnvelope }));
    expect(await (await call("/api/v1/e2ee/recovery-envelope", { headers: auth(owner.access_token) })).json())
      .toEqual(expect.objectContaining({ key_version: 1, envelope: recovery }));

    const linkedResponse = await call("/api/v1/devices/link", {
      method: "POST",
      headers: auth(owner.access_token, { "content-type": "application/json" }),
      body: JSON.stringify({ name: "Encrypted peer", kind: "pwa", public_key: DEVICE_PUBLIC_KEY }),
    });
    const linked = await linkedResponse.json<{ device: { id: string } }>();
    const peerEnvelope = { ...currentEnvelope, recipient_device_id: linked.device.id, ciphertext: "peer-fixture" };
    const put = () => call(`/api/v1/e2ee/device-envelopes/${linked.device.id}`, {
      method: "PUT",
      headers: auth(owner.access_token, { "content-type": "application/json" }),
      body: JSON.stringify({ key_version: 1, envelope: peerEnvelope }),
    });
    expect((await put()).status).toBe(201);
    expect((await put()).status).toBe(200);
    const changedEnvelope = { ...peerEnvelope, ciphertext: "different" };
    expect((await call(`/api/v1/e2ee/device-envelopes/${linked.device.id}`, {
      method: "PUT",
      headers: auth(owner.access_token, { "content-type": "application/json" }),
      body: JSON.stringify({ key_version: 1, envelope: changedEnvelope }),
    })).status).toBe(409);
    await env.DB.prepare("UPDATE devices SET revoked_at = ? WHERE id = ?").bind(Date.now(), linked.device.id).run();
    expect((await put()).status).toBe(404);

    const stranger = await bootstrap("198.51.100.220");
    expect((await call(`/api/v1/e2ee/device-envelopes/${stranger.device.id}`, {
      method: "PUT",
      headers: auth(owner.access_token, { "content-type": "application/json" }),
      body: JSON.stringify({ key_version: 1, envelope: { ...peerEnvelope, recipient_device_id: stranger.device.id } }),
    })).status).toBe(404);
  });

  it("stores payload_version 2 ciphertext without plaintext and can require E2EE", async () => {
    const owner = await bootstrap("198.51.100.221");
    const clientGuid = unique("encrypted");
    const encryptedBody = {
      type: "note",
      target: { kind: "all_other_devices" },
      payload_version: 2,
      key_version: 1,
      encryption_salt: "c2FsdF9maXh0dXJl",
      nonce: "bm9uY2VfZml4dHVyZQ",
      ciphertext: "Y2lwaGVydGV4dF9maXh0dXJl",
      client_guid: clientGuid,
    };
    const created = await call("/api/v1/pushes", {
      method: "POST",
      headers: auth(owner.access_token, { "content-type": "application/json", "idempotency-key": clientGuid }),
      body: JSON.stringify(encryptedBody),
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual(expect.objectContaining({
      payload_version: 2,
      key_version: 1,
      encryption_salt: encryptedBody.encryption_salt,
      nonce: encryptedBody.nonce,
      ciphertext: encryptedBody.ciphertext,
      payload: null,
    }));
    const stored = await env.DB.prepare(`SELECT payload_json, key_version, encryption_salt, ciphertext, nonce
      FROM pushes WHERE user_id = ? AND client_guid = ?`).bind(owner.user.id, clientGuid)
      .first<{ payload_json: string | null; key_version: number; encryption_salt: string; ciphertext: string; nonce: string }>();
    expect(stored).toEqual({ payload_json: null, key_version: 1, encryption_salt: encryptedBody.encryption_salt,
      ciphertext: encryptedBody.ciphertext, nonce: encryptedBody.nonce });
    expect((await call("/api/v1/pushes", {
      method: "POST",
      headers: auth(owner.access_token, { "content-type": "application/json", "idempotency-key": clientGuid }),
      body: JSON.stringify(encryptedBody),
    })).headers.get("idempotent-replayed")).toBe("true");

    const handler = createWorker();
    const fetchHandler = handler.fetch as unknown as (request: Request<unknown, any>, workerEnv: Env, ctx: ExecutionContext) => Promise<Response>;
    const plaintext = request("/api/v1/pushes", {
      method: "POST",
      headers: auth(owner.access_token, { "content-type": "application/json" }),
      body: JSON.stringify({ type: "note", target: { kind: "all_other_devices" }, payload: { title: "must not persist" } }),
    });
    const rejected = await fetchHandler(plaintext, { ...env, REQUIRE_E2EE: "true" }, {} as ExecutionContext);
    expect(rejected.status).toBe(422);
    expect((await rejected.json<{ detail: { code: string } }>()).detail.code).toBe("e2ee_required");
    const plaintextFile = await fetchHandler(request("/api/v1/files/init", {
      method: "POST",
      headers: auth(owner.access_token, { "content-type": "application/json" }),
      body: JSON.stringify({ filename: "leaked-name.txt", content_type: "text/plain", size: 0 }),
    }), { ...env, REQUIRE_E2EE: "true" }, {} as ExecutionContext);
    expect(plaintextFile.status).toBe(422);
    const encryptedFile = await fetchHandler(request("/api/v1/files/init", {
      method: "POST",
      headers: auth(owner.access_token, { "content-type": "application/json" }),
      body: JSON.stringify({ filename: "encrypted.bin", content_type: "application/octet-stream", size: 0, encrypted: true }),
    }), { ...env, REQUIRE_E2EE: "true" }, {} as ExecutionContext);
    expect(encryptedFile.status).toBe(201);
    const encryptedFileBody = await encryptedFile.json<{ file: { id: string; original_name: string; e2ee: boolean } }>();
    expect(encryptedFileBody.file).toEqual(expect.objectContaining({ original_name: "encrypted.bin", e2ee: true }));
  });

  it("uses D1, R2, and Durable Object bindings", async () => {
    const health = await call("/healthz");
    expect(health.status).toBe(200);
    await env.FILES.put("test/runtime-bindings", new Uint8Array([1, 2, 3]));
    expect([...new Uint8Array(await (await env.FILES.get("test/runtime-bindings"))!.arrayBuffer())]).toEqual([1, 2, 3]);
    await env.FILES.delete("test/runtime-bindings");
    const stub = env.USER_HUB.get(env.USER_HUB.idFromName("test"));
    expect((await stub.fetch("https://user-hub.test/")).status).toBe(404);
  });

  it("issues a session-bound one-time realtime ticket and sends a signed cursor tickle", async () => {
    const session = await bootstrap();
    const issued = await issueRealtimeTicket(session.access_token);
    expect(Date.parse(issued.expires_at) - Date.now()).toBeLessThanOrEqual(30_000);
    expect(Date.parse(issued.expires_at)).toBeGreaterThan(Date.now());

    const opened = await openRealtime(issued.ticket);
    expect(opened.response.status).toBe(101);
    expect(opened.connected).toEqual(expect.objectContaining({ event_version: 1, type: "connected" }));

    const syncMessage = nextWebSocketMessage(opened.socket!);
    const created = await createNote(session.access_token);
    expect(created.status).toBe(201);
    const sync = JSON.parse(String((await syncMessage).data)) as {
      type: string;
      reason: string;
      cursor_hint?: string;
    };
    expect(sync).toEqual(expect.objectContaining({
      type: "sync_required",
      reason: "push.created",
      cursor_hint: expect.stringContaining("."),
    }));

    const replay = await call("/realtime", {
      headers: { upgrade: "websocket", "sec-websocket-protocol": `pushbridge.v1, pushbridge-ticket.${issued.ticket}` },
    });
    expect(replay.status).toBe(409);
    expect((await replay.json<{ detail: { code: string } }>()).detail.code).toBe("realtime_ticket_used");
    opened.socket!.close(1000, "test complete");
  });

  it("rejects expired tickets and tickets whose session was revoked", async () => {
    const expiredSession = await bootstrap();
    const expired = await issueRealtimeTicket(expiredSession.access_token);
    await env.DB.prepare("UPDATE realtime_tickets SET expires_at = 0 WHERE token_hash = ?")
      .bind(await sha256Hex(expired.ticket)).run();
    const expiredResponse = await call("/realtime", {
      headers: { upgrade: "websocket", "sec-websocket-protocol": `pushbridge.v1, pushbridge-ticket.${expired.ticket}` },
    });
    expect(expiredResponse.status).toBe(410);

    const revokedSession = await bootstrap();
    const revoked = await issueRealtimeTicket(revokedSession.access_token);
    await env.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE device_id = ?")
      .bind(Date.now(), revokedSession.device.id).run();
    const revokedResponse = await call("/realtime", {
      headers: { upgrade: "websocket", "sec-websocket-protocol": `pushbridge.v1, pushbridge-ticket.${revoked.ticket}` },
    });
    expect(revokedResponse.status).toBe(401);
    expect((await revokedResponse.json<{ detail: { code: string } }>()).detail.code).toBe("realtime_session_invalid");
  });

  it("enforces per-device connection and inbound message limits", async () => {
    const session = await bootstrap();
    const first = await openRealtime((await issueRealtimeTicket(session.access_token)).ticket);
    const second = await openRealtime((await issueRealtimeTicket(session.access_token)).ticket);
    expect(first.response.status).toBe(101);
    expect(second.response.status).toBe(101);

    const third = await openRealtime((await issueRealtimeTicket(session.access_token)).ticket);
    expect(third.response.status).toBe(429);

    const closed = nextWebSocketClose(first.socket!);
    first.socket!.send("x".repeat(65_537));
    expect((await closed).code).toBe(1009);
    second.socket!.close(1000, "test complete");
  });

  it("isolates realtime fan-out by account", async () => {
    const accountA = await bootstrap();
    const accountB = await bootstrap();
    const socketA = (await openRealtime((await issueRealtimeTicket(accountA.access_token)).ticket)).socket!;
    const socketB = (await openRealtime((await issueRealtimeTicket(accountB.access_token)).ticket)).socket!;
    let leaked = false;
    socketB.addEventListener("message", (event) => {
      try {
        if ((JSON.parse(String(event.data)) as { type?: string }).type === "sync_required") leaked = true;
      } catch { /* Ignore non-JSON protocol frames. */ }
    });
    const delivered = nextWebSocketMessage(socketA);
    expect((await createNote(accountA.access_token)).status).toBe(201);
    expect(JSON.parse(String((await delivered).data))).toEqual(expect.objectContaining({ type: "sync_required" }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(leaked).toBe(false);
    socketA.close(1000, "test complete");
    socketB.close(1000, "test complete");
  });

  it("closes a backpressured realtime connection before sending another tickle", async () => {
    const session = await bootstrap();
    const attachment = {
      userId: session.user.id,
      deviceId: session.device.id,
      sessionTokenHash: await sha256Hex(session.access_token),
      connectedAt: Date.now(),
    };
    let closeCode: number | undefined;
    let sent = false;
    const socket = {
      bufferedAmount: 1_048_577,
      deserializeAttachment: () => attachment,
      close: (code: number) => { closeCode = code; },
      send: () => { sent = true; },
    };
    const state = {
      setWebSocketAutoResponse: () => undefined,
      getWebSockets: () => [socket],
    } as unknown as DurableObjectState;
    const hub = new UserHub(state, env);
    const response = await hub.fetch(new Request("https://user-hub.internal/tickle", {
      method: "POST",
      headers: { "content-type": "application/json", "x-pushbridge-user-id": session.user.id },
      body: JSON.stringify({ reason: "push.created" }),
    }));
    expect(response.status).toBe(200);
    expect(closeCode).toBe(1013);
    expect(sent).toBe(false);
  });

  it("disconnects a revoked device without rolling back the D1 mutation", async () => {
    const owner = await bootstrap();
    const linkedResponse = await call("/api/v1/devices/link", {
      method: "POST",
      headers: auth(owner.access_token, { "content-type": "application/json" }),
      body: JSON.stringify({ name: "Realtime peer", kind: "pwa" }),
    });
    const linked = await linkedResponse.json<{ device: { id: string }; access_token: string }>();
    const opened = await openRealtime((await issueRealtimeTicket(linked.access_token)).ticket);
    const closed = nextWebSocketClose(opened.socket!);
    const revoked = await call(`/api/v1/devices/${linked.device.id}`, {
      method: "DELETE",
      headers: auth(owner.access_token),
    });
    expect(revoked.status).toBe(204);
    expect((await closed).code).toBe(4401);
    expect((await env.DB.prepare("SELECT revoked_at FROM devices WHERE id = ?")
      .bind(linked.device.id).first<{ revoked_at: number | null }>())?.revoked_at).not.toBeNull();
  });

  it("keeps the committed push when the Durable Object tickle fails", async () => {
    const session = await bootstrap();
    const handler = createWorker();
    const fetchHandler = handler.fetch as unknown as (
      request: Request<unknown, any>,
      workerEnv: Env,
      ctx: ExecutionContext,
    ) => Promise<Response>;
    const unavailableHub = {
      idFromName: (name: string) => env.USER_HUB.idFromName(name),
      get: () => ({ fetch: async () => { throw new Error("Durable Object unavailable"); } }),
    } as unknown as DurableObjectNamespace;
    const clientGuid = unique("do_failure");
    const response = await fetchHandler(request("/api/v1/pushes", {
      method: "POST",
      headers: auth(session.access_token, {
        "content-type": "application/json",
        "idempotency-key": clientGuid,
      }),
      body: JSON.stringify({
        type: "note",
        client_guid: clientGuid,
        target: { kind: "all_other_devices" },
        payload_version: 1,
        payload: { title: "fixture", body: "fixture" },
      }),
    }), { ...env, USER_HUB: unavailableHub }, {} as ExecutionContext);
    expect(response.status).toBe(201);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM pushes WHERE user_id = ? AND client_guid = ?")
      .bind(session.user.id, clientGuid).first<{ count: number }>())?.count).toBe(1);
  });

  it("rejects revoked sessions", async () => {
    const session = await bootstrap();
    await env.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE device_id = ?").bind(Date.now(), session.device.id).run();
    expect((await call("/api/v1/devices", { headers: auth(session.access_token) })).status).toBe(401);
  });

  it("encrypts, upserts, lists, scopes, and revokes Web Push subscriptions", async () => {
    const owner = await bootstrap("198.51.100.90");
    const config = await (await call("/api/v1/web-push-config")).json<{
      subscription_registration: boolean;
      delivery: boolean;
      vapid_public_key: string;
    }>();
    expect(config.subscription_registration).toBe(true);
    expect(config.delivery).toBe(false);
    expect(config.vapid_public_key).toHaveLength(87);

    const linkedResponse = await call("/api/v1/devices/link", {
      method: "POST",
      headers: auth(owner.access_token, { "content-type": "application/json" }),
      body: JSON.stringify({ name: "Subscription peer", kind: "pwa" }),
    });
    const linked = await linkedResponse.json<{ access_token: string }>();
    const input = {
      endpoint: `https://push.example.test/${unique("endpoint")}`,
      p256dh: "BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      auth: "AAAAAAAAAAAAAAAAAAAAAA",
      storage_namespace: "worker-test",
      local_cache_max_bytes: 1024,
    };
    const createdResponse = await call("/api/v1/web-push-subscriptions", {
      method: "POST",
      headers: auth(owner.access_token, { "content-type": "application/json" }),
      body: JSON.stringify(input),
    });
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json<{ id: string; endpoint: string }>();
    expect(created.endpoint).toBe(input.endpoint);

    const stored = await env.DB.prepare(`SELECT endpoint_ciphertext, endpoint_hash, p256dh_ciphertext, auth_ciphertext
      FROM web_push_subscriptions WHERE id = ?`).bind(created.id).first<Record<string, string>>();
    expect(stored?.endpoint_ciphertext).not.toContain(input.endpoint);
    expect(stored?.p256dh_ciphertext).not.toBe(input.p256dh);
    expect(stored?.auth_ciphertext).not.toBe(input.auth);
    expect(stored?.endpoint_hash).toMatch(/^[a-f0-9]{64}$/);

    const replay = await call("/api/v1/web-push-subscriptions", {
      method: "POST",
      headers: auth(owner.access_token, { "content-type": "application/json" }),
      body: JSON.stringify({ ...input, local_cache_max_bytes: 2048 }),
    });
    expect(replay.status).toBe(200);
    expect((await replay.json<{ id: string }>()).id).toBe(created.id);
    const listed = await (await call("/api/v1/web-push-subscriptions", { headers: auth(owner.access_token) }))
      .json<Array<{ id: string; endpoint: string }>>();
    expect(listed).toEqual([expect.objectContaining({ id: created.id, endpoint: input.endpoint })]);

    expect((await call(`/api/v1/web-push-subscriptions/${created.id}`, { method: "DELETE", headers: auth(linked.access_token) })).status).toBe(404);
    expect((await call(`/api/v1/web-push-subscriptions/${created.id}`, { method: "DELETE", headers: auth(owner.access_token) })).status).toBe(204);
    expect(await (await call("/api/v1/web-push-subscriptions", { headers: auth(owner.access_token) })).json()).toEqual([]);
  });

  it("rejects malformed and modified cursors", async () => {
    const session = await bootstrap();
    expect((await call("/api/v1/pushes?after=not-a-cursor", { headers: auth(session.access_token) })).status).toBe(400);
    expect((await createNote(session.access_token)).status).toBe(201);
    const page = await (await call("/api/v1/pushes", { headers: auth(session.access_token) })).json<PushPage>();
    expect(page.next_cursor).toBeTruthy();
    const cursor = page.next_cursor!;
    const replacement = cursor.endsWith("A") ? "B" : "A";
    expect((await call(`/api/v1/pushes?after=${encodeURIComponent(cursor.slice(0, -1) + replacement)}`, { headers: auth(session.access_token) })).status).toBe(400);
  });

  it("honors include_deleted", async () => {
    const session = await bootstrap();
    const created = await createNote(session.access_token);
    const push = await created.json<PushResult>();
    expect((await call(`/api/v1/pushes/${push.id}`, { method: "DELETE", headers: auth(session.access_token) })).status).toBe(200);
    const active = await (await call("/api/v1/pushes?include_deleted=false", { headers: auth(session.access_token) })).json<PushPage>();
    const all = await (await call("/api/v1/pushes?include_deleted=true", { headers: auth(session.access_token) })).json<PushPage>();
    expect(active.items.some((item) => item.id === push.id)).toBe(false);
    expect(all.items.some((item) => item.id === push.id)).toBe(true);
  });

  it("rejects cross-user device targets and push reads", async () => {
    const first = await bootstrap("198.51.100.40");
    const second = await bootstrap("198.51.100.41");
    expect((await createNote(first.access_token, unique("target"), { kind: "device", device_id: second.device.id })).status).toBe(422);
    const secondPush = await (await createNote(second.access_token)).json<PushResult>();
    expect((await call(`/api/v1/pushes/${secondPush.id}`, { headers: auth(first.access_token) })).status).toBe(404);
  });

  it("enforces payload size by UTF-8 bytes", async () => {
    const session = await bootstrap();
    const clientGuid = unique("utf8");
    const response = await call("/api/v1/pushes", {
      method: "POST",
      headers: auth(session.access_token, { "content-type": "application/json", "idempotency-key": clientGuid }),
      body: JSON.stringify({ type: "note", client_guid: clientGuid, target: { kind: "all_devices" }, payload: { body: "é".repeat(1_000_000) } }),
    });
    expect(response.status).toBe(413);
  });

  it("paginates more than 200 rows with identical modified_at", async () => {
    const session = await bootstrap();
    const timestamp = Date.now();
    for (let offset = 0; offset < 205; offset += 50) {
      const statements = Array.from({ length: Math.min(50, 205 - offset) }, (_, index) => {
        const value = offset + index;
        const pushId = `psh_page_${String(value).padStart(4, "0")}_${session.user.id}`;
        return env.DB.prepare(`INSERT INTO pushes
          (id, user_id, source_device_id, target_device_id, target_kind, type, payload_version, ciphertext, nonce,
           payload_json, client_guid, created_at, modified_at, expires_at, status)
          VALUES (?, ?, ?, NULL, 'all_other_devices', 'note', 1, '', '', '{}', ?, ?, ?, ?, 'active')`)
          .bind(pushId, session.user.id, session.device.id, `page-${value}-${session.user.id}`, timestamp, timestamp, timestamp + 60_000);
      });
      await env.DB.batch(statements);
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: PushPage = await (await call(`/api/v1/pushes?limit=100${cursor ? `&after=${encodeURIComponent(cursor)}` : ""}`, { headers: auth(session.access_token) })).json<PushPage>();
      seen.push(...page.items.map((item) => item.id));
      cursor = page.has_more ? page.next_cursor : null;
    } while (cursor);
    expect(seen).toHaveLength(205);
    expect(new Set(seen).size).toBe(205);
  });

  it("replays the same Idempotency-Key 100 times without duplication", async () => {
    const session = await bootstrap();
    const key = unique("hundred");
    const responses: Response[] = [];
    for (let index = 0; index < 100; index += 1) responses.push(await createNote(session.access_token, key));
    expect(responses[0].status).toBe(201);
    expect(responses.slice(1).every((response) => response.status === 200 && response.headers.get("idempotent-replayed") === "true")).toBe(true);
    const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM pushes WHERE user_id = ? AND client_guid = ?").bind(session.user.id, key).first<{ count: number }>();
    expect(Number(count?.count)).toBe(1);
  });

  it("rate limits bootstrap and supports production/Turnstile feature flags", async () => {
    const sourceIp = "198.51.100.99";
    for (let index = 0; index < 20; index += 1) {
      const response = await call("/api/v1/auth/bootstrap", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": sourceIp },
        body: "{}",
      });
      expect(response.status).toBe(422);
    }
    expect((await call("/api/v1/auth/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": sourceIp },
      body: "{}",
    })).status).toBe(429);

    const handler = createWorker();
    const fetchHandler = handler.fetch as unknown as (request: Request<unknown, any>, env: Env, ctx: ExecutionContext) => Promise<Response>;
    const baseRequest = request("/api/v1/auth/bootstrap", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect((await fetchHandler(baseRequest.clone(), { ...env, APP_ENVIRONMENT: "production", ENABLE_DEV_BOOTSTRAP: "true" }, {} as ExecutionContext)).status).toBe(404);
    expect((await fetchHandler(baseRequest.clone(), { ...env, REQUIRE_DEV_BOOTSTRAP_TURNSTILE: "true" }, {} as ExecutionContext)).status).toBe(403);
  });

  it("streams a private R2 file through tickets and syncs its file_ref to another device", async () => {
    const first = await bootstrap("198.51.100.110");
    const linkedResponse = await call("/api/v1/devices/link", {
      method: "POST",
      headers: auth(first.access_token, { "content-type": "application/json" }),
      body: JSON.stringify({ name: "Receiver", kind: "pwa" }),
    });
    expect(linkedResponse.status).toBe(201);
    const linked = await linkedResponse.json<{ device: { id: string }; access_token: string }>();
    const receiverKeys = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const receiverPublic = new Uint8Array(await crypto.subtle.exportKey("raw", receiverKeys.publicKey));
    const receiverAuth = crypto.getRandomValues(new Uint8Array(16));
    expect((await call("/api/v1/web-push-subscriptions", {
      method: "POST",
      headers: auth(linked.access_token, { "content-type": "application/json" }),
      body: JSON.stringify({
        endpoint: `https://push.example.test/${unique("receiver")}`,
        p256dh: base64UrlEncode(receiverPublic),
        auth: base64UrlEncode(receiverAuth),
        storage_namespace: "worker-file-test",
      }),
    })).status).toBe(201);
    const bytes = new TextEncoder().encode("encrypted file fixture");
    const initialized = await initFile(first.access_token, bytes, "must-not-appear-in-r2-key.svg");
    expect(initialized.response.status).toBe(201);
    const file = initialized.result!;
    const ledger = await env.DB.prepare("SELECT r2_key FROM files WHERE id = ?").bind(file.file.id).first<{ r2_key: string }>();
    expect(ledger?.r2_key).toMatch(/^ttl\/1d\//);
    expect(ledger?.r2_key).not.toContain("must-not-appear");
    expect((await uploadFile(file.upload_url, bytes)).status).toBe(200);
    const completed = await call(`/api/v1/files/${file.file.id}/complete`, { method: "POST", headers: auth(first.access_token) });
    expect(completed.status).toBe(200);
    const replay = await call(`/api/v1/files/${file.file.id}/complete`, { method: "POST", headers: auth(first.access_token) });
    expect(replay.status).toBe(200);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");

    const clientGuid = unique("file-push");
    const pushResponse = await call("/api/v1/pushes", {
      method: "POST",
      headers: auth(first.access_token, { "content-type": "application/json", "idempotency-key": clientGuid }),
      body: JSON.stringify({
        type: "file",
        file_id: file.file.id,
        client_guid: clientGuid,
        target: { kind: "device", device_id: linked.device.id },
        payload: { file: { name: "fixture.bin", size: bytes.byteLength } },
      }),
    });
    expect(pushResponse.status).toBe(201);
    const filePush = await pushResponse.json<PushResult>();
    const delivery = await env.DB.prepare("SELECT * FROM file_deliveries WHERE file_id = ? AND destination_device_id = ?")
      .bind(file.file.id, linked.device.id).first<{ id: string; state: string }>();
    expect(delivery).toMatchObject({ state: "pending" });
    const vapidKeys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const vapidPublic = new Uint8Array(await crypto.subtle.exportKey("raw", vapidKeys.publicKey));
    const vapidPrivate = await crypto.subtle.exportKey("jwk", vapidKeys.privateKey);
    let webPushPosts = 0;
    await deliverFilePush({
      ...env,
      VAPID_PUBLIC_KEY: base64UrlEncode(vapidPublic),
      VAPID_PRIVATE_KEY: vapidPrivate.d!,
      VAPID_SUBJECT: "mailto:pushbridge@example.test",
    }, filePush.id, "https://worker.test", {
      now: () => Date.now(),
      id: (prefix) => unique(prefix),
      token: () => unique("delivery-secret"),
    }, (async (_input: RequestInfo | URL, init?: RequestInit) => {
      webPushPosts += 1;
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("content-encoding")).toBe("aes128gcm");
      expect(new TextDecoder().decode(init?.body as ArrayBuffer)).not.toContain("fixture.bin");
      return new Response(null, { status: 201 });
    }) as typeof fetch);
    expect(webPushPosts).toBe(1);
    expect((await env.DB.prepare("SELECT state FROM file_deliveries WHERE id = ?").bind(delivery!.id).first<{ state: string }>())?.state).toBe("notified");
    const ackToken = unique("delivery-token");
    const issued = await issueDeliveryToken(env, delivery!.id, {
      now: () => Date.now(),
      id: (prefix) => unique(prefix),
      token: () => ackToken,
    });
    expect(issued).not.toBeNull();
    expect((await env.DB.prepare("SELECT state FROM file_deliveries WHERE id = ?").bind(delivery!.id).first<{ state: string }>())?.state).toBe("notified");
    expect((await call(`/api/v1/file-deliveries/${delivery!.id}/events`, {
      method: "POST",
      headers: { authorization: "Bearer wrong", "content-type": "application/json" },
      body: JSON.stringify({ state: "cached" }),
    })).status).toBe(403);
    const fetching = await call(`/api/v1/file-deliveries/${delivery!.id}/events`, {
      method: "POST",
      headers: { authorization: `Bearer ${ackToken}`, "content-type": "application/json" },
      body: JSON.stringify({ state: "fetching" }),
    });
    expect(fetching.status).toBe(200);
    const cached = await call(`/api/v1/file-deliveries/${delivery!.id}/events`, {
      method: "POST",
      headers: { authorization: `Bearer ${ackToken}`, "content-type": "application/json" },
      body: JSON.stringify({ state: "cached" }),
    });
    expect(cached.status).toBe(200);
    expect((await cached.json<{ state: string }>()).state).toBe("cached");
    expect((await call(`/api/v1/file-deliveries/${delivery!.id}/events`, {
      method: "POST",
      headers: { authorization: `Bearer ${ackToken}`, "content-type": "application/json" },
      body: JSON.stringify({ state: "cached" }),
    })).headers.get("idempotent-replayed")).toBe("true");

    const thirdResponse = await call("/api/v1/devices/link", {
      method: "POST",
      headers: auth(first.access_token, { "content-type": "application/json" }),
      body: JSON.stringify({ name: "Receiver without cache", kind: "pwa" }),
    });
    const third = await thirdResponse.json<{ device: { id: string }; access_token: string }>();
    const thirdReceiverKeys = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const thirdReceiverPublic = new Uint8Array(await crypto.subtle.exportKey("raw", thirdReceiverKeys.publicKey));
    const thirdSubscriptionResponse = await call("/api/v1/web-push-subscriptions", {
      method: "POST",
      headers: auth(third.access_token, { "content-type": "application/json" }),
      body: JSON.stringify({
        endpoint: `https://push.example.test/${unique("gone-receiver")}`,
        p256dh: base64UrlEncode(thirdReceiverPublic),
        auth: base64UrlEncode(crypto.getRandomValues(new Uint8Array(16))),
        storage_namespace: "worker-file-test-gone",
      }),
    });
    expect(thirdSubscriptionResponse.status).toBe(201);
    const thirdSubscription = await thirdSubscriptionResponse.json<{ id: string }>();
    const missedKey = unique("file-push-missed");
    const missedPushResponse = await call("/api/v1/pushes", {
      method: "POST",
      headers: auth(first.access_token, { "content-type": "application/json", "idempotency-key": missedKey }),
      body: JSON.stringify({
        type: "file",
        file_id: file.file.id,
        client_guid: missedKey,
        target: { kind: "device", device_id: third.device.id },
        payload: { file: { name: "fixture.bin", size: bytes.byteLength } },
      }),
    });
    expect(missedPushResponse.status).toBe(201);
    const missedPush = await missedPushResponse.json<PushResult>();
    let goneDeliveryPosts = 0;
    await deliverFilePush({
      ...env,
      VAPID_PUBLIC_KEY: base64UrlEncode(vapidPublic),
      VAPID_PRIVATE_KEY: vapidPrivate.d!,
      VAPID_SUBJECT: "mailto:pushbridge@example.test",
    }, missedPush.id, "https://worker.test", {
      now: () => Date.now(),
      id: (prefix) => unique(prefix),
      token: () => unique("gone-delivery-secret"),
    }, (async () => {
      goneDeliveryPosts += 1;
      return new Response(null, { status: goneDeliveryPosts === 1 ? 503 : 410 });
    }) as typeof fetch);
    expect(goneDeliveryPosts).toBe(2);
    expect((await env.DB.prepare("SELECT revoked_at FROM web_push_subscriptions WHERE id = ?")
      .bind(thirdSubscription.id).first<{ revoked_at: number | null }>())?.revoked_at).not.toBeNull();
    expect((await env.DB.prepare("SELECT state FROM file_deliveries WHERE push_id = ?")
      .bind(missedPush.id).first<{ state: string }>())?.state).toBe("failed_retryable");
    const receiverPage = await (await call("/api/v1/pushes", { headers: auth(linked.access_token) })).json<PushPage>();
    expect(receiverPage.items.some((item) => item.file_ref?.id === file.file.id && item.file_ref.state === "ready")).toBe(true);

    const ticket = await (await call(`/api/v1/files/${file.file.id}/download-ticket`, { method: "POST", headers: auth(linked.access_token) }))
      .json<{ download_url: string }>();
    const download = await call(new URL(ticket.download_url).pathname);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition")).toContain("attachment");
    expect(download.headers.get("content-type")).toBe("application/octet-stream");
    expect([...new Uint8Array(await download.arrayBuffer())]).toEqual([...bytes]);
    expect((await call(new URL(ticket.download_url).pathname)).status).toBe(410);

    expect((await call(`/api/v1/files/${file.file.id}`, { method: "DELETE", headers: auth(first.access_token) })).status).toBe(200);
    const deliveries = await (await call(`/api/v1/files/${file.file.id}/deliveries`, { headers: auth(first.access_token) }))
      .json<Array<{ destination_device_id: string; state: string }>>();
    expect(deliveries).toEqual(expect.arrayContaining([
      expect.objectContaining({ destination_device_id: linked.device.id, state: "cached" }),
      expect.objectContaining({ destination_device_id: third.device.id, state: "missed" }),
    ]));
    expect(await env.FILES.get(ledger!.r2_key)).toBeNull();
    expect((await call(new URL(ticket.download_url).pathname)).status).toBe(410);
  });

  it("supports zero-byte and 25 MiB boundary uploads and downloads", async () => {
    const session = await bootstrap("198.51.100.111");
    for (const bytes of [new Uint8Array(0), new Uint8Array(25 * 1024 * 1024)]) {
      if (bytes.byteLength) bytes.fill(0x5a);
      const initialized = await initFile(session.access_token, bytes);
      expect(initialized.response.status).toBe(201);
      expect((await uploadFile(initialized.result!.upload_url, bytes)).status).toBe(200);
      expect((await call(`/api/v1/files/${initialized.result!.file.id}/complete`, { method: "POST", headers: auth(session.access_token) })).status).toBe(200);
      const ticket = await (await call(`/api/v1/files/${initialized.result!.file.id}/download-ticket`, { method: "POST", headers: auth(session.access_token) }))
        .json<{ download_url: string }>();
      const downloaded = await call(new URL(ticket.download_url).pathname);
      expect(downloaded.status).toBe(200);
      const downloadedBytes = new Uint8Array(await downloaded.arrayBuffer());
      expect(downloadedBytes.byteLength).toBe(bytes.byteLength);
      expect(await digestHex(downloadedBytes)).toBe(await digestHex(bytes));
      expect((await call(`/api/v1/files/${initialized.result!.file.id}`, { method: "DELETE", headers: auth(session.access_token) })).status).toBe(200);
    }
  }, 60_000);

  it("rejects oversized, mismatched, caller-supplied-key, expired, and cross-user file operations", async () => {
    const owner = await bootstrap("198.51.100.112");
    const other = await bootstrap("198.51.100.113");
    const over = await call("/api/v1/files/init", {
      method: "POST",
      headers: auth(owner.access_token, { "content-type": "application/json" }),
      body: JSON.stringify({ filename: "over.bin", size: 25 * 1024 * 1024 + 1, expires_in: 86_400 }),
    });
    expect(over.status).toBe(413);
    const suppliedKey = await call("/api/v1/files/init", {
      method: "POST",
      headers: auth(owner.access_token, { "content-type": "application/json" }),
      body: JSON.stringify({ filename: "bad.bin", size: 1, expires_in: 86_400, r2_key: "caller/key" }),
    });
    expect(suppliedKey.status).toBe(422);

    const expected = new Uint8Array([1, 2, 3]);
    const wrongSize = await initFile(owner.access_token, expected);
    expect((await uploadFile(wrongSize.result!.upload_url, new Uint8Array([1, 2]))).status).toBe(422);
    const wrongHashResponse = await call("/api/v1/files/init", {
      method: "POST",
      headers: auth(owner.access_token, { "content-type": "application/json" }),
      body: JSON.stringify({ filename: "hash.bin", size: 3, sha256: "0".repeat(64), expires_in: 86_400 }),
    });
    const wrongHash = await wrongHashResponse.json<FileInitResult>();
    expect((await uploadFile(wrongHash.upload_url, expected)).status).toBe(422);

    const valid = await initFile(owner.access_token, expected);
    expect((await uploadFile(valid.result!.upload_url, expected)).status).toBe(200);
    expect((await call(`/api/v1/files/${valid.result!.file.id}/complete`, { method: "POST", headers: auth(owner.access_token) })).status).toBe(200);
    expect((await call(`/api/v1/files/${valid.result!.file.id}`, { headers: auth(other.access_token) })).status).toBe(404);
    expect((await call(`/api/v1/files/${valid.result!.file.id}/download-ticket`, { method: "POST", headers: auth(other.access_token) })).status).toBe(404);
    expect((await call(`/api/v1/pushes`, {
      method: "POST",
      headers: auth(other.access_token, { "content-type": "application/json" }),
      body: JSON.stringify({ type: "file", file_id: valid.result!.file.id, client_guid: unique("cross-file"), target: { kind: "all_devices" }, payload: {} }),
    })).status).toBe(404);
    await env.DB.prepare("UPDATE files SET expires_at = ? WHERE id = ?").bind(Date.now() - 1, valid.result!.file.id).run();
    expect((await call(`/api/v1/files/${valid.result!.file.id}/download-ticket`, { method: "POST", headers: auth(owner.access_token) })).status).toBe(410);
  });

  it("reclaims an interrupted upload reservation after ticket expiry", async () => {
    const session = await bootstrap("198.51.100.114");
    const interrupted = await initFile(session.access_token, new Uint8Array([9]));
    await env.DB.batch([
      env.DB.prepare("UPDATE files SET upload_reservation_expires_at = ? WHERE id = ?").bind(Date.now() - 1, interrupted.result!.file.id),
      env.DB.prepare("UPDATE file_tickets SET expires_at = ? WHERE file_id = ?").bind(Date.now() - 1, interrupted.result!.file.id),
    ]);
    expect((await uploadFile(interrupted.result!.upload_url, new Uint8Array([9]))).status).toBe(410);
    const replacement = await initFile(session.access_token, new Uint8Array(0));
    expect(replacement.response.status).toBe(201);
    const reclaimed = await env.DB.prepare("SELECT state, delete_reason FROM files WHERE id = ?")
      .bind(interrupted.result!.file.id).first<{ state: string; delete_reason: string }>();
    expect(reclaimed).toEqual({ state: "deleted", delete_reason: "retention_expired" });
  });

  it("expires bytes, scrubs payloads, marks missed deliveries, and purges aliases after tombstone retention", async () => {
    const owner = await bootstrap("198.51.100.120");
    const receiverResponse = await call("/api/v1/devices/link", {
      method: "POST",
      headers: auth(owner.access_token, { "content-type": "application/json" }),
      body: JSON.stringify({ name: "Retention receiver", kind: "pwa" }),
    });
    const receiver = await receiverResponse.json<{ device: { id: string } }>();
    const ready = await createReadyFile(owner.access_token, 19, "must-be-scrubbed.bin");
    const pushKey = unique("retention-file-push");
    const pushResponse = await call("/api/v1/pushes", {
      method: "POST",
      headers: auth(owner.access_token, { "content-type": "application/json", "idempotency-key": pushKey }),
      body: JSON.stringify({
        type: "file",
        file_id: ready.id,
        target: { kind: "device", device_id: receiver.device.id },
        client_guid: pushKey,
        payload: { file: { name: "must-be-scrubbed.bin", size: 19 } },
      }),
    });
    const push = await pushResponse.json<PushResult>();
    let clock = Date.now() + 1_000;
    await env.DB.prepare("UPDATE files SET expires_at = ?, alias_expires_at = ? WHERE id = ?")
      .bind(clock - 1, clock + 10_000, ready.id).run();
    const runtime = { now: () => clock, id: (prefix: string) => unique(prefix), token: () => unique("cleanup-token") };
    const first = await cleanupExpiredMetadata(env, runtime);
    expect(first.expiredFiles).toBe(1);
    expect(first.deletedObjects).toBe(1);
    expect(await env.FILES.get(ready.r2Key)).toBeNull();
    const file = await env.DB.prepare(`SELECT state, original_name, expected_sha256, actual_sha256, delete_reason
      FROM files WHERE id = ?`).bind(ready.id).first<Record<string, unknown>>();
    expect(file).toMatchObject({
      state: "expired",
      original_name: "expired-file.bin",
      expected_sha256: null,
      actual_sha256: null,
      delete_reason: "retention_expired",
    });
    const scrubbed = await env.DB.prepare(`SELECT payload_json, length(ciphertext) AS ciphertext_length,
      length(nonce) AS nonce_length FROM pushes WHERE id = ?`).bind(push.id).first<Record<string, unknown>>();
    expect(scrubbed).toEqual({ payload_json: null, ciphertext_length: 0, nonce_length: 0 });
    expect((await env.DB.prepare("SELECT state FROM file_deliveries WHERE push_id = ?").bind(push.id).first<{ state: string }>())?.state).toBe("missed");
    const duplicate = await cleanupExpiredMetadata(env, runtime);
    expect(duplicate.expiredFiles).toBe(0);
    expect(duplicate.deletedObjects).toBe(0);

    clock += 11_000;
    await cleanupExpiredMetadata(env, runtime);
    expect((await env.DB.prepare("SELECT status, deleted_at FROM pushes WHERE id = ?").bind(push.id).first<{ status: string; deleted_at: number }>())?.status).toBe("deleted");
    clock += 7 * 24 * 60 * 60 * 1000 + 1;
    const purged = await cleanupExpiredMetadata(env, runtime);
    expect(purged.purgedTombstones).toBeGreaterThanOrEqual(1);
    expect(purged.purgedFileAliases).toBeGreaterThanOrEqual(1);
    expect(await env.DB.prepare("SELECT id FROM pushes WHERE id = ?").bind(push.id).first()).toBeNull();
    expect(await env.DB.prepare("SELECT id FROM files WHERE id = ?").bind(ready.id).first()).toBeNull();
  });

  it("evicts deterministically under pressure and recovers from R2 and D1 cleanup faults", async () => {
    await env.DB.prepare("UPDATE files SET state = 'deleted' WHERE state IN ('pending', 'uploaded', 'ready', 'delete_pending')").run();
    const owner = await bootstrap("198.51.100.121");
    const files = [
      await createReadyFile(owner.access_token, 30, "old-unpinned.bin"),
      await createReadyFile(owner.access_token, 30, "new-unpinned.bin"),
      await createReadyFile(owner.access_token, 30, "pinned.bin"),
    ];
    const pushIds: string[] = [];
    for (const file of files) {
      const key = unique("pressure-push");
      const response = await call("/api/v1/pushes", {
        method: "POST",
        headers: auth(owner.access_token, { "content-type": "application/json", "idempotency-key": key }),
        body: JSON.stringify({ type: "file", file_id: file.id, target: { kind: "all_devices" }, client_guid: key, payload: { file: { size: 30 } } }),
      });
      pushIds.push((await response.json<PushResult>()).id);
    }
    await env.DB.batch([
      env.DB.prepare("UPDATE files SET created_at = 1 WHERE id = ?").bind(files[0].id),
      env.DB.prepare("UPDATE files SET created_at = 2 WHERE id = ?").bind(files[1].id),
      env.DB.prepare("UPDATE files SET created_at = 0 WHERE id = ?").bind(files[2].id),
      env.DB.prepare("UPDATE pushes SET pinned_at = ? WHERE id = ?").bind(Date.now(), pushIds[2]),
    ]);
    let clock = Date.now() + 2_000;
    const runtime = { now: () => clock, id: (prefix: string) => unique(prefix), token: () => unique("pressure-token") };
    const pressureEnv = {
      ...env,
      STORAGE_BUDGET_BYTES: "100",
      STORAGE_PRESSURE_HIGH_PERCENT: "95",
      STORAGE_CLEANUP_TARGET_PERCENT: "50",
    };
    const pressure = await cleanupExpiredMetadata(pressureEnv, runtime, 10);
    expect(pressure.pressureEvictedFiles).toBe(2);
    expect(pressure.pressureEvictedBytes).toBe(60);
    const states = await env.DB.prepare("SELECT id, state FROM files WHERE id IN (?, ?, ?) ORDER BY id")
      .bind(files[0].id, files[1].id, files[2].id).all<{ id: string; state: string }>();
    expect(new Map(states.results.map((row) => [row.id, row.state]))).toEqual(new Map([
      [files[0].id, "deleted"],
      [files[1].id, "deleted"],
      [files[2].id, "ready"],
    ]));
    expect(await env.FILES.get(files[0].r2Key)).toBeNull();
    expect(await env.FILES.get(files[1].r2Key)).toBeNull();
    expect(await env.FILES.get(files[2].r2Key)).not.toBeNull();
    expect(Number((await env.DB.prepare("SELECT COUNT(*) AS count FROM storage_usage_daily").first<{ count: number }>())?.count)).toBeGreaterThan(0);

    const originalBucket = env.FILES;
    const failingBucket = new Proxy(originalBucket, {
      get(target, property) {
        if (property === "delete") return async () => { throw new Error("injected R2 delete failure"); };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const handler = createWorker();
    const fetchHandler = handler.fetch as unknown as (request: Request<unknown, any>, workerEnv: Env, ctx: ExecutionContext) => Promise<Response>;
    const insufficient = await fetchHandler(request("/api/v1/files/init", {
      method: "POST",
      headers: auth(owner.access_token, { "content-type": "application/json" }),
      body: JSON.stringify({ filename: "cannot-fit.bin", size: 30, expires_in: 86_400 }),
    }), { ...pressureEnv, STORAGE_BUDGET_BYTES: "50", FILES: failingBucket } as Env, {} as ExecutionContext);
    expect(insufficient.status).toBe(507);
    const pending = await env.DB.prepare("SELECT state, r2_delete_error_code FROM files WHERE id = ?")
      .bind(files[2].id).first<{ state: string; r2_delete_error_code: string }>();
    expect(pending).toEqual({ state: "delete_pending", r2_delete_error_code: "r2_delete_failed" });

    await env.DB.prepare("UPDATE files SET r2_delete_retry_at = ? WHERE id = ?").bind(clock, files[2].id).run();
    await cleanupExpiredMetadata(pressureEnv, runtime);
    expect((await env.DB.prepare("SELECT state FROM files WHERE id = ?").bind(files[2].id).first<{ state: string }>())?.state).toBe("deleted");

    const interrupted = await createReadyFile(owner.access_token, 11, "d1-interruption.bin");
    await env.DB.prepare("UPDATE files SET expires_at = ? WHERE id = ?").bind(clock - 1, interrupted.id).run();
    const failingDatabase = new Proxy(env.DB, {
      get(target, property) {
        if (property === "batch") return async () => { throw new Error("injected D1 finalization failure"); };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const interruptedReport = await cleanupExpiredMetadata({ ...env, DB: failingDatabase } as Env, runtime);
    expect(interruptedReport.errors).toBeGreaterThan(0);
    expect(await env.FILES.get(interrupted.r2Key)).toBeNull();
    expect((await env.DB.prepare("SELECT state, r2_delete_error_code FROM files WHERE id = ?")
      .bind(interrupted.id).first<{ state: string; r2_delete_error_code: string }>())).toEqual({ state: "delete_pending", r2_delete_error_code: "d1_finalize_failed" });
    await env.DB.prepare("UPDATE files SET r2_delete_retry_at = ? WHERE id = ?").bind(clock, interrupted.id).run();
    const recovered = await cleanupExpiredMetadata(env, runtime);
    expect(recovered.deletedObjects).toBeGreaterThanOrEqual(1);
    expect((await env.DB.prepare("SELECT state FROM files WHERE id = ?").bind(interrupted.id).first<{ state: string }>())?.state).toBe("expired");
  });

  it("logically locks an account before deleting its R2 objects and D1 metadata", async () => {
    const owner = await bootstrap("198.51.100.130");
    const ready = await createReadyFile(owner.access_token, 17, "account-delete.bin");
    const missingConfirmation = await call("/api/v1/account", {
      method: "DELETE",
      headers: auth(owner.access_token, { "content-type": "application/json" }),
      body: JSON.stringify({ confirmation: "delete" }),
    });
    expect(missingConfirmation.status).toBe(422);

    const response = await call("/api/v1/account", {
      method: "DELETE",
      headers: auth(owner.access_token, { "content-type": "application/json" }),
      body: JSON.stringify({ confirmation: "DELETE" }),
    });
    expect(response.status).toBe(202);
    const result = await response.json<{ deletion: { id: string; state: string } }>();
    expect(result.deletion.state).toBe("completed");
    expect(await env.FILES.get(ready.r2Key)).toBeNull();
    expect(await env.DB.prepare("SELECT id FROM users WHERE id = ?").bind(owner.user.id).first()).toBeNull();
    expect(await env.DB.prepare("SELECT id FROM files WHERE user_id = ?").bind(owner.user.id).first()).toBeNull();
    expect((await env.DB.prepare(`SELECT state, r2_objects_found, r2_objects_deleted, last_error_code
      FROM account_deletion_jobs WHERE id = ?`).bind(result.deletion.id).first<Record<string, unknown>>()))
      .toEqual({ state: "completed", r2_objects_found: 1, r2_objects_deleted: 1, last_error_code: null });
    expect((await call("/api/v1/devices", { headers: auth(owner.access_token) })).status).toBe(401);
  });

  it("keeps a deleted account locked and retries a transient R2 deletion failure", async () => {
    const owner = await bootstrap("198.51.100.131");
    const ready = await createReadyFile(owner.access_token, 23, "account-delete-retry.bin");
    const failingBucket = new Proxy(env.FILES, {
      get(target, property) {
        if (property === "delete") return async () => { throw new Error("injected account R2 deletion failure"); };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const handler = createWorker();
    const fetchHandler = handler.fetch as unknown as (request: Request<unknown, any>, workerEnv: Env, ctx: ExecutionContext) => Promise<Response>;
    const response = await fetchHandler(request("/api/v1/account", {
      method: "DELETE",
      headers: auth(owner.access_token, { "content-type": "application/json" }),
      body: JSON.stringify({ confirmation: "DELETE" }),
    }), { ...env, FILES: failingBucket } as Env, {} as ExecutionContext);
    expect(response.status).toBe(202);
    const result = await response.json<{ deletion: { id: string; state: string } }>();
    expect(result.deletion.state).toBe("failed");
    expect(await env.FILES.get(ready.r2Key)).not.toBeNull();
    expect((await call("/api/v1/devices", { headers: auth(owner.access_token) })).status).toBe(401);
    expect((await env.DB.prepare("SELECT deleted_at FROM users WHERE id = ?")
      .bind(owner.user.id).first<{ deleted_at: number }>())?.deleted_at).toBeTypeOf("number");

    const clock = Date.now() + 120_000;
    await env.DB.prepare("UPDATE account_deletion_jobs SET retry_at = ? WHERE id = ?").bind(clock, result.deletion.id).run();
    const runtime = { now: () => clock, id: (prefix: string) => unique(prefix), token: () => unique("deletion-token") };
    expect(await processAccountDeletionJobs(env, runtime, owner.user.id)).toBe(1);
    expect(await env.FILES.get(ready.r2Key)).toBeNull();
    expect(await env.DB.prepare("SELECT id FROM users WHERE id = ?").bind(owner.user.id).first()).toBeNull();
    expect((await env.DB.prepare("SELECT state FROM account_deletion_jobs WHERE id = ?")
      .bind(result.deletion.id).first<{ state: string }>())?.state).toBe("completed");
  });

  it("continues account R2 deletion with a cursor across 100-object batches", async () => {
    const owner = await bootstrap("198.51.100.132");
    const now = Date.now();
    const statements: D1PreparedStatement[] = [];
    const keys: string[] = [];
    for (let index = 0; index < 101; index += 1) {
      const id = unique(`fil-account-batch-${String(index).padStart(3, "0")}`);
      const key = `ttl/1d/${owner.user.id}/${id}`;
      keys.push(key);
      await env.FILES.put(key, new Uint8Array([index % 256]));
      statements.push(env.DB.prepare(`INSERT INTO files
        (id, user_id, r2_key, original_name, content_type, expected_size, actual_size, state,
          created_at, completed_at, expires_at, alias_expires_at, r2_delete_attempts, e2ee)
        VALUES (?, ?, ?, 'encrypted.bin', 'application/octet-stream', 1, 1, 'ready', ?, ?, ?, ?, 0, 1)`)
        .bind(id, owner.user.id, key, now, now, now + 86_400_000, now + 172_800_000));
    }
    await env.DB.batch(statements.slice(0, 50));
    await env.DB.batch(statements.slice(50, 100));
    await env.DB.batch(statements.slice(100));

    const response = await call("/api/v1/account", {
      method: "DELETE",
      headers: auth(owner.access_token, { "content-type": "application/json" }),
      body: JSON.stringify({ confirmation: "DELETE" }),
    });
    const result = await response.json<{ deletion: { id: string; state: string } }>();
    expect(response.status).toBe(202);
    expect(result.deletion.state).toBe("pending");
    expect((await call("/api/v1/devices", { headers: auth(owner.access_token) })).status).toBe(401);

    const runtime = { now: () => now + 1, id: (prefix: string) => unique(prefix), token: () => unique("deletion-token") };
    expect(await processAccountDeletionJobs(env, runtime, owner.user.id)).toBe(1);
    const completed = await env.DB.prepare(`SELECT state, r2_objects_found, r2_objects_deleted
      FROM account_deletion_jobs WHERE id = ?`).bind(result.deletion.id).first<Record<string, unknown>>();
    expect(completed).toEqual({ state: "completed", r2_objects_found: 101, r2_objects_deleted: 101 });
    expect(await env.DB.prepare("SELECT id FROM users WHERE id = ?").bind(owner.user.id).first()).toBeNull();
    for (const key of keys) expect(await env.FILES.get(key)).toBeNull();
  });

  it("stops automatic account deletion retries after twenty failures", async () => {
    const owner = await bootstrap("198.51.100.133");
    const ready = await createReadyFile(owner.access_token, 7, "account-delete-exhausted.bin");
    const failingBucket = new Proxy(env.FILES, {
      get(target, property) {
        if (property === "delete") return async () => { throw new Error("persistent R2 deletion failure"); };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const handler = createWorker();
    const fetchHandler = handler.fetch as unknown as (request: Request<unknown, any>, workerEnv: Env, ctx: ExecutionContext) => Promise<Response>;
    const response = await fetchHandler(request("/api/v1/account", {
      method: "DELETE",
      headers: auth(owner.access_token, { "content-type": "application/json" }),
      body: JSON.stringify({ confirmation: "DELETE" }),
    }), { ...env, FILES: failingBucket } as Env, {} as ExecutionContext);
    const result = await response.json<{ deletion: { id: string } }>();
    const clock = Date.now() + 120_000;
    await env.DB.prepare(`UPDATE account_deletion_jobs SET state = 'failed', attempts = 19, retry_at = ?
      WHERE id = ?`).bind(clock, result.deletion.id).run();
    const runtime = { now: () => clock, id: (prefix: string) => unique(prefix), token: () => unique("deletion-token") };
    expect(await processAccountDeletionJobs({ ...env, FILES: failingBucket } as Env, runtime, owner.user.id)).toBe(1);
    expect((await env.DB.prepare(`SELECT state, attempts, retry_at FROM account_deletion_jobs WHERE id = ?`)
      .bind(result.deletion.id).first<Record<string, unknown>>()))
      .toEqual({ state: "manual_intervention", attempts: 20, retry_at: null });
    expect(await processAccountDeletionJobs(env, runtime, owner.user.id)).toBe(0);
    expect(await env.FILES.get(ready.r2Key)).not.toBeNull();

    await env.DB.prepare(`UPDATE account_deletion_jobs SET state = 'failed', attempts = 1, retry_at = ?
      WHERE id = ?`).bind(clock, result.deletion.id).run();
    expect(await processAccountDeletionJobs(env, runtime, owner.user.id)).toBe(1);
    expect(await env.FILES.get(ready.r2Key)).toBeNull();
  });
});
