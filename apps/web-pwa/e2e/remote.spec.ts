import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';

const settingsKey = 'pushbridge.client-settings.v2';
const tokenKey = 'pushbridge.bearer-token.local.v2';
const remoteOrigin = process.env.PUSHBRIDGE_REMOTE_ORIGIN ?? 'https://pushbridge-dev.mokusatsu.workers.dev';
const remoteEnabled = Boolean(process.env.PUSHBRIDGE_REMOTE_ORIGIN
  && process.env.CF_ACCESS_CLIENT_ID
  && process.env.CF_ACCESS_CLIENT_SECRET);

interface Credential {
  user: { id: string };
  device: { id: string };
  access_token: string;
}

async function createCredentials(request: APIRequestContext, publicKeyA: string, publicKeyB: string) {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const bootstrap = await request.post('/api/v1/auth/bootstrap', {
    data: { handle: `remote_browser_${suffix}`, device_name: 'Remote Browser A', device_kind: 'pwa', public_key: publicKeyA },
  });
  expect(bootstrap.status()).toBe(201);
  const first = await bootstrap.json() as Credential;
  const linked = await request.post('/api/v1/devices/link', {
    headers: { Authorization: `Bearer ${first.access_token}` },
    data: { name: 'Remote Browser B', kind: 'pwa', public_key: publicKeyB },
  });
  expect(linked.status()).toBe(201);
  const second = await linked.json() as Omit<Credential, 'user'>;
  return { first, second, namespace: `remote-browser-${first.user.id}` };
}

async function prepareDeviceIdentity(context: BrowserContext) {
  const page = await context.newPage();
  const bootstrapPath = '/__pushbridge_identity_bootstrap__';
  await context.route(`**${bootstrapPath}`, (route) => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: '<!doctype html><title>identity bootstrap</title>',
  }));
  await page.goto(`${remoteOrigin}${bootstrapPath}`);
  const publicKey = await page.evaluate(async () => {
    const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']) as CryptoKeyPair;
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
    let binary = '';
    for (const byte of raw) binary += String.fromCharCode(byte);
    const encoded = btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
    const value = `p256.${encoded}`;
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open('pushbridge-device-identity-v1', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('identity', { keyPath: 'id' });
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    await new Promise<void>((resolve, reject) => {
      const put = db.transaction('identity', 'readwrite').objectStore('identity').put({
        id: 'current', privateKey: pair.privateKey, publicKey: value, createdAt: new Date().toISOString(),
      });
      put.onsuccess = () => resolve();
      put.onerror = () => reject(put.error);
    });
    db.close();
    return value;
  });
  await context.unroute(`**${bootstrapPath}`);
  return { page, publicKey };
}

async function establishAccessCookie(context: BrowserContext) {
  const clientId = process.env.CF_ACCESS_CLIENT_ID;
  const clientSecret = process.env.CF_ACCESS_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('Cloudflare Access service-token environment variables are unavailable.');
  const response = await context.request.get(remoteOrigin, {
    headers: {
      'CF-Access-Client-Id': clientId,
      'CF-Access-Client-Secret': clientSecret,
    },
  });
  expect(response.status()).toBe(200);
  const cookieNames = (await context.cookies(remoteOrigin)).map((cookie) => cookie.name);
  expect(cookieNames).toContain('CF_Authorization');
}

async function configureContext(context: BrowserContext, token: string, deviceId: string, namespace: string) {
  await context.addInitScript(({ settingsKey: key, tokenKey: authKey, token: value, deviceId: device, namespace: storage }) => {
    localStorage.setItem(key, JSON.stringify({
      apiBaseUrl: '/api/v1', realtimePath: '/realtime', authMode: 'bearer', rememberBearerToken: true,
      currentDeviceId: device, storageNamespace: storage, pollIntervalSeconds: 5,
      autoCacheReceivedFiles: true, localFileCacheMaxBytes: 64 * 1024 * 1024,
    }));
    localStorage.setItem(authKey, value);
  }, { settingsKey, tokenKey, token, deviceId, namespace });
}

