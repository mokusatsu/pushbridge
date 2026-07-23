#!/usr/bin/env node

import { createECDH, createHash, randomBytes } from "node:crypto";
import WebSocket from "ws";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function base64Url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

function fromBase64Url(value) {
  return new Uint8Array(Buffer.from(value, "base64url"));
}

function owned(bytes) {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function concatBytes(...parts) {
  const output = new Uint8Array(parts.reduce((size, part) => size + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

async function deriveAesKey(inputKeyMaterial, salt, info) {
  const material = await crypto.subtle.importKey("raw", owned(inputKeyMaterial), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({
    name: "HKDF",
    hash: "SHA-256",
    salt: owned(salt),
    info: encoder.encode(info),
  }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

async function seal(rawKey, plaintext, keyVersion, info, aad) {
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const key = await deriveAesKey(rawKey, salt, info);
  const ciphertext = await crypto.subtle.encrypt({
    name: "AES-GCM",
    iv: owned(nonce),
    additionalData: encoder.encode(aad),
  }, key, owned(plaintext));
  return {
    v: 1,
    alg: "A256GCM-HKDF-SHA256",
    key_version: keyVersion,
    salt: base64Url(salt),
    nonce: base64Url(nonce),
    ciphertext: base64Url(new Uint8Array(ciphertext)),
  };
}

async function openEnvelope(rawKey, envelope, info, aad) {
  const key = await deriveAesKey(rawKey, fromBase64Url(envelope.salt), info);
  const plaintext = await crypto.subtle.decrypt({
    name: "AES-GCM",
    iv: owned(fromBase64Url(envelope.nonce)),
    additionalData: encoder.encode(aad),
  }, key, owned(fromBase64Url(envelope.ciphertext)));
  return new Uint8Array(plaintext);
}

async function generateDeviceKeyPair() {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const publicBytes = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { privateKey: pair.privateKey, publicKey: `p256.${base64Url(publicBytes)}` };
}

async function importDevicePublicKey(value) {
  const raw = fromBase64Url(value.slice(5));
  return crypto.subtle.importKey("raw", owned(raw), { name: "ECDH", namedCurve: "P-256" }, false, []);
}

async function wrapAccountKeyForDevice(accountKey, keyVersion, recipientDeviceId, recipientPublicKey) {
  const recipient = await importDevicePublicKey(recipientPublicKey);
  const ephemeral = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: recipient }, ephemeral.privateKey, 256));
  const publicBytes = new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey));
  const context = `pushbridge/device-envelope/v1/${recipientDeviceId}/${keyVersion}`;
  return {
    ...await seal(shared, accountKey, keyVersion, context, context),
    recipient_device_id: recipientDeviceId,
    ephemeral_public_key: `p256.${base64Url(publicBytes)}`,
  };
}

async function unwrapAccountKeyForDevice(envelope, privateKey) {
  const ephemeral = await importDevicePublicKey(envelope.ephemeral_public_key);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: ephemeral }, privateKey, 256));
  const context = `pushbridge/device-envelope/v1/${envelope.recipient_device_id}/${envelope.key_version}`;
  return openEnvelope(shared, envelope, context, context);
}

async function wrapAccountKeyForRecovery(accountKey, recoveryKey, keyVersion) {
  const context = `pushbridge/recovery-envelope/v1/${keyVersion}`;
  return { ...await seal(recoveryKey, accountKey, keyVersion, context, context), kind: "recovery" };
}

async function encryptPushPayload(accountKey, keyVersion, type, clientGuid, payload) {
  const context = `pushbridge/push/v2/${type}/${clientGuid}`;
  return seal(accountKey, encoder.encode(JSON.stringify(payload)), keyVersion, `pushbridge/content/v2/${keyVersion}`, context);
}

async function decryptPushPayload(accountKey, item) {
  const context = `pushbridge/push/v2/${item.type}/${item.client_guid}`;
  const envelope = {
    key_version: item.key_version,
    salt: item.encryption_salt,
    nonce: item.nonce,
    ciphertext: item.ciphertext,
  };
  return JSON.parse(decoder.decode(await openEnvelope(accountKey, envelope, `pushbridge/content/v2/${item.key_version}`, context)));
}

