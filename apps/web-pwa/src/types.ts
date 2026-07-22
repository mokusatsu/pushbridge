export type PushType = 'note' | 'link' | 'file';
export type PushStatus = 'active' | 'dismissed' | 'deleted' | 'expired';
export type FileState = 'pending' | 'uploaded' | 'ready' | 'expired' | 'deleted';
export type FileDeleteReason = 'retention_expired' | 'storage_pressure' | 'user_deleted';
export type DeviceKind = 'pwa' | 'web' | 'browser_extension' | 'test' | 'unknown';
export type TargetKind = 'all_other_devices' | 'all_devices' | 'device';

export interface PushTarget {
  kind: TargetKind;
  device_id?: string;
  device_name?: string;
}

export interface FileAttachment {
  id: string;
  name: string;
  mime_type: string;
  size: number;
  state?: FileState;
  expires_at?: string | null;
  sha256?: string | null;
  deleted_at?: string | null;
  delete_reason?: FileDeleteReason | null;
  alias_expires_at?: string | null;
}

export interface PushRecord {
  id: string;
  user_id?: string;
  client_guid: string;
  type: PushType;
  source_device_id?: string | null;
  source_device_name?: string | null;
  target: PushTarget;
  payload_version?: number;
  title?: string | null;
  body?: string | null;
  url?: string | null;
  file_id?: string | null;
  file?: FileAttachment | null;
  pinned: boolean;
  status: PushStatus;
  created_at: string;
  modified_at: string;
  dismissed_at?: string | null;
  deleted_at?: string | null;
  expires_at?: string | null;
  expired_at?: string | null;
  is_for_current_device?: boolean;
  /** Client-only state. These fields are never sent to the REST API. */
  local_archived_at?: string | null;
  local_file_cached?: boolean;
  local_file_delivery?: 'cached' | 'pending' | 'missed';
}

export interface CachedFile {
  file_id: string;
  push_id: string;
  name: string;
  mime_type: string;
  size: number;
  blob: Blob;
  cached_at: string;
  last_accessed_at: string;
  pinned: boolean;
}

export interface LocalStorageUsage {
  cached_file_count: number;
  cached_file_bytes: number;
  cache_limit_bytes: number;
  persistence: 'granted' | 'not-granted' | 'unsupported' | 'unknown';
}

export interface Device {
  id: string;
  user_id?: string;
  name: string;
  kind: DeviceKind;
  public_key?: string | null;
  active: boolean;
  is_current?: boolean;
  created_at: string;
  last_seen_at?: string | null;
  revoked_at?: string | null;
}

export interface UserAccount {
  id: string;
  handle: string;
  created_at: string;
}

export interface BootstrapRequest {
  handle: string;
  device_name: string;
  device_kind?: Exclude<DeviceKind, 'unknown'>;
  public_key?: string | null;
  turnstile_token?: string | null;
}

export interface DeviceCredential {
  device: Device;
  access_token: string;
  token_type: 'bearer';
  expires_at: string;
}

export interface BootstrapResponse extends DeviceCredential {
  user: UserAccount;
}

export interface LinkDeviceRequest {
  name: string;
  kind: Exclude<DeviceKind, 'unknown'>;
  public_key?: string | null;
}

export interface FeatureCapabilities {
  realtime: boolean;
  web_push_delivery: boolean;
  web_push_subscription_registration: boolean;
  e2ee: boolean;
  direct_upload: boolean;
  device_registration: boolean;
}

export interface LimitCapabilities {
  max_file_bytes: number;
  max_push_payload_bytes: number;
  file_ttl_seconds: number[];
  default_push_ttl_seconds: number;
  default_file_ttl_seconds: number;
  file_alias_ttl_seconds: number;
  max_devices: number;
}

export interface SystemCapabilities {
  api_version: string;
  environment_id: string;
  features: FeatureCapabilities;
  limits: LimitCapabilities;
  transports: {
    realtime: string[];
    upload: string[];
  };
  recommended_poll_interval_seconds: number;
}

