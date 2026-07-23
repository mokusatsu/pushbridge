#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from '@playwright/test';

const extensionPath = resolve('apps/chromium-extension/dist');
const output = resolve('apps/chromium-extension/store/screenshots');
const profile = await mkdtemp(join(tmpdir(), 'pushbridge-extension-store-'));
let context;

try {
  await mkdir(output, { recursive: true });
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  let worker = context.serviceWorkers()[0];
  worker ??= await context.waitForEvent('serviceworker', { timeout: 15_000 });
  const extensionId = new URL(worker.url()).hostname;
  assert.match(extensionId, /^[a-p]{32}$/u);

  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.locator('#status').filter({ hasText: '未接続' }).waitFor();
  await page.screenshot({ path: join(output, 'popup-unlinked-1280x800.png') });
  await page.locator('#send-file').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, 'popup-file-unlinked-1280x800.png') });

  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await page.locator('#status').filter({ hasText: '未接続' }).waitFor();
  await page.screenshot({ path: join(output, 'options-unlinked-1280x800.png') });
  assert.deepEqual(errors, []);
  console.log('Chromium extension Store evidence captured: 3 actual 1280x800 screenshots with no linked account data.');
} finally {
  await context?.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
