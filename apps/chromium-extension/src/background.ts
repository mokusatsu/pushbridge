import {
  API_BASE_PATH,
  API_ORIGIN,
  decryptPushPayload,
  draftFromContextMenu,
  encryptPushPayload,
  payloadForDraft,
  targetFromValue,
  unwrapAccountKey,
  type ContentEnvelope,
  type DeviceEnvelope,
  type Draft,
  type PushTarget,
  type PushType,
} from './shared';
import {
  REALTIME_HEARTBEAT_INTERVAL_MS,
  parseRealtimeEnvelope,
  realtimeReconnectDelayMs,
} from './realtime';
import {
  clearSecrets,
  clearState,
  ensureIdentity,
  getAccountKey,
  getState,
  patchState,
  putAccountKey,
} from './storage';
import type { UploadedEncryptedFile } from './file';

interface Device {
  id: string;
  name: string;
  kind: string;
  is_current: boolean;
  public_key?: string | null;
  revoked_at?: string | null;
}

interface ApiProblem {
  detail?: string;
  message?: string;
  code?: string;
}

interface ExtensionRequest {
  type: string;
  token?: string;
  draft?: Draft;
  target?: string;
  enabled?: boolean;
  file?: UploadedEncryptedFile;
  title?: string;
  body?: string;
}

interface PushRow {
  id: string;
  source_device_id: string;
  type: string;
  payload_version: number;
  key_version: number | null;
  encryption_salt: string | null;
  nonce: string | null;
  ciphertext: string | null;
  client_guid: string;
  status: string;
  deleted_at: string | null;
  is_for_current_device: boolean;
}

interface PushPage {
  items: PushRow[];
  next_cursor: string | null;
  has_more: boolean;
}

let realtimeSocket: WebSocket | undefined;
let realtimeConnected = false;
let reconnectAttempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
let syncInFlight: Promise<void> | undefined;
let syncPending = false;

function apiUrl(path: string): string {
  return `${API_ORIGIN}${API_BASE_PATH}${path.startsWith('/') ? path : `/${path}`}`;
}

async function api<T>(path: string, init: RequestInit = {}, authenticated = true): Promise<T> {
  const state = await getState();
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  headers.set('X-Client-Version', 'pushbridge-extension/0.1.0');
  if (init.body) headers.set('Content-Type', 'application/json');
  if (authenticated) {
    if (!state.accessToken) throw new Error('拡張機能を端末リンクしてください。');
    headers.set('Authorization', `Bearer ${state.accessToken}`);
  }
  const response = await fetch(apiUrl(path), { ...init, headers, credentials: 'include' });
  const contentType = response.headers.get('content-type') ?? '';
  const body = contentType.includes('json') ? await response.json() as T & ApiProblem : undefined;
  if (!response.ok || !contentType.includes('json')) {
    if (response.status === 200 && !contentType.includes('json')) {
      throw new Error('Cloudflare Accessへのブラウザーログインが必要です。');
    }
    const problem = body as ApiProblem | undefined;
    throw new Error(problem?.detail || problem?.message || `API request failed (${response.status})`);
  }
  return body as T;
}

async function syncAccountKey(): Promise<boolean> {
  const state = await getState();
  if (!state.accessToken) return false;
  const identity = await ensureIdentity();
  try {
    const result = await api<{ key_version: number; envelope: DeviceEnvelope }>('/e2ee/device-envelope');
    if (result.envelope.recipient_device_id !== state.deviceId) throw new Error('E2EE envelopeの端末が一致しません。');
    const accountKey = await unwrapAndStore(result.key_version, result.envelope, identity.privateKey);
    return accountKey;
  } catch (error) {
    if (error instanceof Error && /No account-key envelope|404|見つか/u.test(error.message)) return false;
    throw error;
  }
}

async function unwrapAndStore(version: number, envelope: DeviceEnvelope, privateKey: CryptoKey): Promise<boolean> {
  const bytes = await unwrapAccountKey(envelope, privateKey);
  await putAccountKey(version, bytes);
  return true;
}

async function status() {
  const [state, accountKey, identity] = await Promise.all([getState(), getAccountKey(), ensureIdentity()]);
  let devices: Device[] = [];
  if (state.accessToken) {
    try {
      const result = await api<Device[]>('/devices');
      devices = result.filter((device) => !device.revoked_at);
    } catch {
      // Status remains useful when Access or the network is temporarily unavailable.
    }
  }
  return {
    origin: API_ORIGIN,
    linked: Boolean(state.accessToken && state.deviceId),
    deviceId: state.deviceId,
    publicKey: identity.publicKey,
    keyReady: Boolean(accountKey),
    realtimeConnected,
    notificationsEnabled: state.notificationsEnabled !== false,
    lastSyncAt: state.lastSyncAt,
    defaultTarget: state.defaultTarget ?? 'all_other_devices',
    devices: devices.map((device) => ({
      id: device.id,
      name: device.name,
      kind: device.kind,
      current: device.is_current,
    })),
  };
}

