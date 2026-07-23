#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from '@playwright/test';

const extensionPath = resolve('apps/chromium-extension/dist');
const profile = await mkdtemp(join(tmpdir(), 'pushbridge-extension-'));
let context;

try {
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });
  let worker = context.serviceWorkers()[0];
  worker ??= await context.waitForEvent('serviceworker', { timeout: 15_000 });
  const extensionId = new URL(worker.url()).hostname;
  assert.match(extensionId, /^[a-p]{32}$/u);

  const manifest = await worker.evaluate(() => chrome.runtime.getManifest());
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ['activeTab', 'alarms', 'contextMenus', 'notifications', 'storage']);
  assert.equal(JSON.stringify(manifest).includes('<all_urls>'), false);
  assert.equal(manifest.content_scripts, undefined);

  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.locator('#status').filter({ hasText: '未接続' }).waitFor();
  assert.match(await page.locator('#status').innerText(), /未接続/u);
  assert.equal(await page.locator('#target option').first().innerText(), '自分のほかの全端末');

  await page.goto(`chrome-extension://${extensionId}/options.html`);
  assert.equal(await page.locator('#origin').innerText(), 'https://pushbridge-dev.mokusatsu.workers.dev');
  await page.locator('#status').filter({ hasText: '未接続' }).waitFor();
  assert.match(await page.locator('#status').innerText(), /未接続/u);
  assert.deepEqual(pageErrors, []);

  console.log('Chromium extension load E2E passed: MV3 service worker, minimal permissions, popup, and options.');
} finally {
  await context?.close();
  await rm(profile, { recursive: true, force: true });
}
