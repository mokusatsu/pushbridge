import { z } from 'zod';
import type {
  Device,
  DeviceKind,
  FileAttachment,
  FileState,
  PushRecord,
  SystemCapabilities,
} from '@/types';

const nullableString = z.string().nullable();
const optionalNullableString = nullableString.optional();
const payloadSchema = z.record(z.string(), z.unknown());
const fileStateSchema = z.enum(['pending', 'uploaded', 'ready', 'expired', 'deleted']);
const fileDeleteReasonSchema = z.enum(['retention_expired', 'storage_pressure', 'user_deleted']);

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export const userSchema = z.object({
  id: z.string(),
  handle: z.string(),
  created_at: z.string(),
}).strict();

const deviceWireSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  kind: z.string(),
  name: z.string(),
  public_key: nullableString,
  created_at: z.string(),
  last_seen_at: z.string(),
  revoked_at: nullableString,
  is_current: z.boolean().default(false),
}).strict();

export const deviceSchema = deviceWireSchema.transform((value): Device => {
  const kind: DeviceKind = value.kind === 'pwa' || value.kind === 'web' || value.kind === 'browser_extension' || value.kind === 'test'
    ? value.kind
    : 'unknown';
  return {
    id: value.id,
    user_id: value.user_id,
    name: value.name,
    kind,
    public_key: value.public_key,
    active: value.revoked_at === null,
    is_current: value.is_current,
    created_at: value.created_at,
    last_seen_at: value.last_seen_at,
    revoked_at: value.revoked_at,
  };
});

const fileWireSchema = z.object({
  id: z.string(),
  original_name: z.string(),
  content_type: z.string(),
  expected_size: z.number().nonnegative(),
  actual_size: z.number().nonnegative().nullable(),
  expected_sha256: nullableString,
  actual_sha256: nullableString,
  state: fileStateSchema,
  created_at: z.string(),
  completed_at: nullableString,
  expires_at: z.string(),
  deleted_at: nullableString,
  delete_reason: fileDeleteReasonSchema.nullable().optional().default(null),
  alias_expires_at: nullableString.optional().default(null),
}).strict();

export const fileAttachmentSchema = fileWireSchema.transform((value): FileAttachment => ({
  id: value.id,
  name: value.original_name,
  mime_type: value.content_type || 'application/octet-stream',
  size: value.actual_size ?? value.expected_size,
  state: value.state,
  expires_at: value.expires_at,
  sha256: value.actual_sha256 ?? value.expected_sha256,
  deleted_at: value.deleted_at,
  delete_reason: value.delete_reason,
  alias_expires_at: value.alias_expires_at,
}));

const fileRefWireSchema = z.object({
  id: z.string(),
  state: fileStateSchema,
  size: z.number().nonnegative(),
  expires_at: z.string(),
  deleted_at: nullableString.optional().default(null),
  delete_reason: fileDeleteReasonSchema.nullable().optional().default(null),
  alias_expires_at: nullableString.optional().default(null),
}).strict();

export const pushTargetSchema = z.object({
  kind: z.enum(['all_other_devices', 'all_devices', 'device']).default('all_other_devices'),
  device_id: optionalNullableString,
}).strict().transform((value) => ({
  kind: value.kind,
  ...(value.device_id ? { device_id: value.device_id } : {}),
}));

const pushWireSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  source_device_id: z.string(),
  target: pushTargetSchema,
  type: z.enum(['note', 'link', 'file']),
  file_id: nullableString,
  file_ref: fileRefWireSchema.nullable().optional().default(null),
  payload_version: z.number().int().positive(),
  payload: payloadSchema.nullable(),
  ciphertext: nullableString,
  nonce: nullableString,
  client_guid: z.string(),
  pinned: z.boolean(),
  status: z.enum(['active', 'dismissed', 'deleted', 'expired']),
  created_at: z.string(),
  modified_at: z.string(),
  expires_at: nullableString,
  expired_at: nullableString,
  dismissed_at: nullableString,
  deleted_at: nullableString,
  is_for_current_device: z.boolean(),
}).strict();

function normalizeFileState(value: unknown): FileState | undefined {
  return value === 'pending' || value === 'uploaded' || value === 'ready' || value === 'expired' || value === 'deleted'
    ? value
    : undefined;
}