async function redeem(token: string): Promise<ReturnType<typeof status>> {
  if (!token.trim()) throw new Error('device-link tokenが必要です。');
  const identity = await ensureIdentity();
  const result = await api<{ device: Device & { user_id?: string }; access_token: string }>('/device-links/redeem', {
    method: 'POST',
    body: JSON.stringify({ link_token: token.trim(), public_key: identity.publicKey }),
  }, false);
  await clearState();
  await patchState({
    accessToken: result.access_token,
    deviceId: result.device.id,
    linkedAt: new Date().toISOString(),
    defaultTarget: 'all_other_devices',
    notificationsEnabled: true,
  });
  await syncAccountKey().catch(() => false);
  void initializeRuntime();
  return status();
}

async function sendDraft(draft: Draft, targetValue?: string): Promise<{ id: string }> {
  const state = await getState();
  let accountKey = await getAccountKey();
  if (!accountKey && await syncAccountKey()) accountKey = await getAccountKey();
  if (!accountKey) throw new Error('E2EE鍵を待っています。リンク元PWAを同期してから再試行してください。');
  const clientGuid = crypto.randomUUID();
  const payload = payloadForDraft(draft);
  const envelope = await encryptPushPayload(accountKey.bytes, accountKey.version, draft.type, clientGuid, payload);
  const target: PushTarget = targetFromValue(targetValue ?? state.defaultTarget ?? 'all_other_devices');
  const response = await api<{ id: string }>('/pushes', {
    method: 'POST',
    headers: { 'Idempotency-Key': clientGuid },
    body: JSON.stringify({
      type: draft.type,
      target,
      client_guid: clientGuid,
      payload_version: 2,
      key_version: envelope.key_version,
      encryption_salt: envelope.salt,
      nonce: envelope.nonce,
      ciphertext: envelope.ciphertext,
    }),
  });
  return { id: response.id };
}

async function sendFile(
  file: UploadedEncryptedFile,
  titleValue?: string,
  bodyValue?: string,
  targetValue?: string,
): Promise<{ id: string }> {
  const state = await getState();
  let accountKey = await getAccountKey();
  if (!accountKey && await syncAccountKey()) accountKey = await getAccountKey();
  if (!accountKey) throw new Error('E2EE鍵を待っています。リンク元PWAを同期してから再試行してください。');
  const clientGuid = crypto.randomUUID();
  const title = titleValue?.trim();
  const body = bodyValue?.trim();
  const payload = {
    ...(title ? { title } : {}),
    ...(body ? { body } : {}),
    file: {
      name: file.name,
      mime_type: file.mimeType,
      size: file.size,
      client_file_id: file.id,
      sha256: null,
      expires_at: file.expiresAt,
    },
  };
  const envelope = await encryptPushPayload(accountKey.bytes, accountKey.version, 'file', clientGuid, payload);
  const target: PushTarget = targetFromValue(targetValue ?? state.defaultTarget ?? 'all_other_devices');
  const response = await api<{ id: string }>('/pushes', {
    method: 'POST',
    headers: { 'Idempotency-Key': clientGuid },
    body: JSON.stringify({
      type: 'file',
      target,
      file_id: file.id,
      client_guid: clientGuid,
      payload_version: 2,
      key_version: envelope.key_version,
      encryption_salt: envelope.salt,
      nonce: envelope.nonce,
      ciphertext: envelope.ciphertext,
    }),
  });
  return { id: response.id };
}

async function currentTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || !/^https?:\/\//iu.test(tab.url)) throw new Error('このタブは送信できません。');
  return tab;
}

async function recentHistory() {
  const accountKey = await getAccountKey();
  if (!accountKey) return [];
  const result = await api<{ items: Array<Record<string, unknown>> }>('/pushes?limit=10&include_deleted=false');
  const items = [];
  for (const row of result.items) {
    const type = row.type;
    if ((type !== 'note' && type !== 'link') || row.payload_version !== 2) continue;
    try {
      const payload = await decryptPushPayload(accountKey.bytes, type, String(row.client_guid), {
        v: 1,
        alg: 'A256GCM-HKDF-SHA256',
        key_version: Number(row.key_version),
        salt: String(row.encryption_salt),
        nonce: String(row.nonce),
        ciphertext: String(row.ciphertext),
      } satisfies ContentEnvelope);
      items.push({
        id: String(row.id),
        type,
        title: typeof payload.title === 'string' ? payload.title : '',
        body: typeof payload.body === 'string' ? payload.body : '',
        url: typeof payload.url === 'string' ? payload.url : '',
      });
    } catch {
      // Another key version or a malformed record must not leak partial content.
    }
  }
  return items;
}

