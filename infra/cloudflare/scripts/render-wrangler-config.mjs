#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const root = join(scriptDirectory, "..");
const generatedDirectory = join(root, ".generated");
const outputPath = join(generatedDirectory, "wrangler.migrations.jsonc");

const terraform = spawnSync(
  process.env.TERRAFORM_BIN ?? "terraform",
  ["-chdir=infra", "output", "-json"],
  {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  },
);

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
    throw new Error(`Terraform output ${name} is missing. Run terraform apply first.`);
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
