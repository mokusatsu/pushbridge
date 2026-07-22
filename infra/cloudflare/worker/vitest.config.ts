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
        },
      },
    })),
  ],
  test: {
    include: ["infra/cloudflare/worker/test/**/*.test.ts"],
    setupFiles: ["./infra/cloudflare/worker/test/setup.ts"],
  },
});