async function notify(title: string, message: string, id?: string): Promise<void> {
  const options: chrome.notifications.NotificationCreateOptions = {
    type: 'basic',
    iconUrl: 'icons/icon-128.png',
    title,
    message,
  };
  if (id) await chrome.notifications.create(id, options);
  else await chrome.notifications.create(options);
}

async function decryptRow(row: PushRow): Promise<{ title: string; message: string } | undefined> {
  if ((row.type !== 'note' && row.type !== 'link') || row.payload_version !== 2) return undefined;
  const accountKey = await getAccountKey();
  if (!accountKey || row.key_version !== accountKey.version || !row.encryption_salt || !row.nonce || !row.ciphertext) {
    return undefined;
  }
  try {
    const payload = await decryptPushPayload(accountKey.bytes, row.type, row.client_guid, {
      v: 1,
      alg: 'A256GCM-HKDF-SHA256',
      key_version: row.key_version,
      salt: row.encryption_salt,
      nonce: row.nonce,
      ciphertext: row.ciphertext,
    });
    const title = typeof payload.title === 'string' && payload.title.trim()
      ? payload.title.trim()
      : row.type === 'note' ? '新しいNote' : '新しいLink';
    const detail = row.type === 'note'
      ? (typeof payload.body === 'string' ? payload.body : '')
      : (typeof payload.url === 'string' ? payload.url : '');
    return { title: title.slice(0, 200), message: detail.slice(0, 500) || 'Pushbridgeで受信しました。' };
  } catch {
    return undefined;
  }
}

async function syncIncoming(): Promise<void> {
  if (syncInFlight) {
    syncPending = true;
    return syncInFlight;
  }
  syncInFlight = (async () => {
    do {
      syncPending = false;
      const state = await getState();
      if (!state.accessToken || !state.deviceId || !await getAccountKey()) return;
      let cursor = state.syncCursor;
      const notifyIncoming = state.syncInitialized === true && state.notificationsEnabled !== false;
      let hasMore = false;
      do {
        const query = new URLSearchParams({ limit: '100', include_deleted: 'true' });
        if (cursor) query.set('after', cursor);
        const page = await api<PushPage>(`/pushes?${query.toString()}`);
        if (notifyIncoming) {
          for (const row of page.items) {
            if (!row.is_for_current_device
              || row.source_device_id === state.deviceId
              || row.status !== 'active'
              || row.deleted_at) continue;
            const content = await decryptRow(row);
            if (content) await notify(content.title, content.message, `pushbridge-push-${row.id}`);
          }
        }
        if (page.next_cursor) cursor = page.next_cursor;
        hasMore = page.has_more;
      } while (hasMore);
      await patchState({
        ...(cursor ? { syncCursor: cursor } : {}),
        syncInitialized: true,
        lastSyncAt: new Date().toISOString(),
      });
    } while (syncPending);
  })().finally(() => {
    syncInFlight = undefined;
    if (syncPending) {
      syncPending = false;
      void syncIncoming();
    }
  });
  return syncInFlight;
}

function realtimeUrl(rawUrl: string): string {
  const value = new URL(rawUrl, API_ORIGIN);
  if (value.protocol === 'http:') value.protocol = 'ws:';
  if (value.protocol === 'https:') value.protocol = 'wss:';
  if (!['ws:', 'wss:'].includes(value.protocol) || value.host !== new URL(API_ORIGIN).host) {
    throw new Error('Realtime URL origin mismatch');
  }
  return value.toString();
}

function scheduleHeartbeat(socket: WebSocket): void {
  if (heartbeatTimer) clearTimeout(heartbeatTimer);
  heartbeatTimer = setTimeout(() => {
    if (realtimeSocket !== socket || socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify({ type: 'ping' }));
      scheduleHeartbeat(socket);
    } catch {
      socket.close();
    }
  }, REALTIME_HEARTBEAT_INTERVAL_MS);
}

function scheduleReconnect(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectAttempts += 1;
  reconnectTimer = setTimeout(() => void startRealtime(), realtimeReconnectDelayMs(reconnectAttempts));
}

