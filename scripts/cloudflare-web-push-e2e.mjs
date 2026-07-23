#!/usr/bin/env node

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { chromium } from '@playwright/test';

const repositoryRoot = resolve(import.meta.dirname, '..');
const runtimeRoot = resolve(repositoryRoot, '.runtime');
const origin = (process.env.PUSHBRIDGE_REMOTE_ORIGIN
  ?? 'https://pushbridge-dev.mokusatsu.workers.dev').replace(/\/$/u, '');
const accessClientId = process.env.CF_ACCESS_CLIENT_ID;
const accessClientSecret = process.env.CF_ACCESS_CLIENT_SECRET;
const edgeExecutable = process.env.PUSHBRIDGE_EDGE_EXECUTABLE
  ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const accessHeaders = accessClientId && accessClientSecret ? {
  'CF-Access-Client-Id': accessClientId,
  'CF-Access-Client-Secret': accessClientSecret,
} : {};
const settingsKey = 'pushbridge.client-settings.v2';
const tokenKey = 'pushbridge.bearer-token.local.v2';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function poll(read, predicate, label, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let value;
  while (Date.now() < deadline) {
    value = await read();
    if (predicate(value)) return value;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error(`${label} did not reach the expected state.`);
}

async function establishAccessCookie(context) {
  const response = await context.request.get(origin, { headers: accessHeaders });
  assert(response.status() === 200, `Cloudflare Access returned HTTP ${response.status()}.`);
  const cookieNames = (await context.cookies(origin)).map((cookie) => cookie.name);
  assert(cookieNames.includes('CF_Authorization'), 'Cloudflare Access cookie was not issued.');
}

async function prepareDeviceIdentity(context) {
  const page = await context.newPage();
  const bootstrapPath = '/__pushbridge_web_push_identity__';
  await context.route(`**${bootstrapPath}`, (route) => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: '<!doctype html><title>identity bootstrap</title>',
  }));
  await page.goto(`${origin}${bootstrapPath}`);
  const publicKey = await page.evaluate(async () => {
    const pair = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      ['deriveBits'],
    );
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
    let binary = '';
    for (const byte of raw) binary += String.fromCharCode(byte);
    const encoded = btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
    const value = `p256.${encoded}`;
    const database = await new Promise((resolvePromise, reject) => {
      const open = indexedDB.open('pushbridge-device-identity-v1', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('identity', { keyPath: 'id' });
      open.onsuccess = () => resolvePromise(open.result);
      open.onerror = () => reject(open.error);
    });
    await new Promise((resolvePromise, reject) => {
      const put = database.transaction('identity', 'readwrite').objectStore('identity').put({
        id: 'current',
        privateKey: pair.privateKey,
        publicKey: value,
        createdAt: new Date().toISOString(),
      });
      put.onsuccess = () => resolvePromise();
      put.onerror = () => reject(put.error);
    });
    database.close();
    return value;
  });
  await context.unroute(`**${bootstrapPath}`);
  return { page, publicKey };
}

async function configureContext(context, token, deviceId, namespace) {
  await context.addInitScript((settings) => {
    localStorage.setItem(settings.settingsKey, JSON.stringify({
      apiBaseUrl: '/api/v1',
      realtimePath: '/realtime',
      authMode: 'bearer',
      rememberBearerToken: true,
      currentDeviceId: settings.deviceId,
      storageNamespace: settings.namespace,
      pollIntervalSeconds: 5,
      autoCacheReceivedFiles: true,
      localFileCacheMaxBytes: 64 * 1024 * 1024,
    }));
    localStorage.setItem(settings.tokenKey, settings.token);
  }, { settingsKey, tokenKey, token, deviceId, namespace });
}

async function waitForOnline(page) {
  await page.locator('.connection-badge').waitFor({ state: 'visible' });
  await poll(
    () => page.locator('.connection-badge').getAttribute('title'),
    (value) => /^API接続中/u.test(value ?? ''),
    'PWA connection',
    30_000,
  );
}

async function hasAccountKey(page, namespace) {
  return page.evaluate(async (storageNamespace) => {
    const safe = storageNamespace.toLowerCase()
      .replace(/[^a-z0-9_-]+/gu, '-')
      .replace(/^-+|-+$/gu, '');
    const database = await new Promise((resolvePromise, reject) => {
      const open = indexedDB.open(`pushbridge-${safe || 'default'}-v2`);
      open.onsuccess = () => resolvePromise(open.result);
      open.onerror = () => reject(open.error);
    });
    if (!database.objectStoreNames.contains('e2eeKeys')) {
      database.close();
      return false;
    }
    const record = await new Promise((resolvePromise, reject) => {
      const get = database.transaction('e2eeKeys').objectStore('e2eeKeys').get('account-key');
      get.onsuccess = () => resolvePromise(get.result);
      get.onerror = () => reject(get.error);
    });
    database.close();
    return Boolean(record?.key_bytes);
  }, namespace);
}