async function encryptFile(accountKey, keyVersion, fileId, plaintext) {
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const context = `pushbridge/file/v1/${fileId}`;
  const key = await deriveAesKey(accountKey, salt, `pushbridge/file/v1/${keyVersion}`);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({
    name: "AES-GCM",
    iv: owned(nonce),
    additionalData: encoder.encode(context),
  }, key, owned(plaintext)));
  const version = new Uint8Array(5);
  version[0] = 1;
  new DataView(version.buffer).setUint32(1, keyVersion, false);
  return concatBytes(encoder.encode("PBFE"), version, salt, nonce, ciphertext);
}

async function decryptFile(accountKey, fileId, encrypted) {
  const bytes = new Uint8Array(encrypted);
  assert(decoder.decode(bytes.slice(0, 4)) === "PBFE" && bytes[4] === 1, "downloaded File container is invalid");
  const keyVersion = new DataView(bytes.buffer, bytes.byteOffset + 5, 4).getUint32(0, false);
  const salt = bytes.slice(9, 25);
  const nonce = bytes.slice(25, 37);
  const ciphertext = bytes.slice(37);
  const context = `pushbridge/file/v1/${fileId}`;
  const key = await deriveAesKey(accountKey, salt, `pushbridge/file/v1/${keyVersion}`);
  return new Uint8Array(await crypto.subtle.decrypt({
    name: "AES-GCM",
    iv: owned(nonce),
    additionalData: encoder.encode(context),
  }, key, owned(ciphertext)));
}

const origin = (process.env.PUSHBRIDGE_REMOTE_ORIGIN ?? "https://pushbridge-dev.mokusatsu.workers.dev").replace(/\/$/, "");
const accessClientId = process.env.CF_ACCESS_CLIENT_ID;
const accessClientSecret = process.env.CF_ACCESS_CLIENT_SECRET;
const expectWebPush = process.env.PUSHBRIDGE_EXPECT_WEB_PUSH === "true";
const expectRealtime = process.env.PUSHBRIDGE_EXPECT_REALTIME === "true";

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

let cachedWebSocketAccessCookie;

async function websocketAccessCookie() {
  if (!accessClientId || !accessClientSecret) return undefined;
  if (cachedWebSocketAccessCookie) return cachedWebSocketAccessCookie;
  const response = await fetch(origin, withAccess({ redirect: "manual" }));
  const cookie = response.headers.getSetCookie()
    .map((value) => /^CF_Authorization=([^;]+)/u.exec(value))
    .find(Boolean);
  await response.body?.cancel();
  assert(cookie, "Cloudflare Access service token did not issue a CF_Authorization cookie for realtime WebSocket validation.");
  cachedWebSocketAccessCookie = `CF_Authorization=${cookie[1]}`;
  return cachedWebSocketAccessCookie;
}

function waitForSocketMessage(socket, predicate, timeoutMs = 10_000) {
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
  const accessCookie = await websocketAccessCookie();
  const socket = new WebSocket(
    `${origin.replace(/^http/, "ws")}/realtime`,
    ["pushbridge.v1", `pushbridge-ticket.${ticket}`],
    accessCookie ? { headers: { Cookie: accessCookie } } : undefined,
  );
  const connected = waitForSocketMessage(socket, (message) => message.type === "connected");
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error(
      "Realtime WebSocket connection failed after applying the available Cloudflare Access authorization.",
    )), { once: true });
  });
  await connected;
  return socket;
}

const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
let authA;
let authB;
let deviceBId;
let fileId;
let subscriptionId;
let accountKey;
let deviceAKey;
let deviceBKey;
let e2eeEnabled = false;
let realtimeSocket;
const createdPushIds = [];