async function sync(page: Page) {
  const button = page.getByRole('button', { name: '今すぐ同期' });
  await expect(button).toBeEnabled();
  await button.click();
  await expect(button).toBeEnabled();
}

async function waitForOnline(page: Page) {
  await expect(page.locator('.connection-badge')).toHaveAttribute('title', /^API接続中/);
}

async function listPushes(request: APIRequestContext, token: string) {
  const response = await request.get('/api/v1/pushes?limit=100&include_deleted=true', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.status()).toBe(200);
  return (await response.json()) as { items: Array<Record<string, unknown>> };
}

test('public Worker PWA preserves an encrypted File in IndexedDB and offline @remote', async ({ browser, request }) => {
  test.skip(!remoteEnabled, 'Requires the remote origin and Cloudflare Access service-token environment variables.');
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  await establishAccessCookie(contextA);
  await establishAccessCookie(contextB);
  const preparedA = await prepareDeviceIdentity(contextA);
  const preparedB = await prepareDeviceIdentity(contextB);
  const { first, second, namespace } = await createCredentials(request, preparedA.publicKey, preparedB.publicKey);
  let fileId: string | undefined;
  const createdPushIds: string[] = [];
  try {
    await configureContext(contextA, first.access_token, first.device.id, namespace);
    const pageA = preparedA.page;
    await pageA.goto('/#/timeline');
    await waitForOnline(pageA);

    await configureContext(contextB, second.access_token, second.device.id, namespace);
    const pageB = preparedB.page;
    await pageB.goto('/#/timeline');
    await waitForOnline(pageB);

    const noteTitle = `Remote encrypted Note ${Date.now()}`;
    const noteBody = 'remote browser plaintext remains client-side';
    await pageA.goto('/#/compose');
    await pageA.getByPlaceholder('短い見出し').fill(noteTitle);
    await pageA.getByPlaceholder('別の端末へ送りたい内容を入力します。').fill(noteBody);
    await pageA.getByRole('button', { name: '送信する' }).click();
    await pageA.getByRole('button', { name: /送信済み/ }).click();
    await expect(pageA.getByRole('heading', { name: noteTitle })).toBeVisible();
    await sync(pageB);
    await expect(pageB.getByRole('heading', { name: noteTitle })).toBeVisible();

    const notePushes = await listPushes(request, first.access_token);
    const notePush = notePushes.items.find((item) => item.type === 'note');
    expect(notePush).toMatchObject({ payload_version: 2, payload: null, key_version: 1 });
    expect(JSON.stringify(notePush)).not.toContain(noteTitle);
    expect(JSON.stringify(notePush)).not.toContain(noteBody);
    createdPushIds.push(String(notePush?.id));

    const fileName = `remote-encrypted-${Date.now()}.txt`;
    const fileBody = 'remote encrypted file bytes';
    await pageA.goto('/#/compose');
    await pageA.getByRole('button', { name: 'ファイル', exact: true }).click();
    await pageA.locator('#file-input').setInputFiles({ name: fileName, mimeType: 'text/plain', buffer: Buffer.from(fileBody) });
    await pageA.getByRole('button', { name: '送信する' }).click();
    await pageA.getByRole('button', { name: /送信済み/ }).click();
    await expect(pageA.getByRole('heading', { name: fileName, exact: true })).toBeVisible();

    await expect.poll(async () => (await listPushes(request, first.access_token)).items.some((item) => item.type === 'file')).toBe(true);
    const filePushes = await listPushes(request, first.access_token);
    const filePush = filePushes.items.find((item) => item.type === 'file');
    expect(filePush).toMatchObject({ payload_version: 2, payload: null, key_version: 1 });
    expect(JSON.stringify(filePush)).not.toContain(fileName);
    fileId = String(filePush?.file_id);
    createdPushIds.push(String(filePush?.id));
    const metadata = await request.get(`/api/v1/files/${encodeURIComponent(fileId)}`, {
      headers: { Authorization: `Bearer ${first.access_token}` },
    });
    expect(metadata.status()).toBe(200);
    expect(await metadata.json()).toMatchObject({ original_name: 'encrypted.bin', content_type: 'application/octet-stream', e2ee: true });

    await sync(pageB);
    await expect(pageB.getByRole('heading', { name: fileName, exact: true })).toBeVisible();
    await expect(pageB.getByText('この端末に保存済み').first()).toBeVisible();
    const cachedText = await pageB.evaluate(async ({ namespace: storage, fileId: id }) => {
      const safe = storage.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const open = indexedDB.open(`pushbridge-${safe || 'default'}-v2`);
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
      const cached = await new Promise<{ blob: Blob }>((resolve, reject) => {
        const result = db.transaction('cachedFiles').objectStore('cachedFiles').get(id);
        result.onsuccess = () => resolve(result.result);
        result.onerror = () => reject(result.error);
      });
      db.close();
      return cached.blob.text();
    }, { namespace, fileId });
    expect(cachedText).toBe(fileBody);
    expect(await pageB.evaluate(() => Object.keys(localStorage).some((key) => /account.*key|recovery.*key/i.test(key)))).toBe(false);

    const deleted = await request.delete(`/api/v1/files/${encodeURIComponent(fileId)}`, {
      headers: { Authorization: `Bearer ${first.access_token}` },
    });
    expect(deleted.status()).toBe(200);
    await sync(pageB);
    await expect(pageB.getByText('この端末に保存済み').first()).toBeVisible();

    const serviceWorker = await pageB.evaluate(async () => {
      try {
        const registration = await Promise.race([
          navigator.serviceWorker.register('/sw.js', { scope: '/' }),
          new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error('registration timeout')), 10_000)),
        ]);
        return {
          ok: true,
          scope: registration.scope,
          active: registration.active?.state ?? null,
          waiting: registration.waiting?.state ?? null,
          installing: registration.installing?.state ?? null,
        };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    });
    expect(serviceWorker, `Service Worker registration failed: ${JSON.stringify(serviceWorker)}`).toMatchObject({ ok: true });
    await expect.poll(async () => (await pageB.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration('/');
      return registration?.active?.state ?? null;
    }))).toBe('activated');
    await pageB.reload();
    await expect.poll(() => pageB.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
    await contextB.setOffline(true);
    await pageB.reload();
    await expect(pageB.getByRole('heading', { name: fileName, exact: true })).toBeVisible();
    await expect(pageB.getByText('この端末に保存済み').first()).toBeVisible();
    await contextB.setOffline(false);
  } finally {
    await contextB.setOffline(false).catch(() => undefined);
    if (fileId) {
      await request.delete(`/api/v1/files/${encodeURIComponent(fileId)}`, {
        headers: { Authorization: `Bearer ${first.access_token}` },
      }).catch(() => undefined);
    }
    for (const pushId of createdPushIds.filter((value) => value && value !== 'undefined')) {
      await request.delete(`/api/v1/pushes/${encodeURIComponent(pushId)}`, {
        headers: { Authorization: `Bearer ${first.access_token}` },
      }).catch(() => undefined);
    }
    await request.delete(`/api/v1/devices/${encodeURIComponent(second.device.id)}`, {
      headers: { Authorization: `Bearer ${first.access_token}` },
    }).catch(() => undefined);
    await request.delete('/api/v1/account', {
      headers: {
        Authorization: `Bearer ${first.access_token}`,
        'content-type': 'application/json',
      },
      data: { confirmation: 'DELETE' },
    }).catch(() => undefined);
    await contextA.close();
    await contextB.close();
  }
});
