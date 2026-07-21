import { createHash, randomUUID } from 'node:crypto';

const origin = (process.env.API_ORIGIN || 'http://127.0.0.1:8000').replace(/\/+$/, '');
const apiBase = process.env.API_BASE_URL || `${origin}/v1`;
let bearerToken = process.env.API_BEARER_TOKEN || '';
const timeoutMs = Number(process.env.API_TIMEOUT_MS || 15_000);

function join(base, path) {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function requestId() {
  return `req_smoke_${randomUUID().replace(/-/g, '_')}`;
}

function headers(extra = {}, authenticated = true, id = requestId()) {
  return {
    Accept: 'application/json',
    'X-Client-Version': 'relaymock-smoke/0.4.0',
    'X-Request-ID': id,
    ...(authenticated && bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
    ...extra,
  };
}

async function request(path, init = {}, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const id = options.requestId || requestId();
  try {
    const url = options.root ? join(origin, path) : join(apiBase, path);
    const response = await fetch(url, {
      ...init,
      headers: headers(init.headers, options.authenticated !== false, id),
      signal: controller.signal,
    });
    const contentType = response.headers.get('content-type') || '';
    const body = response.status === 204
      ? undefined
      : contentType.includes('json')
        ? await response.json()
        : await response.text();
    if (!response.ok) {
      throw new Error(`${init.method || 'GET'} ${url}: ${response.status} ${JSON.stringify(body)}`);
    }
    const echoed = response.headers.get('X-Request-ID');
    assert(echoed === id, `${init.method || 'GET'} ${url}: X-Request-ID was not echoed (${echoed || 'missing'})`);
    return { response, body, requestId: echoed };
  } finally {
    clearTimeout(timer);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function bootstrapIfNeeded() {
  if (bearerToken) return;
  const handle = `smoke-${randomUUID().slice(0, 8)}`;
  const result = await request('/auth/bootstrap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      handle,
      device_name: 'API smoke PWA',
      device_kind: 'test',
    }),
  }, { authenticated: false });
  assert(result.body?.access_token && result.body?.device?.id, 'bootstrap response is incomplete');
  assert(result.response.headers.get('Cache-Control') === 'no-store', 'bootstrap Cache-Control must be no-store');
  assert(result.response.headers.get('Pragma') === 'no-cache', 'bootstrap Pragma must be no-cache');
  bearerToken = result.body.access_token;
  console.log(`✓ bootstrap: ${result.body.user.handle} / ${result.body.device.id}`);
}

async function main() {
  console.log(`RelayMock smoke target: ${apiBase}`);

  const health = (await request('/health', {}, { root: true, authenticated: false })).body;
  assert(health && typeof health === 'object', 'health response must be an object');
  console.log('✓ health + Request ID');

  const capabilities = (await request('/system/capabilities', {}, { authenticated: false })).body;
  assert(capabilities?.api_version === '0.1.1', `unexpected API version: ${capabilities?.api_version}`);
  assert(capabilities?.features?.web_push_subscription_registration === true, 'subscription registration capability is missing');
  assert(Number.isInteger(capabilities?.recommended_poll_interval_seconds), 'recommended poll interval is missing');
  console.log(`✓ capabilities: ${capabilities.api_version}, poll ${capabilities.recommended_poll_interval_seconds}s`);

  const webPushConfig = (await request('/web-push-config', {}, { authenticated: false })).body;
  assert(webPushConfig?.subscription_registration === true, 'Web Push registration config is disabled');
  assert(typeof webPushConfig?.vapid_public_key === 'string', 'VAPID public key is missing');
  console.log(`✓ Web Push config: delivery=${webPushConfig.delivery}`);

  await bootstrapIfNeeded();

  const current = (await request('/devices/me')).body;
  assert(current?.id && current?.is_current === true, 'current device response is invalid');
  const devices = (await request('/devices')).body;
  assert(Array.isArray(devices), 'devices must be an array');
  console.log(`✓ devices: ${devices.length}, current ${current.id}`);

  const endpoint = `https://push.example.test/${randomUUID()}`;
  const firstSubscription = await request('/web-push-subscriptions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint, p256dh: 'p256dh-one', auth: 'auth-one' }),
  });
  const updatedSubscription = await request('/web-push-subscriptions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint, p256dh: 'p256dh-two', auth: 'auth-two' }),
  });
  assert(firstSubscription.response.status === 201, 'first subscription registration must return 201');
  assert(updatedSubscription.response.status === 200, 'subscription upsert must return 200');
  assert(firstSubscription.body.id === updatedSubscription.body.id, 'subscription upsert created a new record');
  console.log(`✓ Web Push subscription upsert: ${updatedSubscription.body.id}`);

  const initial = (await request('/pushes?limit=100&include_deleted=true')).body;
  assert(Array.isArray(initial?.items), 'pushes.items must be an array');
  const checkpoint = initial.next_cursor || '';
  console.log(`✓ initial cursor: ${checkpoint || '(empty)'}`);

  const idempotencyKey = `smoke_${randomUUID()}`;
  const noteBody = {
    target: { kind: 'all_other_devices' },
    type: 'note',
    payload_version: 1,
    payload: { title: 'RelayMock smoke test', body: new Date().toISOString() },
    client_guid: idempotencyKey,
    expires_in: capabilities.limits.default_push_ttl_seconds,
  };
  const firstResult = await request('/pushes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(noteBody),
  });
  const replayResult = await request('/pushes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(noteBody),
  });
  assert(firstResult.response.status === 201, 'first push must return 201');
  assert(replayResult.response.status === 200, 'idempotent replay must return 200');
  assert(firstResult.body?.id === replayResult.body?.id, 'idempotent replay created a different push');
  assert(replayResult.response.headers.get('Idempotent-Replayed') === 'true', 'replay header is missing');
  console.log(`✓ idempotent note push: ${firstResult.body.id}`);

  const payload = Buffer.from(`relaymock-smoke-${randomUUID()}\n`, 'utf8');
  const sha256 = createHash('sha256').update(payload).digest('hex');
  const initialized = (await request('/files/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filename: 'relaymock-smoke.txt',
      content_type: 'text/plain',
      size: payload.length,
      sha256,
      expires_in: capabilities.limits.default_file_ttl_seconds,
    }),
  })).body;
  assert(initialized?.file?.id && initialized?.upload_url, 'file init response is incomplete');

  const uploadUrl = new URL(initialized.upload_url, `${origin}/`).toString();
  const uploadResponse = await fetch(uploadUrl, {
    method: initialized.upload_method || 'PUT',
    headers: initialized.upload_headers || {},
    body: payload,
  });
  if (!uploadResponse.ok) throw new Error(`file upload failed: ${uploadResponse.status} ${await uploadResponse.text()}`);
  assert(uploadResponse.headers.get('X-Request-ID')?.startsWith('req_'), 'upload response Request ID is missing');

  const completed = (await request(`/files/${encodeURIComponent(initialized.file.id)}/complete`, { method: 'POST' })).body;
  assert(completed?.id === initialized.file.id && completed?.state === 'ready', 'file did not become ready');
  assert(completed?.actual_sha256 === sha256, 'file sha256 mismatch');
  console.log(`✓ file upload: ${completed.id}, ${completed.actual_size} bytes`);

  const fileKey = `smoke_file_${randomUUID()}`;
  const filePush = (await request('/pushes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': fileKey },
    body: JSON.stringify({
      target: { kind: 'all_other_devices' },
      type: 'file',
      file_id: completed.id,
      payload_version: 1,
      payload: {
        title: 'RelayMock file smoke test',
        file: {
          name: completed.original_name,
          mime_type: completed.content_type,
          size: completed.actual_size,
          sha256: completed.actual_sha256,
          expires_at: completed.expires_at,
        },
      },
      client_guid: fileKey,
      expires_in: capabilities.limits.default_file_ttl_seconds,
    }),
  })).body;
  assert(filePush?.file_id === completed.id, 'file push does not reference the completed file');
  assert(filePush?.file_ref?.state === 'ready', 'file_ref does not report ready');

  const downloadTicket = (await request(`/files/${encodeURIComponent(completed.id)}/download-ticket`, { method: 'POST' })).body;
  const downloadUrl = new URL(downloadTicket.download_url, `${origin}/`).toString();
  const downloadedResponse = await fetch(downloadUrl);
  if (!downloadedResponse.ok) throw new Error(`file download failed: ${downloadedResponse.status}`);
  assert(downloadedResponse.headers.get('X-Request-ID')?.startsWith('req_'), 'download response Request ID is missing');
  const downloaded = Buffer.from(await downloadedResponse.arrayBuffer());
  assert(downloaded.equals(payload), 'downloaded file differs from uploaded payload');
  console.log(`✓ file push, file_ref and download ticket: ${filePush.id}`);

  const query = new URLSearchParams({ limit: '100', include_deleted: 'true' });
  if (checkpoint) query.set('after', checkpoint);
  const after = (await request(`/pushes?${query.toString()}`)).body;
  assert(after.items.some((item) => item.id === firstResult.body.id), 'created note is missing from cursor sync');
  assert(after.items.some((item) => item.id === filePush.id), 'created file push is missing from cursor sync');
  const createdCheckpoint = after.next_cursor || checkpoint;
  console.log(`✓ incremental REST sync: ${after.items.length} item(s)`);

  const pinned = (await request(`/pushes/${encodeURIComponent(firstResult.body.id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pinned: true }),
  })).body;
  assert(pinned.pinned === true && pinned.expires_at === null, 'pin transition failed');
  console.log('✓ pin transition');

  await request(`/files/${encodeURIComponent(completed.id)}`, { method: 'DELETE' });
  const fileStateQuery = new URLSearchParams({ limit: '100', include_deleted: 'true' });
  if (createdCheckpoint) fileStateQuery.set('after', createdCheckpoint);
  const fileStateChanges = (await request(`/pushes?${fileStateQuery.toString()}`)).body;
  const changedFilePush = fileStateChanges.items.find((item) => item.id === filePush.id);
  assert(changedFilePush?.file_ref?.state === 'deleted', 'file deletion was not re-emitted through the push cursor');
  console.log('✓ file_ref state change re-entered cursor sync');

  await request(`/web-push-subscriptions/${encodeURIComponent(updatedSubscription.body.id)}`, { method: 'DELETE' });
  await request(`/pushes/${encodeURIComponent(firstResult.body.id)}`, { method: 'DELETE' });
  await request(`/pushes/${encodeURIComponent(filePush.id)}`, { method: 'DELETE' });
  console.log('✓ cleanup');
  console.log('RelayMock API smoke test passed.');
}

main().catch((error) => {
  console.error(`RelayMock API smoke test failed: ${error instanceof Error ? error.stack || error.message : String(error)}`);
  process.exitCode = 1;
});
