#!/usr/bin/env node

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '@playwright/test';

const windows = process.platform === 'win32';
const npm = windows ? process.execPath : 'npm';
const npmPrefix = windows ? [join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')] : [];
const npx = windows ? process.execPath : 'npx';
const npxPrefix = windows ? [join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js')] : [];
const remoteOrigin = process.env.PUSHBRIDGE_EXTENSION_E2E_ORIGIN?.replace(/\/+$/u, '');
const remoteMode = Boolean(remoteOrigin);
const origin = remoteOrigin ?? 'http://127.0.0.1:8791';
const config = 'infra/cloudflare/wrangler.local.jsonc';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const accessHeaders = remoteMode ? {
  'CF-Access-Client-Id': process.env.CF_ACCESS_CLIENT_ID,
  'CF-Access-Client-Secret': process.env.CF_ACCESS_CLIENT_SECRET,
} : {};
if (remoteMode && (!accessHeaders['CF-Access-Client-Id'] || !accessHeaders['CF-Access-Client-Secret'])) {
  throw new Error('Remote extension E2E requires Cloudflare Access service-token environment variables.');
}

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { stdio: 'inherit', env, shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${args.join(' ')} failed with ${result.status}`);
}

function base64Url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

function fromBase64Url(value) {
  return new Uint8Array(Buffer.from(value, 'base64url'));
}

function owned(bytes) {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function deriveAesKey(input, salt, info) {
  const material = await crypto.subtle.importKey('raw', owned(input), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({
    name: 'HKDF', hash: 'SHA-256', salt: owned(salt), info: encoder.encode(info),
  }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function seal(rawKey, plaintext, keyVersion, info, aad) {
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const key = await deriveAesKey(rawKey, salt, info);
  const ciphertext = await crypto.subtle.encrypt({
    name: 'AES-GCM', iv: owned(nonce), additionalData: encoder.encode(aad),
  }, key, owned(plaintext));
  return {
    v: 1,
    alg: 'A256GCM-HKDF-SHA256',
    key_version: keyVersion,
    salt: base64Url(salt),
    nonce: base64Url(nonce),
    ciphertext: base64Url(new Uint8Array(ciphertext)),
  };
}

async function generateDeviceKeyPair() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const publicBytes = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { privateKey: pair.privateKey, publicKey: `p256.${base64Url(publicBytes)}` };
}

async function importDevicePublicKey(value) {
  return crypto.subtle.importKey('raw', owned(fromBase64Url(value.slice(5))), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
}

async function wrapAccountKeyForDevice(accountKey, keyVersion, deviceId, publicKey) {
  const recipient = await importDevicePublicKey(publicKey);
  const ephemeral = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: recipient }, ephemeral.privateKey, 256));
  const ephemeralPublic = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey));
  const context = `pushbridge/device-envelope/v1/${deviceId}/${keyVersion}`;
  return {
    ...await seal(shared, accountKey, keyVersion, context, context),
    recipient_device_id: deviceId,
    ephemeral_public_key: `p256.${base64Url(ephemeralPublic)}`,
  };
}

async function decryptPush(accountKey, item) {
  const context = `pushbridge/push/v2/${item.type}/${item.client_guid}`;
  const key = await deriveAesKey(accountKey, fromBase64Url(item.encryption_salt), `pushbridge/content/v2/${item.key_version}`);
  const plaintext = await crypto.subtle.decrypt({
    name: 'AES-GCM',
    iv: owned(fromBase64Url(item.nonce)),
    additionalData: encoder.encode(context),
  }, key, owned(fromBase64Url(item.ciphertext)));
  return JSON.parse(decoder.decode(plaintext));
}

async function decryptFileContainer(accountKey, fileId, encrypted) {
  const bytes = encrypted instanceof Uint8Array ? encrypted : new Uint8Array(encrypted);
  assert.equal(decoder.decode(bytes.slice(0, 4)), 'PBFE');
  assert.equal(bytes[4], 1);
  const keyVersion = new DataView(bytes.buffer, bytes.byteOffset + 5, 4).getUint32(0, false);
  const key = await deriveAesKey(accountKey, bytes.slice(9, 25), `pushbridge/file/v1/${keyVersion}`);
  return new Uint8Array(await crypto.subtle.decrypt({
    name: 'AES-GCM',
    iv: owned(bytes.slice(25, 37)),
    additionalData: encoder.encode(`pushbridge/file/v1/${fileId}`),
  }, key, owned(bytes.slice(37))));
}

async function request(path, init = {}, token) {
  const headers = new Headers(init.headers);
  for (const [name, value] of Object.entries(accessHeaders)) if (value) headers.set(name, value);
  headers.set('Accept', 'application/json');
  if (init.body) headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(`${origin}/api/v1${path}`, { ...init, headers });
  const body = response.status === 204 ? undefined : await response.json();
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return body;
}

async function waitForPush(token, predicate) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = await request('/pushes?limit=100&include_deleted=true', {}, token);
    const item = result.items.find(predicate);
    if (item) return item;
    await delay(250);
  }
  throw new Error('Timed out waiting for extension push');
}

async function extensionRequest(page, message) {
  const response = await page.evaluate((value) => chrome.runtime.sendMessage(value), message);
  if (!response?.ok) throw new Error(response?.error || 'Extension request failed');
  return response.value;
}

async function waitForExtension(page, predicate) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const value = await extensionRequest(page, { type: 'STATUS' });
    if (predicate(value)) return value;
    await delay(250);
  }
  throw new Error('Timed out waiting for extension runtime state');
}

async function waitForWorker(child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode != null) throw new Error(`wrangler dev exited early with ${child.exitCode}`);
    try {
      if ((await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(1000) })).ok) return;
    } catch { /* still starting */ }
    await delay(250);
  }
  throw new Error('wrangler dev did not become ready');
}

await mkdir(resolve('.runtime'), { recursive: true });
const persistence = remoteMode ? undefined : await mkdtemp(resolve('.runtime', 'wrangler-extension-e2e-'));
const profile = await mkdtemp(join(tmpdir(), 'pushbridge-extension-linked-'));
const extensionPath = resolve('apps/chromium-extension/dist');
const extensionEnv = { ...process.env, PUSHBRIDGE_EXTENSION_API_ORIGIN: origin };

run(npm, [...npmPrefix, 'run', 'extension:build'], extensionEnv);
let child;
if (!remoteMode) {
  run(npm, [...npmPrefix, 'run', 'worker:build']);
  run(npx, [...npxPrefix, '--yes', 'wrangler@4', 'd1', 'migrations', 'apply', 'DB', '--local', '--config', config, '--persist-to', persistence]);
  child = spawn(npx, [...npxPrefix, '--yes', 'wrangler@4', 'dev', '--local', '--config', config, '--persist-to', persistence,
    '--ip', '127.0.0.1', '--port', '8791', '--var', 'REQUIRE_E2EE:true'], {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    detached: !windows,
    windowsHide: true,
  });
}
let logs = '';
for (const stream of child ? [child.stdout, child.stderr] : []) {
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => { logs = `${logs}${chunk}`.slice(-12000); });
}

let context;
let auth;
let extensionDeviceId;
let uploadedFileId;
const pushIds = [];
try {
  if (child) await waitForWorker(child);
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const issuerKey = await generateDeviceKeyPair();
  auth = await request('/auth/bootstrap', {
    method: 'POST',
    body: JSON.stringify({
      handle: `extension_e2e_${suffix}`,
      device_name: 'Extension Issuer',
      device_kind: 'pwa',
      public_key: issuerKey.publicKey,
    }),
  });
  const accountKey = randomBytes(32);
  const recoveryKey = randomBytes(32);
  const issuerEnvelope = await wrapAccountKeyForDevice(accountKey, 1, auth.device.id, issuerKey.publicKey);
  const recoveryContext = 'pushbridge/recovery-envelope/v1/1';
  const recoveryEnvelope = { ...await seal(recoveryKey, accountKey, 1, recoveryContext, recoveryContext), kind: 'recovery' };
  await request('/e2ee/account-key', {
    method: 'POST',
    body: JSON.stringify({ key_version: 1, recovery_envelope: recoveryEnvelope, device_envelope: issuerEnvelope }),
  }, auth.access_token);
  const grant = await request('/device-links', {
    method: 'POST',
    body: JSON.stringify({ name: 'Chromium Extension', kind: 'extension' }),
  }, auth.access_token);

  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  if (remoteMode) {
    const access = await context.request.get(origin, { headers: accessHeaders });
    assert.equal(access.status(), 200);
    assert((await context.cookies(origin)).some((cookie) => cookie.name === 'CF_Authorization'));
  }
  let worker = context.serviceWorkers()[0];
  worker ??= await context.waitForEvent('serviceworker', { timeout: 15_000 });
  const extensionId = new URL(worker.url()).hostname;
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  await options.locator('#link-token').fill(grant.link_token);
  await options.locator('#redeem').click();
  await options.locator('#status').filter({ hasText: 'E2EE envelope待機中' }).waitFor({ timeout: 15_000 });

  const devices = await request('/devices', {}, auth.access_token);
  const extensionDevice = devices.find((device) => device.kind === 'browser_extension');
  assert(extensionDevice?.public_key?.startsWith('p256.'));
  extensionDeviceId = extensionDevice.id;
  const extensionEnvelope = await wrapAccountKeyForDevice(accountKey, 1, extensionDevice.id, extensionDevice.public_key);
  await request(`/e2ee/device-envelopes/${encodeURIComponent(extensionDevice.id)}`, {
    method: 'PUT',
    body: JSON.stringify({ key_version: 1, envelope: extensionEnvelope }),
  }, auth.access_token);

  await options.locator('#sync-key').click();
  await options.locator('#status').filter({ hasText: 'E2EE準備完了' }).waitFor({ timeout: 15_000 });
  await waitForExtension(options, (value) => value.realtimeConnected === true && typeof value.lastSyncAt === 'string');
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  const noteTitle = `Extension encrypted note ${suffix}`;
  const noteBody = 'extension plaintext remains client-side';
  await popup.locator('#note-title').fill(noteTitle);
  await popup.locator('#note-body').fill(noteBody);
  await popup.locator('#send-note').click();
  const encrypted = await waitForPush(auth.access_token, (item) => item.type === 'note');
  assert.equal(encrypted?.payload_version, 2);
  assert.equal(encrypted?.payload, null);
  assert.equal(JSON.stringify(encrypted).includes(noteTitle), false);
  assert.equal(JSON.stringify(encrypted).includes(noteBody), false);
  assert.deepEqual(await decryptPush(accountKey, encrypted), { title: noteTitle, body: noteBody });
  pushIds.push(encrypted.id);

  await popup.locator('#status').filter({ hasText: 'E2EE準備完了' }).waitFor({ timeout: 15_000 });
  await popup.locator('#target').selectOption(auth.device.id);
  const linkTitle = `Extension encrypted link ${suffix}`;
  const linkUrl = `https://example.test/${suffix}`;
  await popup.locator('#link-title').fill(linkTitle);
  await popup.locator('#link-url').fill(linkUrl);
  await popup.locator('#send-link').click();
  const encryptedLink = await waitForPush(auth.access_token, (item) => item.type === 'link');
  assert.equal(encryptedLink?.payload_version, 2);
  assert.equal(encryptedLink?.payload, null);
  assert.deepEqual(encryptedLink?.target, { kind: 'device', device_id: auth.device.id });
  assert.equal(JSON.stringify(encryptedLink).includes(linkTitle), false);
  assert.equal(JSON.stringify(encryptedLink).includes(linkUrl), false);
  assert.deepEqual(await decryptPush(accountKey, encryptedLink), { title: linkTitle, url: linkUrl });
  pushIds.push(encryptedLink.id);

  const incomingGuid = crypto.randomUUID();
  const incomingTitle = `Realtime encrypted Note ${suffix}`;
  const incomingBody = 'realtime payload decrypted only inside extension';
  const incomingContext = `pushbridge/push/v2/note/${incomingGuid}`;
  const incomingEnvelope = await seal(
    accountKey,
    encoder.encode(JSON.stringify({ title: incomingTitle, body: incomingBody })),
    1,
    'pushbridge/content/v2/1',
    incomingContext,
  );
  const incoming = await request('/pushes', {
    method: 'POST',
    headers: { 'Idempotency-Key': incomingGuid },
    body: JSON.stringify({
      type: 'note',
      target: { kind: 'device', device_id: extensionDevice.id },
      client_guid: incomingGuid,
      payload_version: 2,
      key_version: incomingEnvelope.key_version,
      encryption_salt: incomingEnvelope.salt,
      nonce: incomingEnvelope.nonce,
      ciphertext: incomingEnvelope.ciphertext,
    }),
  }, auth.access_token);
  pushIds.push(incoming.id);
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const notifications = await options.evaluate(() => chrome.notifications.getAll());
    if (notifications[`pushbridge-push-${incoming.id}`]) break;
    if (attempt === 79) throw new Error('Realtime notification was not created');
    await delay(250);
  }
  await popup.reload();
  await popup.locator('#history li').filter({ hasText: incomingTitle }).waitFor({ timeout: 15_000 });

  await extensionRequest(options, { type: 'SET_NOTIFICATIONS', enabled: false });
  const beforeMutedSync = await extensionRequest(options, { type: 'STATUS' });
  const mutedGuid = crypto.randomUUID();
  const mutedTitle = `Muted realtime Note ${suffix}`;
  const mutedContext = `pushbridge/push/v2/note/${mutedGuid}`;
  const mutedEnvelope = await seal(
    accountKey,
    encoder.encode(JSON.stringify({ title: mutedTitle, body: 'cursor sync still runs while notifications are muted' })),
    1,
    'pushbridge/content/v2/1',
    mutedContext,
  );
  const muted = await request('/pushes', {
    method: 'POST',
    headers: { 'Idempotency-Key': mutedGuid },
    body: JSON.stringify({
      type: 'note',
      target: { kind: 'device', device_id: extensionDevice.id },
      client_guid: mutedGuid,
      payload_version: 2,
      key_version: mutedEnvelope.key_version,
      encryption_salt: mutedEnvelope.salt,
      nonce: mutedEnvelope.nonce,
      ciphertext: mutedEnvelope.ciphertext,
    }),
  }, auth.access_token);
  pushIds.push(muted.id);
  await waitForExtension(options, (value) => value.lastSyncAt !== beforeMutedSync.lastSyncAt);
  const mutedNotifications = await options.evaluate(() => chrome.notifications.getAll());
  assert.equal(mutedNotifications[`pushbridge-push-${muted.id}`], undefined);
  await popup.reload();
  await popup.locator('#history li').filter({ hasText: mutedTitle }).waitFor({ timeout: 15_000 });
  await extensionRequest(options, { type: 'SET_NOTIFICATIONS', enabled: true });

  const fileName = `extension-private-${suffix}.txt`;
  const fileMime = 'text/plain';
  const fileBytes = Buffer.from(`extension private file ${suffix}`, 'utf8');
  const fileTitle = `Encrypted extension File ${suffix}`;
  await popup.locator('#file-input').setInputFiles({ name: fileName, mimeType: fileMime, buffer: fileBytes });
  await popup.locator('#file-title').fill(fileTitle);
  await popup.locator('#file-ttl').selectOption('86400');
  await popup.locator('#send-file').click();
  const encryptedFilePush = await waitForPush(auth.access_token, (item) => item.type === 'file');
  pushIds.push(encryptedFilePush.id);
  uploadedFileId = encryptedFilePush.file_id;
  assert.equal(encryptedFilePush.payload_version, 2);
  assert.equal(encryptedFilePush.payload, null);
  assert.equal(JSON.stringify(encryptedFilePush).includes(fileName), false);
  assert.equal(JSON.stringify(encryptedFilePush).includes(fileTitle), false);
  const decryptedFileMetadata = await decryptPush(accountKey, encryptedFilePush);
  assert.equal(decryptedFileMetadata.title, fileTitle);
  assert.deepEqual(decryptedFileMetadata.file, {
    name: fileName,
    mime_type: fileMime,
    size: fileBytes.byteLength,
    client_file_id: uploadedFileId,
    sha256: null,
    expires_at: decryptedFileMetadata.file.expires_at,
  });
  const serverFile = await request(`/files/${encodeURIComponent(uploadedFileId)}`, {}, auth.access_token);
  assert.equal(serverFile.original_name, 'encrypted.bin');
  assert.equal(serverFile.content_type, 'application/octet-stream');
  assert.equal(serverFile.expected_size, fileBytes.byteLength + 53);
  assert.equal(serverFile.actual_size, fileBytes.byteLength + 53);
  assert.equal(serverFile.e2ee, true);
  const downloadTicket = await request(`/files/${encodeURIComponent(uploadedFileId)}/download-ticket`, {
    method: 'POST',
  }, auth.access_token);
  const downloaded = new Uint8Array(await (await fetch(downloadTicket.download_url, {
    headers: accessHeaders,
  })).arrayBuffer());
  assert.equal(Buffer.from(downloaded).indexOf(fileBytes), -1);
  assert.deepEqual(await decryptFileContainer(accountKey, uploadedFileId, downloaded), new Uint8Array(fileBytes));
  console.log(`Chromium extension ${remoteMode ? 'remote' : 'local'} E2E passed: device-link, E2EE Note/Link/File, private R2, target selection, one-time WebSocket, cursor sync, notification, and peer decryption.`);
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  if (auth?.access_token) {
    for (const pushId of pushIds) {
      await request(`/pushes/${encodeURIComponent(pushId)}`, { method: 'DELETE' }, auth.access_token).catch(() => undefined);
    }
    if (uploadedFileId) {
      await request(`/files/${encodeURIComponent(uploadedFileId)}`, { method: 'DELETE' }, auth.access_token).catch(() => undefined);
    }
  }
  if (auth?.access_token && extensionDeviceId) {
    await request(`/devices/${encodeURIComponent(extensionDeviceId)}`, { method: 'DELETE' }, auth.access_token).catch(() => undefined);
  }
  if (auth?.access_token) {
    await request('/account', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirmation: 'DELETE' }),
    }, auth.access_token).catch(() => undefined);
  }
  await context?.close();
  if (windows && child?.pid) {
    spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
  } else if (child?.pid && child.exitCode == null) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
  }
  await delay(500);
  await Promise.all([
    rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }),
    ...(persistence ? [rm(persistence, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })] : []),
  ]);
}
