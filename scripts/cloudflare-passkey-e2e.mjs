#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const windows = process.platform === "win32";
const npm = windows ? process.execPath : "npm";
const npmPrefix = windows ? [join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")] : [];
const npx = windows ? process.execPath : "npx";
const npxPrefix = windows ? [join(dirname(process.execPath), "node_modules", "npm", "bin", "npx-cli.js")] : [];
const origin = "http://localhost:8787";
const config = "infra/cloudflare/wrangler.local.jsonc";
const persistence = ".runtime/wrangler-passkey-e2e";

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { stdio: "inherit", env, shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${args.join(" ")} failed with ${result.status}`);
}

async function waitForWorker(child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode != null) throw new Error(`wrangler dev exited early with ${child.exitCode}`);
    try {
      if ((await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(1000) })).ok) return;
    } catch { /* still starting */ }
    await delay(250);
  }
  throw new Error("wrangler dev did not become ready");
}

run(npm, [...npmPrefix, "run", "worker:build"]);
run(npm, [...npmPrefix, "run", "--prefix", "apps/web-pwa", "build"]);
run(npx, [...npxPrefix, "--yes", "wrangler@4", "d1", "migrations", "apply", "DB", "--local", "--config", config, "--persist-to", persistence]);

const child = spawn(npx, [...npxPrefix, "--yes", "wrangler@4", "dev", "--local", "--config", config, "--persist-to", persistence, "--ip", "127.0.0.1", "--port", "8787", "--var", "REQUIRE_E2EE:true"], {
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
  shell: false,
  detached: !windows,
  windowsHide: true,
});
let logs = "";
for (const stream of [child.stdout, child.stderr]) {
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => { logs = `${logs}${chunk}`.slice(-12000); });
}

try {
  await waitForWorker(child);
  run(npm, [...npmPrefix, "run", "--prefix", "apps/web-pwa", "test:e2e", "--", "e2e/passkey.spec.ts", "--project=desktop"], {
    ...process.env,
    PUSHBRIDGE_PASSKEY_ORIGIN: origin,
  });
  run(npm, [...npmPrefix, "run", "cloudflare:remote:smoke"], {
    ...process.env,
    PUSHBRIDGE_REMOTE_ORIGIN: origin,
  });
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  if (windows && child.pid) {
    spawnSync("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
  } else if (child.pid && child.exitCode == null) {
    try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
  }
}
