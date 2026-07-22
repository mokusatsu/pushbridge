import { env, exports as workerExports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createWorker } from "../src/index";
import type { Env } from "../src/types";

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

async function bootstrap(sourceIp = `198.51.100.${sequence + 1}`): Promise<BootstrapResult> {
  const response = await call("/api/v1/auth/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": sourceIp },
    body: JSON.stringify({ handle: unique("user"), device_name: "Test device", device_kind: "pwa", public_key: "test-key" }),
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

async function uploadFile(uploadUrl: string, bytes: Uint8Array): Promise<Response> {
  const body = new Uint8Array(bytes.byteLength);
  body.set(bytes);
  return call(new URL(uploadUrl).pathname, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: body.buffer });
}

describe("Worker runtime integration", () => {
  it("uses D1, R2, and Durable Object bindings", async () => {
    const health = await call("/healthz");
    expect(health.status).toBe(200);
    await env.FILES.put("test/runtime-bindings", new Uint8Array([1, 2, 3]));
    expect([...new Uint8Array(await (await env.FILES.get("test/runtime-bindings"))!.arrayBuffer())]).toEqual([1, 2, 3]);
    await env.FILES.delete("test/runtime-bindings");
    const stub = env.USER_HUB.get(env.USER_HUB.idFromName("test"));
    expect((await stub.fetch("https://user-hub.test/")).status).toBe(501);
  });

  it("rejects revoked sessions", async () => {
    const session = await bootstrap();
    await env.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE device_id = ?").bind(Date.now(), session.device.id).run();
    expect((await call("/api/v1/devices", { headers: auth(session.access_token) })).status).toBe(401);
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
    const receiverPage = await (await call("/api/v1/pushes", { headers: auth(linked.access_token) })).json<PushPage>();
    expect(receiverPage.items.some((item) => item.file_ref?.id === file.file.id && item.file_ref.state === "ready")).toBe(true);

    const ticket = await (await call(`/api/v1/files/${file.file.id}/download-ticket`, { method: "POST", headers: auth(linked.access_token) }))
      .json<{ download_url: string }>();
    const download = await call(new URL(ticket.download_url).pathname);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition")).toContain("attachment");
    expect(download.headers.get("content-type")).toBe("application/octet-stream");
    expect([...new Uint8Array(await download.arrayBuffer())]).toEqual([...bytes]);

    expect((await call(`/api/v1/files/${file.file.id}`, { method: "DELETE", headers: auth(first.access_token) })).status).toBe(200);
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
});
