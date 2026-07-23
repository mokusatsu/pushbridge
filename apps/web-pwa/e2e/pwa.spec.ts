import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import { BrowserEvidence } from './browserEvidence';

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
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
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
  const evidence = new BrowserEvidence(browser.version());
  const contextA = await browser.newContext({ baseURL: origin, viewport: { width: 1440, height: 1000 } });
  const contextB = await browser.newContext({ baseURL: origin, viewport: { width: 1280, height: 900 } });
  try {
    const pageA = await openClient(contextA, first.access_token, first.device.id, namespace);
    const pageB = await openClient(contextB, second.access_token, second.device.id, namespace);
    evidence.observe(pageA, '端末A');
    evidence.observe(pageB, '端末B');

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
    await evidence.capture(pageA, '端末AからFile送信後', namespace);
    await sync(pageB);
    await expect(pageB.getByText('この端末に保存済み').first()).toBeVisible();
    await evidence.capture(pageB, '端末Bの同期とIndexedDB自動保存後', namespace);
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
    await evidence.capture(pageB, 'サーバー本体削除後も端末内Blobを維持', namespace);

    await pageB.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
    await pageB.reload();
    await expect.poll(() => pageB.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
    await contextB.setOffline(true);
    await pageB.reload();
    await expect(pageB.getByRole('heading', { name: cachedName })).toBeVisible();
    await evidence.capture(pageB, 'オフライン再読み込み後のローカル表示', namespace);
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
    await evidence.capture(pageB, '未保存ファイルのmissed表示', namespace);
  } finally {
    await evidence.write();
    await contextA.close();
    await contextB.close();
  }
});

test('account deletion revokes every device and clears local IndexedDB identity @desktop', async ({ browser, request }) => {
  const { first, second, namespace } = await createCredentials(request);
  const context = await browser.newContext({ baseURL: origin, viewport: { width: 1280, height: 900 } });
  try {
    const page = await context.newPage();
    await page.goto(origin);
    await page.evaluate(({ settingsKey: key, tokenKey: authKey, token, deviceId, namespace: storage }) => {
      localStorage.setItem(key, JSON.stringify({
        apiBaseUrl: '/api/v1', realtimePath: '/realtime', authMode: 'bearer', rememberBearerToken: true,
        currentDeviceId: deviceId, storageNamespace: storage, pollIntervalSeconds: 5,
        autoCacheReceivedFiles: true, localFileCacheMaxBytes: 64 * 1024 * 1024,
      }));
      localStorage.setItem(authKey, token);
    }, { settingsKey, tokenKey, token: first.access_token, deviceId: first.device.id, namespace });
    await page.goto(`${origin}/#/timeline`);
    await expect(page.getByText('API接続中')).toBeVisible();
    await sendNote(page, `Delete account ${Date.now()}`);
    await page.evaluate(async () => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const open = indexedDB.open('pushbridge-device-identity-v1', 1);
        open.onupgradeneeded = () => open.result.createObjectStore('identity', { keyPath: 'id' });
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction('identity', 'readwrite');
        transaction.objectStore('identity').put({ id: 'current', privateKey: 'fixture-secret', publicKey: 'fixture-public' });
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
      database.close();
    });

    await page.goto(`${origin}/#/settings`);
    page.once('dialog', async (dialog) => {
      expect(dialog.type()).toBe('prompt');
      await dialog.accept('DELETE');
    });
    await page.getByRole('button', { name: 'アカウントを完全に削除' }).click();
    await expect(page.getByText('RelayMockの端末Tokenが未設定です。')).toBeVisible();
    const localState = await page.evaluate(async ({ settings, token, namespace: storage }) => {
      const databases = await indexedDB.databases();
      const safe = storage.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
      const databaseName = `pushbridge-${safe || 'default'}-v2`;
      const runtimeDatabaseExists = databases.some((entry) => entry.name === databaseName);
      if (!runtimeDatabaseExists) {
        return {
          settings: localStorage.getItem(settings),
          token: localStorage.getItem(token),
          identityDatabaseExists: databases.some((entry) => entry.name === 'pushbridge-device-identity-v1'),
          runtimeDatabaseExists,
          cursor: '',
          sensitiveRecords: 0,
        };
      }
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const open = indexedDB.open(databaseName);
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
      const counts: Record<string, number> = {};
      for (const store of Array.from(database.objectStoreNames)) {
        counts[store] = await new Promise<number>((resolve, reject) => {
          const count = database.transaction(store).objectStore(store).count();
          count.onsuccess = () => resolve(count.result);
          count.onerror = () => reject(count.error);
        });
      }
      const cursor = await new Promise<string>((resolve, reject) => {
        const result = database.transaction('meta').objectStore('meta').get('cursor');
        result.onsuccess = () => resolve(result.result?.value ?? '');
        result.onerror = () => reject(result.error);
      });
      database.close();
      return {
        settings: localStorage.getItem(settings),
        token: localStorage.getItem(token),
        identityDatabaseExists: databases.some((entry) => entry.name === 'pushbridge-device-identity-v1'),
        runtimeDatabaseExists,
        cursor,
        sensitiveRecords: ['pushes', 'devices', 'outbox', 'cachedFiles', 'e2eeKeys']
          .reduce((total, store) => total + (counts[store] ?? 0), 0),
      };
    }, { settings: settingsKey, token: tokenKey, namespace });
    expect(localState).toEqual({
      settings: null,
      token: null,
      identityDatabaseExists: false,
      runtimeDatabaseExists: false,
      cursor: '',
      sensitiveRecords: 0,
    });
    expect((await request.get('/api/v1/devices', {
      headers: { Authorization: `Bearer ${first.access_token}` },
    })).status()).toBe(401);
    expect((await request.get('/api/v1/devices', {
      headers: { Authorization: `Bearer ${second.access_token}` },
    })).status()).toBe(401);
  } finally {
    await context.close();
  }
});

