import { describe, expect, it } from 'vitest';
import {
  createNonceGenerator,
  decryptFile,
  decryptPushPayload,
  encryptFile,
  encryptPushPayload,
  generateDeviceKeyPair,
  unwrapAccountKeyForDevice,
  unwrapAccountKeyFromRecovery,
  wrapAccountKeyForDevice,
  wrapAccountKeyForRecovery,
} from './e2ee';

const sequence = (start: number) => (length: number) => Uint8Array.from({ length }, (_, index) => (start + index) & 0xff);

describe('E2EE protocol v1', () => {
  it('wraps the same account key for a P-256 device and recovery key', async () => {
    const accountKey = sequence(1)(32);
    const recoveryKey = sequence(101)(32);
    const device = await generateDeviceKeyPair();
    const deviceEnvelope = await wrapAccountKeyForDevice(accountKey, 1, 'dev_fixture', device.publicKey);
    expect(await unwrapAccountKeyForDevice(deviceEnvelope, device.privateKey)).toEqual(accountKey);
    const recoveryEnvelope = await wrapAccountKeyForRecovery(accountKey, recoveryKey, 1);
    expect(await unwrapAccountKeyFromRecovery(recoveryEnvelope, recoveryKey)).toEqual(accountKey);
  });

  it('encrypts metadata and fails closed for modified AAD or the wrong key', async () => {
    const key = sequence(11)(32);
    const envelope = await encryptPushPayload(key, 1, 'note', 'guid_fixture', { title: 'secret', body: 'hidden' }, {
      random: sequence(21), nonce: () => sequence(41)(12),
    });
    expect(envelope).toEqual({
      v: 1,
      alg: 'A256GCM-HKDF-SHA256',
      key_version: 1,
      salt: 'FRYXGBkaGxwdHh8gISIjJA',
      nonce: 'KSorLC0uLzAxMjM0',
      ciphertext: 'rKzz1iZ95ybF5Lz_Y862FGI-6A_YCEsJG-iLbAaS5J6EdJ3oyK55B-7toLOdalDzZCw',
    });
    expect(await decryptPushPayload(key, 'note', 'guid_fixture', envelope)).toEqual({ title: 'secret', body: 'hidden' });
    await expect(decryptPushPayload(key, 'link', 'guid_fixture', envelope)).rejects.toThrow();
    await expect(decryptPushPayload(sequence(12)(32), 'note', 'guid_fixture', envelope)).rejects.toThrow();
  });

  it('encrypts File bytes and authenticates the client file ID', async () => {
    const key = sequence(51)(32);
    const plaintext = sequence(81)(4096);
    const encrypted = await encryptFile(key, 3, 'local_file_fixture', plaintext.buffer, {
      random: sequence(61), nonce: () => sequence(71)(12),
    });
    expect(new Uint8Array(await decryptFile(key, 'local_file_fixture', encrypted))).toEqual(plaintext);
    await expect(decryptFile(key, 'different_file', encrypted)).rejects.toThrow();
  });

  it('rejects nonce reuse from a faulty random source', () => {
    const nonce = sequence(1)(12);
    const generator = createNonceGenerator(() => nonce);
    expect(generator()).toEqual(nonce);
    expect(() => generator()).toThrow('Unable to allocate a unique nonce');
  });
});