async function createBrowserSubscription(page) {
  return page.evaluate(async () => {
    const configResponse = await fetch('/api/v1/web-push-config');
    if (!configResponse.ok) throw new Error(`Web Push config returned HTTP ${configResponse.status}.`);
    const config = await configResponse.json();
    const normalized = String(config.vapid_public_key).replaceAll('-', '+').replaceAll('_', '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const applicationServerKey = Uint8Array.from(
      atob(padded),
      (character) => character.charCodeAt(0),
    );
    const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    await navigator.serviceWorker.ready;
    const existing = await registration.pushManager.getSubscription();
    await existing?.unsubscribe();
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey,
    });
    const encode = (value) => {
      const bytes = new Uint8Array(value);
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
    };
    const p256dh = subscription.getKey('p256dh');
    const auth = subscription.getKey('auth');
    if (!p256dh || !auth) throw new Error('Browser Web Push keys are unavailable.');
    return {
      endpoint: subscription.endpoint,
      p256dh: encode(p256dh),
      auth: encode(auth),
      permission: Notification.permission,
    };
  });
}

async function readCachedText(page, namespace, fileId) {
  return page.evaluate(async ({ storageNamespace, id }) => {
    const safe = storageNamespace.toLowerCase()
      .replace(/[^a-z0-9_-]+/gu, '-')
      .replace(/^-+|-+$/gu, '');
    const database = await new Promise((resolvePromise, reject) => {
      const open = indexedDB.open(`pushbridge-${safe || 'default'}-v2`);
      open.onsuccess = () => resolvePromise(open.result);
      open.onerror = () => reject(open.error);
    });
    const cached = await new Promise((resolvePromise, reject) => {
      const get = database.transaction('cachedFiles').objectStore('cachedFiles').get(id);
      get.onsuccess = () => resolvePromise(get.result);
      get.onerror = () => reject(get.error);
    });
    database.close();
    return cached?.blob ? cached.blob.text() : null;
  }, { storageNamespace: namespace, id: fileId });
}

mkdirSync(runtimeRoot, { recursive: true });
const receiverProfile = mkdtempSync(join(runtimeRoot, 'web-push-e2e-'));
let receiverContext;
let senderBrowser;
let senderContext;
let senderToken;
let receiverToken;
let fileId;
let accountDeleted = false;

