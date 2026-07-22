import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
} from '@simplewebauthn/browser';
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import type { ApiClient } from '@/api/client';
import type { Device, PasskeyPublicConfig } from '@/types';

interface Challenge<T> {
  challenge_id: string;
  public_key: T;
  expires_at: string;
}

export interface PasskeySession {
  csrf_token: string;
  expires_at: string;
  user?: { id: string; handle: string; created_at: string };
  device?: Device;
}

export function passkeysSupported(): boolean {
  return browserSupportsWebAuthn();
}

export async function getPasskeyConfig(api: ApiClient): Promise<PasskeyPublicConfig> {
  return api.request('/auth/config') as Promise<PasskeyPublicConfig>;
}

export async function registerPasskey(api: ApiClient, input: { handle: string; device_name: string; turnstile_token?: string }): Promise<PasskeySession> {
  const challenge = await api.request('/auth/passkeys/registration/options', {
    method: 'POST',
    body: JSON.stringify({ ...input, device_kind: 'pwa' }),
  }) as Challenge<PublicKeyCredentialCreationOptionsJSON>;
  const credential = await startRegistration({ optionsJSON: challenge.public_key });
  return api.request('/auth/passkeys/registration/verify', {
    method: 'POST',
    body: JSON.stringify({ challenge_id: challenge.challenge_id, credential }),
  }) as Promise<PasskeySession>;
}

export async function authenticatePasskey(api: ApiClient, handle?: string): Promise<PasskeySession> {
  const challenge = await api.request('/auth/passkeys/authentication/options', {
    method: 'POST',
    body: JSON.stringify(handle ? { handle } : {}),
  }) as Challenge<PublicKeyCredentialRequestOptionsJSON>;
  const credential = await startAuthentication({ optionsJSON: challenge.public_key });
  return api.request('/auth/passkeys/authentication/verify', {
    method: 'POST',
    body: JSON.stringify({ challenge_id: challenge.challenge_id, credential }),
  }) as Promise<PasskeySession>;
}