async function pushInput(type, clientGuid, target, payload, referencedFileId) {
  const input = {
    type,
    target,
    client_guid: clientGuid,
    ...(referencedFileId ? { file_id: referencedFileId } : {}),
  };
  if (!e2eeEnabled) return { ...input, payload_version: 1, payload };
  const envelope = await encryptPushPayload(accountKey, 1, type, clientGuid, payload);
  return {
    ...input,
    payload_version: 2,
    key_version: envelope.key_version,
    encryption_salt: envelope.salt,
    nonce: envelope.nonce,
    ciphertext: envelope.ciphertext,
  };
}

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
  if (expectRealtime) {
    assert(capabilities.body.features?.realtime === true, "realtime capability is disabled");
    assert(capabilities.body.transports?.realtime?.includes("websocket"), "WebSocket realtime transport is unavailable");
  }
  e2eeEnabled = capabilities.body.features?.e2ee === true;
  if (e2eeEnabled) {
    deviceAKey = await generateDeviceKeyPair();
    deviceBKey = await generateDeviceKeyPair();
    accountKey = randomBytes(32);
  }
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
    body: JSON.stringify({
      handle: `smoke_${suffix}`,
      device_name: "Remote Smoke A",
      device_kind: "pwa",
      ...(e2eeEnabled ? { public_key: deviceAKey.publicKey } : {}),
    }),
  });
  expectStatus(bootstrap, 201, "device A bootstrap");
  assert(typeof bootstrap.body.access_token === "string", "device A token is missing");
  authA = { authorization: `Bearer ${bootstrap.body.access_token}`, "content-type": "application/json" };

  const linked = await request("/api/v1/devices/link", {
    method: "POST",
    headers: authA,
    body: JSON.stringify({ name: "Remote Smoke B", kind: "pwa", ...(e2eeEnabled ? { public_key: deviceBKey.publicKey } : {}) }),
  });
  expectStatus(linked, 201, "device B link");
  assert(typeof linked.body.access_token === "string", "device B token is missing");
  deviceBId = linked.body.device?.id;
  authB = { authorization: `Bearer ${linked.body.access_token}`, "content-type": "application/json" };
  if (expectRealtime) {
    const realtimeTicket = await request("/api/v1/realtime-ticket", { method: "POST", headers: authB });
    expectStatus(realtimeTicket, 201, "realtime ticket");
    realtimeSocket = await openRealtimeSocket(realtimeTicket.body.ticket);
  }

  if (e2eeEnabled) {
    const deviceAId = bootstrap.body.device?.id;
    assert(typeof deviceAId === "string", "device A ID is missing");
    const recoveryKey = randomBytes(32);
    const initializedKey = await request("/api/v1/e2ee/account-key", {
      method: "POST",
      headers: authA,
      body: JSON.stringify({
        key_version: 1,
        recovery_envelope: await wrapAccountKeyForRecovery(accountKey, recoveryKey, 1),
        device_envelope: await wrapAccountKeyForDevice(accountKey, 1, deviceAId, deviceAKey.publicKey),
      }),
    });
    expectStatus(initializedKey, 201, "E2EE account key initialization");
    const provisioned = await request(`/api/v1/e2ee/device-envelopes/${encodeURIComponent(deviceBId)}`, {
      method: "PUT",
      headers: authA,
      body: JSON.stringify({
        key_version: 1,
        envelope: await wrapAccountKeyForDevice(accountKey, 1, deviceBId, deviceBKey.publicKey),
      }),
    });
    expectStatus(provisioned, 201, "device B key envelope provisioning");
    const peerEnvelope = await request("/api/v1/e2ee/device-envelope", { headers: authB });
    expectStatus(peerEnvelope, 200, "device B key envelope");
    const peerAccountKey = await unwrapAccountKeyForDevice(peerEnvelope.body.envelope, deviceBKey.privateKey);
    assert(Buffer.from(peerAccountKey).equals(Buffer.from(accountKey)), "device B could not unwrap the account key");
    const keyStatus = await request("/api/v1/e2ee/status", { headers: authA });
    expectStatus(keyStatus, 200, "E2EE status");
    assert(keyStatus.body.initialized === true && keyStatus.body.current_key_version === 1, "E2EE account status is incomplete");

    const rejectedPlaintext = await request("/api/v1/pushes", {
      method: "POST",
      headers: authA,
      body: JSON.stringify({ type: "note", target: { kind: "all_other_devices" }, payload_version: 1, payload: {} }),
    });
    expectStatus(rejectedPlaintext, 422, "plaintext Push rejection");
    assert(rejectedPlaintext.body.detail?.code === "e2ee_required", "plaintext Push used the wrong E2EE rejection code");
  }

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
  const firstPayload = { title: "Remote smoke note", body: "from device A" };
  const firstBody = await pushInput("note", firstKey, { kind: "all_other_devices" }, firstPayload);
  const realtimeTickle = realtimeSocket
    ? waitForSocketMessage(realtimeSocket, (message) => message.type === "sync_required" && message.reason === "push.created")
    : undefined;
  const first = await request("/api/v1/pushes", {
    method: "POST",
    headers: { ...authA, "idempotency-key": firstKey },
    body: JSON.stringify(firstBody),
  });
  expectStatus(first, 201, "first Note");
  createdPushIds.push(first.body.id);
  if (realtimeTickle) {
    const tickle = await realtimeTickle;
    assert(typeof tickle.cursor_hint === "string" && tickle.cursor_hint.includes("."), "realtime tickle did not contain a signed cursor hint");
  }

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
    body: JSON.stringify(await pushInput("note", firstKey, { kind: "all_other_devices" }, { title: "Changed", body: "must conflict" })),
  });
  expectStatus(conflict, 409, "idempotency conflict");
  assert(conflict.body.detail?.code === "idempotency_conflict", "idempotency conflict used the wrong error code");

  const pageOne = await request("/api/v1/pushes?limit=100&include_deleted=true", { headers: authB });
  expectStatus(pageOne, 200, "device B initial sync");
  assert(pageOne.body.items.length === 1 && pageOne.body.items[0].is_for_current_device === true, "device B did not receive the first Note");
  if (e2eeEnabled) {
    assert(pageOne.body.items[0].payload === null, "encrypted Note exposed a plaintext payload");
    assert(JSON.stringify(await decryptPushPayload(accountKey, pageOne.body.items[0])) === JSON.stringify(firstPayload), "device B could not decrypt the first Note");
  }
  assert(typeof pageOne.body.next_cursor === "string", "initial sync cursor is missing");

  const secondKey = `note-${suffix}-2`;
  const secondPayload = { title: "Remote smoke delta", body: "cursor sync" };
  const second = await request("/api/v1/pushes", {
    method: "POST",
    headers: { ...authA, "idempotency-key": secondKey },
    body: JSON.stringify(await pushInput("note", secondKey, { kind: "all_other_devices" }, secondPayload)),
  });
  expectStatus(second, 201, "second Note");
  createdPushIds.push(second.body.id);

  const pageTwo = await request(`/api/v1/pushes?limit=100&after=${encodeURIComponent(pageOne.body.next_cursor)}`, { headers: authB });
  expectStatus(pageTwo, 200, "device B cursor sync");
  assert(pageTwo.body.items.length === 1 && pageTwo.body.items[0].id === second.body.id, "cursor delta did not contain exactly the second Note");
  if (e2eeEnabled) {
    assert(JSON.stringify(await decryptPushPayload(accountKey, pageTwo.body.items[0])) === JSON.stringify(secondPayload), "device B could not decrypt the cursor delta Note");
  }

  const fileBytes = encoder.encode(`pushbridge-remote-${suffix}`);
  const initialized = await request("/api/v1/files/init", {
    method: "POST",
    headers: authA,
    body: JSON.stringify({
      filename: e2eeEnabled ? "encrypted.bin" : "remote-smoke.bin",
      content_type: "application/octet-stream",
      size: fileBytes.byteLength + (e2eeEnabled ? 53 : 0),
      ...(!e2eeEnabled ? { sha256: createHash("sha256").update(fileBytes).digest("hex") } : {}),
      expires_in: 86_400,
      encrypted: e2eeEnabled,
    }),
  });
  expectStatus(initialized, 201, "File init");
  fileId = initialized.body.file?.id;
  assert(typeof fileId === "string", "File init did not return an ID");
  assert(new URL(initialized.body.upload_url).origin === origin, "upload ticket escaped the Worker origin");
  const uploadedBytes = e2eeEnabled ? await encryptFile(accountKey, 1, fileId, fileBytes) : fileBytes;
  const uploadedHash = createHash("sha256").update(uploadedBytes).digest("hex");

  const upload = await fetch(initialized.body.upload_url, withAccess({
    method: "PUT",
    headers: initialized.body.upload_headers,
    body: uploadedBytes,
  }));
  assert(upload.status === 200, `File upload returned HTTP ${upload.status}`);
  const completed = await request(`/api/v1/files/${encodeURIComponent(fileId)}/complete`, { method: "POST", headers: authA });
  expectStatus(completed, 200, "File complete");
  assert(completed.body.state === "ready" && completed.body.actual_sha256 === uploadedHash, "File complete did not verify the uploaded bytes");
  if (e2eeEnabled) {
    assert(completed.body.original_name === "encrypted.bin" && completed.body.e2ee === true, "encrypted File metadata was not opaque");
  }

  const fileKey = `file-${suffix}`;
  const filePayload = { file: {
    name: "remote-smoke.bin",
    mime_type: "application/octet-stream",
    size: fileBytes.byteLength,
    client_file_id: fileId,
  } };
  const filePush = await request("/api/v1/pushes", {
    method: "POST",
    headers: { ...authA, "idempotency-key": fileKey },
    body: JSON.stringify(await pushInput("file", fileKey, { kind: "device", device_id: deviceBId }, filePayload, fileId)),
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
  if (e2eeEnabled) {
    assert(fileDelta.body.items[0].payload === null, "encrypted File Push exposed plaintext metadata");
    assert(JSON.stringify(await decryptPushPayload(accountKey, fileDelta.body.items[0])) === JSON.stringify(filePayload), "device B could not decrypt File metadata");
  }
  const downloadTicket = await request(`/api/v1/files/${encodeURIComponent(fileId)}/download-ticket`, { method: "POST", headers: authB });
  expectStatus(downloadTicket, 200, "File download ticket");
  assert(new URL(downloadTicket.body.download_url).origin === origin, "download ticket escaped the Worker origin");
  const downloaded = await fetch(downloadTicket.body.download_url, withAccess());
  assert(downloaded.status === 200, `File download returned HTTP ${downloaded.status}`);
  assert(downloaded.headers.get("content-disposition")?.startsWith("attachment"), "File download was not forced as an attachment");
  const downloadedBytes = new Uint8Array(await downloaded.arrayBuffer());
  assert(createHash("sha256").update(downloadedBytes).digest("hex") === uploadedHash, "downloaded File bytes differ");
  if (e2eeEnabled) {
    const decryptedBytes = await decryptFile(accountKey, fileId, downloadedBytes);
    assert(Buffer.from(decryptedBytes).equals(Buffer.from(fileBytes)), "device B could not decrypt the downloaded File");
  }
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

  console.log(`Cloudflare remote smoke passed for ${origin}: health, D1 API, two devices, Bearer auth, Note/File delivery, private R2 byte verification, one-use tickets, delivery pending/missed states, deletion, idempotency, cursor sync, PWA, SPA fallback, Service Worker ACK code${e2eeEnabled ? ", P-256 device envelopes, encrypted Note/File metadata, and File decryption" : ""}${expectWebPush ? ", Web Push subscription CRUD" : ""}${expectRealtime ? ", and one-time Durable Object WebSocket tickle" : ""}.`);
} finally {
  if (realtimeSocket?.readyState < WebSocket.CLOSING) realtimeSocket.close(1000, "smoke complete");
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
