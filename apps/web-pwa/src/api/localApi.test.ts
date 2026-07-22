import { describe, expect, it, vi } from 'vitest';
import type { ClientSettings } from '@/types';
import { ApiClient } from './client';
import { LocalApi } from './localApi';

const settings: ClientSettings = {
  apiBaseUrl: '/api/v1',
  realtimePath: '/realtime',
  authMode: 'bearer',
  bearerToken: 'device-token',
  rememberBearerToken: false,
  currentDeviceId: 'dev_current',
  storageNamespace: 'test',
  pollIntervalSeconds: 30,
  autoCacheReceivedFiles: true,
  localFileCacheMaxBytes: 512 * 1024 * 1024,
};

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json', 'X-Request-ID': 'req_test' },
  });
}

const deviceWire = {
  id: 'dev_current',
  user_id: 'usr_1',
  kind: 'browser_extension',
  name: 'Browser',
  public_key: null,
  created_at: '2026-01-01T00:00:00Z',
  last_seen_at: '2026-01-01T00:00:00Z',
  revoked_at: null,
  is_current: true,
};

const pushWire = {
  id: 'psh_1',
  user_id: 'usr_1',
  source_device_id: 'dev_current',
  target: { kind: 'all_other_devices', device_id: null },
  type: 'note',
  file_id: null,
  file_ref: null,
  payload_version: 1,
  payload: { title: 'Hello', body: 'World' },
  ciphertext: null,
  nonce: null,
  client_guid: 'job_1',
  pinned: false,
  status: 'active',
  created_at: '2026-01-01T00:00:00Z',
  modified_at: '2026-01-01T00:00:00Z',
  expires_at: null,
  expired_at: null,
  dismissed_at: null,
  deleted_at: null,
  is_for_current_device: false,
};

const capabilitiesWire = {
  api_version: '0.1.1',
  environment_id: 'relaymock-local',
  features: {
    realtime: false,
    web_push_delivery: false,
    web_push_subscription_registration: true,
    e2ee: false,
    direct_upload: true,
    device_registration: true,
  },
  limits: {
    max_file_bytes: 26_214_400,
    max_push_payload_bytes: 2_000_000,
    file_ttl_seconds: [86_400, 604_800, 2_592_000],
    default_push_ttl_seconds: 2_592_000,
    default_file_ttl_seconds: 86_400,
    max_devices: 10,
  },
  transports: { realtime: ['poll'], upload: ['server-ticket'] },
  recommended_poll_interval_seconds: 30,
};

