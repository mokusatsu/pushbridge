#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const root = join(scriptDirectory, "..");
const terraformDirectory = join(root, "infra");
const terraformBin = process.env.TERRAFORM_BIN ?? "terraform";

function run(args) {
  return spawnSync(terraformBin, ["-chdir=infra", ...args], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function oneLine(value) {
  return String(value ?? "").trim().replaceAll(/\s+/g, " ");
}

console.log(`terraform_directory=${terraformDirectory}`);

const metadataPath = join(terraformDirectory, ".terraform", "terraform.tfstate");
try {
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  console.log(`backend_type=${metadata.backend?.type ?? "unknown"}`);
  console.log(`backend_bucket=${metadata.backend?.config?.bucket ?? "unknown"}`);
  console.log(`backend_key=${metadata.backend?.config?.key ?? "unknown"}`);
} catch {
  console.log("backend_metadata=missing_or_unreadable");
}

const workspace = run(["workspace", "show"]);
console.log(`workspace=${workspace.status === 0 ? oneLine(workspace.stdout) : "unavailable"}`);

const state = run(["state", "pull"]);
const resources = run(["state", "list"]);
let stateDocument;
try {
  stateDocument = JSON.parse(state.stdout);
} catch {
  stateDocument = undefined;
}
if (state.status !== 0 || resources.status !== 0 || !stateDocument?.lineage) {
  const detail = `${state.stderr ?? ""}${resources.stderr ?? ""}`;
  const classification = !stateDocument?.lineage || /No state file was found/i.test(detail)
    ? "backend_reachable_state_object_missing"
    : "backend_or_credentials_unavailable";
  console.log(`classification=${classification}`);
  if (detail.trim()) console.error(oneLine(detail));
  process.exit(2);
}

const resourceNames = resources.status === 0
  ? resources.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  : [];
console.log(`state_resources=${resourceNames.length}`);

const output = run(["output", "-json"]);
if (output.status !== 0) {
  console.log("classification=state_present_outputs_unreadable");
  console.error(oneLine(output.stderr));
  process.exit(3);
}

let outputValues = {};
try {
  outputValues = JSON.parse(output.stdout);
} catch {
  console.log("classification=state_present_outputs_invalid_json");
  process.exit(3);
}

const outputNames = Object.keys(outputValues).sort();
const requiredOutputNames = [
  "account_id",
  "compatibility_date",
  "worker_name",
  "d1_database_name",
  "d1_database_id",
];
const unavailableOutputNames = requiredOutputNames.filter((name) => {
  const value = outputValues[name]?.value;
  return value === null || value === undefined || value === "";
});

console.log(`output_names=${outputNames.join(",")}`);
console.log(`required_outputs_unavailable=${unavailableOutputNames.join(",")}`);
console.log(`classification=${unavailableOutputNames.length === 0 ? "state_and_required_outputs_available" : "state_present_required_outputs_missing"}`);
