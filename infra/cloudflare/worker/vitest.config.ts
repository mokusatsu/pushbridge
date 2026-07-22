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
        },
      },
    })),
  ],
  test: {
    include: ["infra/cloudflare/worker/test/**/*.test.ts"],
    setupFiles: ["./infra/cloudflare/worker/test/setup.ts"],
  },
});
