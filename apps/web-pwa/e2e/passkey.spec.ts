import { expect, test } from '@playwright/test';

const passkeyOrigin = process.env.PUSHBRIDGE_PASSKEY_ORIGIN;

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
  await linkedContext.close();

  await page.goto(`${passkeyOrigin}/#/settings`);
  await page.getByRole('button', { name: 'ログアウト' }).click();
  await expect(page.getByRole('heading', { name: 'Passkeyで安全に接続' })).toBeVisible();
  const loginCard = page.locator('.passkey-auth').filter({ hasText: 'Passkeyで安全に接続' });
  await loginCard.getByLabel('Handle').fill(handle);
  await loginCard.getByRole('button', { name: 'Passkeyでログイン' }).click();
  await expect(page.getByRole('heading', { name: 'ブラウザーセッション' })).toBeVisible();
});
