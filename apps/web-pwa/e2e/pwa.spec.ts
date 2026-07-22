import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';

const origin = 'http://127.0.0.1:8766';
const settingsKey = 'pushbridge.client-settings.v2';
const tokenKey = 'pushbridge.bearer-token.local.v2';

interface Credential {
  user: { id: string };
  device: { id: string };
  access_token: string;
}

async function createCredentials(request: APIRequestContext) {
  const handle = `e2e_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const bootstrapResponse = await request.post('/api/v1/auth/bootstrap', {
    data: { handle, device_name: 'Desktop A', device_kind: 'pwa', public_key: null },
  });
  expect(bootstrapResponse.status()).toBe(201);
  const first = await bootstrapResponse.json() as Credential;
  const linkResponse = await request.post('/api/v1/devices/link', {
    headers: { Authorization: `Bearer ${first.access_token}` },
    data: { name: 'Desktop B', kind: 'pwa', public_key: null },
  });
  expect(linkResponse.status()).toBe(201);
  const second = await linkResponse.json() as Omit<Credential, 'user'>;
  return { first, second, namespace: `e2e-${first.user.id}` };
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

async function openClient(context: BrowserContext, token: string, deviceId: string, namespace: string) {
  await configureContext(context, token, deviceId, namespace);
  const page = await context.newPage();
  await page.goto(`${origin}/#/timeline`);
  await expect(page.getByText('API接続中')).toBeVisible();
  return page;
}

async function sync(page: Page) {
  const button = page.getByRole('button', { name: '今すぐ同期' });
  await expect(button).toBeEnabled();
  await button.click();
  await expect(button).toBeEnabled();
}

