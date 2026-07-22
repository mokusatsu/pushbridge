const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export interface ContentEnvelopeV1 {
  v: 1;
  alg: 'A256GCM-HKDF-SHA256';
  key_version: number;
  salt: string;
  nonce: string;
  ciphertext: string;
}

export interface DeviceEnvelopeV1 extends ContentEnvelopeV1 {
  recipient_device_id: string;
  ephemeral_public_key: string;
}

export interface RecoveryEnvelopeV1 extends ContentEnvelopeV1 {
  kind: 'recovery';
}

export interface DeviceKeyPair {
  privateKey: CryptoKey;
  publicKey: string;
}

type RandomBytes = (length: number) => Uint8Array;

function defaultRandom(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

export function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/u.test(value)) throw new Error('Invalid base64url');
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function owned(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((size, part) => size + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.byteLength; }
  return output;
}

export function createNonceGenerator(random: RandomBytes = defaultRandom): () => Uint8Array {
  const seen = new Set<string>();
  return () => {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const nonce = random(12);
      if (nonce.byteLength !== 12) throw new Error('Nonce source must return 12 bytes');
      const encoded = encodeBase64Url(nonce);
      if (!seen.has(encoded)) { seen.add(encoded); return nonce; }
    }
    throw new Error('Unable to allocate a unique nonce');
  };
}

const nextNonce = createNonceGenerator();

async function deriveAesKey(inputKeyMaterial: Uint8Array, salt: Uint8Array, info: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', owned(inputKeyMaterial), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({
    name: 'HKDF', hash: 'SHA-256', salt: owned(salt), info: encoder.encode(info),
  }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function seal(rawKey: Uint8Array, plaintext: Uint8Array, keyVersion: number, info: string, aad: string,
  random: RandomBytes = defaultRandom, nonceGenerator: () => Uint8Array = nextNonce): Promise<ContentEnvelopeV1> {
  const salt = random(16);
  if (salt.byteLength !== 16) throw new Error('Salt source must return 16 bytes');
  const nonce = nonceGenerator();
  const key = await deriveAesKey(rawKey, salt, info);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: owned(nonce), additionalData: encoder.encode(aad) }, key, owned(plaintext));
  return { v: 1, alg: 'A256GCM-HKDF-SHA256', key_version: keyVersion, salt: encodeBase64Url(salt), nonce: encodeBase64Url(nonce), ciphertext: encodeBase64Url(new Uint8Array(ciphertext)) };
}

async function open(rawKey: Uint8Array, envelope: ContentEnvelopeV1, info: string, aad: string): Promise<Uint8Array> {
  if (envelope.v !== 1 || envelope.alg !== 'A256GCM-HKDF-SHA256' || !Number.isSafeInteger(envelope.key_version) || envelope.key_version < 1) {
    throw new Error('Unsupported E2EE envelope');
  }
  const salt = decodeBase64Url(envelope.salt);
  const nonce = decodeBase64Url(envelope.nonce);
  if (salt.byteLength !== 16 || nonce.byteLength !== 12) throw new Error('Invalid E2EE parameters');
  const key = await deriveAesKey(rawKey, salt, info);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: owned(nonce), additionalData: encoder.encode(aad) }, key, owned(decodeBase64Url(envelope.ciphertext)));
  return new Uint8Array(plaintext);
}

export function generateAccountKey(random: RandomBytes = defaultRandom): Uint8Array {
  const value = random(32);
  if (value.byteLength !== 32) throw new Error('Account key source must return 32 bytes');
  return value;
}

export const generateRecoveryKey = generateAccountKey;

export async function generateDeviceKeyPair(): Promise<DeviceKeyPair> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']) as CryptoKeyPair;
  const publicBytes = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { privateKey: pair.privateKey, publicKey: `p256.${encodeBase64Url(publicBytes)}` };
}

async function importDevicePublicKey(value: string): Promise<CryptoKey> {
  if (!value.startsWith('p256.')) throw new Error('Unsupported device public key');
  const raw = decodeBase64Url(value.slice(5));
  if (raw.byteLength !== 65 || raw[0] !== 4) throw new Error('Invalid P-256 public key');
  return crypto.subtle.importKey('raw', owned(raw), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
}

export async function wrapAccountKeyForDevice(accountKey: Uint8Array, keyVersion: number, recipientDeviceId: string,
  recipientPublicKey: string): Promise<DeviceEnvelopeV1> {
  if (accountKey.byteLength !== 32) throw new Error('Account key must contain 32 bytes');
  const recipient = await importDevicePublicKey(recipientPublicKey);
  const ephemeral = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: recipient }, ephemeral.privateKey, 256));
  const publicBytes = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey));
  const context = `pushbridge/device-envelope/v1/${recipientDeviceId}/${keyVersion}`;
  return {
    ...await seal(shared, accountKey, keyVersion, context, context),
    recipient_device_id: recipientDeviceId,
    ephemeral_public_key: `p256.${encodeBase64Url(publicBytes)}`,
  };
}

