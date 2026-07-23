import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['apps/chromium-extension/src/**/*.test.ts'],
  },
});
