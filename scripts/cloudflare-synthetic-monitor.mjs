#!/usr/bin/env node

import { performance } from 'node:perf_hooks';

const origin = (process.env.PUSHBRIDGE_REMOTE_ORIGIN
  ?? 'https://pushbridge-dev.mokusatsu.workers.dev').replace(/\/$/u, '');
const accessClientId = process.env.CF_ACCESS_CLIENT_ID;
const accessClientSecret = process.env.CF_ACCESS_CLIENT_SECRET;
const maxLatencyMs = Number(process.env.PUSHBRIDGE_MONITOR_MAX_LATENCY_MS ?? 5_000);

if (Boolean(accessClientId) !== Boolean(accessClientSecret)) {
  throw new Error('Set both CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET, or neither.');
}
if (!Number.isFinite(maxLatencyMs) || maxLatencyMs < 100 || maxLatencyMs > 30_000) {
  throw new Error('PUSHBRIDGE_MONITOR_MAX_LATENCY_MS must be from 100 through 30000.');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function check(path, validate) {
  const started = performance.now();
  const response = await fetch(`${origin}${path}`, {
    headers: accessClientId && accessClientSecret ? {
      'CF-Access-Client-Id': accessClientId,
      'CF-Access-Client-Secret': accessClientSecret,
    } : {},
    signal: AbortSignal.timeout(15_000),
  });
  const elapsedMs = Math.round(performance.now() - started);
  const contentType = response.headers.get('content-type') ?? '';
  assert(contentType.includes('json'), `${path} did not return JSON`);
  const body = await response.json();
  assert(response.status === 200, `${path} returned HTTP ${response.status}`);
  assert(elapsedMs <= maxLatencyMs, `${path} exceeded ${maxLatencyMs} ms (${elapsedMs} ms)`);
  validate(body);
  return elapsedMs;
}

const healthMs = await check('/healthz', (body) => {
  assert(body?.ok === true && body?.service === 'pushbridge', 'healthz response is invalid');
});
const bootstrapMs = await check('/api/bootstrap/status', (body) => {
  assert(body?.ok === true && body?.bootstrap === false, 'bootstrap status is invalid');
  assert(body?.bindings?.d1 === true && body?.bindings?.r2 === true && body?.bindings?.durableObject === true,
    'required Cloudflare bindings are unavailable');
});
const capabilitiesMs = await check('/api/v1/system/capabilities', (body) => {
  assert(body?.features?.device_registration === true, 'device registration capability is unavailable');
  assert(body?.features?.e2ee === true, 'E2EE capability is unavailable');
  assert(body?.features?.realtime === true, 'realtime capability is unavailable');
  assert(body?.features?.web_push_delivery === true, 'Web Push delivery capability is unavailable');
  assert(body?.features?.direct_upload === false, 'server-ticket PoC must not advertise direct upload');
});

console.log(
  'Cloudflare synthetic monitor passed:'
  + ` health_ms=${healthMs}`
  + ` bootstrap_ms=${bootstrapMs}`
  + ` capabilities_ms=${capabilitiesMs}`
  + ` threshold_ms=${maxLatencyMs}`,
);
