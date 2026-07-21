#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const root = join(scriptDirectory, "..");
const generatedDirectory = join(root, ".generated");
const outputPath = join(generatedDirectory, "wrangler.migrations.jsonc");
const terraformBin = process.env.TERRAFORM_BIN ?? "terraform";

function runTerraform(args) {
  return spawnSync(terraformBin, ["-chdir=infra", ...args], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

const state = runTerraform(["state", "pull"]);
const stateList = runTerraform(["state", "list"]);
let stateDocument;
try {
  stateDocument = JSON.parse(state.stdout);
} catch {
  stateDocument = undefined;
}
if (state.status !== 0 || stateList.status !== 0 || !stateDocument?.lineage) {
  const detail = `${state.stderr ?? ""}${stateList.stderr ?? ""}`;
  if (!stateDocument?.lineage || /No state file was found/i.test(detail)) {
    console.error([
      "Terraform backend is reachable, but the selected backend key/workspace has no state.",
      "Verify terraform init -reconfigure -backend-config=backend-r2.hcl and terraform workspace show.",
      "Do not run terraform apply until existing Cloudflare resources have been reconciled or imported.",
    ].join("\n"));
  } else {
    process.stderr.write(detail || "terraform state pull failed\n");
  }
  process.exit(state.status ?? 1);
}

const terraform = runTerraform(["output", "-json"]);

if (terraform.status !== 0) {
  process.stderr.write(terraform.stderr || "terraform output failed\n");
  process.exit(terraform.status ?? 1);
}

let outputs;
try {
  outputs = JSON.parse(terraform.stdout);
} catch (error) {
  console.error("Could not parse terraform output -json:", error);
  process.exit(1);
}

function requiredOutput(name) {
  const value = outputs[name]?.value;
  if (value === undefined || value === null || value === "") {
    throw new Error(
      `Terraform output ${name} is missing from an existing state. `
      + "The state may be stale, connected to the wrong backend/workspace, or predate outputs.tf; inspect a refresh-only plan before changing it.",
    );
  }
  return value;
}

let config;
try {
  config = {
    account_id: requiredOutput("account_id"),
    name: requiredOutput("worker_name"),
    compatibility_date: requiredOutput("compatibility_date"),
    d1_databases: [
      {
        binding: "DB",
        database_name: requiredOutput("d1_database_name"),
        database_id: requiredOutput("d1_database_id"),
        migrations_dir: "../worker/migrations",
      },
    ],
  };
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

mkdirSync(generatedDirectory, { recursive: true });
const body = [
  "// Generated from Terraform outputs for D1 migration commands only.",
  "// Do not use this file to deploy the Worker; Terraform owns deployment.",
  JSON.stringify(config, null, 2),
  "",
].join("\n");
writeFileSync(outputPath, body, { mode: 0o600 });
console.log(outputPath);
