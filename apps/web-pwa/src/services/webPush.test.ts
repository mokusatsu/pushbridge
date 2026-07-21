import { describe, expect, it } from 'vitest';
import { decodeVapidPublicKey, subscriptionToInput } from './webPush';

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

describe('Web Push helpers', () => {
  it('decodes a 65-byte uncompressed P-256 VAPID public key', () => {
    const bytes = new Uint8Array(65);
    bytes[0] = 0x04;
    for (let index = 1; index < bytes.length; index += 1) bytes[index] = index;

    expect(Array.from(new Uint8Array(decodeVapidPublicKey(base64Url(bytes))))).toEqual(Array.from(bytes));
  });

  it('rejects malformed VAPID keys before invoking PushManager', () => {
    expect(() => decodeVapidPublicKey('base64url-public-key')).toThrow(/65 bytes/);
  });

  it('serializes the browser subscription keys as base64url', () => {
    const p256dh = Uint8Array.from([1, 2, 3]).buffer;
    const auth = Uint8Array.from([4, 5, 6]).buffer;
    const subscription = {
      endpoint: 'https://push.example/subscription',
      getKey(name: PushEncryptionKeyName) {
        return name === 'p256dh' ? p256dh : auth;
      },
    } as unknown as PushSubscription;

    expect(subscriptionToInput(subscription)).toEqual({
      endpoint: 'https://push.example/subscription',
      p256dh: 'AQID',
      auth: 'BAUG',
    });
  });
});
