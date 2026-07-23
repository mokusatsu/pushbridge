#!/usr/bin/env node

import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repositoryRoot = resolve(import.meta.dirname, '..');
const terraformBin = process.env.TERRAFORM_BIN ?? 'terraform';
const apiToken = process.env.CLOUDFLARE_API_TOKEN;
if (!apiToken) throw new Error('Set CLOUDFLARE_API_TOKEN.');

const terraform = spawnSync(
  terraformBin,
  ['-chdir=infra/cloudflare/infra', 'output', '-json'],
  { cwd: repositoryRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
);
if (terraform.status !== 0) {
  throw new Error('Terraform outputs are unavailable; diagnose the remote state before querying metrics.');
}
const outputs = JSON.parse(terraform.stdout);
const accountId = outputs.account_id?.value;
const scriptName = outputs.worker_name?.value;
const databaseId = outputs.d1_database_id?.value;
const bucketName = outputs.r2_bucket_name?.value;
if (!accountId || !scriptName || !databaseId || !bucketName) {
  throw new Error('Required Terraform resource outputs are missing.');
}

const to = new Date();
const from = new Date(to.getTime() - 24 * 60 * 60 * 1000);
const query = `query Metrics(
  $accountTag: string
  $from: Time
  $to: Time
  $scriptName: string
  $bucketName: string
) {
  viewer {
    accounts(filter: {accountTag: $accountTag}) {
      workersInvocationsAdaptive(
        limit: 100
        filter: {scriptName: $scriptName, datetime_geq: $from, datetime_leq: $to}
      ) {
        sum { requests errors subrequests }
        quantiles { cpuTimeP50 cpuTimeP99 }
        dimensions { status }
      }
      r2StorageAdaptiveGroups(
        limit: 1
        filter: {bucketName: $bucketName, datetime_geq: $from, datetime_leq: $to}
        orderBy: [datetime_DESC]
      ) {
        max { objectCount uploadCount payloadSize metadataSize }
        dimensions { datetime }
      }
      r2OperationsAdaptiveGroups(
        limit: 100
        filter: {bucketName: $bucketName, datetime_geq: $from, datetime_leq: $to}
      ) {
        sum { requests }
        dimensions { actionStatus }
      }
    }
  }
}`;
const headers = {
  authorization: `Bearer ${apiToken}`,
  'content-type': 'application/json',
};

async function fetchWithRateLimitRetry(url, init) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const response = await fetch(url, init);
    if (response.status !== 429 || attempt === 5) return response;
    await response.body?.cancel();
    const retryAfter = Number(response.headers.get('retry-after'));
    const delay = Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(30_000, retryAfter * 1000)
      : Math.min(16_000, 1000 * 2 ** attempt);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, delay));
  }
  throw new Error('Cloudflare rate-limit retry loop ended unexpectedly.');
}

const [analyticsResponse, databaseResponse] = await Promise.all([
  fetchWithRateLimitRetry('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      query,
      variables: {
        accountTag: accountId,
        from: from.toISOString(),
        to: to.toISOString(),
        scriptName,
        bucketName,
      },
    }),
    signal: AbortSignal.timeout(30_000),
  }),
  fetchWithRateLimitRetry(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}`, {
    headers: { authorization: `Bearer ${apiToken}` },
    signal: AbortSignal.timeout(30_000),
  }),
]);
if (!analyticsResponse.ok) throw new Error(`Cloudflare GraphQL returned HTTP ${analyticsResponse.status}.`);
if (!databaseResponse.ok) throw new Error(`Cloudflare D1 API returned HTTP ${databaseResponse.status}.`);
const analytics = await analyticsResponse.json();
const database = await databaseResponse.json();
if (analytics.errors?.length) {
  throw new Error(`Cloudflare GraphQL rejected the metrics query (${analytics.errors.length} error(s)).`);
}
if (!database.success) throw new Error('Cloudflare D1 API did not return a successful result.');

const account = analytics.data?.viewer?.accounts?.[0];
const workerRows = account?.workersInvocationsAdaptive ?? [];
const worker = workerRows.reduce((summary, row) => ({
  requests: summary.requests + Number(row.sum?.requests ?? 0),
  errors: summary.errors + Number(row.sum?.errors ?? 0),
  subrequests: summary.subrequests + Number(row.sum?.subrequests ?? 0),
  cpuP50: Math.max(summary.cpuP50, Number(row.quantiles?.cpuTimeP50 ?? 0)),
  cpuP99: Math.max(summary.cpuP99, Number(row.quantiles?.cpuTimeP99 ?? 0)),
}), { requests: 0, errors: 0, subrequests: 0, cpuP50: 0, cpuP99: 0 });
const r2 = account?.r2StorageAdaptiveGroups?.[0]?.max ?? {};
const r2Operations = (account?.r2OperationsAdaptiveGroups ?? []).reduce(
  (count, row) => count + Number(row.sum?.requests ?? 0),
  0,
);

console.log([
  'Cloudflare 24h metrics verified:',
  `worker_requests=${worker.requests}`,
  `worker_errors=${worker.errors}`,
  `worker_subrequests=${worker.subrequests}`,
  `worker_cpu_p50_us=${worker.cpuP50}`,
  `worker_cpu_p99_us=${worker.cpuP99}`,
  `d1_bytes=${Number(database.result?.file_size ?? 0)}`,
  `d1_tables=${Number(database.result?.num_tables ?? 0)}`,
  `r2_objects=${Number(r2.objectCount ?? 0)}`,
  `r2_payload_bytes=${Number(r2.payloadSize ?? 0)}`,
  `r2_metadata_bytes=${Number(r2.metadataSize ?? 0)}`,
  `r2_pending_uploads=${Number(r2.uploadCount ?? 0)}`,
  `r2_operations=${r2Operations}`,
].join(' '));