export async function unwrapAccountKeyForDevice(envelope: DeviceEnvelopeV1, recipientPrivateKey: CryptoKey): Promise<Uint8Array> {
  const ephemeral = await importDevicePublicKey(envelope.ephemeral_public_key);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: ephemeral }, recipientPrivateKey, 256));
  const context = `pushbridge/device-envelope/v1/${envelope.recipient_device_id}/${envelope.key_version}`;
  return open(shared, envelope, context, context);
}

export async function wrapAccountKeyForRecovery(accountKey: Uint8Array, recoveryKey: Uint8Array, keyVersion: number): Promise<RecoveryEnvelopeV1> {
  const context = `pushbridge/recovery-envelope/v1/${keyVersion}`;
  return { ...await seal(recoveryKey, accountKey, keyVersion, context, context), kind: 'recovery' };
}

export async function unwrapAccountKeyFromRecovery(envelope: RecoveryEnvelopeV1, recoveryKey: Uint8Array): Promise<Uint8Array> {
  const context = `pushbridge/recovery-envelope/v1/${envelope.key_version}`;
  return open(recoveryKey, envelope, context, context);
}

export async function encryptPushPayload(accountKey: Uint8Array, keyVersion: number, type: string, clientGuid: string,
  payload: Record<string, unknown>, options: { random?: RandomBytes; nonce?: () => Uint8Array } = {}): Promise<ContentEnvelopeV1> {
  const context = `pushbridge/push/v2/${type}/${clientGuid}`;
  return seal(accountKey, encoder.encode(JSON.stringify(payload)), keyVersion, `pushbridge/content/v2/${keyVersion}`, context,
    options.random, options.nonce);
}

export async function decryptPushPayload(accountKey: Uint8Array, type: string, clientGuid: string,
  envelope: ContentEnvelopeV1): Promise<Record<string, unknown>> {
  const context = `pushbridge/push/v2/${type}/${clientGuid}`;
  return JSON.parse(decoder.decode(await open(accountKey, envelope, `pushbridge/content/v2/${envelope.key_version}`, context))) as Record<string, unknown>;
}

const FILE_MAGIC = encoder.encode('PBFE');
const FILE_HEADER_BYTES = 4 + 1 + 4 + 16 + 12;

export async function encryptFile(accountKey: Uint8Array, keyVersion: number, clientFileId: string, plaintext: ArrayBuffer,
  options: { random?: RandomBytes; nonce?: () => Uint8Array } = {}): Promise<ArrayBuffer> {
  const random = options.random ?? defaultRandom;
  const salt = random(16);
  const nonce = (options.nonce ?? nextNonce)();
  const context = `pushbridge/file/v1/${clientFileId}`;
  const key = await deriveAesKey(accountKey, salt, `pushbridge/file/v1/${keyVersion}`);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: owned(nonce), additionalData: encoder.encode(context) }, key, plaintext));
  const version = new Uint8Array(5);
  version[0] = 1;
  new DataView(version.buffer).setUint32(1, keyVersion, false);
  return owned(concat(FILE_MAGIC, version, salt, nonce, ciphertext));
}

export async function decryptFile(accountKey: Uint8Array, clientFileId: string, encrypted: ArrayBuffer): Promise<ArrayBuffer> {
  const bytes = new Uint8Array(encrypted);
  if (bytes.byteLength < FILE_HEADER_BYTES + 16 || !FILE_MAGIC.every((byte, index) => bytes[index] === byte) || bytes[4] !== 1) {
    throw new Error('Invalid encrypted File container');
  }
  const keyVersion = new DataView(bytes.buffer, bytes.byteOffset + 5, 4).getUint32(0, false);
  if (keyVersion < 1) throw new Error('Invalid encrypted File key version');
  const salt = bytes.slice(9, 25);
  const nonce = bytes.slice(25, 37);
  const ciphertext = bytes.slice(37);
  const context = `pushbridge/file/v1/${clientFileId}`;
  const key = await deriveAesKey(accountKey, salt, `pushbridge/file/v1/${keyVersion}`);
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: owned(nonce), additionalData: encoder.encode(context) }, key, owned(ciphertext));
}