async function startRealtime(): Promise<void> {
  const state = await getState();
  if (!state.accessToken || !state.deviceId) return;
  if (realtimeSocket
    && (realtimeSocket.readyState === WebSocket.OPEN || realtimeSocket.readyState === WebSocket.CONNECTING)) return;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  try {
    const ticket = await api<{ ticket: string; url: string }>('/realtime-ticket', { method: 'POST' });
    const socket = new WebSocket(realtimeUrl(ticket.url), ['pushbridge.v1', `pushbridge-ticket.${ticket.ticket}`]);
    realtimeSocket = socket;
    socket.addEventListener('open', () => {
      realtimeConnected = true;
      reconnectAttempts = 0;
      scheduleHeartbeat(socket);
      void syncIncoming();
    });
    socket.addEventListener('message', (event) => {
      const envelope = parseRealtimeEnvelope(event.data);
      if (envelope?.type === 'sync_required') void syncIncoming();
    });
    socket.addEventListener('close', () => {
      const shouldReconnect = realtimeSocket === socket;
      if (shouldReconnect) realtimeSocket = undefined;
      realtimeConnected = false;
      if (heartbeatTimer) clearTimeout(heartbeatTimer);
      heartbeatTimer = undefined;
      if (shouldReconnect) scheduleReconnect();
    });
    socket.addEventListener('error', () => socket.close());
  } catch {
    realtimeConnected = false;
    scheduleReconnect();
  }
}

function stopRealtime(): void {
  const socket = realtimeSocket;
  realtimeSocket = undefined;
  realtimeConnected = false;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (heartbeatTimer) clearTimeout(heartbeatTimer);
  reconnectTimer = undefined;
  heartbeatTimer = undefined;
  if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, 'extension disconnected');
}

async function initializeRuntime(): Promise<void> {
  await chrome.alarms.create('pushbridge-runtime', { periodInMinutes: 1 });
  const ready = await syncAccountKey().catch(() => false);
  if (ready || await getAccountKey()) await syncIncoming().catch(() => undefined);
  await startRealtime();
}

async function handle(request: ExtensionRequest): Promise<unknown> {
  switch (request.type) {
    case 'STATUS':
      return status();
    case 'REDEEM':
      return redeem(request.token ?? '');
    case 'SYNC_KEY':
      await syncAccountKey();
      void initializeRuntime();
      return status();
    case 'SET_TARGET':
      await patchState({ defaultTarget: request.target || 'all_other_devices' });
      return status();
    case 'SET_NOTIFICATIONS':
      await patchState({ notificationsEnabled: request.enabled !== false });
      return status();
    case 'SYNC_NOW':
      await syncIncoming();
      return status();
    case 'SEND':
      if (!request.draft) throw new Error('送信内容がありません。');
      return sendDraft(request.draft, request.target);
    case 'SEND_FILE':
      if (!request.file) throw new Error('アップロード済みファイル情報がありません。');
      return sendFile(request.file, request.title, request.body, request.target);
    case 'CURRENT_TAB': {
      const tab = await currentTab();
      return { title: tab.title ?? '', url: tab.url ?? '' };
    }
    case 'SEND_CURRENT_TAB': {
      const tab = await currentTab();
      return sendDraft({ type: 'link', title: tab.title, url: tab.url });
    }
    case 'HISTORY':
      return recentHistory();
    case 'DISCONNECT': {
      stopRealtime();
      await Promise.all([clearState(), clearSecrets()]);
      return status();
    }
    default:
      throw new Error('Unknown extension request');
  }
}

chrome.runtime.onMessage.addListener((request: ExtensionRequest, _sender, sendResponse) => {
  void handle(request).then(
    (value) => sendResponse({ ok: true, value }),
    (error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
  );
  return true;
});

async function installMenus(): Promise<void> {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({ id: 'pushbridge-page', title: 'このページをPushbridgeで送る', contexts: ['page'] });
  chrome.contextMenus.create({ id: 'pushbridge-link', title: 'このリンクをPushbridgeで送る', contexts: ['link'] });
  chrome.contextMenus.create({ id: 'pushbridge-selection', title: '選択テキストをPushbridgeで送る', contexts: ['selection'] });
  chrome.contextMenus.create({ id: 'pushbridge-image', title: '画像URLをPushbridgeで送る', contexts: ['image'] });
}

chrome.runtime.onInstalled.addListener(() => {
  void installMenus();
  void initializeRuntime();
});
chrome.runtime.onStartup.addListener(() => {
  void installMenus();
  void initializeRuntime();
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'pushbridge-runtime') void initializeRuntime();
});
chrome.commands.onCommand.addListener((command) => {
  if (command !== 'send-current-tab') return;
  void handle({ type: 'SEND_CURRENT_TAB' }).then(
    () => notify('Pushbridge', '現在のタブを送信しました。'),
    (error) => notify('Pushbridge送信失敗', error instanceof Error ? error.message : String(error)),
  );
});
chrome.contextMenus.onClicked.addListener((info, tab) => {
  const draft = draftFromContextMenu(info, tab);
  void sendDraft(draft).then(
    () => notify('Pushbridge', draft.type === 'note' ? '選択テキストを送信しました。' : 'リンクを送信しました。'),
    (error) => notify('Pushbridge送信失敗', error instanceof Error ? error.message : String(error)),
  );
});

void initializeRuntime();