try {
  receiverContext = await chromium.launchPersistentContext(receiverProfile, {
    executablePath: edgeExecutable,
    headless: false,
    viewport: { width: 1280, height: 900 },
    extraHTTPHeaders: accessHeaders,
    args: ['--no-first-run', '--disable-default-apps'],
  });
  senderBrowser = await chromium.launch({ headless: true });
  senderContext = await senderBrowser.newContext({ extraHTTPHeaders: accessHeaders });
  await receiverContext.grantPermissions(['notifications'], { origin });
  await establishAccessCookie(receiverContext);
  await establishAccessCookie(senderContext);

  const sender = await prepareDeviceIdentity(senderContext);
  const receiver = await prepareDeviceIdentity(receiverContext);
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const bootstrap = await senderContext.request.post(`${origin}/api/v1/auth/bootstrap`, {
    data: {
      handle: `web_push_e2e_${suffix}`,
      device_name: 'Web Push Sender',
      device_kind: 'pwa',
      public_key: sender.publicKey,
    },
  });
  assert(bootstrap.status() === 201, `Sender bootstrap returned HTTP ${bootstrap.status()}.`);
  const first = await bootstrap.json();
  senderToken = first.access_token;
  const linked = await senderContext.request.post(`${origin}/api/v1/devices/link`, {
    headers: { Authorization: `Bearer ${senderToken}` },
    data: {
      name: 'Web Push Receiver',
      kind: 'pwa',
      public_key: receiver.publicKey,
    },
  });
  assert(linked.status() === 201, `Receiver link returned HTTP ${linked.status()}.`);
  const second = await linked.json();
  receiverToken = second.access_token;
  const namespace = `web-push-e2e-${first.user.id}`;

  await configureContext(senderContext, senderToken, first.device.id, namespace);
  await sender.page.goto(`${origin}/#/timeline`);
  await waitForOnline(sender.page);
  await configureContext(receiverContext, receiverToken, second.device.id, namespace);
  await receiver.page.goto(`${origin}/#/timeline`);
  await waitForOnline(receiver.page);
  await poll(
    () => hasAccountKey(receiver.page, namespace),
    Boolean,
    'Receiver E2EE account key',
    30_000,
  );

  const browserSubscription = await createBrowserSubscription(receiver.page);
  assert(browserSubscription.permission === 'granted', 'Notification permission was not granted.');
  const registered = await receiverContext.request.post(`${origin}/api/v1/web-push-subscriptions`, {
    headers: { Authorization: `Bearer ${receiverToken}` },
    data: {
      endpoint: browserSubscription.endpoint,
      p256dh: browserSubscription.p256dh,
      auth: browserSubscription.auth,
      storage_namespace: namespace,
      local_cache_max_bytes: 64 * 1024 * 1024,
    },
  });
  assert([200, 201].includes(registered.status()), `Web Push registration returned HTTP ${registered.status()}.`);

  const keeper = await receiverContext.newPage();
  await keeper.goto('about:blank');
  await receiver.page.close();
  assert(
    receiverContext.pages().every((page) => !page.url().startsWith(origin)),
    'Receiver PWA remained open before Web Push delivery.',
  );

  const fixtureName = `web-push-${Date.now()}.txt`;
  const fixtureText = 'synthetic encrypted Web Push file';
  await sender.page.goto(`${origin}/#/compose`);
  await sender.page.getByRole('button', { name: 'ファイル', exact: true }).click();
  await sender.page.locator('#file-input').setInputFiles({
    name: fixtureName,
    mimeType: 'text/plain',
    buffer: Buffer.from(fixtureText),
  });
  await sender.page.getByRole('button', { name: '送信する' }).click();
  await sender.page.getByRole('button', { name: /送信済み/u }).click();
  await sender.page.getByRole('heading', { name: fixtureName, exact: true }).waitFor();

  const filePush = await poll(async () => {
    const response = await senderContext.request.get(`${origin}/api/v1/pushes?limit=100&include_deleted=true`, {
      headers: { Authorization: `Bearer ${senderToken}` },
    });
    assert(response.status() === 200, `Push listing returned HTTP ${response.status()}.`);
    const body = await response.json();
    return body.items.find((item) => item.type === 'file');
  }, Boolean, 'Encrypted File Push');
  fileId = filePush.file_id;
  assert(typeof fileId === 'string', 'Encrypted File Push did not expose a file ID.');

  const delivery = await poll(async () => {
    const response = await senderContext.request.get(`${origin}/api/v1/files/${encodeURIComponent(fileId)}/deliveries`, {
      headers: { Authorization: `Bearer ${senderToken}` },
    });
    assert(response.status() === 200, `File delivery listing returned HTTP ${response.status()}.`);
    const body = await response.json();
    return body.find((item) => item.destination_device_id === second.device.id);
  }, (value) => value?.state === 'cached' || value?.state === 'failed_retryable', 'Web Push File delivery');
  assert(delivery.state === 'cached', 'Closed-PWA Web Push delivery did not produce a cached ACK.');

  const verificationPage = await receiverContext.newPage();
  await verificationPage.goto(`${origin}/#/timeline`);
  await waitForOnline(verificationPage);
  assert(
    await readCachedText(verificationPage, namespace, fileId) === fixtureText,
    'Service Worker IndexedDB Blob did not match the synthetic fixture.',
  );
  const deleted = await senderContext.request.delete(`${origin}/api/v1/files/${encodeURIComponent(fileId)}`, {
    headers: { Authorization: `Bearer ${senderToken}` },
  });
  assert(deleted.status() === 200, `Server File deletion returned HTTP ${deleted.status()}.`);
  await receiverContext.setOffline(true);
  await verificationPage.reload({ waitUntil: 'domcontentloaded' });
  assert(
    await readCachedText(verificationPage, namespace, fileId) === fixtureText,
    'Cached IndexedDB Blob was lost after server deletion and offline reload.',
  );
  await receiverContext.setOffline(false);

  await verificationPage.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration('/');
    await (await registration?.pushManager.getSubscription())?.unsubscribe();
  });
  const erased = await senderContext.request.delete(`${origin}/api/v1/account`, {
    headers: { Authorization: `Bearer ${senderToken}` },
    data: { confirmation: 'DELETE' },
  });
  assert(erased.status() === 202, `Account deletion returned HTTP ${erased.status()}.`);
  const erasedBody = await erased.json();
  assert(erasedBody.deletion?.state === 'completed', 'Web Push E2E account deletion did not complete.');
  const revoked = await receiverContext.request.get(`${origin}/api/v1/devices`, {
    headers: { Authorization: `Bearer ${receiverToken}` },
  });
  assert(revoked.status() === 401, 'Receiver token remained valid after account deletion.');
  accountDeleted = true;

  console.log([
    'Real Edge closed-PWA Web Push E2E passed:',
    'subscription=real',
    'pwa_window=closed',
    'e2ee_file=delivered',
    'indexeddb_commit=verified',
    'cached_ack=verified',
    'server_delete=verified',
    'offline_blob=verified',
    'test_account=erased',
    'profile_removed=true',
  ].join(' '));
} finally {
  await receiverContext?.setOffline(false).catch(() => undefined);
  if (!accountDeleted && senderToken && senderContext) {
    if (fileId) {
      await senderContext.request.delete(`${origin}/api/v1/files/${encodeURIComponent(fileId)}`, {
        headers: { Authorization: `Bearer ${senderToken}` },
      }).catch(() => undefined);
    }
    await senderContext.request.delete(`${origin}/api/v1/account`, {
      headers: { Authorization: `Bearer ${senderToken}` },
      data: { confirmation: 'DELETE' },
    }).catch(() => undefined);
  }
  await receiverContext?.close().catch(() => undefined);
  await senderContext?.close().catch(() => undefined);
  await senderBrowser?.close().catch(() => undefined);
  rmSync(receiverProfile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
