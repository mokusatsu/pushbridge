export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  USER_HUB: DurableObjectNamespace;
  DELIVERY_QUEUE?: Queue;
  APP_NAME?: string;
  APP_ENVIRONMENT?: string;
  FILE_RETENTION_POLICY?: string;
  TURNSTILE_SECRET_KEY?: string;
  TURNSTILE_SITE_KEY?: string;
  ENABLE_DEV_BOOTSTRAP?: string;
  REQUIRE_DEV_BOOTSTRAP_TURNSTILE?: string;
  DEV_BOOTSTRAP_RATE_LIMIT?: string;
  PASSKEY_RP_ID?: string;
  PASSKEY_EXPECTED_ORIGINS?: string;
  PASSKEY_RP_NAME?: string;
  REQUIRE_PASSKEY_TURNSTILE?: string;
  AUTH_RATE_LIMIT?: string;
  ACCOUNT_AUTH_RATE_LIMIT?: string;
  DEVICE_MUTATION_RATE_LIMIT?: string;
  REQUIRE_E2EE?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  WEB_PUSH_DATA_KEY?: string;
  STORAGE_BUDGET_BYTES?: string;
  STORAGE_PRESSURE_HIGH_PERCENT?: string;
  STORAGE_CLEANUP_TARGET_PERCENT?: string;
  STORAGE_MONTHLY_BYTE_DAY_BUDGET?: string;
  TEST_MIGRATIONS?: Array<{ name: string; queries: string[] }>;
}

export interface AuthContext {
  user_id: string;
  device_id: string;
  handle: string;
  cursor_key: string;
  session_token_hash: string;
  auth_method: "bearer" | "cookie";
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
  key_version: number | null;
  encryption_salt: string | null;
  ciphertext: string | ArrayBuffer;
  nonce: string | ArrayBuffer;
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
  e2ee: number;
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

export interface SubscriptionRow {
  id: string;
  user_id: string;
  device_id: string;
  endpoint_ciphertext: string | ArrayBuffer;
  endpoint_hash: string;
  endpoint_nonce: string;
  p256dh_ciphertext: string | ArrayBuffer;
  p256dh_nonce: string;
  auth_ciphertext: string | ArrayBuffer;
  auth_nonce: string;
  storage_namespace: string | null;
  local_cache_max_bytes: number | null;
  consecutive_failures: number;
  last_failure_code: string | null;
  last_success_at: number | null;
  created_at: number;
  updated_at: number;
  revoked_at: number | null;
}

export type FileDeliveryState = "pending" | "notified" | "fetching" | "cached" | "failed_retryable" | "missed";

export interface FileDeliveryRow {
  id: string;
  user_id: string;
  push_id: string;
  file_id: string;
  destination_device_id: string;
  state: FileDeliveryState;
  ack_token_hash: string | null;
  ack_token_expires_at: number | null;
  created_at: number;
  updated_at: number;
  notified_at: number | null;
  fetching_at: number | null;
  cached_at: number | null;
  failed_at: number | null;
  missed_at: number | null;
  failure_code: string | null;
  attempt_count: number;
}