export interface StorageUsage {
  used_bytes: number;
  reserved_bytes: number;
  quota_bytes: number;
  reclaimable_bytes: number;
  pressure: 'normal' | 'notice' | 'constrained' | 'emergency';
  policy_id: string;
  default_retention_days: number;
  early_eviction_possible: boolean;
}

export interface SendPushDraft {
  type: PushType;
  target: PushTarget;
  title?: string;
  body?: string;
  url?: string;
  expires_in?: number;
}

export interface SendPushRequest extends SendPushDraft {
  client_guid: string;
  source_device_id?: string;
  file_id?: string;
  file?: FileAttachment;
}

export interface FileInitRequest {
  name: string;
  mime_type: string;
  size: number;
  expires_in: number;
  sha256?: string;
}

export interface UploadInstruction {
  method: 'PUT' | 'POST';
  url: string;
  headers: Record<string, string>;
  expires_at: string;
}

export interface FileInitResponse {
  file_id: string;
  file?: FileAttachment;
  upload: UploadInstruction;
}

export interface DownloadTicket {
  file_id?: string;
  download: {
    url: string;
    expires_at: string;
  };
}

export interface ChangeEvent {
  cursor: string;
  type: 'push.upsert' | 'push.delete' | 'device.upsert' | 'device.delete';
  entity_id: string;
  push?: PushRecord;
  device?: Device;
}

export interface ChangesResponse {
  items: ChangeEvent[];
  next_cursor: string | null;
  has_more: boolean;
}

export interface RealtimeTicket {
  ticket: string;
  url?: string;
  expires_at?: string;
}

export interface RealtimeEnvelope {
  event_version?: number;
  event_id?: string;
  type: 'sync_required' | 'ping' | 'connected';
  cursor_hint?: string;
  reason?: string;
}

export interface WebPushConfig {
  subscription_registration: boolean;
  delivery: boolean;
  vapid_public_key: string;
}

export interface WebPushSubscriptionInput {
  endpoint: string;
  p256dh: string;
  auth: string;
  storage_namespace?: string;
  local_cache_max_bytes?: number;
}

export interface WebPushSubscriptionRecord {
  id: string;
  device_id: string;
  endpoint: string;
  created_at: string;
  revoked_at?: string | null;
}

export type AuthMode = 'none' | 'cookie' | 'bearer';

export interface ClientSettings {
  apiBaseUrl: string;
  realtimePath: string;
  authMode: AuthMode;
  bearerToken: string;
  rememberBearerToken: boolean;
  currentDeviceId: string;
  storageNamespace: string;
  pollIntervalSeconds: number;
  autoCacheReceivedFiles: boolean;
  localFileCacheMaxBytes: number;
}

export type OutboxStatus = 'queued' | 'sending' | 'failed';

export interface QueuedFile {
  blob: Blob;
  name: string;
  mime_type: string;
  size: number;
}

export interface OutboxJob {
  id: string;
  kind: 'send_push';
  status: OutboxStatus;
  created_at: string;
  updated_at: string;
  next_attempt_at: string;
  attempts: number;
  draft: SendPushDraft;
  file?: QueuedFile;
  uploaded_file?: FileAttachment;
  last_error?: string;
}

export type ConnectionState = 'online' | 'offline' | 'degraded' | 'checking';

export interface RuntimeNotice {
  id: string;
  kind: 'success' | 'error' | 'info';
  message: string;
}

export interface RuntimeSnapshot {
  initialized: boolean;
  syncing: boolean;
  processingOutbox: boolean;
  connection: ConnectionState;
  realtimeConnected: boolean;
  pushes: PushRecord[];
  devices: Device[];
  outbox: OutboxJob[];
  capabilities?: SystemCapabilities;
  storageUsage?: StorageUsage;
  currentDevice?: Device;
  webPushConfig?: WebPushConfig;
  webPushSubscriptions: WebPushSubscriptionRecord[];
  lastSyncAt?: string;
  notice?: RuntimeNotice;
  localStorageUsage: LocalStorageUsage;
}
