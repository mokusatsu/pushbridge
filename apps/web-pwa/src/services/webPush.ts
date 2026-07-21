import type { WebPushSubscriptionInput } from '@/types';

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function decodeVapidPublicKey(value: string): ArrayBuffer {
  const normalized = value.trim().replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  let binary: string;
  try {
    binary = atob(padded);
  } catch (error) {
    throw new Error('サーバーのVAPID公開鍵がBase64 URL形式ではありません。', { cause: error });
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytes.length !== 65 || bytes[0] !== 0x04) {
    throw new Error('サーバーのVAPID公開鍵は非圧縮P-256公開鍵（65 bytes）ではありません。');
  }
  return bytes.buffer;
}

export function subscriptionToInput(subscription: PushSubscription): WebPushSubscriptionInput {
  const p256dh = subscription.getKey('p256dh');
  const auth = subscription.getKey('auth');
  if (!p256dh || !auth) throw new Error('ブラウザーのPush Subscriptionから暗号鍵を取得できません。');
  return {
    endpoint: subscription.endpoint,
    p256dh: bytesToBase64Url(new Uint8Array(p256dh)),
    auth: bytesToBase64Url(new Uint8Array(auth)),
  };
}

export function webPushSupport(): { supported: boolean; reason?: string } {
  if (!('serviceWorker' in navigator)) return { supported: false, reason: 'Service Workerに対応していません。' };
  if (!('PushManager' in window)) return { supported: false, reason: 'Push APIに対応していません。' };
  if (!('Notification' in window)) return { supported: false, reason: '通知APIに対応していません。' };
  return { supported: true };
}

export async function getActiveServiceWorkerRegistration(): Promise<ServiceWorkerRegistration> {
  const support = webPushSupport();
  if (!support.supported) throw new Error(support.reason);

  const existing = await navigator.serviceWorker.getRegistration('/');
  if (existing?.active) return existing;

  if (!import.meta.env.PROD) {
    throw new Error('Web Push登録は、`npm run build`後に`npm run serve:local`で起動したPWAから試してください。');
  }

  const registration = existing ?? await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  if (registration.active) return registration;

  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise<never>((_, reject) => window.setTimeout(
      () => reject(new Error('Service Workerの有効化を確認できませんでした。ページを再読み込みしてください。')),
      10_000,
    )),
  ]);
}
