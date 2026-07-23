#!/usr/bin/env node

import { performance } from 'node:perf_hooks';
import { randomBytes } from 'node:crypto';

const origin = (process.env.PUSHBRIDGE_REMOTE_ORIGIN
  ?? 'https://pushbridge-dev.mokusatsu.workers.dev').replace(/\/$/u, '');
const accessClientId = process.env.CF_ACCESS_CLIENT_ID;
const accessClientSecret = process.env.CF_ACCESS_CLIENT_SECRET;
const healthRequests = boundedInteger('PUSHBRIDGE_LOAD_HEALTH_REQUESTS', 100, 1, 500);
const apiRequests = boundedInteger('PUSHBRIDGE_LOAD_API_REQUESTS', 100, 1, 250);
const replayRequests = boundedInteger('PUSHBRIDGE_LOAD_REPLAY_REQUESTS', 50, 2, 100);
const concurrency = boundedInteger('PUSHBRIDGE_LOAD_CONCURRENCY', 10, 1, 25);
const encoder = new TextEncoder();

if (Boolean(accessClientId) !== Boolean(accessClientSecret)) {
  throw new Error('Set both CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET, or neither.');
}

function boundedInteger(name, fallback, minimum, maximum) {
  const value = process.env[name] == null ? fallback : Number(process.env[name]);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function accessHeaders(headers = {}) {
  return {
    ...headers,
    ...(accessClientId && accessClientSecret ? {
      'CF-Access-Client-Id': accessClientId,
      'CF-Access-Client-Secret': accessClientSecret,
    } : {}),
  };
}

async function request(path, init = {}) {
  const started = performance.now();
  const response = await fetch(`${origin}${path}`, {
    ...init,
    headers: accessHeaders(init.headers),
    signal: init.signal ?? AbortSignal.timeout(15_000),
  });
  const elapsedMs = performance.now() - started;
  const contentType = response.headers.get('content-type') ?? '';
  const body = contentType.includes('json') ? await response.json() : await response.text();
  return { response, body, elapsedMs };
}

async function mapConcurrent(count, limit, operation) {
  const results = new Array(count);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(count, limit) }, async () => {
    while (next < count) {
      const index = next;
      next += 1;
      results[index] = await operation(index);
    }
  }));
  return results;
}

function percentile(values, fraction) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.floor((ordered.length - 1) * fraction))];
}

function metric(results) {
  const times = results.map((result) => result.elapsedMs);
  return {
    count: results.length,
    p50: Math.round(percentile(times, 0.5)),
    p95: Math.round(percentile(times, 0.95)),
    p99: Math.round(percentile(times, 0.99)),
  };
}

async function devicePublicKey() {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  );
  return `p256.${base64url(await crypto.subtle.exportKey('raw', pair.publicKey))}`;
}

