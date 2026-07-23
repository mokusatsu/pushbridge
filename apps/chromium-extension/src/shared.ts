declare const __PUSHBRIDGE_EXTENSION_API_ORIGIN__: string;

export const API_ORIGIN = typeof __PUSHBRIDGE_EXTENSION_API_ORIGIN__ === 'string'
  ? __PUSHBRIDGE_EXTENSION_API_ORIGIN__
  : 'https://pushbridge-dev.mokusatsu.workers.dev';
export const API_BASE_PATH = '/api/v1';

export type PushType = 'note' | 'link' | 'file';
export type PushTarget = { kind: 'all_other_devices' } | { kind: 'device'; device_id: string };

export interface Draft {
  type: 'note' | 'link';
  title?: string;
  body?: string;
  url?: string;
}

export interface ContentEnvelope {
  v: 1;
  alg: 'A256GCM-HKDF-SHA256';
  key_version: number;
  salt: string;
  nonce: string;
  ciphertext: string;
}

export interface DeviceEnvelope extends ContentEnvelope {
  recipient_device_id: string;
  ephemeral_public_key: string;
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
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

async function importDevicePublicKey(value: string): Promise<CryptoKey> {
  if (!value.startsWith('p256.')) throw new Error('Unsupported device public key');
  const raw = decodeBase64Url(value.slice(5));
  if (raw.byteLength !== 65 || raw[0] !== 4) throw new Error('Invalid P-256 public key');
  return crypto.subtle.importKey('raw', owned(raw), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
}

async function deriveAesKey(input: Uint8Array, salt: Uint8Array, info: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', owned(input), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({
    name: 'HKDF',
    hash: 'SHA-256',
    salt: owned(salt),
    info: new TextEncoder().encode(info),
  }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function generateDeviceKeyPair(): Promise<{ privateKey: CryptoKey; publicKey: string }> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { privateKey: pair.privateKey, publicKey: `p256.${encodeBase64Url(raw)}` };
}

export async function unwrapAccountKey(envelope: DeviceEnvelope, privateKey: CryptoKey): Promise<Uint8Array> {
  const ephemeral = await importDevicePublicKey(envelope.ephemeral_public_key);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: ephemeral }, privateKey, 256));
  const context = `pushbridge/device-envelope/v1/${envelope.recipient_device_id}/${envelope.key_version}`;
  const salt = decodeBase64Url(envelope.salt);
  const nonce = decodeBase64Url(envelope.nonce);
  const key = await deriveAesKey(shared, salt, context);
  const plaintext = await crypto.subtle.decrypt({
    name: 'AES-GCM',
    iv: owned(nonce),
    additionalData: new TextEncoder().encode(context),
  }, key, owned(decodeBase64Url(envelope.ciphertext)));
  const value = new Uint8Array(plaintext);
  if (value.byteLength !== 32) throw new Error('Invalid account key');
  return value;
}

export async function encryptPushPayload(
  accountKey: Uint8Array,
  keyVersion: number,
  type: PushType,
  clientGuid: string,
  payload: Record<string, unknown>,
  random: RandomBytes = defaultRandom,
): Promise<ContentEnvelope> {
  if (accountKey.byteLength !== 32) throw new Error('Invalid account key');
  const salt = random(16);
  const nonce = random(12);
  if (salt.byteLength !== 16 || nonce.byteLength !== 12) throw new Error('Invalid random source');
  const context = `pushbridge/push/v2/${type}/${clientGuid}`;
  const key = await deriveAesKey(accountKey, salt, `pushbridge/content/v2/${keyVersion}`);
  const ciphertext = await crypto.subtle.encrypt({
    name: 'AES-GCM',
    iv: owned(nonce),
    additionalData: new TextEncoder().encode(context),
  }, key, new TextEncoder().encode(JSON.stringify(payload)));
  return {
    v: 1,
    alg: 'A256GCM-HKDF-SHA256',
    key_version: keyVersion,
    salt: encodeBase64Url(salt),
    nonce: encodeBase64Url(nonce),
    ciphertext: encodeBase64Url(new Uint8Array(ciphertext)),
  };
}

