import { defineConfig, devices } from '@playwright/test';

const requestedChannel = process.env.PUSHBRIDGE_PLAYWRIGHT_CHANNEL;
const localChannel = requestedChannel === 'bundled'
  ? undefined
  : requestedChannel || (process.platform === 'win32' && !process.env.CI ? 'msedge' : undefined);

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI
    ? [['github'], ['list']]
    : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:8766',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    channel: localChannel,
  },
  projects: [
    { name: 'desktop', grep: /@desktop/, use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', grep: /@mobile/, use: { ...devices['Pixel 7'], reducedMotion: 'reduce' } },
  ],
  webServer: [
    {
      command: 'node tools/e2e-relaymock.mjs',
      url: 'http://127.0.0.1:8765/health',
      timeout: 60_000,
      reuseExistingServer: false,
    },
    {
      command: 'npm run build && npm run serve:local',
      url: 'http://127.0.0.1:8766',
      timeout: 120_000,
      reuseExistingServer: false,
      env: {
        LOCAL_GATEWAY_PORT: '8766',
        API_PROXY_TARGET: 'http://127.0.0.1:8765',
      },
    },
  ],
});