async function encryptedNote(clientGuid) {
  const accountKey = randomBytes(32);
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const context = `pushbridge/content/v2/note/${clientGuid}`;
  const material = await crypto.subtle.importKey('raw', accountKey, 'HKDF', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({
    name: 'HKDF',
    hash: 'SHA-256',
    salt,
    info: encoder.encode('pushbridge/content/v2/1'),
  }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const ciphertext = await crypto.subtle.encrypt({
    name: 'AES-GCM',
    iv: nonce,
    additionalData: encoder.encode(context),
  }, key, encoder.encode(JSON.stringify({ title: 'synthetic', body: 'load evidence' })));
  return {
    type: 'note',
    target: { kind: 'all_other_devices' },
    client_guid: clientGuid,
    payload_version: 2,
    key_version: 1,
    encryption_salt: base64url(salt),
    nonce: base64url(nonce),
    ciphertext: base64url(ciphertext),
  };
}

const suffix = `${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;
let authorization;

try {
  const preflight = await request('/healthz');
  assert(preflight.response.status === 200 && preflight.body?.ok === true, `healthz preflight returned HTTP ${preflight.response.status}`);

  const bootstrap = await request('/api/v1/auth/bootstrap', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      handle: `load_${suffix}`,
      device_name: 'Synthetic Load Device',
      device_kind: 'pwa',
      public_key: await devicePublicKey(),
    }),
  });
  assert(bootstrap.response.status === 201, `bootstrap returned HTTP ${bootstrap.response.status}`);
  assert(typeof bootstrap.body?.access_token === 'string', 'bootstrap access token is missing');
  authorization = `Bearer ${bootstrap.body.access_token}`;

  const clientGuid = `load-${suffix}`;
  const pushBody = JSON.stringify(await encryptedNote(clientGuid));
  const replayResults = await mapConcurrent(replayRequests, concurrency, () => request('/api/v1/pushes', {
    method: 'POST',
    headers: {
      authorization,
      'content-type': 'application/json',
      'idempotency-key': clientGuid,
    },
    body: pushBody,
  }));
  const replayStatuses = replayResults.map(({ response }) => response.status);
  assert(replayStatuses.every((status) => status === 200 || status === 201),
    `idempotent replay returned unexpected HTTP status: ${[...new Set(replayStatuses)].join(',')}`);
  assert(replayStatuses.filter((status) => status === 201).length === 1,
    'idempotent replay did not create exactly one Push');
  const pushIds = new Set(replayResults.map(({ body }) => body?.id));
  assert(pushIds.size === 1 && !pushIds.has(undefined), 'idempotent replay returned multiple Push IDs');

  const healthResults = await mapConcurrent(healthRequests, concurrency, () => request('/healthz'));
  assert(healthResults.every(({ response, body }) => response.status === 200 && body?.ok === true),
    'one or more health requests failed');

  const apiResults = await mapConcurrent(apiRequests, concurrency, () => request('/api/v1/pushes?limit=100&include_deleted=true', {
    headers: { authorization },
  }));
  assert(apiResults.every(({ response, body }) => response.status === 200 && Array.isArray(body?.items)),
    'one or more authenticated cursor reads failed');

  const deletion = await request('/api/v1/account', {
    method: 'DELETE',
    headers: { authorization, 'content-type': 'application/json' },
    body: JSON.stringify({ confirmation: 'DELETE' }),
  });
  assert(deletion.response.status === 202 && deletion.body?.deletion?.state === 'completed',
    `account deletion returned HTTP ${deletion.response.status} without completion`);

  const revoked = await request('/api/v1/pushes', { headers: { authorization } });
  assert(revoked.response.status === 401, `deleted-account token returned HTTP ${revoked.response.status}`);
  authorization = undefined;

  const replayMetric = metric(replayResults);
  const healthMetric = metric(healthResults);
  const apiMetric = metric(apiResults);
  console.log(
    'Cloudflare bounded load evidence passed:'
    + ` concurrency=${concurrency}`
    + ` idempotent_replays=${replayMetric.count}`
    + ` replay_p50_ms=${replayMetric.p50}`
    + ` replay_p95_ms=${replayMetric.p95}`
    + ` replay_p99_ms=${replayMetric.p99}`
    + ` health_requests=${healthMetric.count}`
    + ` health_p50_ms=${healthMetric.p50}`
    + ` health_p95_ms=${healthMetric.p95}`
    + ` health_p99_ms=${healthMetric.p99}`
    + ` cursor_reads=${apiMetric.count}`
    + ` cursor_p50_ms=${apiMetric.p50}`
    + ` cursor_p95_ms=${apiMetric.p95}`
    + ` cursor_p99_ms=${apiMetric.p99}`
    + ' errors=0 unique_pushes=1 test_account=erased token_revoked=true',
  );
} finally {
  if (authorization) {
    await request('/api/v1/account', {
      method: 'DELETE',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ confirmation: 'DELETE' }),
    }).catch(() => undefined);
  }
}
