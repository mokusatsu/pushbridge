#!/usr/bin/env node

const origin = (process.env.PUSHBRIDGE_REMOTE_ORIGIN ?? "https://pushbridge-dev.mokusatsu.workers.dev").replace(/\/$/, "");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(path, init = {}) {
  const response = await fetch(`${origin}${path}`, { ...init, signal: init.signal ?? AbortSignal.timeout(10_000) });
  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("json") ? await response.json() : await response.text();
  return { response, body };
}

function expectStatus(result, status, label) {
  assert(result.response.status === status, `${label} returned HTTP ${result.response.status}`);
}

const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
let authA;
let deviceBId;
const createdPushIds = [];

try {
  const health = await request("/healthz");
  expectStatus(health, 200, "healthz");
  assert(health.body.ok === true, "healthz did not return the Worker JSON response");

  const status = await request("/api/bootstrap/status");
  expectStatus(status, 200, "bootstrap status");
  assert(status.body.bootstrap === false && status.body.bindings?.d1 === true, "bootstrap bindings are incomplete");

  const capabilities = await request("/api/v1/system/capabilities");
  expectStatus(capabilities, 200, "capabilities");
  assert(capabilities.body.features?.device_registration === true, "device registration is unavailable");

  const bootstrap = await request("/api/v1/auth/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle: `smoke_${suffix}`, device_name: "Remote Smoke A", device_kind: "pwa" }),
  });
  expectStatus(bootstrap, 201, "device A bootstrap");
  assert(typeof bootstrap.body.access_token === "string", "device A token is missing");
  authA = { authorization: `Bearer ${bootstrap.body.access_token}`, "content-type": "application/json" };

  const linked = await request("/api/v1/devices/link", {
    method: "POST",
    headers: authA,
    body: JSON.stringify({ name: "Remote Smoke B", kind: "pwa" }),
  });
  expectStatus(linked, 201, "device B link");
  assert(typeof linked.body.access_token === "string", "device B token is missing");
  deviceBId = linked.body.device?.id;
  const authB = { authorization: `Bearer ${linked.body.access_token}`, "content-type": "application/json" };

  expectStatus(await request("/api/v1/devices"), 401, "unauthenticated device list");
  const devices = await request("/api/v1/devices", { headers: authB });
  expectStatus(devices, 200, "authenticated device list");
  assert(devices.body.length === 2, "device B cannot see both linked devices");

  const firstKey = `note-${suffix}-1`;
  const firstBody = {
    type: "note",
    target: { kind: "all_other_devices" },
    payload_version: 1,
    client_guid: firstKey,
    payload: { title: "Remote smoke note", body: "from device A" },
  };
  const first = await request("/api/v1/pushes", {
    method: "POST",
    headers: { ...authA, "idempotency-key": firstKey },
    body: JSON.stringify(firstBody),
  });
  expectStatus(first, 201, "first Note");
  createdPushIds.push(first.body.id);

  const replay = await request("/api/v1/pushes", {
    method: "POST",
    headers: { ...authA, "idempotency-key": firstKey },
    body: JSON.stringify(firstBody),
  });
  expectStatus(replay, 200, "idempotent Note replay");
  assert(replay.body.id === first.body.id && replay.response.headers.get("idempotent-replayed") === "true", "idempotent replay created a duplicate");

  const conflict = await request("/api/v1/pushes", {
    method: "POST",
    headers: { ...authA, "idempotency-key": firstKey },
    body: JSON.stringify({ ...firstBody, payload: { title: "Changed", body: "must conflict" } }),
  });
  expectStatus(conflict, 409, "idempotency conflict");
  assert(conflict.body.detail?.code === "idempotency_conflict", "idempotency conflict used the wrong error code");

  const pageOne = await request("/api/v1/pushes?limit=100&include_deleted=true", { headers: authB });
  expectStatus(pageOne, 200, "device B initial sync");
  assert(pageOne.body.items.length === 1 && pageOne.body.items[0].is_for_current_device === true, "device B did not receive the first Note");
  assert(typeof pageOne.body.next_cursor === "string", "initial sync cursor is missing");

  const secondKey = `note-${suffix}-2`;
  const second = await request("/api/v1/pushes", {
    method: "POST",
    headers: { ...authA, "idempotency-key": secondKey },
    body: JSON.stringify({ ...firstBody, client_guid: secondKey, payload: { title: "Remote smoke delta", body: "cursor sync" } }),
  });
  expectStatus(second, 201, "second Note");
  createdPushIds.push(second.body.id);

  const pageTwo = await request(`/api/v1/pushes?limit=100&after=${encodeURIComponent(pageOne.body.next_cursor)}`, { headers: authB });
  expectStatus(pageTwo, 200, "device B cursor sync");
  assert(pageTwo.body.items.length === 1 && pageTwo.body.items[0].id === second.body.id, "cursor delta did not contain exactly the second Note");

  const root = await request("/");
  expectStatus(root, 200, "PWA root");
  assert(String(root.body).includes('id="root"'), "PWA root element is missing");
  const spa = await request("/settings/offline-check");
  expectStatus(spa, 200, "SPA fallback");
  assert(String(spa.body).includes('id="root"'), "SPA fallback did not return the PWA");
  const sw = await request("/sw.js");
  expectStatus(sw, 200, "Service Worker");
  assert(String(sw.body).includes("CACHE_NAME"), "Service Worker asset is invalid");

  console.log(`Cloudflare remote smoke passed for ${origin}: health, D1 API, two devices, Bearer auth, Note delivery, idempotency, cursor sync, PWA, SPA fallback, and Service Worker.`);
} finally {
  if (authA) {
    for (const pushId of createdPushIds) {
      await request(`/api/v1/pushes/${encodeURIComponent(pushId)}`, { method: "DELETE", headers: authA }).catch(() => undefined);
    }
    if (deviceBId) {
      await request(`/api/v1/devices/${encodeURIComponent(deviceBId)}`, { method: "DELETE", headers: authA }).catch(() => undefined);
    }
  }
}
