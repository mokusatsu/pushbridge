import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      main: "./infra/cloudflare/worker/src/index.ts",
      wrangler: { configPath: "./infra/cloudflare/wrangler.local.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations("./infra/cloudflare/worker/migrations"),
          VAPID_PUBLIC_KEY: "BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          WEB_PUSH_DATA_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          PASSKEY_RP_ID: "worker.test",
          PASSKEY_EXPECTED_ORIGINS: "[\"https://worker.test\"]",
          PASSKEY_RP_NAME: "Pushbridge Test",
          REQUIRE_PASSKEY_TURNSTILE: "false",
          TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
          ACCOUNT_AUTH_RATE_LIMIT: "20",
          DEVICE_MUTATION_RATE_LIMIT: "300",
        },
      },
    })),
  ],
  test: {
    include: ["infra/cloudflare/worker/test/**/*.test.ts"],
    setupFiles: ["./infra/cloudflare/worker/test/setup.ts"],
  },
});