function fileFromPayload(
  fileId: string | null,
  payload: Record<string, unknown> | null,
  fileRef: z.infer<typeof fileRefWireSchema> | null,
): FileAttachment | null {
  if (!fileId) return null;
  const nested = payload?.file;
  const source = typeof nested === 'object' && nested !== null
    ? nested as Record<string, unknown>
    : {};
  const name = stringValue(source.name) ?? stringValue(source.filename) ?? stringValue(source.original_name);
  const mimeType = stringValue(source.mime_type) ?? stringValue(source.content_type);
  const payloadSize = numberValue(source.size) ?? numberValue(source.actual_size) ?? numberValue(source.expected_size);
  const payloadExpiresAt = stringValue(source.expires_at);
  const sha256 = stringValue(source.sha256) ?? stringValue(source.actual_sha256) ?? stringValue(source.expected_sha256);
  const payloadState = normalizeFileState(source.state);

  if (!name && payloadSize === undefined && !mimeType && !fileRef) return null;
  return {
    id: fileId,
    name: name ?? `ファイル ${fileId}`,
    mime_type: mimeType ?? 'application/octet-stream',
    size: fileRef?.size ?? payloadSize ?? 0,
    state: fileRef?.state ?? payloadState,
    expires_at: fileRef?.expires_at ?? payloadExpiresAt ?? null,
    sha256: sha256 ?? null,
    deleted_at: fileRef?.deleted_at ?? null,
    delete_reason: fileRef?.delete_reason ?? null,
    alias_expires_at: fileRef?.alias_expires_at ?? null,
  };
}

export const pushSchema = pushWireSchema.transform((value): PushRecord => {
  const payload = value.payload;
  return {
    id: value.id,
    user_id: value.user_id,
    client_guid: value.client_guid,
    type: value.type,
    source_device_id: value.source_device_id,
    target: value.target,
    payload_version: value.payload_version,
    title: stringValue(payload?.title) ?? null,
    body: stringValue(payload?.body) ?? null,
    url: stringValue(payload?.url) ?? null,
    file_id: value.file_id,
    file: fileFromPayload(value.file_id, payload, value.file_ref),
    pinned: value.pinned,
    status: value.status,
    created_at: value.created_at,
    modified_at: value.modified_at,
    expires_at: value.expires_at,
    expired_at: value.expired_at,
    dismissed_at: value.dismissed_at,
    deleted_at: value.deleted_at,
    is_for_current_device: value.is_for_current_device,
  };
});

export const pushListResponseSchema = z.object({
  items: z.array(pushSchema),
  next_cursor: nullableString,
  has_more: z.boolean(),
}).strict().transform((value) => ({
  items: value.items.map((push) => ({
    cursor: `${push.modified_at}:${push.id}`,
    type: push.status === 'deleted' ? 'push.delete' as const : 'push.upsert' as const,
    entity_id: push.id,
    ...(push.status === 'deleted' ? {} : { push }),
  })),
  next_cursor: value.next_cursor,
  has_more: value.has_more,
}));

export const pushResponseSchema = pushSchema;
export const devicesResponseSchema = z.array(deviceSchema);
export const deviceResponseSchema = deviceSchema;

export const bootstrapResponseSchema = z.object({
  user: userSchema,
  device: deviceSchema,
  access_token: z.string(),
  token_type: z.literal('bearer').default('bearer'),
  expires_at: z.string(),
}).strict();

export const linkDeviceResponseSchema = z.object({
  device: deviceSchema,
  access_token: z.string(),
  token_type: z.literal('bearer').default('bearer'),
  expires_at: z.string(),
}).strict();

export const fileInitResponseSchema = z.object({
  file: fileAttachmentSchema,
  upload_url: z.string(),
  upload_method: z.literal('PUT').default('PUT'),
  upload_expires_at: z.string(),
  upload_headers: z.record(z.string(), z.string()).default({}),
}).strict().transform((value) => ({
  file_id: value.file.id,
  file: value.file,
  upload: {
    method: value.upload_method,
    url: value.upload_url,
    headers: value.upload_headers,
    expires_at: value.upload_expires_at,
  },
}));

