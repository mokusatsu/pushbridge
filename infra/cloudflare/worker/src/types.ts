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
  file_ref_state?: string | null;
  file_ref_size?: number | null;
  file_ref_expires_at?: number | null;
  file_ref_deleted_at?: number | null;
  file_ref_delete_reason?: string | null;
  file_ref_alias_expires_at?: number | null;
}

export interface FileRow {
  id: string;
  user_id: string;
  r2_key: string;
  original_name: string;
  content_type: string;
  expected_size: number;
  actual_size: number | null;
  expected_sha256: string | null;
  actual_sha256: string | null;
  state: "pending" | "uploaded" | "ready" | "delete_pending" | "expired" | "deleted";
  created_at: number;
  completed_at: number | null;
  expires_at: number;
  deleted_at: number | null;
  delete_reason: "retention_expired" | "storage_pressure" | "user_deleted" | null;
  alias_expires_at: number;
  upload_reservation_expires_at: number | null;
  r2_delete_attempts: number;
  r2_delete_retry_at: number | null;
  r2_delete_error_code: string | null;
}
