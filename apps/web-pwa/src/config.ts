import type { AuthMode, ClientSettings } from './types';

const SETTINGS_KEY = 'pushbridge.client-settings.v2';
const SESSION_TOKEN_KEY = 'pushbridge.bearer-token.session.v2';
const LOCAL_TOKEN_KEY = 'pushbridge.bearer-token.local.v2';

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeAuthMode(value: string | undefined): AuthMode {
  return value === 'none' || value === 'cookie' ? value : 'bearer';
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return value !== 'false' && value !== '0';
}

const defaults: Omit<ClientSettings, 'bearerToken'> = {
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL || '/api/v1',
  realtimePath: import.meta.env.VITE_REALTIME_PATH || '/realtime',
  authMode: normalizeAuthMode(import.meta.env.VITE_AUTH_MODE),
  rememberBearerToken: parseBoolean(import.meta.env.VITE_REMEMBER_BEARER_TOKEN, true),
  currentDeviceId: import.meta.env.VITE_CURRENT_DEVICE_ID || '',
  storageNamespace: import.meta.env.VITE_STORAGE_NAMESPACE || 'relaymock-local',
  pollIntervalSeconds: parsePositiveInt(import.meta.env.VITE_POLL_INTERVAL_SECONDS, 30),
  autoCacheReceivedFiles: parseBoolean(import.meta.env.VITE_AUTO_CACHE_RECEIVED_FILES, true),
  localFileCacheMaxBytes: parsePositiveInt(import.meta.env.VITE_LOCAL_FILE_CACHE_MAX_BYTES, 512 * 1024 * 1024),
};

function safeLocalStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function safeSessionStorage(): Storage | undefined {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

export function loadClientSettings(): ClientSettings {
  let persisted: Partial<Omit<ClientSettings, 'bearerToken'>> = {};
  const raw = safeLocalStorage()?.getItem(SETTINGS_KEY);
  if (raw) {
    try {
      persisted = JSON.parse(raw) as Partial<Omit<ClientSettings, 'bearerToken'>>;
    } catch {
      persisted = {};
    }
  }

  const rememberBearerToken = persisted.rememberBearerToken ?? defaults.rememberBearerToken;
  const bearerToken = rememberBearerToken
    ? safeLocalStorage()?.getItem(LOCAL_TOKEN_KEY) ?? ''
    : safeSessionStorage()?.getItem(SESSION_TOKEN_KEY) ?? '';

  return {
    ...defaults,
    ...persisted,
    authMode: normalizeAuthMode(persisted.authMode ?? defaults.authMode),
    rememberBearerToken,
    pollIntervalSeconds: Math.max(5, persisted.pollIntervalSeconds ?? defaults.pollIntervalSeconds),
    autoCacheReceivedFiles: persisted.autoCacheReceivedFiles ?? defaults.autoCacheReceivedFiles,
    localFileCacheMaxBytes: Math.max(0, persisted.localFileCacheMaxBytes ?? defaults.localFileCacheMaxBytes),
    bearerToken,
  };
}

export function saveClientSettings(settings: ClientSettings): void {
  const { bearerToken, ...persisted } = settings;
  safeLocalStorage()?.setItem(SETTINGS_KEY, JSON.stringify(persisted));
  safeLocalStorage()?.removeItem(LOCAL_TOKEN_KEY);
  safeSessionStorage()?.removeItem(SESSION_TOKEN_KEY);

  if (bearerToken) {
    if (settings.rememberBearerToken) safeLocalStorage()?.setItem(LOCAL_TOKEN_KEY, bearerToken);
    else safeSessionStorage()?.setItem(SESSION_TOKEN_KEY, bearerToken);
  }
}

export function clearClientSettings(): void {
  safeLocalStorage()?.removeItem(SETTINGS_KEY);
  safeLocalStorage()?.removeItem(LOCAL_TOKEN_KEY);
  safeSessionStorage()?.removeItem(SESSION_TOKEN_KEY);
}

export function applicationVersion(): string {
  return __APP_VERSION__;
}
