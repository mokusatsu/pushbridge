#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(scriptDirectory, "..", "..", "..");
const envPath = process.env.PUSHBRIDGE_ENV_FILE ?? join(repositoryRoot, "env.txt");
const outputPath = join(repositoryRoot, "infra", "cloudflare", "infra", "r2-direct.auto.tfvars");

function parseAssignments(source) {
  const values = new Map();
  for (const line of source.split(/\r?\n/u)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/u);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values.set(match[1], value);
  }
  return values;
}

const values = parseAssignments(readFileSync(envPath, "utf8"));
const accessKeyId = values.get("R2_S3_ACCESS_KEY_ID");
const secretAccessKey = values.get("R2_S3_SECRET_ACCESS_KEY");
const missing = [
  !accessKeyId && "R2_S3_ACCESS_KEY_ID",
  !secretAccessKey && "R2_S3_SECRET_ACCESS_KEY",
].filter(Boolean);
if (missing.length > 0) {
  throw new Error(`Missing dedicated R2 variables in env.txt: ${missing.join(", ")}`);
}
if (accessKeyId.length < 16 || secretAccessKey.length < 32) {
  throw new Error("Dedicated R2 credentials have an invalid length");
}
if (accessKeyId === values.get("AWS_ACCESS_KEY_ID") || secretAccessKey === values.get("AWS_SECRET_ACCESS_KEY")) {
  throw new Error("Refusing to reuse Terraform remote-backend credentials for application R2 presigning");
}

const body = [
  "# Generated from ignored env.txt. Do not commit this file.",
  "# These credentials must be restricted to the Pushbridge file bucket.",
  `r2_s3_access_key_id     = ${JSON.stringify(accessKeyId)}`,
  `r2_s3_secret_access_key = ${JSON.stringify(secretAccessKey)}`,
  "",
].join("\n");

writeFileSync(outputPath, body, { mode: 0o600 });
console.log(outputPath);
