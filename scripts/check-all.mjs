#!/usr/bin/env node

import { existsSync, readdirSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const windows = process.platform === "win32";
const npm = windows ? process.execPath : "npm";
const npmPrefix = windows
  ? [join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")]
  : [];

function run(command, args, options = {}) {
  console.log(`> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
    shell: false,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function executable(candidates) {
  for (const candidate of candidates) {
    if ((candidate.includes("/") || candidate.includes("\\")) && !existsSync(candidate)) continue;
    const probe = spawnSync(candidate, ["--version"], {
      encoding: "utf8",
      shell: windows && candidate.toLowerCase().endsWith(".cmd"),
    });
    if (!probe.error && probe.status === 0) return candidate;
  }
  return undefined;
}

const python = executable([
  process.env.PYTHON_BIN,
  windows ? join(".runtime", "venv", "Scripts", "python.exe") : join(".runtime", "venv", "bin", "python"),
  "python",
  "python3",
].filter(Boolean));
if (!python) throw new Error("Python was not found. Set PYTHON_BIN or create .runtime/venv.");

const terraform = executable([process.env.TERRAFORM_BIN, "terraform"].filter(Boolean));
if (!terraform) throw new Error("Terraform was not found. Set TERRAFORM_BIN to the executable path.");

run(python, ["scripts/verify-contract.py"]);
run(python, ["-m", "pytest", "services/relaymock"], {
  env: {
    ...process.env,
    PYTHONPATH: [join(process.cwd(), "services", "relaymock"), process.env.PYTHONPATH].filter(Boolean).join(delimiter),
  },
});
run(npm, [...npmPrefix, "--prefix", "apps/web-pwa", "run", "check"]);
run(npm, [...npmPrefix, "run", "worker:check"]);
const terraformFiles = readdirSync(join(process.cwd(), "infra", "cloudflare", "infra"))
  .filter((name) => name.endsWith(".tf") && name !== "backend.tf")
  .sort();
run(terraform, ["-chdir=infra/cloudflare/infra", "fmt", "-check", ...terraformFiles]);
run(terraform, ["-chdir=infra/cloudflare/infra", "validate"]);
run(process.execPath, ["--check", "infra/cloudflare/app/dist/sw.js"]);
run(process.execPath, ["--check", "infra/cloudflare/scripts/render-wrangler-config.mjs"]);
run(process.execPath, ["--check", "infra/cloudflare/scripts/generate-web-push-credentials.mjs"]);
run(process.execPath, ["--check", "infra/cloudflare/scripts/render-web-push-tfvars.mjs"]);
run(process.execPath, ["--check", "infra/cloudflare/scripts/diagnose-terraform-state.mjs"]);
run(process.execPath, ["--check", "scripts/cloudflare-local-smoke.mjs"]);
run(process.execPath, ["--check", "scripts/cloudflare-passkey-e2e.mjs"]);
run(process.execPath, ["--check", "scripts/cloudflare-remote-smoke.mjs"]);
run(process.execPath, ["--check", "scripts/update-phase7-openapi.mjs"]);
run(process.execPath, ["--check", "apps/web-pwa/tools/e2e-relaymock.mjs"]);
run(process.execPath, ["--check", "apps/web-pwa/tools/generate-browser-evidence.mjs"]);
run(process.execPath, ["--check", "apps/web-pwa/tools/check-browser-evidence.mjs"]);
run(npm, [...npmPrefix, "--prefix", "apps/web-pwa", "run", "test:e2e", "--", "--list"]);

console.log("All repository checks passed.");
