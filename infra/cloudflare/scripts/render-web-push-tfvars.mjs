#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(scriptDirectory, "..", "..", "..");
const envPath = process.env.PUSHBRIDGE_ENV_FILE ?? join(repositoryRoot, "env.txt");
const outputPath = join(repositoryRoot, "infra", "cloudflare", "infra", "web-push.auto.tfvars");

function parseAssignments(source) {
  const values = new Map();
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
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
const required = ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT", "WEB_PUSH_DATA_KEY"];
const missing = required.filter((name) => !values.get(name));
if (missing.length > 0) {
  console.error(`Missing Web Push variables in env.txt: ${missing.join(", ")}`);
  process.exit(1);
}

if (!/^[A-Za-z0-9_-]{87}$/.test(values.get("VAPID_PUBLIC_KEY"))) throw new Error("VAPID_PUBLIC_KEY must encode a 65-byte P-256 public key");
if (!/^[A-Za-z0-9_-]{43}$/.test(values.get("VAPID_PRIVATE_KEY"))) throw new Error("VAPID_PRIVATE_KEY must encode a 32-byte P-256 private key");
if (!/^(mailto:|https:\/\/)/.test(values.get("VAPID_SUBJECT"))) throw new Error("VAPID_SUBJECT must be a mailto or HTTPS URI");
if (!/^[A-Za-z0-9_-]{43}$/.test(values.get("WEB_PUSH_DATA_KEY"))) throw new Error("WEB_PUSH_DATA_KEY must encode a 32-byte data key");
const publicBytes = Buffer.from(values.get("VAPID_PUBLIC_KEY"), "base64url");
const privateBytes = Buffer.from(values.get("VAPID_PRIVATE_KEY"), "base64url");
const dataBytes = Buffer.from(values.get("WEB_PUSH_DATA_KEY"), "base64url");
if (publicBytes.length !== 65 || publicBytes[0] !== 4 || privateBytes.length !== 32 || dataBytes.length !== 32) {
  throw new Error("Web Push key material has an invalid decoded length or public-key format");
}
const privateKey = createPrivateKey({
  key: {
    kty: "EC",
    crv: "P-256",
    x: publicBytes.subarray(1, 33).toString("base64url"),
    y: publicBytes.subarray(33).toString("base64url"),
    d: privateBytes.toString("base64url"),
  },
  format: "jwk",
});
const derivedPublic = createPublicKey(privateKey).export({ format: "jwk" });
if (derivedPublic.x !== publicBytes.subarray(1, 33).toString("base64url")
  || derivedPublic.y !== publicBytes.subarray(33).toString("base64url")) {
  throw new Error("VAPID public and private keys do not form a pair");
}

const body = [
  "# Generated from ignored env.txt. Do not commit this file.",
  `vapid_public_key  = ${JSON.stringify(values.get("VAPID_PUBLIC_KEY"))}`,
  `vapid_private_key = ${JSON.stringify(values.get("VAPID_PRIVATE_KEY"))}`,
  `vapid_subject     = ${JSON.stringify(values.get("VAPID_SUBJECT"))}`,
  `web_push_data_key = ${JSON.stringify(values.get("WEB_PUSH_DATA_KEY"))}`,
  "",
].join("\n");

writeFileSync(outputPath, body, { mode: 0o600 });
console.log(outputPath);
