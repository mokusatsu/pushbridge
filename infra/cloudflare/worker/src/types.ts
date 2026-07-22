export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  USER_HUB: DurableObjectNamespace;
  DELIVERY_QUEUE?: Queue;
  APP_NAME?: string;
  APP_ENVIRONMENT?: string;
  FILE_RETENTION_POLICY?: string;
  TURNSTILE_SECRET_KEY?: string;
  ENABLE_DEV_BOOTSTRAP?: string;
  REQUIRE_DEV_BOOTSTRAP_TURNSTILE?: string;
  DEV_BOOTSTRAP_RATE_LIMIT?: string;
  TEST_MIGRATIONS?: Array<{ name: string; queries: string[] }>;
}

export interface AuthContext {
  user_id: string;
  device_id: string;
  handle: string;
  cursor_key: string;
}

export interface Runtime {
  now(): number;
  id(prefix: string): string;
  token(): string;
}

export interface DeviceRow {
  id: string;
  user_id: string;
  kind: string;
  name_ciphertext: string | ArrayBuffer | null;
  public_key: string | ArrayBuffer | null;
  created_at: number;
  last_seen_at: number | null;
  revoked_at: number | null;
}

export interface PushRow {
  id: string;
  user_id: string;
  source_device_id: string;
  target_device_id: string | null;
  target_kind: string;
  type: string;
  file_id: string | null;
  payload_version: number;
  payload_json: string | null;
  client_guid: string;
  pinned_at: number | null;
  status: string;
  created_at: number;
  modified_at: number;
  expires_at: number;
  expired_at: number | null;
  dismissed_at: number | null;
  deleted_at: number | null;
}
