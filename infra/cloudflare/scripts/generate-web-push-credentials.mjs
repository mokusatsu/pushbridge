#!/usr/bin/env node

import { generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(scriptDirectory, "..", "..", "..");
const envPath = process.env.PUSHBRIDGE_ENV_FILE ?? join(repositoryRoot, "env.txt");
const subjectArgument = process.argv.find((argument) => argument.startsWith("--subject="));
const subject = subjectArgument?.slice("--subject=".length) ?? process.env.PUSHBRIDGE_VAPID_SUBJECT;
const required = ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT", "WEB_PUSH_DATA_KEY"];

if (!subject || !/^(mailto:|https:\/\/)/.test(subject)) {
  console.error("Pass --subject=mailto:operator@example.com or --subject=https://operator.example.");
  process.exit(1);
}

const existing = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
const existingNames = new Set();
for (const line of existing.split(/\r?\n/)) {
  const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
  if (match) existingNames.add(match[1]);
}
const conflicts = required.filter((name) => existingNames.has(name));
if (conflicts.length > 0) {
  console.error(`Refusing to overwrite existing Web Push variables in env.txt: ${conflicts.join(", ")}`);
  process.exit(1);
}

const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const jwk = privateKey.export({ format: "jwk" });
if (!jwk.x || !jwk.y || !jwk.d) throw new Error("Node.js did not export a complete P-256 key pair");
const publicKey = Buffer.concat([
  Buffer.from([4]),
  Buffer.from(jwk.x, "base64url"),
  Buffer.from(jwk.y, "base64url"),
]).toString("base64url");
const block = [
  "# Pushbridge dev Web Push credentials. Generated locally; never commit.",
  `VAPID_PUBLIC_KEY=${JSON.stringify(publicKey)}`,
  `VAPID_PRIVATE_KEY=${JSON.stringify(jwk.d)}`,
  `VAPID_SUBJECT=${JSON.stringify(subject)}`,
  `WEB_PUSH_DATA_KEY=${JSON.stringify(randomBytes(32).toString("base64url"))}`,
  "",
].join("\n");
const separator = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
const temporaryPath = `${envPath}.web-push-${process.pid}.tmp`;
try {
  writeFileSync(temporaryPath, `${existing}${separator}${block}`, { mode: 0o600, flag: "wx" });
  renameSync(temporaryPath, envPath);
} finally {
  if (existsSync(temporaryPath)) rmSync(temporaryPath);
}
console.log(`Generated four Web Push variables in ${envPath} without printing their values.`);
