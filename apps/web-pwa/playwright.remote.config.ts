import { defineConfig, devices } from '@playwright/test';

const origin = process.env.PUSHBRIDGE_REMOTE_ORIGIN ?? 'https://pushbridge-dev.mokusatsu.workers.dev';
const accessClientId = process.env.CF_ACCESS_CLIENT_ID;
const accessClientSecret = process.env.CF_ACCESS_CLIENT_SECRET;

export default defineConfig({
  testDir: './e2e',
  testMatch: 'remote.spec.ts',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: origin,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
    extraHTTPHeaders: accessClientId && accessClientSecret ? {
      'CF-Access-Client-Id': accessClientId,
      'CF-Access-Client-Secret': accessClientSecret,
    } : {},
  },
  projects: [{ name: 'remote-desktop', use: { ...devices['Desktop Chrome'] } }],
});