export async function decryptPushPayload(
  accountKey: Uint8Array,
  type: PushType,
  clientGuid: string,
  envelope: ContentEnvelope,
): Promise<Record<string, unknown>> {
  const context = `pushbridge/push/v2/${type}/${clientGuid}`;
  const key = await deriveAesKey(accountKey, decodeBase64Url(envelope.salt), `pushbridge/content/v2/${envelope.key_version}`);
  const plaintext = await crypto.subtle.decrypt({
    name: 'AES-GCM',
    iv: owned(decodeBase64Url(envelope.nonce)),
    additionalData: new TextEncoder().encode(context),
  }, key, owned(decodeBase64Url(envelope.ciphertext)));
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)) as Record<string, unknown>;
}

const FILE_MAGIC = new TextEncoder().encode('PBFE');
const FILE_HEADER_BYTES = 4 + 1 + 4 + 16 + 12;

export async function encryptFile(
  accountKey: Uint8Array,
  keyVersion: number,
  clientFileId: string,
  plaintext: ArrayBuffer,
  random: RandomBytes = defaultRandom,
): Promise<ArrayBuffer> {
  const salt = random(16);
  const nonce = random(12);
  if (accountKey.byteLength !== 32 || salt.byteLength !== 16 || nonce.byteLength !== 12) {
    throw new Error('Invalid File encryption input');
  }
  const context = `pushbridge/file/v1/${clientFileId}`;
  const key = await deriveAesKey(accountKey, salt, `pushbridge/file/v1/${keyVersion}`);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({
    name: 'AES-GCM',
    iv: owned(nonce),
    additionalData: new TextEncoder().encode(context),
  }, key, plaintext));
  const version = new Uint8Array(5);
  version[0] = 1;
  new DataView(version.buffer).setUint32(1, keyVersion, false);
  return owned(concat(FILE_MAGIC, version, salt, nonce, ciphertext));
}

export async function decryptFile(
  accountKey: Uint8Array,
  clientFileId: string,
  encrypted: ArrayBuffer,
): Promise<ArrayBuffer> {
  const bytes = new Uint8Array(encrypted);
  if (bytes.byteLength < FILE_HEADER_BYTES + 16
    || !FILE_MAGIC.every((byte, index) => bytes[index] === byte)
    || bytes[4] !== 1) throw new Error('Invalid encrypted File container');
  const keyVersion = new DataView(bytes.buffer, bytes.byteOffset + 5, 4).getUint32(0, false);
  if (keyVersion < 1) throw new Error('Invalid encrypted File key version');
  const salt = bytes.slice(9, 25);
  const nonce = bytes.slice(25, 37);
  const ciphertext = bytes.slice(37);
  const context = `pushbridge/file/v1/${clientFileId}`;
  const key = await deriveAesKey(accountKey, salt, `pushbridge/file/v1/${keyVersion}`);
  return crypto.subtle.decrypt({
    name: 'AES-GCM',
    iv: owned(nonce),
    additionalData: new TextEncoder().encode(context),
  }, key, owned(ciphertext));
}

export function payloadForDraft(draft: Draft): Record<string, unknown> {
  if (draft.type === 'note') {
    const title = draft.title?.trim();
    const body = draft.body?.trim();
    if (!title && !body) throw new Error('Noteにはタイトルまたは本文が必要です。');
    return { ...(title ? { title } : {}), ...(body ? { body } : {}) };
  }
  const url = draft.url?.trim();
  if (!url || !/^https?:\/\//iu.test(url)) throw new Error('LinkにはHTTPまたはHTTPS URLが必要です。');
  const title = draft.title?.trim();
  const body = draft.body?.trim();
  return { url, ...(title ? { title } : {}), ...(body ? { body } : {}) };
}

export function draftFromContextMenu(
  info: Pick<chrome.contextMenus.OnClickData, 'menuItemId' | 'selectionText' | 'linkUrl' | 'srcUrl' | 'pageUrl'>,
  tab?: Pick<chrome.tabs.Tab, 'title' | 'url'>,
): Draft {
  switch (info.menuItemId) {
    case 'pushbridge-selection':
      return { type: 'note', title: tab?.title || '選択テキスト', body: info.selectionText || '' };
    case 'pushbridge-link':
      return { type: 'link', title: info.selectionText || tab?.title, url: info.linkUrl };
    case 'pushbridge-image':
      return { type: 'link', title: tab?.title || '画像', url: info.srcUrl };
    default:
      return { type: 'link', title: tab?.title, url: tab?.url || info.pageUrl };
  }
}

export function targetFromValue(value: string): PushTarget {
  return value && value !== 'all_other_devices'
    ? { kind: 'device', device_id: value }
    : { kind: 'all_other_devices' };
}