async function sendNote(page: Page, title: string) {
  await page.goto(`${origin}/#/compose`);
  await page.getByPlaceholder('短い見出し').fill(title);
  await page.getByPlaceholder('別の端末へ送りたい内容を入力します。').fill('E2E body');
  await page.getByRole('button', { name: '送信する' }).click();
  await page.getByRole('button', { name: /送信済み/ }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
}

async function sendFile(page: Page, name: string, content: string) {
  await page.goto(`${origin}/#/compose`);
  await page.getByRole('button', { name: 'ファイル', exact: true }).click();
  await page.locator('#file-input').setInputFiles({ name, mimeType: 'application/octet-stream', buffer: Buffer.from(content) });
  await page.getByRole('button', { name: '送信する' }).click();
  await page.getByRole('button', { name: /送信済み/ }).click();
  await expect(page.getByText(name, { exact: true })).toBeVisible();
}

async function fileIdByName(request: APIRequestContext, token: string, name: string): Promise<string> {
  await expect.poll(async () => {
    const response = await request.get('/api/v1/pushes?limit=100&include_deleted=true', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await response.json() as { items: Array<{ file_id?: string; payload?: { file?: { name?: string } } }> };
    return body.items.find((item) => item.payload?.file?.name === name)?.file_id ?? '';
  }).not.toBe('');
  const response = await request.get('/api/v1/pushes?limit=100&include_deleted=true', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await response.json() as { items: Array<{ file_id?: string; payload?: { file?: { name?: string } } }> };
  return body.items.find((item) => item.payload?.file?.name === name)!.file_id!;
}

test('two devices preserve a received File in IndexedDB and expose missed delivery @desktop', async ({ browser, request }) => {
  const { first, second, namespace } = await createCredentials(request);
  const contextA = await browser.newContext({ baseURL: origin, viewport: { width: 1440, height: 1000 } });
  const contextB = await browser.newContext({ baseURL: origin, viewport: { width: 1280, height: 900 } });
  try {
    const pageA = await openClient(contextA, first.access_token, first.device.id, namespace);
    const pageB = await openClient(contextB, second.access_token, second.device.id, namespace);

    const noteTitle = `Note ${Date.now()}`;
    await sendNote(pageA, noteTitle);
    await sync(pageB);
    await expect(pageB.getByRole('heading', { name: noteTitle })).toBeVisible();

    await pageA.goto(`${origin}/#/compose`);
    await pageA.getByRole('button', { name: 'リンク', exact: true }).click();
    await pageA.getByPlaceholder('https://example.com/article').fill('https://example.com/e2e');
    await pageA.getByPlaceholder('短い見出し').fill('E2E Link');
    await pageA.getByRole('button', { name: '送信する' }).click();
    await pageA.getByRole('button', { name: /送信済み/ }).click();
    await expect(pageA.getByRole('heading', { name: 'E2E Link' })).toBeVisible();
    await sync(pageB);
    await expect(pageB.getByRole('link', { name: /example\.com\/e2e/ })).toBeVisible();

    const cachedName = `cached-${Date.now()}.bin`;
    await sendFile(pageA, cachedName, 'cached-file-bytes');
    await sync(pageB);
    await expect(pageB.getByText('この端末に保存済み').first()).toBeVisible();
    const cachedCount = await pageB.evaluate(async ({ namespace: storage, cachedName: expected }) => {
      const dbName = `pushbridge-${storage.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')}-v2`;
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const open = indexedDB.open(dbName);
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
      const values = await new Promise<Array<{ name: string }>>((resolve, reject) => {
        const request = db.transaction('cachedFiles').objectStore('cachedFiles').getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      db.close();
      return values.filter((value) => value.name === expected).length;
    }, { namespace, cachedName });
    expect(cachedCount).toBe(1);

    const cachedFileId = await fileIdByName(request, first.access_token, cachedName);
    const deleteCached = await request.delete(`/api/v1/files/${encodeURIComponent(cachedFileId)}`, {
      headers: { Authorization: `Bearer ${first.access_token}` },
    });
    expect(deleteCached.ok()).toBeTruthy();
    await sync(pageB);
    await expect(pageB.getByText('この端末に保存済み').first()).toBeVisible();

    await pageB.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
    await pageB.reload();
    await expect.poll(() => pageB.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
    await contextB.setOffline(true);
    await pageB.reload();
    await expect(pageB.getByRole('heading', { name: cachedName })).toBeVisible();
    await contextB.setOffline(false);

    await contextB.setOffline(true);
    const missedName = `missed-${Date.now()}.bin`;
    await sendFile(pageA, missedName, 'missed-file-bytes');
    const missedFileId = await fileIdByName(request, first.access_token, missedName);
    const deleteMissed = await request.delete(`/api/v1/files/${encodeURIComponent(missedFileId)}`, {
      headers: { Authorization: `Bearer ${first.access_token}` },
    });
    expect(deleteMissed.ok()).toBeTruthy();
    await contextB.setOffline(false);
    await sync(pageB);
    await expect(pageB.getByText('この端末では同期できず、サーバーから削除されました。')).toBeVisible();
  } finally {
    await contextA.close();
    await contextB.close();
  }
});

test('mobile keyboard and ARIA flow remains usable when notifications are denied @mobile', async ({ page, request }) => {
  const { first, namespace } = await createCredentials(request);
  await configureContext(page.context(), first.access_token, first.device.id, namespace);
  await page.goto(`${origin}/#/timeline`);
  await expect(page.locator('.connection-badge')).toHaveAttribute('title', /^API接続中/);
  const session = await page.context().newCDPSession(page);
  const { targetInfo } = await session.send('Target.getTargetInfo');
  await session.send('Browser.setPermission', {
    permission: { name: 'notifications' }, setting: 'denied', origin: new URL(page.url()).origin,
    browserContextId: targetInfo.browserContextId,
  });
  expect(await page.evaluate(() => Notification.permission)).toBe('denied');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);
  await expect(page.getByRole('button', { name: '今すぐ同期' })).toHaveAttribute('type', 'button');

  const sendLink = page.getByRole('link', { name: '送信' }).last();
  await sendLink.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: '新しいPush' })).toBeVisible();
  await page.getByPlaceholder('短い見出し').fill('Denied notification note');
  await page.getByRole('button', { name: '送信する' }).click();
  await page.getByRole('button', { name: /送信済み/ }).click();
  await expect(page.getByRole('heading', { name: 'Denied notification note' })).toBeVisible();
});
