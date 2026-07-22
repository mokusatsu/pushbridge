#!/usr/bin/env node

import { createECDH, createHash, randomBytes } from "node:crypto";

const origin = (process.env.PUSHBRIDGE_REMOTE_ORIGIN ?? "https://pushbridge-dev.mokusatsu.workers.dev").replace(/\/$/, "");
const accessClientId = process.env.CF_ACCESS_CLIENT_ID;
const accessClientSecret = process.env.CF_ACCESS_CLIENT_SECRET;
const expectWebPush = process.env.PUSHBRIDGE_EXPECT_WEB_PUSH === "true";

if (Boolean(accessClientId) !== Boolean(accessClientSecret)) {
  throw new Error("Set both CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET, or neither.");
}

function withAccess(init = {}) {
  const headers = new Headers(init.headers);
  if (accessClientId && accessClientSecret) {
    headers.set("CF-Access-Client-Id", accessClientId);
    headers.set("CF-Access-Client-Secret", accessClientSecret);
  }
  return { ...init, headers, signal: init.signal ?? AbortSignal.timeout(10_000) };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(path, init = {}) {
  const response = await fetch(`${origin}${path}`, withAccess(init));
  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("json") ? await response.json() : await response.text();
  return { response, body };
}

function expectStatus(result, status, label) {
  assert(result.response.status === status, `${label} returned HTTP ${result.response.status}`);
}

const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
let authA;
let authB;
let deviceBId;
let fileId;
let subscriptionId;
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
  assert(capabilities.body.features?.direct_upload === false, "server-ticket must not be advertised as direct upload");
  assert(capabilities.body.transports?.upload?.includes("server-ticket"), "server-ticket upload transport is unavailable");
  const webPushConfig = await request("/api/v1/web-push-config");
  expectStatus(webPushConfig, 200, "Web Push config");
  if (expectWebPush) {
    assert(capabilities.body.features?.web_push_subscription_registration === true, "Web Push registration capability is disabled");
    assert(capabilities.body.features?.web_push_delivery === true, "Web Push delivery capability is disabled");
    assert(webPushConfig.body.subscription_registration === true && webPushConfig.body.delivery === true, "Web Push config is not enabled");
    assert(typeof webPushConfig.body.vapid_public_key === "string" && webPushConfig.body.vapid_public_key.length === 87, "VAPID public key is unavailable");
  }

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
  authB = { authorization: `Bearer ${linked.body.access_token}`, "content-type": "application/json" };

  if (expectWebPush) {
    const receiver = createECDH("prime256v1");
    receiver.generateKeys();
    const subscription = await request("/api/v1/web-push-subscriptions", {
      method: "POST",
      headers: authB,
      body: JSON.stringify({
        endpoint: `https://push.example.invalid/${suffix}`,
        p256dh: receiver.getPublicKey().toString("base64url"),
        auth: randomBytes(16).toString("base64url"),
        storage_namespace: `remote-smoke-${suffix}`,
        local_cache_max_bytes: 1_048_576,
      }),
    });
    expectStatus(subscription, 201, "Web Push subscription create");
    subscriptionId = subscription.body.id;
    const subscriptions = await request("/api/v1/web-push-subscriptions", { headers: authB });
    expectStatus(subscriptions, 200, "Web Push subscription list");
    assert(subscriptions.body.length === 1 && subscriptions.body[0].id === subscriptionId, "Web Push subscription was not listed for device B");
    expectStatus(await request(`/api/v1/web-push-subscriptions/${encodeURIComponent(subscriptionId)}`, { method: "DELETE", headers: authB }), 204, "Web Push subscription revoke");
    subscriptionId = undefined;
  }

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

  const fileBytes = new TextEncoder().encode(`pushbridge-remote-${suffix}`);
  const fileHash = createHash("sha256").update(fileBytes).digest("hex");
  const initialized = await request("/api/v1/files/init", {
    method: "POST",
    headers: authA,
    body: JSON.stringify({
      filename: "remote-smoke.bin",
      content_type: "application/octet-stream",
      size: fileBytes.byteLength,
      sha256: fileHash,
      expires_in: 86_400,
    }),
  });
  expectStatus(initialized, 201, "File init");
  fileId = initialized.body.file?.id;
  assert(typeof fileId === "string", "File init did not return an ID");
  assert(new URL(initialized.body.upload_url).origin === origin, "upload ticket escaped the Worker origin");

  const upload = await fetch(initialized.body.upload_url, withAccess({
    method: "PUT",
    headers: initialized.body.upload_headers,
    body: fileBytes,
  }));
  assert(upload.status === 200, `File upload returned HTTP ${upload.status}`);
  const completed = await request(`/api/v1/files/${encodeURIComponent(fileId)}/complete`, { method: "POST", headers: authA });
  expectStatus(completed, 200, "File complete");
  assert(completed.body.state === "ready" && completed.body.actual_sha256 === fileHash, "File complete did not verify the uploaded bytes");

  const fileKey = `file-${suffix}`;
  const filePush = await request("/api/v1/pushes", {
    method: "POST",
    headers: { ...authA, "idempotency-key": fileKey },
    body: JSON.stringify({
      type: "file",
      file_id: fileId,
      target: { kind: "device", device_id: deviceBId },
      client_guid: fileKey,
      payload: { file: { name: "remote-smoke.bin", size: fileBytes.byteLength } },
    }),
  });
  expectStatus(filePush, 201, "File Push");
  createdPushIds.push(filePush.body.id);
  assert(filePush.body.file_ref?.state === "ready", "File Push did not contain a ready file_ref");
  const pendingDeliveries = await request(`/api/v1/files/${encodeURIComponent(fileId)}/deliveries`, { headers: authA });
  expectStatus(pendingDeliveries, 200, "File delivery ledger");
  assert(pendingDeliveries.body.length === 1
    && pendingDeliveries.body[0].destination_device_id === deviceBId
    && pendingDeliveries.body[0].state === "pending", "File delivery was not recorded as pending");

  const fileDelta = await request(`/api/v1/pushes?limit=100&after=${encodeURIComponent(pageTwo.body.next_cursor)}`, { headers: authB });
  expectStatus(fileDelta, 200, "device B File cursor sync");
  assert(fileDelta.body.items.length === 1 && fileDelta.body.items[0].id === filePush.body.id, "device B did not receive exactly the File Push");
  const downloadTicket = await request(`/api/v1/files/${encodeURIComponent(fileId)}/download-ticket`, { method: "POST", headers: authB });
  expectStatus(downloadTicket, 200, "File download ticket");
  assert(new URL(downloadTicket.body.download_url).origin === origin, "download ticket escaped the Worker origin");
  const downloaded = await fetch(downloadTicket.body.download_url, withAccess());
  assert(downloaded.status === 200, `File download returned HTTP ${downloaded.status}`);
  assert(downloaded.headers.get("content-disposition")?.startsWith("attachment"), "File download was not forced as an attachment");
  const downloadedBytes = new Uint8Array(await downloaded.arrayBuffer());
  assert(createHash("sha256").update(downloadedBytes).digest("hex") === fileHash, "downloaded File bytes differ");
  const reusedDownload = await fetch(downloadTicket.body.download_url, withAccess());
  assert(reusedDownload.status === 410, `used File ticket returned HTTP ${reusedDownload.status}`);

  const deletedFile = await request(`/api/v1/files/${encodeURIComponent(fileId)}`, { method: "DELETE", headers: authA });
  expectStatus(deletedFile, 200, "File delete");
  assert(deletedFile.body.state === "deleted", "File delete did not reach the deleted state");
  const missedDeliveries = await request(`/api/v1/files/${encodeURIComponent(fileId)}/deliveries`, { headers: authA });
  expectStatus(missedDeliveries, 200, "missed File delivery ledger");
  assert(missedDeliveries.body.length === 1 && missedDeliveries.body[0].state === "missed", "unacknowledged File delivery was not marked missed");
  const staleDownload = await fetch(downloadTicket.body.download_url, withAccess());
  assert(staleDownload.status === 410, `deleted File ticket returned HTTP ${staleDownload.status}`);
  const deletedDelta = await request(`/api/v1/pushes?limit=100&after=${encodeURIComponent(fileDelta.body.next_cursor)}`, { headers: authB });
  expectStatus(deletedDelta, 200, "device B deleted File cursor sync");
  assert(deletedDelta.body.items.length === 1 && deletedDelta.body.items[0].file_ref?.state === "deleted", "deleted file_ref was not cursor-synchronized");

  const root = await request("/");
  expectStatus(root, 200, "PWA root");
  assert(String(root.body).includes('id="root"'), "PWA root element is missing");
  const spa = await request("/settings/offline-check");
  expectStatus(spa, 200, "SPA fallback");
  assert(String(spa.body).includes('id="root"'), "SPA fallback did not return the PWA");
  const sw = await request("/sw.js");
  expectStatus(sw, 200, "Service Worker");
  assert(String(sw.body).includes("CACHE_NAME")
    && String(sw.body).includes("acknowledgeFileDelivery")
    && String(sw.body).includes("failed_retryable"), "Phase 3 Service Worker asset is invalid");

  console.log(`Cloudflare remote smoke passed for ${origin}: health, D1 API, two devices, Bearer auth, Note/File delivery, private R2 byte verification, one-use tickets, delivery pending/missed states, deletion, idempotency, cursor sync, PWA, SPA fallback, Service Worker ACK code${expectWebPush ? ", and Web Push subscription CRUD" : ""}.`);
} finally {
  if (authA) {
    if (subscriptionId && authB) {
      await request(`/api/v1/web-push-subscriptions/${encodeURIComponent(subscriptionId)}`, { method: "DELETE", headers: authB }).catch(() => undefined);
    }
    if (fileId) {
      await request(`/api/v1/files/${encodeURIComponent(fileId)}`, { method: "DELETE", headers: authA }).catch(() => undefined);
    }
    for (const pushId of createdPushIds) {
      await request(`/api/v1/pushes/${encodeURIComponent(pushId)}`, { method: "DELETE", headers: authA }).catch(() => undefined);
    }
    if (deviceBId) {
      await request(`/api/v1/devices/${encodeURIComponent(deviceBId)}`, { method: "DELETE", headers: authA }).catch(() => undefined);
    }
  }
}
