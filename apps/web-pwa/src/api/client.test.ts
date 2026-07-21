import { describe, expect, it, vi } from 'vitest';
import type { ClientSettings } from '@/types';
import { apiErrorMessage, ApiError } from './errors';
import { ApiClient } from './client';

const settings: ClientSettings = {
  apiBaseUrl: '/api/v1',
  realtimePath: '/realtime',
  authMode: 'bearer',
  bearerToken: 'test-token',
  rememberBearerToken: false,
  currentDeviceId: 'dev_web',
  storageNamespace: 'test',
  pollIntervalSeconds: 30,
  autoCacheReceivedFiles: true,
  localFileCacheMaxBytes: 512 * 1024 * 1024,
};

describe('ApiClient', () => {
  it('uses the API base path and adds client/auth/request headers', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'X-Request-ID': 'req_server' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new ApiClient(settings);
    await client.request('/probe', { method: 'POST', body: JSON.stringify({ hello: 'world' }) });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [input, init] = fetchMock.mock.calls[0]!;
    expect(input).toBe('/api/v1/probe');
    const headers = init?.headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer test-token');
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(headers.get('X-Client-Version')).toBe('0.4.0');
    expect(headers.get('X-Request-ID')).toMatch(/^req_[A-Za-z0-9_-]+$/);
    expect(init?.credentials).toBe('include');
  });

  it('understands RelayMock nested detail errors and server Request ID', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      detail: {
        code: 'idempotency_conflict',
        message: 'The idempotency key was reused with different content.',
        request_id: 'req_body',
      },
    }), {
      status: 409,
      headers: { 'Content-Type': 'application/json', 'X-Request-ID': 'req_header' },
    })));

    const client = new ApiClient(settings);
    await expect(client.request('/probe')).rejects.toMatchObject({
      status: 409,
      code: 'idempotency_conflict',
      requestId: 'req_header',
      retryable: false,
      message: 'The idempotency key was reused with different content.',
    });
  });

  it('falls back to the error body Request ID when the header is missing', () => {
    const error = new ApiError('Not ready', { status: 409, requestId: 'req_body' });
    expect(apiErrorMessage(error)).toContain('Request ID: req_body');
  });

  it('formats FastAPI validation errors into a readable message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      detail: [{ loc: ['body', 'handle'], msg: 'String should match pattern', type: 'string_pattern_mismatch' }],
    }), {
      status: 422,
      headers: { 'Content-Type': 'application/json', 'X-Request-ID': 'req_validation' },
    })));

    const client = new ApiClient(settings);
    await expect(client.request('/probe')).rejects.toMatchObject({
      status: 422,
      requestId: 'req_validation',
      message: 'body.handle: String should match pattern',
    });
  });
});
