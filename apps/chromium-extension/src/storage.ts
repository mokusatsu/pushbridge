import { generateDeviceKeyPair } from './shared';

export interface ExtensionState {
  accessToken?: string;
  deviceId?: string;
  defaultTarget?: string;
  linkedAt?: string;
}

interface StoredIdentity {
  id: 'identity';
  privateKey: CryptoKey;
  publicKey: string;
}

interface StoredAccountKey {
  id: 'account';
  version: number;
  bytes: ArrayBuffer;
}

const DB_NAME = 'pushbridge-extension-secrets-v1';
const STORE_NAME = 'secrets';

function openSecrets(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getSecret<T>(id: string): Promise<T | undefined> {
  const db = await openSecrets();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const request = db.transaction(STORE_NAME).objectStore(STORE_NAME).get(id);
      request.onsuccess = () => resolve(request.result as T | undefined);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

async function putSecret(value: StoredIdentity | StoredAccountKey): Promise<void> {
  const db = await openSecrets();
  try {
    await new Promise<void>((resolve, reject) => {
      const request = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put(value);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export async function ensureIdentity(): Promise<StoredIdentity> {
  const existing = await getSecret<StoredIdentity>('identity');
  if (existing?.privateKey && existing.publicKey?.startsWith('p256.')) return existing;
  const generated = await generateDeviceKeyPair();
  const value: StoredIdentity = { id: 'identity', ...generated };
  await putSecret(value);
  return value;
}

export async function getAccountKey(): Promise<{ version: number; bytes: Uint8Array } | undefined> {
  const value = await getSecret<StoredAccountKey>('account');
  return value ? { version: value.version, bytes: new Uint8Array(value.bytes) } : undefined;
}

export async function putAccountKey(version: number, bytes: Uint8Array): Promise<void> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  await putSecret({ id: 'account', version, bytes: copy.buffer });
}

export async function clearSecrets(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Secret database is busy'));
  });
}

export async function getState(): Promise<ExtensionState> {
  return chrome.storage.local.get(['accessToken', 'deviceId', 'defaultTarget', 'linkedAt']) as Promise<ExtensionState>;
}

export async function patchState(value: Partial<ExtensionState>): Promise<void> {
  await chrome.storage.local.set(value);
}

export async function clearState(): Promise<void> {
  await chrome.storage.local.remove(['accessToken', 'deviceId', 'defaultTarget', 'linkedAt']);
}
