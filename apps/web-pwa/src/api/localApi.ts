import type {
  BootstrapRequest,
  BootstrapResponse,
  ChangesResponse,
  Device,
  DeviceCredential,
  DownloadTicket,
  FileAttachment,
  FileInitRequest,
  FileInitResponse,
  LinkDeviceRequest,
  PushRecord,
  RealtimeTicket,
  SendPushRequest,
  SystemCapabilities,
  StorageUsage,
  WebPushConfig,
  WebPushSubscriptionInput,
  WebPushSubscriptionRecord,
} from '@/types';
import { ApiClient } from './client';
import { ApiError } from './errors';
import {
  bootstrapResponseSchema,
  capabilitiesSchema,
  deviceResponseSchema,
  devicesResponseSchema,
  downloadTicketSchema,
  fileCompleteResponseSchema,
  fileInitResponseSchema,
  fileMetadataResponseSchema,
  healthSchema,
  linkDeviceResponseSchema,
  pushListResponseSchema,
  pushResponseSchema,
  realtimeTicketSchema,
  subscriptionSchema,
  storageUsageSchema,
  subscriptionsResponseSchema,
  webPushConfigSchema,
} from './schemas';

/**
 * RelayMock-specific paths and wire transformations live in this module.
 * The React screens, IndexedDB layer and outbox only use normalized models.
 */
export const endpoints = {
  capabilities: '/system/capabilities',
  storageUsage: '/storage/usage',
  webPushConfig: '/web-push-config',
  bootstrap: '/auth/bootstrap',
  devices: '/devices',
  currentDevice: '/devices/me',
  linkDevice: '/devices/link',
  pushes: '/pushes',
  files: '/files',
  realtimeTicket: '/realtime-ticket',
  subscriptions: '/web-push-subscriptions',
} as const;

const relayMockCapabilities: SystemCapabilities = {
  api_version: '0.1.0-compat',
  environment_id: 'relaymock-local',
  features: {
    realtime: false,
    web_push_delivery: false,
    web_push_subscription_registration: false,
    e2ee: false,
    direct_upload: true,
    device_registration: true,
  },
  limits: {
    max_file_bytes: 25 * 1024 * 1024,
    max_push_payload_bytes: 2_000_000,
    file_ttl_seconds: [86_400, 604_800, 2_592_000],
    default_push_ttl_seconds: 2_592_000,
    default_file_ttl_seconds: 2_592_000,
    file_alias_ttl_seconds: 15_552_000,
    max_devices: 10,
  },
  transports: {
    realtime: ['poll'],
    upload: ['server-ticket'],
  },
  recommended_poll_interval_seconds: 30,
};

