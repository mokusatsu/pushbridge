import { ApiClient } from '@/api/client';
import { ApiError, apiErrorMessage } from '@/api/errors';
import { LocalApi } from '@/api/localApi';
import { saveClientSettings } from '@/config';
import type {
  ClientSettings,
  Device,
  DeviceCredential,
  FileAttachment,
  OutboxJob,
  PushRecord,
  RealtimeEnvelope,
  RuntimeNotice,
  RuntimeSnapshot,
  SendPushDraft,
  SystemCapabilities,
  WebPushSubscriptionRecord,
} from '@/types';
import { AppDatabase } from '@/storage/db';
import { subscribeDataChanged } from '@/storage/events';
import { formatBytes, safeFilename } from '@/utils/format';
import { newId } from '@/utils/id';
import { decodeVapidPublicKey, getActiveServiceWorkerRegistration, subscriptionToInput, webPushSupport } from './webPush';

const DEFAULT_MAX_FILE_BYTES = 25 * 1024 * 1024;
const DEFAULT_FILE_TTL_SECONDS = 86_400;
const MAX_SYNC_PAGES = 50;

function nowIso(): string {
  return new Date().toISOString();
}

function retryDelayMs(attempts: number): number {
  return Math.min(5 * 60_000, 2_000 * (2 ** Math.max(0, attempts - 1)));
}

