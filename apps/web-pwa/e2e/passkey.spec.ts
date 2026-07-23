import { expect, test } from '@playwright/test';

const passkeyOrigin = process.env.PUSHBRIDGE_PASSKEY_ORIGIN;

async function sync(page: import('@playwright/test').Page) {
  const button = page.getByRole('button', { name: '今すぐ同期' });
  await expect(button).toBeEnabled();
  await button.click();
  await expect(button).toBeEnabled();
}

test('Passkey registration, session rotation, one-time device link, logout, and login @desktop', async ({ page, context, browser }) => {
  test.skip(!passkeyOrigin, 'Run through npm run cloudflare:local:passkey-e2e');
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });

  const handle = `passkey_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  await page.goto(`${passkeyOrigin}/#/settings`);
  await expect.poll(async () => {
    try { return await page.evaluate(() => Boolean(navigator.serviceWorker.controller)); }
    catch { return false; }
  }).toBe(true);
  const passkeyCard = page.locator('.passkey-auth').filter({ hasText: 'Passkeyで安全に接続' });
  await expect(passkeyCard).toBeVisible();
  await passkeyCard.getByLabel('Handle').fill(handle);
  await passkeyCard.getByLabel('この端末の名前').fill('Passkey E2E');
  const optionsResponse = page.waitForResponse((response) => response.url().endsWith('/api/v1/auth/passkeys/registration/options'));
  const verifyResponse = page.waitForResponse((response) => response.url().endsWith('/api/v1/auth/passkeys/registration/verify'));
  const rotationResponse = page.waitForResponse((response) => response.url().endsWith('/api/v1/auth/session/rotate'));
  await passkeyCard.getByRole('button', { name: '新規Passkeyを登録' }).click();
  expect((await optionsResponse).status()).toBe(200);
  expect((await verifyResponse).status()).toBe(201);
  expect((await rotationResponse).status()).toBe(200);

  await expect(page.getByRole('heading', { name: 'ブラウザーセッション' })).toBeVisible();
  await expect(page.getByRole('button', { name: '回復キーをコピー' })).toBeVisible();
  expect(await page.evaluate(() => {
    const raw = localStorage.getItem('pushbridge.client-settings.v2');
    const parsed = raw ? JSON.parse(raw) as { authMode?: string } : {};
    return { authMode: parsed.authMode, csrfPresent: Boolean(sessionStorage.getItem('pushbridge.csrf-token.session.v1')) };
  })).toEqual({ authMode: 'cookie', csrfPresent: true });
  await page.goto(`${passkeyOrigin}/#/devices`);
  await expect(page.getByText('1 / 10台', { exact: true })).toBeVisible();
  await expect(page.getByText('現在の端末', { exact: true })).toBeVisible();
  await page.getByLabel('追加端末名').fill('CSRF verified peer');
  await page.getByLabel('追加端末種別').selectOption('pwa');
  await page.getByRole('button', { name: 'リンク', exact: true }).click();
  const tokenBanner = page.getByText('一回限りの端末リンクToken', { exact: true }).locator('..');
  await expect(tokenBanner).toBeVisible();
  const linkToken = await tokenBanner.locator('code').innerText();

  const linkedContext = await browser.newContext();
  const linkedPage = await linkedContext.newPage();
  await linkedPage.goto(`${passkeyOrigin}/#/settings`);
  await expect.poll(async () => {
    try { return await linkedPage.evaluate(() => Boolean(navigator.serviceWorker.controller)); }
    catch { return false; }
  }).toBe(true);
  await linkedPage.getByLabel('端末リンクToken').fill(linkToken);
  await linkedPage.getByRole('button', { name: 'この端末で使用' }).click();
  await expect.poll(async () => {
    try {
      return await linkedPage.evaluate(() => {
        const raw = localStorage.getItem('pushbridge.client-settings.v2');
        return raw ? (JSON.parse(raw) as { authMode?: string }).authMode : undefined;
      });
    } catch { return undefined; }
  }).toBe('bearer');

  const replay = await linkedContext.request.post(`${passkeyOrigin}/api/v1/device-links/redeem`, { data: { link_token: linkToken } });
  expect(replay.status()).toBe(410);

  await page.goto(`${passkeyOrigin}/#/timeline`);
  await sync(page);
  await linkedPage.goto(`${passkeyOrigin}/#/timeline`);
  await sync(linkedPage);
  await expect(page.getByText('API接続中・リアルタイム')).toBeVisible();
  await expect(linkedPage.getByText('API接続中・リアルタイム')).toBeVisible();

  const noteTitle = `E2EE Note ${Date.now()}`;
  const noteBody = 'plaintext must never reach D1';
  await page.goto(`${passkeyOrigin}/#/compose`);
  await page.getByPlaceholder('短い見出し').fill(noteTitle);
  await page.getByPlaceholder('別の端末へ送りたい内容を入力します。').fill(noteBody);
  await page.getByRole('button', { name: '送信する' }).click();
  await page.getByRole('button', { name: /送信済み/ }).click();
  await expect(page.getByRole('heading', { name: noteTitle })).toBeVisible();
  const pushesResponse = await context.request.get(`${passkeyOrigin}/api/v1/pushes?limit=100&include_deleted=true`);
  expect(pushesResponse.status()).toBe(200);
  const pushes = await pushesResponse.json() as { items: Array<Record<string, unknown>> };
  const encryptedNote = pushes.items.find((item) => item.client_guid && item.type === 'note');
  expect(encryptedNote).toMatchObject({ payload_version: 2, payload: null, key_version: 1 });
  expect(JSON.stringify(encryptedNote)).not.toContain(noteTitle);
  expect(JSON.stringify(encryptedNote)).not.toContain(noteBody);
  await expect(linkedPage.getByRole('heading', { name: noteTitle })).toBeVisible();

  const fileName = `phase7-${Date.now()}.txt`;
  const fileBody = 'client encrypted file bytes';
  await page.goto(`${passkeyOrigin}/#/compose`);
  await page.getByRole('button', { name: 'ファイル', exact: true }).click();
  await page.locator('#file-input').setInputFiles({ name: fileName, mimeType: 'text/plain', buffer: Buffer.from(fileBody) });
  await page.getByRole('button', { name: '送信する' }).click();
  await page.getByRole('button', { name: /送信済み/ }).click();
  await expect(page.getByRole('heading', { name: fileName })).toBeVisible();
  const filesResponse = await context.request.get(`${passkeyOrigin}/api/v1/pushes?limit=100&include_deleted=true`);
  const filePush = ((await filesResponse.json()) as { items: Array<Record<string, unknown>> }).items.find((item) => item.type === 'file');
  expect(filePush).toMatchObject({ payload_version: 2, payload: null });
  const fileId = String(filePush?.file_id);
  const metadata = await context.request.get(`${passkeyOrigin}/api/v1/files/${encodeURIComponent(fileId)}`);
  expect(await metadata.json()).toMatchObject({ original_name: 'encrypted.bin', content_type: 'application/octet-stream', e2ee: true });
  await expect(linkedPage.getByRole('heading', { name: fileName })).toBeVisible();
  await expect(linkedPage.getByText('この端末に保存済み').first()).toBeVisible();
  const cachedText = await linkedPage.evaluate(async ({ fileId: id }) => {
    const settings = JSON.parse(localStorage.getItem('pushbridge.client-settings.v2') || '{}') as { storageNamespace?: string };
    const safe = String(settings.storageNamespace || 'default').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(`pushbridge-${safe || 'default'}-v2`); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const cached = await new Promise<{ blob: Blob }>((resolve, reject) => { const request = db.transaction('cachedFiles').objectStore('cachedFiles').get(id); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    db.close();
    return cached.blob.text();
  }, { fileId });
  expect(cachedText).toBe(fileBody);
  await linkedContext.setOffline(true);
  await linkedPage.reload();
  await expect(linkedPage.getByRole('heading', { name: noteTitle })).toBeVisible();
  await expect(linkedPage.getByRole('heading', { name: fileName })).toBeVisible();
  await linkedContext.setOffline(false);
  await linkedContext.close();

  await page.goto(`${passkeyOrigin}/#/settings`);
  await page.getByRole('button', { name: 'ログアウト' }).click();
  await expect(page.getByRole('heading', { name: 'Passkeyで安全に接続' })).toBeVisible();
  const loginCard = page.locator('.passkey-auth').filter({ hasText: 'Passkeyで安全に接続' });
  await loginCard.getByLabel('Handle').fill(handle);
  await loginCard.getByRole('button', { name: 'Passkeyでログイン' }).click();
  await expect(page.getByRole('heading', { name: 'ブラウザーセッション' })).toBeVisible();
});