function compactObject(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function wireTarget(input: SendPushRequest['target']): Record<string, unknown> {
  if (input.kind === 'device') {
    if (!input.device_id) throw new ApiError('特定端末宛にはdevice_idが必要です。', { status: 422, code: 'client_invalid_target' });
    return { kind: 'device', device_id: input.device_id };
  }
  return { kind: input.kind };
}

/** Build one of RelayMock 0.1.1's six mutually exclusive PushCreate shapes. */
export function buildRelayMockPushBody(input: SendPushRequest): Record<string, unknown> {
  const common = compactObject({
    target: wireTarget(input.target),
    payload_version: 1,
    client_guid: input.client_guid,
    expires_in: input.expires_in,
  });

  if (input.type === 'note') {
    const payload = compactObject({ title: input.title, body: input.body });
    if (Object.keys(payload).length === 0) {
      throw new ApiError('ノートにはタイトルまたは本文が必要です。', { status: 422, code: 'client_invalid_note' });
    }
    return { ...common, type: 'note', payload };
  }

  if (input.type === 'link') {
    if (!input.url) throw new ApiError('リンクPushにはURLが必要です。', { status: 422, code: 'client_invalid_link' });
    return {
      ...common,
      type: 'link',
      payload: compactObject({ url: input.url, title: input.title, body: input.body }),
    };
  }

  if (!input.file_id || !input.file) {
    throw new ApiError('ファイルPushには完了済みのfile_idとメタデータが必要です。', {
      status: 422,
      code: 'client_invalid_file_push',
    });
  }
  return {
    ...common,
    type: 'file',
    file_id: input.file_id,
    payload: compactObject({
      title: input.title,
      body: input.body,
      file: {
        name: input.file.name,
        mime_type: input.file.mime_type,
        size: input.file.size,
        sha256: input.file.sha256 ?? null,
        expires_at: input.file.expires_at ?? null,
      },
    }),
  };
}

export class LocalApi {
  private readonly fileCache = new Map<string, FileAttachment>();

  constructor(readonly client: ApiClient) {}

  async health(): Promise<Record<string, string>> {
    return healthSchema.parse(await this.client.requestUrl('/health'));
  }

  async getCapabilities(): Promise<SystemCapabilities> {
    try {
      return capabilitiesSchema.parse(await this.client.request(endpoints.capabilities));
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 404) throw error;
      await this.health();
      return relayMockCapabilities;
    }
  }

  async getStorageUsage(): Promise<StorageUsage> {
    return storageUsageSchema.parse(await this.client.request(endpoints.storageUsage));
  }

  async getWebPushConfig(): Promise<WebPushConfig | undefined> {
    try {
      return webPushConfigSchema.parse(await this.client.request(endpoints.webPushConfig));
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return undefined;
      throw error;
    }
  }

  async bootstrap(input: BootstrapRequest): Promise<BootstrapResponse> {
    return bootstrapResponseSchema.parse(await this.client.request(endpoints.bootstrap, {
      method: 'POST',
      body: JSON.stringify({
        handle: input.handle,
        device_name: input.device_name,
        device_kind: input.device_kind ?? 'pwa',
        public_key: input.public_key ?? null,
      }),
    }));
  }

  async listDevices(): Promise<Device[]> {
    return devicesResponseSchema.parse(await this.client.request(endpoints.devices));
  }

  async getCurrentDevice(): Promise<Device> {
    return deviceResponseSchema.parse(await this.client.request(endpoints.currentDevice));
  }

  async linkDevice(input: LinkDeviceRequest): Promise<DeviceCredential> {
    return linkDeviceResponseSchema.parse(await this.client.request(endpoints.linkDevice, {
      method: 'POST',
      body: JSON.stringify({
        name: input.name,
        kind: input.kind,
        public_key: input.public_key ?? null,
      }),
    }));
  }

  async renameDevice(deviceId: string, name: string): Promise<Device> {
    return deviceResponseSchema.parse(await this.client.request(`${endpoints.devices}/${encodeURIComponent(deviceId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }));
  }

  async revokeDevice(deviceId: string): Promise<void> {
    await this.client.request(`${endpoints.devices}/${encodeURIComponent(deviceId)}`, { method: 'DELETE' });
  }

  async getChanges(cursor: string, limit = 100): Promise<ChangesResponse> {
    const query = new URLSearchParams({
      limit: String(limit),
      include_deleted: 'true',
    });
    if (cursor) query.set('after', cursor);

    const changes = pushListResponseSchema.parse(
      await this.client.request(`${endpoints.pushes}?${query.toString()}`),
    );

    await Promise.all(changes.items.map(async (change) => {
      if (change.type !== 'push.upsert' || !change.push?.file_id) return;
      if (change.push.file) {
        this.fileCache.set(change.push.file.id, change.push.file);
        return;
      }
      if (change.push.status === 'expired' || change.push.status === 'deleted') return;
      change.push.file = await this.getFileMetadata(change.push.file_id).catch((error: unknown) => {
        if (error instanceof ApiError && (error.status === 404 || error.status === 410)) return null;
        throw error;
      });
      if (change.push.file) this.fileCache.set(change.push.file.id, change.push.file);
    }));

    return changes;
  }

  async getPush(pushId: string): Promise<PushRecord> {
    const push = pushResponseSchema.parse(
      await this.client.request(`${endpoints.pushes}/${encodeURIComponent(pushId)}`),
    );
    return this.rememberPushFile(await this.hydratePushFile(push));
  }

  async createPush(input: SendPushRequest, idempotencyKey: string): Promise<PushRecord> {
    const push = pushResponseSchema.parse(await this.client.request(endpoints.pushes, {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(buildRelayMockPushBody(input)),
    }));

    if (input.file) {
      push.file = push.file ? { ...input.file, ...push.file, name: input.file.name, mime_type: input.file.mime_type } : input.file;
    }
    return this.rememberPushFile(await this.hydratePushFile(push));
  }

  async setDismissed(pushId: string, dismissed: boolean): Promise<PushRecord> {
    return this.rememberPushFile(pushResponseSchema.parse(await this.client.request(`${endpoints.pushes}/${encodeURIComponent(pushId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ dismissed }),
    })));
  }

  async setPinned(pushId: string, pinned: boolean): Promise<PushRecord> {
    return this.rememberPushFile(pushResponseSchema.parse(await this.client.request(`${endpoints.pushes}/${encodeURIComponent(pushId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ pinned }),
    })));
  }

  async deletePush(pushId: string): Promise<PushRecord> {
    return pushResponseSchema.parse(await this.client.request(`${endpoints.pushes}/${encodeURIComponent(pushId)}`, {
      method: 'DELETE',
    }));
  }

  async initFile(input: FileInitRequest): Promise<FileInitResponse> {
    const result = fileInitResponseSchema.parse(await this.client.request(`${endpoints.files}/init`, {
      method: 'POST',
      body: JSON.stringify({
        filename: input.name,
        content_type: input.mime_type,
        size: input.size,
        sha256: input.sha256 ?? null,
        expires_in: input.expires_in,
      }),
    }));
    if (result.file) this.fileCache.set(result.file.id, result.file);
    return result;
  }

  async uploadFile(init: FileInitResponse, blob: Blob): Promise<void> {
    await this.client.upload(init.upload, blob);
  }

  async completeFile(fileId: string): Promise<FileAttachment> {
    const file = fileCompleteResponseSchema.parse(await this.client.request(`${endpoints.files}/${encodeURIComponent(fileId)}/complete`, {
      method: 'POST',
    }));
    this.fileCache.set(file.id, file);
    return file;
  }

  async getFileMetadata(fileId: string): Promise<FileAttachment> {
    const cached = this.fileCache.get(fileId);
    if (cached) return cached;
    const file = fileMetadataResponseSchema.parse(
      await this.client.request(`${endpoints.files}/${encodeURIComponent(fileId)}`),
    );
    this.fileCache.set(file.id, file);
    return file;
  }

  async deleteFile(fileId: string): Promise<FileAttachment> {
    const file = fileMetadataResponseSchema.parse(await this.client.request(`${endpoints.files}/${encodeURIComponent(fileId)}`, {
      method: 'DELETE',
    }));
    this.fileCache.set(fileId, file);
    return file;
  }

  async getDownloadTicket(fileId: string): Promise<DownloadTicket> {
    return downloadTicketSchema.parse(await this.client.request(`${endpoints.files}/${encodeURIComponent(fileId)}/download-ticket`, {
      method: 'POST',
    }));
  }

  async listWebPushSubscriptions(): Promise<WebPushSubscriptionRecord[]> {
    return subscriptionsResponseSchema.parse(await this.client.request(endpoints.subscriptions));
  }

  async createWebPushSubscription(input: WebPushSubscriptionInput): Promise<WebPushSubscriptionRecord> {
    return subscriptionSchema.parse(await this.client.request(endpoints.subscriptions, {
      method: 'POST',
      body: JSON.stringify(input),
    }));
  }

  async revokeWebPushSubscription(subscriptionId: string): Promise<void> {
    await this.client.request(`${endpoints.subscriptions}/${encodeURIComponent(subscriptionId)}`, { method: 'DELETE' });
  }

  async createRealtimeTicket(): Promise<RealtimeTicket> {
    return realtimeTicketSchema.parse(await this.client.request(endpoints.realtimeTicket, {
      method: 'POST',
    }));
  }

  private rememberPushFile(push: PushRecord): PushRecord {
    if (push.file) this.fileCache.set(push.file.id, push.file);
    return push;
  }

  private async hydratePushFile(push: PushRecord): Promise<PushRecord> {
    if (!push.file_id || push.file || push.status === 'expired' || push.status === 'deleted') return push;
    const file = await this.getFileMetadata(push.file_id).catch((error: unknown) => {
      if (error instanceof ApiError && (error.status === 404 || error.status === 410)) return null;
      throw error;
    });
    return { ...push, file };
  }
}