async function sha256Hex(blob: Blob): Promise<string | undefined> {
  if (!crypto.subtle) return undefined;
  const buffer = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function payloadBytes(draft: SendPushDraft, file?: File): number {
  const payload = draft.type === 'note'
    ? { ...(draft.title ? { title: draft.title } : {}), ...(draft.body ? { body: draft.body } : {}) }
    : draft.type === 'link'
      ? { url: draft.url ?? '', ...(draft.title ? { title: draft.title } : {}), ...(draft.body ? { body: draft.body } : {}) }
      : {
          ...(draft.title ? { title: draft.title } : {}),
          ...(draft.body ? { body: draft.body } : {}),
          file: {
            name: file?.name ?? '',
            mime_type: file?.type || 'application/octet-stream',
            size: file?.size ?? 0,
          },
        };
  return new TextEncoder().encode(JSON.stringify(payload)).byteLength;
}

function mergeSubscription(
  subscriptions: WebPushSubscriptionRecord[],
  incoming: WebPushSubscriptionRecord,
): WebPushSubscriptionRecord[] {
  return [incoming, ...subscriptions.filter((value) => value.id !== incoming.id && value.endpoint !== incoming.endpoint)];
}

function initialSnapshot(): RuntimeSnapshot {
  return {
    initialized: false,
    syncing: false,
    processingOutbox: false,
    connection: navigator.onLine ? 'checking' : 'offline',
    realtimeConnected: false,
    pushes: [],
    devices: [],
    outbox: [],
    webPushSubscriptions: [],
    localStorageUsage: {
      cached_file_count: 0,
      cached_file_bytes: 0,
      cache_limit_bytes: 0,
      persistence: 'unknown',
    },
  };
}

export class AppRuntime {
  readonly api: LocalApi;
  readonly db: AppDatabase;

  private snapshot: RuntimeSnapshot = initialSnapshot();
  private readonly subscribers = new Set<() => void>();
  private started = false;
  private destroyed = false;
  private syncPromise?: Promise<void>;
  private outboxPromise?: Promise<void>;
  private unsubscribeStorage?: () => void;
  private pollTimer?: number;
  private reconnectTimer?: number;
  private syncDebounceTimer?: number;
  private websocket?: WebSocket;
  private reconnectAttempts = 0;

  private readonly onlineHandler = () => {
    this.patch({ connection: 'checking' });
    void this.syncNow(false);
    void this.processOutbox();
  };

  private readonly offlineHandler = () => {
    this.closeRealtime();
    this.patch({ connection: 'offline', realtimeConnected: false });
    this.schedulePoll();
  };

  private readonly serviceWorkerMessageHandler = (event: MessageEvent<{ type?: string }>) => {
    if (event.data?.type !== 'WEB_PUSH_RECEIVED') return;
    void this.reloadCached();
    void this.syncNow(false);
  };

  constructor(readonly settings: ClientSettings) {
    this.api = new LocalApi(new ApiClient(settings));
    this.db = new AppDatabase(settings.storageNamespace);
  }

  getSnapshot = (): RuntimeSnapshot => this.snapshot;

  subscribe = (subscriber: () => void): (() => void) => {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  };

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.destroyed = false;
    this.unsubscribeStorage = subscribeDataChanged(() => void this.reloadCached());
    window.addEventListener('online', this.onlineHandler);
    window.addEventListener('offline', this.offlineHandler);
    navigator.serviceWorker?.addEventListener('message', this.serviceWorkerMessageHandler);

    await this.reloadCached();
    await this.refreshStorageUsage(true);
    this.patch({ initialized: true });
    this.schedulePoll();
    if (navigator.onLine) void this.syncNow(false);
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.destroyed = true;
    this.unsubscribeStorage?.();
    window.removeEventListener('online', this.onlineHandler);
    window.removeEventListener('offline', this.offlineHandler);
    navigator.serviceWorker?.removeEventListener('message', this.serviceWorkerMessageHandler);
    if (this.pollTimer) window.clearTimeout(this.pollTimer);
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
    if (this.syncDebounceTimer) window.clearTimeout(this.syncDebounceTimer);
    this.closeRealtime();
  }

  clearNotice(): void {
    if (this.snapshot.notice) this.patch({ notice: undefined });
  }

  notify(kind: RuntimeNotice['kind'], message: string): void {
    this.patch({ notice: { id: newId('notice'), kind, message } });
  }

  async syncNow(showErrors = true): Promise<void> {
    if (this.syncPromise) return this.syncPromise;
    if (!navigator.onLine) {
      this.patch({ connection: 'offline' });
      return;
    }

    this.syncPromise = this.performSync(showErrors).finally(() => {
      this.syncPromise = undefined;
      this.schedulePoll();
    });
    return this.syncPromise;
  }

  private async performSync(showErrors: boolean): Promise<void> {
    this.patch({ syncing: true, connection: this.snapshot.connection === 'online' ? 'online' : 'checking' });
    try {
      const capabilities = this.snapshot.capabilities ?? await this.api.getCapabilities();
      const webPushConfig = this.snapshot.webPushConfig ?? await this.api.getWebPushConfig();
      if (this.settings.authMode === 'bearer' && !this.settings.bearerToken) {
        this.patch({
          capabilities,
          webPushConfig,
          webPushSubscriptions: [],
          syncing: false,
          connection: 'degraded',
        });
        if (showErrors) this.notify('info', '設定画面でRelayMockをBootstrapするか、端末Bearer Tokenを入力してください。');
        return;
      }

      const [currentDevice, devices, webPushSubscriptions, storageUsage] = await Promise.all([
        this.api.getCurrentDevice(),
        this.api.listDevices(),
        capabilities.features.web_push_subscription_registration
          ? this.api.listWebPushSubscriptions()
          : Promise.resolve([]),
        this.api.getStorageUsage().catch(() => undefined),
      ]);
      const normalizedDevices = devices.map((device) => ({
        ...device,
        is_current: device.id === currentDevice.id || device.is_current,
      }));
      await this.db.replaceDevices(normalizedDevices);

      if (this.settings.currentDeviceId !== currentDevice.id) {
        this.settings.currentDeviceId = currentDevice.id;
        saveClientSettings(this.settings);
      }

      let cursor = await this.db.getCursor();
      for (let page = 0; page < MAX_SYNC_PAGES; page += 1) {
        const changes = await this.api.getChanges(cursor, 100);
        const nextCursor = changes.next_cursor ?? cursor;
        await this.db.applyChanges(changes.items, nextCursor);
        if (this.settings.autoCacheReceivedFiles) {
          await this.cacheReceivedFiles(changes.items.map((change) => change.push).filter((push): push is PushRecord => Boolean(push)));
        }
        if (changes.has_more && nextCursor === cursor) {
          throw new Error('同期カーソルが進みません。RelayMockのページング応答を確認してください。');
        }
        cursor = nextCursor;
        if (!changes.has_more) break;
        if (page === MAX_SYNC_PAGES - 1) throw new Error('同期ページ数が安全上限を超えました。');
      }

      await this.reloadCached();
      this.patch({
        capabilities,
        currentDevice,
        webPushConfig,
        webPushSubscriptions,
        storageUsage,
        connection: 'online',
        syncing: false,
        lastSyncAt: nowIso(),
      });

      if (capabilities.features.realtime) void this.ensureRealtime();
      void this.processOutbox();
    } catch (error) {
      this.patch({
        syncing: false,
        connection: navigator.onLine ? 'degraded' : 'offline',
      });
      if (showErrors) this.notify('error', apiErrorMessage(error));
    }
  }

  async enqueuePush(draft: SendPushDraft, file?: File): Promise<string> {
    const capabilities = this.snapshot.capabilities;
    const maxFileBytes = capabilities?.limits.max_file_bytes ?? DEFAULT_MAX_FILE_BYTES;
    const maxPayloadBytes = capabilities?.limits.max_push_payload_bytes ?? 2_000_000;
    if (draft.type === 'file' && !file) throw new Error('ファイルPushにはファイルが必要です。');
    if (draft.type !== 'file' && file) throw new Error('ノートまたはリンクPushへファイルを添付できません。');
    if (file && capabilities && capabilities.transports.upload.length === 0) {
      throw new Error('接続先APIはファイルアップロードに対応していません。');
    }
    if (file && file.size > maxFileBytes) {
      throw new Error(`ファイルサイズが上限の${formatBytes(maxFileBytes)}を超えています。`);
    }
    const encodedPayloadBytes = payloadBytes(draft, file);
    if (encodedPayloadBytes > maxPayloadBytes) {
      throw new Error(`Push Payloadが上限の${formatBytes(maxPayloadBytes)}を超えています（現在 ${formatBytes(encodedPayloadBytes)}）。`);
    }

    const timestamp = nowIso();
    const job: OutboxJob = {
      id: newId('job'),
      kind: 'send_push',
      status: 'queued',
      created_at: timestamp,
      updated_at: timestamp,
      next_attempt_at: timestamp,
      attempts: 0,
      draft,
      ...(file ? {
        file: {
          blob: file,
          name: file.name,
          mime_type: file.type || 'application/octet-stream',
          size: file.size,
        },
      } : {}),
    };

    await this.db.putOutbox(job);
    await this.reloadCached();
    this.notify('success', navigator.onLine ? '送信箱に追加しました。' : 'オフライン送信箱に保存しました。');
    if (navigator.onLine) void this.processOutbox();
    return job.id;
  }

  async processOutbox(): Promise<void> {
    if (this.outboxPromise) return this.outboxPromise;
    if (!navigator.onLine) return;
    if (this.settings.authMode === 'bearer' && !this.settings.bearerToken) return;

    this.outboxPromise = this.performOutboxWithLock().finally(() => {
      this.outboxPromise = undefined;
    });
    return this.outboxPromise;
  }

  private async performOutboxWithLock(): Promise<void> {
    if ('locks' in navigator && navigator.locks) {
      await navigator.locks.request(`pushbridge-outbox:${this.db.name}`, { ifAvailable: true }, async (lock) => {
        if (lock) await this.performOutbox();
      });
      return;
    }
    await this.performOutbox();
  }

  private async performOutbox(): Promise<void> {
    this.patch({ processingOutbox: true });
    let sentAny = false;
    const jobs = await this.db.listOutbox();

    for (const original of jobs) {
      if (original.status === 'failed' || new Date(original.next_attempt_at).getTime() > Date.now()) continue;
      let job: OutboxJob = {
        ...original,
        status: 'sending',
        attempts: original.attempts + 1,
        updated_at: nowIso(),
        last_error: undefined,
      };
      await this.db.putOutbox(job, false);
      await this.reloadCached();

      try {
        if (job.file && !job.uploaded_file) {
          const expiresIn = job.draft.expires_in
            ?? this.snapshot.capabilities?.limits.default_file_ttl_seconds
            ?? DEFAULT_FILE_TTL_SECONDS;
          const init = await this.api.initFile({
            name: job.file.name,
            mime_type: job.file.mime_type,
            size: job.file.size,
            expires_in: expiresIn,
            sha256: await sha256Hex(job.file.blob),
          });
          await this.api.uploadFile(init, job.file.blob);
          const uploaded = await this.api.completeFile(init.file_id);
          job = { ...job, uploaded_file: uploaded, updated_at: nowIso() };
          await this.db.putOutbox(job, false);
        }

        const push = await this.api.createPush({
          ...job.draft,
          client_guid: job.id,
          source_device_id: this.settings.currentDeviceId,
          ...(job.uploaded_file ? { file_id: job.uploaded_file.id, file: job.uploaded_file } : {}),
        }, job.id);
        await this.db.putPush(push, false);
        await this.db.deleteOutbox(job.id, false);
        sentAny = true;
      } catch (error) {
        const retryable = error instanceof ApiError ? error.retryable : false;
        const shouldRetry = retryable && job.attempts < 8;
        const updated: OutboxJob = {
          ...job,
          status: shouldRetry ? 'queued' : 'failed',
          updated_at: nowIso(),
          next_attempt_at: new Date(Date.now() + retryDelayMs(job.attempts)).toISOString(),
          last_error: apiErrorMessage(error),
        };
        await this.db.putOutbox(updated, false);
        if (!shouldRetry) this.notify('error', `送信に失敗しました: ${updated.last_error}`);
      }
    }

    await this.reloadCached();
    this.patch({ processingOutbox: false });
    if (sentAny) {
      this.notify('success', 'Pushを送信しました。');
      void this.syncNow(false);
    }
  }

  async retryOutbox(jobId: string): Promise<void> {
    const jobs = await this.db.listOutbox();
    const job = jobs.find((value) => value.id === jobId);
    if (!job) return;
    await this.db.putOutbox({
      ...job,
      status: 'queued',
      next_attempt_at: nowIso(),
      updated_at: nowIso(),
      last_error: undefined,
    });
    await this.reloadCached();
    if (navigator.onLine) void this.processOutbox();
  }

  async removeOutbox(jobId: string): Promise<void> {
    await this.db.deleteOutbox(jobId);
    await this.reloadCached();
  }

  async setDismissed(pushId: string, dismissed: boolean): Promise<void> {
    const original = await this.db.getPush(pushId);
    if (!original) return;
    const optimistic: PushRecord = {
      ...original,
      status: dismissed ? 'dismissed' : 'active',
      dismissed_at: dismissed ? nowIso() : null,
      modified_at: nowIso(),
    };
    await this.db.putPush(optimistic);
    await this.reloadCached();

    try {
      const updated = await this.api.setDismissed(pushId, dismissed);
      await this.db.putPush({ ...updated, file: updated.file ?? original.file });
      await this.reloadCached();
    } catch (error) {
      await this.db.putPush(original);
      await this.reloadCached();
      this.notify('error', apiErrorMessage(error));
    }
  }

  async setPinned(pushId: string, pinned: boolean): Promise<void> {
    const original = await this.db.getPush(pushId);
    if (!original) return;
    const optimistic: PushRecord = { ...original, pinned, modified_at: nowIso() };
    await this.db.putPush(optimistic);
    if (original.file_id) await this.db.setCachedFilePinned(original.file_id, pinned);
    await this.reloadCached();

    try {
      const updated = await this.api.setPinned(pushId, pinned);
      await this.db.putPush({ ...updated, file: updated.file ?? original.file });
      await this.reloadCached();
    } catch (error) {
      await this.db.putPush(original);
      await this.reloadCached();
      this.notify('error', apiErrorMessage(error));
    }
  }

  async deletePush(pushId: string): Promise<void> {
    const original = await this.db.getPush(pushId);
    if (!original) return;
    await this.db.deletePush(pushId);
    await this.reloadCached();
    try {
      await this.api.deletePush(pushId);
      if (original.file_id) await this.db.deleteCachedFile(original.file_id);
    } catch (error) {
      await this.db.putPush(original);
      await this.reloadCached();
      this.notify('error', apiErrorMessage(error));
    }
  }

  async renameDevice(deviceId: string, name: string): Promise<void> {
    try {
      const updated = await this.api.renameDevice(deviceId, name);
      await this.db.putDevice(updated);
      await this.reloadCached();
      this.notify('success', '端末名を更新しました。');
    } catch (error) {
      this.notify('error', apiErrorMessage(error));
    }
  }

  async revokeDevice(deviceId: string): Promise<void> {
    try {
      await this.api.revokeDevice(deviceId);
      await this.db.deleteDevice(deviceId);
      await this.reloadCached();
      this.notify('success', '端末を解除しました。');
    } catch (error) {
      this.notify('error', apiErrorMessage(error));
    }
  }

  async linkDevice(name: string, kind: 'pwa' | 'web' | 'browser_extension' | 'test'): Promise<DeviceCredential | undefined> {
    try {
      const credential = await this.api.linkDevice({ name, kind });
      await this.db.putDevice(credential.device);
      await this.reloadCached();
      this.notify('success', '追加端末をリンクしました。表示されたTokenは再表示できません。');
      return credential;
    } catch (error) {
      this.notify('error', apiErrorMessage(error));
      return undefined;
    }
  }

  async downloadFile(file: FileAttachment): Promise<void> {
    try {
      const local = await this.db.getCachedFile(file.id);
      const blob = local?.blob ?? await this.downloadRemoteFile(file.id);
      if (!local) {
        const push = this.snapshot.pushes.find((value) => value.file_id === file.id);
        if (push) {
          try {
            await this.storeCachedFile(push, file, blob);
          } catch {
            // The explicit browser download should still succeed if IndexedDB is full.
            this.notify('info', 'ファイルは保存しますが、端末内の永続領域には追加できませんでした。');
          }
        }
      }
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = safeFilename(file.name);
      anchor.rel = 'noopener';
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
    } catch (error) {
      this.notify('error', apiErrorMessage(error));
    }
  }

  async testConnection(): Promise<SystemCapabilities | undefined> {
    try {
      const [capabilities, webPushConfig] = await Promise.all([
        this.api.getCapabilities(),
        this.api.getWebPushConfig(),
      ]);
      const authenticated = this.settings.authMode === 'bearer' && Boolean(this.settings.bearerToken);
      const [currentDevice, webPushSubscriptions] = authenticated
        ? await Promise.all([
            this.api.getCurrentDevice(),
            capabilities.features.web_push_subscription_registration
              ? this.api.listWebPushSubscriptions()
              : Promise.resolve([]),
          ])
        : [undefined, []] as const;
      this.patch({
        capabilities,
        webPushConfig,
        webPushSubscriptions: [...webPushSubscriptions],
        currentDevice,
        connection: currentDevice || this.settings.authMode !== 'bearer' ? 'online' : 'degraded',
      });
      this.notify('success', currentDevice
        ? `RelayMockへ接続しました: ${currentDevice.name}`
        : `RelayMock ${capabilities.api_version}のHealth Checkに成功しました。`);
      return capabilities;
    } catch (error) {
      this.patch({ connection: navigator.onLine ? 'degraded' : 'offline' });
      this.notify('error', apiErrorMessage(error));
      return undefined;
    }
  }

  async registerWebPushSubscription(): Promise<void> {
    try {
      const support = webPushSupport();
      if (!support.supported) throw new Error(support.reason);
      if (!this.settings.bearerToken) throw new Error('Web Push Subscriptionの登録には端末Bearer Tokenが必要です。');

      const config = this.snapshot.webPushConfig ?? await this.api.getWebPushConfig();
      if (!config?.subscription_registration) throw new Error('接続先APIはWeb Push Subscription登録を提供していません。');

      let permission = Notification.permission;
      if (permission === 'default') permission = await Notification.requestPermission();
      if (permission !== 'granted') throw new Error('通知権限が許可されていません。ブラウザー設定を確認してください。');

      const registration = await getActiveServiceWorkerRegistration();
      let browserSubscription = await registration.pushManager.getSubscription();
      if (!browserSubscription) {
        const applicationServerKey = decodeVapidPublicKey(config.vapid_public_key);
        browserSubscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey,
        });
      }

      const record = await this.api.createWebPushSubscription({
        ...subscriptionToInput(browserSubscription),
        storage_namespace: this.settings.storageNamespace,
        local_cache_max_bytes: this.settings.localFileCacheMaxBytes,
      });
      this.patch({
        webPushConfig: config,
        webPushSubscriptions: mergeSubscription(this.snapshot.webPushSubscriptions, record),
      });
      this.notify('success', config.delivery
        ? 'このPWAをWeb Push通知先として登録しました。'
        : 'SubscriptionをRelayMockへ登録しました。RelayMock 0.1.1では実配送は無効です。');
    } catch (error) {
      this.notify('error', apiErrorMessage(error));
      throw error;
    }
  }

  async revokeWebPushSubscription(subscription: WebPushSubscriptionRecord): Promise<void> {
    try {
      if ('serviceWorker' in navigator) {
        const registration = await navigator.serviceWorker.getRegistration('/');
        const browserSubscription = await registration?.pushManager.getSubscription();
        if (browserSubscription?.endpoint === subscription.endpoint) await browserSubscription.unsubscribe();
      }
      await this.api.revokeWebPushSubscription(subscription.id);
      this.patch({
        webPushSubscriptions: this.snapshot.webPushSubscriptions.filter((value) => value.id !== subscription.id),
      });
      this.notify('success', 'Web Push Subscriptionを解除しました。');
    } catch (error) {
      this.notify('error', apiErrorMessage(error));
      throw error;
    }
  }

  async clearLocalData(): Promise<void> {
    await this.db.clearAll();
    await this.reloadCached();
    this.notify('success', 'ローカルキャッシュと送信箱を消去しました。');
  }

  async clearCachedFiles(): Promise<void> {
    const pushes = await this.db.listPushes();
    for (const push of pushes) {
      if (push.file_id && push.local_file_cached) await this.db.deleteCachedFile(push.file_id);
    }
    await this.reloadCached();
    this.notify('success', '端末内に保存したファイルを消去しました。メッセージ履歴は残しています。');
  }

  async deleteLocalPush(pushId: string): Promise<void> {
    const push = await this.db.getPush(pushId);
    if (push?.file_id) await this.db.deleteCachedFile(push.file_id);
    await this.db.deletePush(pushId);
    await this.reloadCached();
  }

  private async downloadRemoteFile(fileId: string): Promise<Blob> {
    const ticket = await this.api.getDownloadTicket(fileId);
    return this.api.client.downloadBlob(ticket.download.url);
  }

  private async cacheReceivedFiles(pushes: PushRecord[]): Promise<void> {
    for (const push of pushes) {
      const file = push.file;
      if (!file || !push.file_id || push.is_for_current_device === false || file.state !== 'ready') continue;
      if (await this.db.getCachedFile(push.file_id, false)) continue;
      try {
        const blob = await this.downloadRemoteFile(push.file_id);
        await this.storeCachedFile(push, file, blob);
      } catch (error) {
        // Best effort: a file can expire or be evicted server-side between sync and download.
        if (!(error instanceof ApiError && (error.status === 404 || error.status === 410))) {
          this.notify('info', `ファイル「${file.name}」を端末内へ保存できませんでした。`);
        }
      }
    }
    await this.refreshStorageUsage(false);
  }

  private async storeCachedFile(push: PushRecord, file: FileAttachment, blob: Blob): Promise<void> {
    const timestamp = nowIso();
    const target = Math.max(0, this.settings.localFileCacheMaxBytes);
    await this.db.enforceCachedFileLimit(Math.max(0, target - blob.size));
    await this.db.putCachedFile({
      file_id: file.id,
      push_id: push.id,
      name: file.name,
      mime_type: file.mime_type,
      size: blob.size,
      blob,
      cached_at: timestamp,
      last_accessed_at: timestamp,
      pinned: push.pinned,
    });
    await this.db.enforceCachedFileLimit(target);
  }

  private async refreshStorageUsage(requestPersistence: boolean): Promise<void> {
    let persistence: RuntimeSnapshot['localStorageUsage']['persistence'] = 'unsupported';
    if (navigator.storage?.persisted) {
      try {
        let persisted = await navigator.storage.persisted();
        if (!persisted && requestPersistence && navigator.storage.persist) persisted = await navigator.storage.persist();
        persistence = persisted ? 'granted' : 'not-granted';
      } catch {
        persistence = 'unknown';
      }
    }
    const usage = await this.db.cachedFileUsage();
    this.patch({
      localStorageUsage: {
        cached_file_count: usage.count,
        cached_file_bytes: usage.bytes,
        cache_limit_bytes: this.settings.localFileCacheMaxBytes,
        persistence,
      },
    });
  }

  private async reloadCached(): Promise<void> {
    const [pushes, devices, outbox] = await Promise.all([
      this.db.listPushes(),
      this.db.listDevices(),
      this.db.listOutbox(),
    ]);
    this.patch({ pushes, devices, outbox });
    void this.refreshStorageUsage(false);
  }

  private async ensureRealtime(): Promise<void> {
    if (this.destroyed || !navigator.onLine) return;
    if (this.websocket && (this.websocket.readyState === WebSocket.OPEN || this.websocket.readyState === WebSocket.CONNECTING)) return;

    try {
      const ticket = await this.api.createRealtimeTicket();
      const rawUrl = ticket.url ?? `${this.settings.realtimePath}?ticket=${encodeURIComponent(ticket.ticket)}`;
      const url = new URL(rawUrl, window.location.href);
      if (url.protocol === 'http:') url.protocol = 'ws:';
      if (url.protocol === 'https:') url.protocol = 'wss:';
      if (!url.searchParams.has('ticket')) url.searchParams.set('ticket', ticket.ticket);

      const socket = new WebSocket(url.toString());
      this.websocket = socket;
      socket.addEventListener('open', () => {
        this.reconnectAttempts = 0;
        this.patch({ realtimeConnected: true, connection: 'online' });
        this.schedulePoll();
      });
      socket.addEventListener('message', (event) => {
        if (typeof event.data !== 'string') return;
        try {
          const message = JSON.parse(event.data) as RealtimeEnvelope;
          if (message.type === 'sync_required') this.debounceSync();
        } catch {
          // Ignore unknown realtime frames; REST sync remains authoritative.
        }
      });
      socket.addEventListener('close', () => {
        if (this.websocket === socket) this.websocket = undefined;
        this.patch({ realtimeConnected: false });
        this.scheduleRealtimeReconnect();
        this.schedulePoll();
      });
      socket.addEventListener('error', () => socket.close());
    } catch {
      this.patch({ realtimeConnected: false });
      this.scheduleRealtimeReconnect();
      this.schedulePoll();
    }
  }

  private debounceSync(): void {
    if (this.syncDebounceTimer) window.clearTimeout(this.syncDebounceTimer);
    this.syncDebounceTimer = window.setTimeout(() => void this.syncNow(false), 250);
  }

  private scheduleRealtimeReconnect(): void {
    if (this.destroyed || !navigator.onLine || !this.snapshot.capabilities?.features.realtime) return;
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
    this.reconnectAttempts += 1;
    const delay = Math.min(60_000, 1_000 * (2 ** Math.min(this.reconnectAttempts, 6)));
    this.reconnectTimer = window.setTimeout(() => void this.ensureRealtime(), delay);
  }

  private closeRealtime(): void {
    const socket = this.websocket;
    this.websocket = undefined;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, 'client offline');
  }

  private schedulePoll(): void {
    if (this.destroyed) return;
    if (this.pollTimer) window.clearTimeout(this.pollTimer);
    const baseInterval = this.snapshot.capabilities?.recommended_poll_interval_seconds
      ?? this.settings.pollIntervalSeconds;
    const seconds = this.snapshot.realtimeConnected
      ? Math.max(300, baseInterval)
      : Math.max(5, baseInterval);
    this.pollTimer = window.setTimeout(() => void this.syncNow(false), seconds * 1000);
  }

  private patch(partial: Partial<RuntimeSnapshot>): void {
    if (this.destroyed) return;
    this.snapshot = { ...this.snapshot, ...partial };
    for (const subscriber of this.subscribers) subscriber();
  }
}