export const fileCompleteResponseSchema = fileAttachmentSchema;
export const fileMetadataResponseSchema = fileAttachmentSchema;

export const downloadTicketSchema = z.object({
  file_id: z.string(),
  download_url: z.string(),
  expires_at: z.string(),
}).strict().transform((value) => ({
  file_id: value.file_id,
  download: {
    url: value.download_url,
    expires_at: value.expires_at,
  },
}));

export const subscriptionSchema = z.object({
  id: z.string(),
  device_id: z.string(),
  endpoint: z.string(),
  created_at: z.string(),
  revoked_at: nullableString,
}).strict();

export const subscriptionsResponseSchema = z.array(subscriptionSchema);

export const webPushConfigSchema = z.object({
  subscription_registration: z.boolean(),
  delivery: z.boolean(),
  vapid_public_key: z.string(),
}).strict();

export const healthSchema = z.record(z.string(), z.string());

const capabilitiesWireSchema = z.object({
  api_version: z.string(),
  environment_id: z.string(),
  features: z.object({
    realtime: z.boolean().default(false),
    web_push_delivery: z.boolean().optional(),
    web_push_subscription_registration: z.boolean().optional(),
    web_push: z.boolean().optional(),
    e2ee: z.boolean().default(false),
    direct_upload: z.boolean().default(true),
    device_registration: z.boolean().default(true),
  }).passthrough(),
  limits: z.object({
    max_file_bytes: z.number().nonnegative().default(25 * 1024 * 1024),
    max_push_payload_bytes: z.number().nonnegative().optional(),
    file_ttl_seconds: z.array(z.number().positive()).default([86_400, 604_800, 2_592_000]),
    default_push_ttl_seconds: z.number().positive().optional(),
    default_file_ttl_seconds: z.number().positive().optional(),
    file_alias_ttl_seconds: z.number().positive().optional(),
    max_devices: z.number().positive().default(10),
  }).passthrough(),
  transports: z.object({
    realtime: z.array(z.string()).default(['poll']),
    upload: z.array(z.string()).default(['server-ticket']),
  }).passthrough(),
  recommended_poll_interval_seconds: z.number().positive().optional(),
}).passthrough();

export const capabilitiesSchema = capabilitiesWireSchema.transform((value): SystemCapabilities => ({
  api_version: value.api_version,
  environment_id: value.environment_id,
  features: {
    realtime: value.features.realtime,
    web_push_delivery: value.features.web_push_delivery ?? value.features.web_push ?? false,
    web_push_subscription_registration: value.features.web_push_subscription_registration ?? value.features.web_push ?? false,
    e2ee: value.features.e2ee,
    direct_upload: value.features.direct_upload,
    device_registration: value.features.device_registration,
  },
  limits: {
    max_file_bytes: value.limits.max_file_bytes,
    max_push_payload_bytes: value.limits.max_push_payload_bytes ?? 2_000_000,
    file_ttl_seconds: value.limits.file_ttl_seconds,
    default_push_ttl_seconds: value.limits.default_push_ttl_seconds ?? 2_592_000,
    default_file_ttl_seconds: value.limits.default_file_ttl_seconds ?? 86_400,
    file_alias_ttl_seconds: value.limits.file_alias_ttl_seconds ?? 15_552_000,
    max_devices: value.limits.max_devices,
  },
  transports: {
    realtime: value.transports.realtime,
    upload: value.transports.upload,
  },
  recommended_poll_interval_seconds: value.recommended_poll_interval_seconds ?? 30,
}));

export const storageUsageSchema = z.object({
  used_bytes: z.number().nonnegative(),
  reserved_bytes: z.number().nonnegative(),
  quota_bytes: z.number().positive(),
  reclaimable_bytes: z.number().nonnegative(),
  pressure: z.enum(['normal', 'notice', 'constrained', 'emergency']),
  policy_id: z.string(),
  default_retention_days: z.number().int().positive(),
  early_eviction_possible: z.boolean(),
}).strict();

export const realtimeTicketSchema = z.object({
  ticket: z.string(),
  url: z.string().optional(),
  expires_at: z.string().optional(),
}).passthrough();
