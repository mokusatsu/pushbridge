#!/usr/bin/env node

import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repositoryRoot = resolve(import.meta.dirname, '..');
const terraformBin = process.env.TERRAFORM_BIN ?? 'terraform';
const apiToken = process.env.CLOUDFLARE_API_TOKEN;
const expectedCron = process.env.PUSHBRIDGE_EXPECTED_CRON ?? '17 3 * * *';

if (!apiToken) throw new Error('Set CLOUDFLARE_API_TOKEN.');

const terraform = spawnSync(
  terraformBin,
  ['-chdir=infra/cloudflare/infra', 'output', '-json'],
  {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
if (terraform.status !== 0) {
  throw new Error('Terraform outputs are unavailable; diagnose the remote state before querying Cron evidence.');
}
const outputs = JSON.parse(terraform.stdout);
const accountId = outputs.account_id?.value;
const scriptName = outputs.worker_name?.value;
if (!accountId || !scriptName) throw new Error('Terraform account_id or worker_name output is missing.');

const to = new Date();
const from = new Date(to.getTime() - 6.9 * 24 * 60 * 60 * 1000);
const query = `query Scheduled($accountTag: string, $from: Time, $to: Time, $scriptName: string) {
  viewer {
    accounts(filter: {accountTag: $accountTag}) {
      workersInvocationsScheduled(
        limit: 100
        filter: {scriptName: $scriptName, datetime_geq: $from, datetime_leq: $to}
        orderBy: [datetime_DESC]
      ) {
        datetime
        scheduledDatetime
        cron
        scriptName
        status
        cpuTimeUs
      }
    }
  }
}`;
const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
  method: 'POST',
  headers: {
    authorization: `Bearer ${apiToken}`,
    'content-type': 'application/json',
  },
  body: JSON.stringify({
    query,
    variables: {
      accountTag: accountId,
      from: from.toISOString(),
      to: to.toISOString(),
      scriptName,
    },
  }),
  signal: AbortSignal.timeout(30_000),
});
if (!response.ok) throw new Error(`Cloudflare GraphQL returned HTTP ${response.status}.`);
const payload = await response.json();
if (payload.errors?.length) {
  throw new Error(`Cloudflare GraphQL rejected the scheduled-invocation query (${payload.errors.length} error(s)).`);
}
const rows = payload.data?.viewer?.accounts?.[0]?.workersInvocationsScheduled ?? [];
const successful = rows.filter((row) => row.cron === expectedCron && row.status === 'success');
if (successful.length === 0) {
  throw new Error(`No successful ${expectedCron} invocation was found in the available seven-day window.`);
}
const latest = successful[0];
console.log([
  'Cloudflare Cron evidence verified:',
  `schedule=${latest.cron}`,
  `status=${latest.status}`,
  `scheduled_at=${latest.scheduledDatetime}`,
  `cpu_us=${latest.cpuTimeUs}`,
  `matching_successes=${successful.length}`,
].join(' '));
