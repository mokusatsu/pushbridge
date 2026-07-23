#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const windows = process.platform === "win32";
const npx = windows ? process.execPath : "npx";
const npxPrefix = windows
  ? [join(dirname(process.execPath), "node_modules", "npm", "bin", "npx-cli.js")]
  : [];
const port = Number(process.env.PUSHBRIDGE_LOCAL_PORT ?? 8787);
const origin = `http://127.0.0.1:${port}`;
const config = "infra/cloudflare/wrangler.local.jsonc";
const persistence = ".runtime/wrangler";

function run(command, args) {
  console.log(`> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { stdio: "inherit", env: process.env, shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(path, init = {}) {
  const response = await fetch(`${origin}${path}`, { ...init, signal: init.signal ?? AbortSignal.timeout(2_000) });
  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("json") ? await response.json() : await response.text();
  return { response, body };
}

async function waitForWorker(child) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode != null) throw new Error(`wrangler dev exited early with ${child.exitCode}`);
    try {
      const { response } = await request("/healthz");
      if (response.ok) return;
    } catch {
      // Wrangler is still starting.
    }
    await delay(250);
  }
  throw new Error("wrangler dev did not become ready");
}

function waitForSocketMessage(socket, predicate, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.removeEventListener("message", onMessage);
      reject(new Error("Timed out waiting for realtime WebSocket message"));
    }, timeoutMs);
    const onMessage = (event) => {
      let value;
      try { value = JSON.parse(String(event.data)); } catch { return; }
      if (!predicate(value)) return;
      clearTimeout(timeout);
      socket.removeEventListener("message", onMessage);
      resolve(value);
    };
    socket.addEventListener("message", onMessage);
  });
}

async function openRealtimeSocket(ticket) {
  const socket = new WebSocket(`${origin.replace(/^http/, "ws")}/realtime`, ["pushbridge.v1", `pushbridge-ticket.${ticket}`]);
  const connected = waitForSocketMessage(socket, (message) => message.type === "connected");
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("Realtime WebSocket connection failed")), { once: true });
  });
  await connected;
  return socket;
}

run(npx, [...npxPrefix, "--yes", "wrangler@4", "d1", "migrations", "apply", "DB", "--local", "--config", config, "--persist-to", persistence]);

const child = spawn(npx, [...npxPrefix, "--yes", "wrangler@4", "dev", "--local", "--config", config, "--persist-to", persistence, "--ip", "127.0.0.1", "--port", String(port)], {
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
  shell: false,
  detached: !windows,
  windowsHide: true,
});
let logs = "";
let realtimeSocket;
for (const stream of [child.stdout, child.stderr]) {
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => { logs = `${logs}${chunk}`.slice(-12000); });
}

try {
  await waitForWorker(child);

  const health = await request("/healthz");
  assert(health.response.status === 200 && health.body.ok === true, "healthz failed");
  const status = await request("/api/bootstrap/status");
  assert(status.response.status === 200 && status.body.bootstrap === false && status.body.bindings.d1, "bootstrap status failed");
  const capabilities = await request("/api/v1/system/capabilities");
  assert(capabilities.response.status === 200 && capabilities.body.features.device_registration, "capabilities failed");
  assert(capabilities.body.features.direct_upload === false, "streaming adapter must not be advertised as direct upload");
  assert(capabilities.body.features.web_push_delivery === false, "Web Push delivery must remain disabled without VAPID secrets");
  assert(capabilities.body.features.realtime === true, "Durable Object realtime capability is missing");
  assert(capabilities.body.transports.realtime.includes("websocket"), "WebSocket realtime transport is missing");
  assert(capabilities.body.transports.upload.includes("server-ticket"), "server-ticket upload transport is missing");
  const webPushConfig = await request("/api/v1/web-push-config");
  assert(webPushConfig.response.status === 200 && webPushConfig.body.delivery === false, "Web Push config must report disabled delivery without VAPID secrets");

  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const bootstrap = await request("/api/v1/auth/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle: `smoke_${suffix}`, device_name: "Device A", device_kind: "pwa" }),
  });
  assert(bootstrap.response.status === 201, `device A bootstrap failed: ${JSON.stringify(bootstrap.body)}`);
  const tokenA = bootstrap.body.access_token;
  const authA = { authorization: `Bearer ${tokenA}`, "content-type": "application/json" };

  const linked = await request("/api/v1/devices/link", {
    method: "POST",
    headers: authA,
    body: JSON.stringify({ name: "Device B", kind: "pwa" }),
  });
  assert(linked.response.status === 201, `device B link failed: ${JSON.stringify(linked.body)}`);
  const tokenB = linked.body.access_token;
  const authB = { authorization: `Bearer ${tokenB}`, "content-type": "application/json" };
  const realtimeTicket = await request("/api/v1/realtime-ticket", { method: "POST", headers: authB });
  assert(realtimeTicket.response.status === 201, `realtime ticket failed: ${JSON.stringify(realtimeTicket.body)}`);
  realtimeSocket = await openRealtimeSocket(realtimeTicket.body.ticket);

  const unauthorized = await request("/api/v1/devices");
  assert(unauthorized.response.status === 401, "Bearer authentication was not enforced");
  const devices = await request("/api/v1/devices", { headers: authB });
  assert(devices.response.status === 200 && devices.body.length === 2, "linked devices were not visible to device B");

  const firstKey = `note-${suffix}-1`;
  const firstBody = {
    type: "note",
    target: { kind: "all_other_devices" },
    payload_version: 1,
    client_guid: firstKey,
    payload: { title: "First note", body: "from A" },
  };
  const firstTickle = waitForSocketMessage(realtimeSocket, (message) => message.type === "sync_required" && message.reason === "push.created");
  const first = await request("/api/v1/pushes", {
    method: "POST",
    headers: { ...authA, "idempotency-key": firstKey },
    body: JSON.stringify(firstBody),
  });
  assert(first.response.status === 201, `first note failed: ${JSON.stringify(first.body)}`);
  const tickle = await firstTickle;
  assert(typeof tickle.cursor_hint === "string" && tickle.cursor_hint.includes("."), "realtime tickle did not carry a signed cursor hint");
  const replay = await request("/api/v1/pushes", {
    method: "POST",
    headers: { ...authA, "idempotency-key": firstKey },
    body: JSON.stringify(firstBody),
  });
  assert(replay.response.status === 200 && replay.body.id === first.body.id, "idempotency replay created a duplicate");
  assert(replay.response.headers.get("idempotent-replayed") === "true", "idempotency replay header is missing");
  const conflict = await request("/api/v1/pushes", {
    method: "POST",
    headers: { ...authA, "idempotency-key": firstKey },
    body: JSON.stringify({ ...firstBody, payload: { title: "Changed", body: "must conflict" } }),
  });
  assert(conflict.response.status === 409 && conflict.body.detail?.code === "idempotency_conflict", "idempotency conflict was not rejected");

  const pageOne = await request("/api/v1/pushes?limit=100&include_deleted=true", { headers: authB });
  assert(pageOne.response.status === 200 && pageOne.body.items.length === 1, "device B did not receive the first note");
  assert(pageOne.body.items[0].is_for_current_device === true, "targeting did not include device B");
  const cursor = pageOne.body.next_cursor;
  assert(typeof cursor === "string" && cursor.length > 0, "first cursor is missing");

  const secondKey = `note-${suffix}-2`;
  const second = await request("/api/v1/pushes", {
    method: "POST",
    headers: { ...authA, "idempotency-key": secondKey },
    body: JSON.stringify({ ...firstBody, client_guid: secondKey, payload: { title: "Second note", body: "cursor delta" } }),
  });
  assert(second.response.status === 201, "second note failed");
  const pageTwo = await request(`/api/v1/pushes?limit=100&after=${encodeURIComponent(cursor)}`, { headers: authB });
  assert(pageTwo.response.status === 200 && pageTwo.body.items.length === 1 && pageTwo.body.items[0].id === second.body.id, "cursor delta sync failed");

  const fileBytes = new TextEncoder().encode(`pushbridge-local-${suffix}`);
  const fileHash = createHash("sha256").update(fileBytes).digest("hex");
  const initialized = await request("/api/v1/files/init", {
    method: "POST",
    headers: authA,
    body: JSON.stringify({ filename: "local-smoke.bin", content_type: "application/octet-stream", size: fileBytes.byteLength, sha256: fileHash, expires_in: 86_400 }),
  });
  assert(initialized.response.status === 201, `file init failed: ${JSON.stringify(initialized.body)}`);
  const upload = await fetch(initialized.body.upload_url, {
    method: "PUT",
    headers: initialized.body.upload_headers,
    body: fileBytes,
    signal: AbortSignal.timeout(5_000),
  });
  assert(upload.status === 200, `file upload failed: ${upload.status}`);
  const completed = await request(`/api/v1/files/${encodeURIComponent(initialized.body.file.id)}/complete`, { method: "POST", headers: authA });
  assert(completed.response.status === 200 && completed.body.state === "ready" && completed.body.actual_sha256 === fileHash, "file complete failed");
  const fileKey = `file-${suffix}`;
  const filePush = await request("/api/v1/pushes", {
    method: "POST",
    headers: { ...authA, "idempotency-key": fileKey },
    body: JSON.stringify({
      type: "file",
      file_id: completed.body.id,
      target: { kind: "device", device_id: linked.body.device.id },
      client_guid: fileKey,
      payload: { file: { name: "local-smoke.bin", size: fileBytes.byteLength } },
    }),
  });
  assert(filePush.response.status === 201 && filePush.body.file_ref?.state === "ready", "file push failed");
  const pendingDeliveries = await request(`/api/v1/files/${encodeURIComponent(completed.body.id)}/deliveries`, { headers: authA });
  assert(pendingDeliveries.response.status === 200
    && pendingDeliveries.body.length === 1
    && pendingDeliveries.body[0].destination_device_id === linked.body.device.id
    && pendingDeliveries.body[0].state === "pending", "file delivery ledger was not created as pending");
  const fileDelta = await request(`/api/v1/pushes?limit=100&after=${encodeURIComponent(pageTwo.body.next_cursor)}`, { headers: authB });
  assert(fileDelta.response.status === 200 && fileDelta.body.items.some((item) => item.id === filePush.body.id), "device B did not cursor-sync the file push");
  const downloadTicket = await request(`/api/v1/files/${encodeURIComponent(completed.body.id)}/download-ticket`, { method: "POST", headers: authB });
  assert(downloadTicket.response.status === 200, "download ticket failed");
  const downloaded = await fetch(downloadTicket.body.download_url, { signal: AbortSignal.timeout(5_000) });
  assert(downloaded.status === 200 && downloaded.headers.get("content-disposition")?.startsWith("attachment"), "file download headers failed");
  const downloadedBytes = new Uint8Array(await downloaded.arrayBuffer());
  assert(createHash("sha256").update(downloadedBytes).digest("hex") === fileHash, "downloaded file bytes differ");
  assert((await fetch(downloadTicket.body.download_url)).status === 410, "used download ticket did not return 410");
  const deletedFile = await request(`/api/v1/files/${encodeURIComponent(completed.body.id)}`, { method: "DELETE", headers: authA });
  assert(deletedFile.response.status === 200 && deletedFile.body.state === "deleted", "file delete failed");
  const missedDeliveries = await request(`/api/v1/files/${encodeURIComponent(completed.body.id)}/deliveries`, { headers: authA });
  assert(missedDeliveries.response.status === 200 && missedDeliveries.body[0].state === "missed", "unacknowledged delivery was not marked missed");
  assert((await fetch(downloadTicket.body.download_url)).status === 410, "deleted file download did not return 410");

  const root = await request("/");
  assert(root.response.status === 200 && String(root.body).includes('id="root"'), "PWA root asset was not served");
  const spa = await request("/settings/offline-check");
  assert(spa.response.status === 200 && String(spa.body).includes('id="root"'), "SPA fallback failed");
  const sw = await request("/sw.js");
  assert(sw.response.status === 200
    && String(sw.body).includes("CACHE_NAME")
    && String(sw.body).includes("acknowledgeFileDelivery")
    && String(sw.body).includes("failed_retryable"), "Phase 3 Service Worker asset was not served");

  console.log("Cloudflare local smoke passed: D1 migrations, Durable Object one-time WebSocket ticket/tickle, private R2 File API, delivery ledger pending/missed transitions, two devices, Bearer auth, cursor sync, idempotency, PWA assets, SPA fallback, and Service Worker ACK code.");
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  if (realtimeSocket?.readyState < WebSocket.CLOSING) realtimeSocket.close(1000, "smoke complete");
  if (windows && child.pid) {
    spawnSync("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
  } else {
    if (child.pid && child.exitCode == null) {
      try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
    }
    await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(3000)]);
    if (child.pid && child.exitCode == null) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    }
  }
}