describe('RelayMock LocalApi adapter', () => {
  it('maps RelayMock devices to the normalized client model', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse([deviceWire])));
    const api = new LocalApi(new ApiClient(settings));
    const devices = await api.listDevices();
    expect(devices).toEqual([expect.objectContaining({
      id: 'dev_current',
      kind: 'browser_extension',
      active: true,
      is_current: true,
    })]);
  });

  it('uses the pushes cursor endpoint as the authoritative change stream', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({
      items: [pushWire],
      next_cursor: 'cursor-1',
      has_more: false,
    }));
    vi.stubGlobal('fetch', fetchMock);

    const api = new LocalApi(new ApiClient(settings));
    const result = await api.getChanges('', 100);

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/pushes?limit=100&include_deleted=true');
    expect(result.next_cursor).toBe('cursor-1');
    expect(result.items[0]).toMatchObject({
      type: 'push.upsert',
      entity_id: 'psh_1',
      push: { title: 'Hello', body: 'World', status: 'active' },
    });
  });

  it('maps RelayMock 0.1.1 capabilities and Web Push configuration', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(capabilitiesWire))
      .mockResolvedValueOnce(jsonResponse({
        subscription_registration: true,
        delivery: false,
        vapid_public_key: 'BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      }));
    vi.stubGlobal('fetch', fetchMock);

    const api = new LocalApi(new ApiClient(settings));
    const capabilities = await api.getCapabilities();
    const config = await api.getWebPushConfig();

    expect(capabilities).toMatchObject({
      api_version: '0.1.1',
      features: {
        web_push_delivery: false,
        web_push_subscription_registration: true,
      },
      limits: {
        max_push_payload_bytes: 2_000_000,
        default_push_ttl_seconds: 2_592_000,
        default_file_ttl_seconds: 86_400,
      },
      recommended_poll_interval_seconds: 30,
    });
    expect(config).toMatchObject({ subscription_registration: true, delivery: false });
  });

  it('accepts file_ref and uses it without an extra metadata request', async () => {
    const filePush = {
      ...pushWire,
      id: 'psh_file',
      type: 'file',
      file_id: 'fil_1',
      file_ref: {
        id: 'fil_1',
        state: 'ready',
        size: 12,
        expires_at: '2026-01-02T00:00:00Z',
      },
      payload: {
        title: 'File',
        file: {
          name: 'hello.txt',
          mime_type: 'text/plain',
          size: 12,
          sha256: null,
          expires_at: '2026-01-02T00:00:00Z',
        },
      },
    };
    const fetchMock = vi.fn(async () => jsonResponse({
      items: [filePush],
      next_cursor: 'cursor-file',
      has_more: false,
    }));
    vi.stubGlobal('fetch', fetchMock);

    const api = new LocalApi(new ApiClient(settings));
    const result = await api.getChanges('', 100);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result.items[0]?.push?.file).toMatchObject({
      id: 'fil_1',
      name: 'hello.txt',
      size: 12,
      state: 'ready',
      expires_at: '2026-01-02T00:00:00Z',
    });
  });

  it('maps flat compose fields into the strict RelayMock payload shape', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toEqual({
        target: { kind: 'all_other_devices' },
        payload_version: 1,
        client_guid: 'job_1',
        type: 'link',
        payload: { url: 'https://example.com', title: 'Docs', body: 'Read this' },
      });
      expect(body).not.toHaveProperty('source_device_id');
      expect(body).not.toHaveProperty('file_id');
      return jsonResponse({
        ...pushWire,
        type: 'link',
        payload: { title: 'Docs', body: 'Read this', url: 'https://example.com' },
      }, 201);
    });
    vi.stubGlobal('fetch', fetchMock);

    const api = new LocalApi(new ApiClient(settings));
    const result = await api.createPush({
      type: 'link',
      target: { kind: 'all_other_devices' },
      title: 'Docs',
      body: 'Read this',
      url: 'https://example.com',
      client_guid: 'job_1',
      source_device_id: 'ignored-by-relaymock',
    }, 'job_1');

    expect(result.url).toBe('https://example.com');
  });

  it('omits server-only file state from the strict FilePayloadV1 request', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        file_id: string;
        payload: { file: Record<string, unknown> };
      };
      expect(body.file_id).toBe('fil_1');
      expect(body.payload.file).toEqual({
        name: 'hello.txt',
        mime_type: 'text/plain',
        size: 5,
        sha256: null,
        expires_at: '2026-01-02T00:00:00Z',
      });
      expect(body.payload.file).not.toHaveProperty('state');
      return jsonResponse({
        ...pushWire,
        type: 'file',
        file_id: 'fil_1',
        file_ref: { id: 'fil_1', state: 'ready', size: 5, expires_at: '2026-01-02T00:00:00Z' },
        payload: { file: body.payload.file },
      }, 201);
    });
    vi.stubGlobal('fetch', fetchMock);

    const api = new LocalApi(new ApiClient(settings));
    await api.createPush({
      type: 'file',
      target: { kind: 'all_other_devices' },
      client_guid: 'job_file',
      file_id: 'fil_1',
      file: {
        id: 'fil_1',
        name: 'hello.txt',
        mime_type: 'text/plain',
        size: 5,
        state: 'ready',
        expires_at: '2026-01-02T00:00:00Z',
      },
    }, 'job_file');
  });

  it('normalizes RelayMock file init and download ticket shapes', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        file: {
          id: 'fil_1',
          original_name: 'hello.txt',
          content_type: 'text/plain',
          expected_size: 5,
          actual_size: null,
          expected_sha256: null,
          actual_sha256: null,
          state: 'pending',
          created_at: '2026-01-01T00:00:00Z',
          completed_at: null,
          expires_at: '2026-01-02T00:00:00Z',
          deleted_at: null,
        },
        upload_url: '/mock-storage/uploads/ticket',
        upload_method: 'PUT',
        upload_expires_at: '2026-01-01T00:01:00Z',
        upload_headers: { 'content-type': 'application/octet-stream' },
      }, 201))
      .mockResolvedValueOnce(jsonResponse({
        file_id: 'fil_1',
        download_url: '/mock-storage/downloads/ticket',
        expires_at: '2026-01-01T00:01:00Z',
      }));
    vi.stubGlobal('fetch', fetchMock);

    const api = new LocalApi(new ApiClient(settings));
    const init = await api.initFile({ name: 'hello.txt', mime_type: 'text/plain', size: 5, expires_in: 3600 });
    const ticket = await api.getDownloadTicket('fil_1');

    expect(init).toMatchObject({ file_id: 'fil_1', upload: { method: 'PUT', url: '/mock-storage/uploads/ticket' } });
    expect(ticket.download.url).toBe('/mock-storage/downloads/ticket');
  });

  it('parses per-device file delivery states from the contract endpoint', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse([{
      id: 'fdl_1',
      push_id: 'psh_file',
      file_id: 'fil_1',
      destination_device_id: 'dev_other',
      state: 'fetching',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:01:00Z',
      notified_at: '2026-01-01T00:00:30Z',
      fetching_at: '2026-01-01T00:01:00Z',
      cached_at: null,
      failed_at: null,
      missed_at: null,
      failure_code: null,
      attempt_count: 1,
    }]));
    vi.stubGlobal('fetch', fetchMock);

    const deliveries = await new LocalApi(new ApiClient(settings)).listFileDeliveries('fil_1');

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/files/fil_1/deliveries');
    expect(deliveries).toEqual([expect.objectContaining({ state: 'fetching', destination_device_id: 'dev_other' })]);
  });
});