test('service worker exposes and applies a real byte-level update @desktop', async ({ page }) => {
  const serviceWorkerPath = fileURLToPath(new URL('../../../infra/cloudflare/app/dist/sw.js', import.meta.url));
  const original = await readFile(serviceWorkerPath, 'utf8');
  try {
    expect(original).toContain('if (item.encrypted) blob = await decryptFileBlob(db, item.file_id, blob)');
    expect(original.indexOf('decryptFileBlob(db, item.file_id, blob)')).toBeLessThan(original.indexOf("transaction.objectStore('cachedFiles').put"));
    await page.goto(`${origin}/#/timeline`);
    await expect.poll(async () => {
      try {
        return await page.evaluate(() => Boolean(navigator.serviceWorker.controller));
      } catch {
        return false;
      }
    }).toBe(true);
    await writeFile(serviceWorkerPath, `${original}\n// playwright-update-${Date.now()}\n`, 'utf8');
    await expect.poll(async () => {
      try {
        return await page.evaluate(async () => {
          const registration = await navigator.serviceWorker.getRegistration('/');
          await registration?.update();
          return true;
        });
      } catch (error) {
        if (/Execution context was destroyed|because of a navigation/u.test(String(error))) return false;
        throw error;
      }
    }).toBe(true);
    await expect(page.getByText('新しいWeb/PWAバージョンを利用できます。')).toBeVisible();
    const update = page.getByRole('button', { name: '更新', exact: true });
    await expect(update).toBeEnabled();
    await Promise.all([page.waitForEvent('load'), update.click()]);
    await expect.poll(() => page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration('/');
      return Boolean(navigator.serviceWorker.controller) && !registration?.waiting;
    })).toBe(true);
  } finally {
    await writeFile(serviceWorkerPath, original, 'utf8');
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
  await expect.poll(async () => {
    try {
      return await page.evaluate(() => Notification.permission);
    } catch {
      return 'navigation-in-progress';
    }
  }).toBe('denied');
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
