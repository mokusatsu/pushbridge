/// <reference types="vite/client" />

declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_REALTIME_PATH?: string;
  readonly VITE_AUTH_MODE?: 'none' | 'cookie' | 'bearer';
  readonly VITE_CURRENT_DEVICE_ID?: string;
  readonly VITE_REMEMBER_BEARER_TOKEN?: string;
  readonly VITE_STORAGE_NAMESPACE?: string;
  readonly VITE_POLL_INTERVAL_SECONDS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
  prompt(): Promise<void>;
}
