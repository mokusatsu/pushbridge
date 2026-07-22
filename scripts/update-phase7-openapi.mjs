#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';

const path = new URL('../contract/openapi.json', import.meta.url);
const doc = JSON.parse(readFileSync(path, 'utf8'));
const schemas = doc.components.schemas;
const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });
const string = { type: 'string', minLength: 1, maxLength: 16384 };

for (const name of ['NoteEncryptedPushCreate', 'LinkEncryptedPushCreate', 'FileEncryptedPushCreate']) {
  const schema = schemas[name];
  schema.properties.payload_version = { type: 'integer', const: 2, default: 2 };
  schema.properties.key_version = { type: 'integer', minimum: 1 };
  schema.properties.encryption_salt = { type: 'string', minLength: 1, maxLength: 1024 };
  schema.required = [...new Set([...schema.required, 'payload_version', 'key_version', 'encryption_salt'])];
}
schemas.PushOut.properties.key_version = nullable({ type: 'integer', minimum: 1 });
schemas.PushOut.properties.encryption_salt = nullable({ type: 'string' });
schemas.PushOut.required = [...new Set([...schemas.PushOut.required, 'key_version', 'encryption_salt'])];
schemas.FileInitIn.properties.encrypted = { type: 'boolean', default: false };
schemas.FileOut.properties.e2ee = { type: 'boolean', default: false };
schemas.FileOut.required = [...new Set([...schemas.FileOut.required, 'e2ee'])];
schemas.PasskeyRegistrationOptionsIn.properties.device_public_key = { type: 'string', pattern: '^p256\\.[A-Za-z0-9_-]{87}$' };
doc.paths['/v1/device-links/redeem'].post.requestBody.content['application/json'].schema.properties.public_key = nullable({ type: 'string', pattern: '^p256\\.[A-Za-z0-9_-]{87}$' });

schemas.E2eeContentEnvelope = {
  type: 'object', additionalProperties: false,
  required: ['v', 'alg', 'key_version', 'salt', 'nonce', 'ciphertext'],
  properties: {
    v: { type: 'integer', const: 1 }, alg: { type: 'string', const: 'A256GCM-HKDF-SHA256' },
    key_version: { type: 'integer', minimum: 1 }, salt: string, nonce: string, ciphertext: string,
  },
};
schemas.E2eeDeviceEnvelope = {
  allOf: [{ $ref: '#/components/schemas/E2eeContentEnvelope' }, { type: 'object', required: ['recipient_device_id', 'ephemeral_public_key'], properties: {
    recipient_device_id: { type: 'string' }, ephemeral_public_key: { type: 'string', pattern: '^p256\\.[A-Za-z0-9_-]{87}$' },
  } }],
};
schemas.E2eeRecoveryEnvelope = {
  allOf: [{ $ref: '#/components/schemas/E2eeContentEnvelope' }, { type: 'object', required: ['kind'], properties: { kind: { type: 'string', const: 'recovery' } } }],
};
schemas.E2eeStatusOut = { type: 'object', required: ['initialized', 'current_key_version', 'algorithm', 'current_device_has_envelope', 'devices'], properties: {
  initialized: { type: 'boolean' }, current_key_version: nullable({ type: 'integer', minimum: 1 }), algorithm: { type: 'string' },
  created_at: nullable({ type: 'string', format: 'date-time' }), current_device_has_envelope: { type: 'boolean' },
  devices: { type: 'array', items: { type: 'object', required: ['id', 'public_key', 'has_envelope'], properties: { id: { type: 'string' }, public_key: { type: 'string' }, has_envelope: { type: 'boolean' } } } },
} };
const security = [{ DeviceBearer: [] }, { BrowserCookie: [] }];
const ok = (schema) => ({ description: 'Successful Response', content: { 'application/json': { schema } }, headers: { 'X-Request-ID': { $ref: '#/components/headers/XRequestID' } } });
const operation = (method, summary, operationId, responses, requestSchema, parameters) => ({
  tags: ['e2ee'], summary, operationId, security, ...(parameters ? { parameters } : {}),
  ...(requestSchema ? { requestBody: { required: true, content: { 'application/json': { schema: requestSchema } } } } : {}),
  responses: { ...responses, '401': { $ref: '#/components/responses/Unauthorized' }, '422': { $ref: '#/components/responses/UnprocessableContent' } },
});
doc.paths['/v1/e2ee/status'] = { get: operation('get', 'Get E2EE status', 'get_e2ee_status', { '200': ok({ $ref: '#/components/schemas/E2eeStatusOut' }) }) };
doc.paths['/v1/e2ee/device-key'] = { put: operation('put', 'Register current device encryption key', 'put_e2ee_device_key', { '200': ok({ type: 'object' }) }, { type: 'object', required: ['public_key'], properties: { public_key: { type: 'string', pattern: '^p256\\.[A-Za-z0-9_-]{87}$' } } }) };
doc.paths['/v1/e2ee/account-key'] = { post: operation('post', 'Initialize account key envelopes', 'initialize_e2ee_account_key', { '201': ok({ type: 'object' }) }, { type: 'object', required: ['key_version', 'recovery_envelope', 'device_envelope'], properties: { key_version: { type: 'integer', minimum: 1 }, recovery_envelope: { $ref: '#/components/schemas/E2eeRecoveryEnvelope' }, device_envelope: { $ref: '#/components/schemas/E2eeDeviceEnvelope' } } }) };
doc.paths['/v1/e2ee/device-envelope'] = { get: operation('get', 'Get current device account-key envelope', 'get_e2ee_device_envelope', { '200': ok({ type: 'object' }), '404': { $ref: '#/components/responses/NotFound' } }) };
doc.paths['/v1/e2ee/recovery-envelope'] = { get: operation('get', 'Get recovery envelope', 'get_e2ee_recovery_envelope', { '200': ok({ type: 'object' }), '404': { $ref: '#/components/responses/NotFound' } }) };
doc.paths['/v1/e2ee/device-envelopes/{device_id}'] = { put: operation('put', 'Provision an active device envelope', 'put_e2ee_device_envelope', { '200': ok({ type: 'object' }), '201': ok({ type: 'object' }), '404': { $ref: '#/components/responses/NotFound' } }, { type: 'object', required: ['key_version', 'envelope'], properties: { key_version: { type: 'integer', minimum: 1 }, envelope: { $ref: '#/components/schemas/E2eeDeviceEnvelope' } } }, [{ name: 'device_id', in: 'path', required: true, schema: { type: 'string' } }]) };

writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
