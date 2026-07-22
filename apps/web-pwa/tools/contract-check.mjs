import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configuredPath = process.env.OPENAPI_CONTRACT;
const contractPath = configuredPath
  ? resolve(process.cwd(), configuredPath)
  : resolve(projectRoot, 'openapi/relaymock.openapi.json');
const document = JSON.parse(await readFile(contractPath, 'utf8'));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function at(pointer) {
  const parts = pointer.split('/').filter(Boolean);
  let value = document;
  for (const part of parts) value = value?.[part];
  return value;
}

function operation(method, path) {
  const value = document.paths?.[path]?.[method.toLowerCase()];
  assert(value, `missing operation: ${method.toUpperCase()} ${path}`);
  return value;
}

function schema(name) {
  const value = document.components?.schemas?.[name];
  assert(value, `missing schema: ${name}`);
  return value;
}

function directResponseHasRequestId(response) {
  if (response?.$ref) return true;
  return Boolean(response?.headers?.['X-Request-ID']);
}

assert(document.openapi === '3.1.0', `expected OpenAPI 3.1.0, received ${document.openapi}`);
assert(document.info?.version === '0.1.1', `expected RelayMock 0.1.1, received ${document.info?.version}`);

for (const path of [
  '/health',
  '/v1/system/capabilities',
  '/v1/web-push-config',
  '/v1/auth/bootstrap',
  '/v1/auth/config',
  '/v1/auth/passkeys/registration/options',
  '/v1/auth/passkeys/registration/verify',
  '/v1/auth/passkeys/authentication/options',
  '/v1/auth/passkeys/authentication/verify',
  '/v1/auth/logout',
  '/v1/auth/session/rotate',
  '/v1/auth/sessions',
  '/v1/auth/sessions/{session_id}',
  '/v1/device-links',
  '/v1/device-links/redeem',
  '/v1/device-links/{link_id}',
  '/v1/devices',
  '/v1/devices/me',
  '/v1/devices/link',
  '/v1/pushes',
  '/v1/files/init',
  '/v1/web-push-subscriptions',
  '/mock-storage/uploads/{ticket}',
  '/mock-storage/downloads/{ticket}',
]) {
  assert(document.paths?.[path], `missing path: ${path}`);
}

const pushCreate = schema('PushCreate');
assert(Array.isArray(pushCreate.oneOf) && pushCreate.oneOf.length === 6, 'PushCreate must expose the six mutually exclusive request shapes');
for (const name of [
  'NotePlainPushCreate',
  'NoteEncryptedPushCreate',
  'LinkPlainPushCreate',
  'LinkEncryptedPushCreate',
  'FilePlainPushCreate',
  'FileEncryptedPushCreate',
  'NotePayloadV1',
  'LinkPayloadV1',
  'FilePayloadV1',
  'FileRef',
  'SystemCapabilitiesOut',
  'WebPushConfigOut',
  'ApiError',
]) schema(name);

const pushOut = schema('PushOut');
assert(pushOut.properties?.file_ref, 'PushOut.file_ref is missing');
assert(pushOut.required?.includes('file_ref'), 'PushOut.file_ref must be required by the 0.1.1 response contract');

const capabilities = schema('CapabilityLimits');
for (const name of [
  'max_file_bytes',
  'max_push_payload_bytes',
  'file_ttl_seconds',
  'default_push_ttl_seconds',
  'default_file_ttl_seconds',
  'max_devices',
]) assert(capabilities.properties?.[name], `CapabilityLimits.${name} is missing`);

const capabilityFeatures = schema('CapabilityFeatures');
for (const name of [
  'web_push_delivery',
  'web_push_subscription_registration',
  'passkey_authentication',
  'browser_cookie_sessions',
  'session_rotation',
  'one_time_device_link',
]) {
  assert(capabilityFeatures.properties?.[name], `CapabilityFeatures.${name} is missing`);
}

const pushPost = operation('post', '/v1/pushes');
assert(pushPost.responses?.['200'], 'POST /v1/pushes must document idempotent replay status 200');
assert(pushPost.responses?.['201'], 'POST /v1/pushes must document create status 201');
assert(pushPost.responses?.['200']?.headers?.['Idempotent-Replayed'], 'idempotent replay response header is missing');

const upload = operation('put', '/mock-storage/uploads/{ticket}');
const uploadBody = upload.requestBody?.content?.['application/octet-stream']?.schema;
assert(uploadBody?.format === 'binary', 'upload ticket request must be application/octet-stream binary');

const download = operation('get', '/mock-storage/downloads/{ticket}');
const downloadBody = download.responses?.['200']?.content?.['application/octet-stream']?.schema;
assert(downloadBody?.format === 'binary', 'download ticket response must be application/octet-stream binary');

for (const name of ['DownloadTicketOut', 'FileInitOut']) {
  const value = schema(name);
  const key = name === 'DownloadTicketOut' ? 'download_url' : 'upload_url';
  assert(value.properties?.[key]?.format === 'uri-reference', `${name}.${key} must allow relative ticket URLs`);
}

for (const [method, path] of [
  ['post', '/v1/auth/bootstrap'],
  ['post', '/v1/devices/link'],
  ['post', '/v1/device-links'],
  ['post', '/v1/device-links/redeem'],
]) {
  const response = operation(method, path).responses?.['201'];
  assert(response?.headers?.['Cache-Control'], `${method.toUpperCase()} ${path} must publish Cache-Control: no-store`);
  assert(response?.headers?.Pragma, `${method.toUpperCase()} ${path} must publish Pragma: no-cache`);
}

const subscriptionPost = operation('post', '/v1/web-push-subscriptions');
assert(subscriptionPost.responses?.['201'] && subscriptionPost.responses?.['200'], 'subscription upsert must document 201 and 200');

for (const path of ['/v1/mock/cleanup', '/v1/mock/reset', '/v1/mock/stats']) {
  const method = path.endsWith('/stats') ? 'get' : 'post';
  const admin = operation(method, path).parameters?.find((value) => value.name === 'X-Mock-Admin');
  assert(admin?.required === true, `${method.toUpperCase()} ${path} must require X-Mock-Admin`);
}

for (const [path, item] of Object.entries(document.paths ?? {})) {
  for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
    const op = item?.[method];
    if (!op) continue;
    for (const [status, response] of Object.entries(op.responses ?? {})) {
      assert(directResponseHasRequestId(response), `${method.toUpperCase()} ${path} response ${status} does not expose X-Request-ID`);
    }
  }
}

for (const responseName of ['BadRequest', 'Unauthorized', 'Forbidden', 'NotFound', 'Conflict', 'Gone', 'PayloadTooLarge', 'UnprocessableContent']) {
  assert(document.components?.responses?.[responseName], `missing reusable response: ${responseName}`);
}

assert(at('/components/headers/XRequestID/schema/pattern') === '^req_[A-Za-z0-9_-]+$', 'X-Request-ID pattern changed unexpectedly');

console.log(`✓ RelayMock OpenAPI contract ${document.info.version}`);
console.log('✓ capabilities, strict PushCreate, file_ref, binary tickets, errors and Request IDs');
