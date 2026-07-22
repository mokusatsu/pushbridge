import { openDB } from 'idb';
import { generateDeviceKeyPair, type DeviceKeyPair } from './e2ee';

interface StoredDeviceIdentity {
  id: 'current';
  privateKey: CryptoKey;
  publicKey: string;
  createdAt: string;
}

const DB_NAME = 'pushbridge-device-identity-v1';
const STORE_NAME = 'identity';

export async function ensureDeviceIdentity(): Promise<DeviceKeyPair> {
  const db = await openDB(DB_NAME, 1, {
    upgrade(database) {
      database.createObjectStore(STORE_NAME, { keyPath: 'id' });
    },
  });
  const existing = await db.get(STORE_NAME, 'current') as StoredDeviceIdentity | undefined;
  if (existing?.privateKey && existing.publicKey?.startsWith('p256.')) {
    return { privateKey: existing.privateKey, publicKey: existing.publicKey };
  }
  const generated = await generateDeviceKeyPair();
  await db.put(STORE_NAME, {
    id: 'current',
    privateKey: generated.privateKey,
    publicKey: generated.publicKey,
    createdAt: new Date().toISOString(),
  } satisfies StoredDeviceIdentity);
  return generated;
}
