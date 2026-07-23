import { applicationVersion } from '@/config';
import type { ClientSettings, UploadInstruction } from '@/types';
import { ApiError, parseApiProblem } from './errors';

const DEFAULT_TIMEOUT_MS = 15_000;
const TRANSFER_TIMEOUT_MS = 120_000;

function isPresignedR2Target(target: URL): boolean {
  return target.protocol === 'https:'
    && /^[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/u.test(target.hostname)
    && target.searchParams.get('X-Amz-Algorithm') === 'AWS4-HMAC-SHA256'
    && Boolean(target.searchParams.get('X-Amz-Signature'));
}

export interface UploadOptions {
  signal?: AbortSignal;
  onProgress?: (loaded: number, total: number) => void;
}

function joinUrl(base: string, path: string): string {
  const cleanBase = base.replace(/\/+$/, '');
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  return `${cleanBase}${cleanPath}`;
}

function createRequestId(): string {
  const random = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  return `req_${random.replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

async function parseResponseBody(response: Response): Promise<unknown> {
  if (response.status === 204 || response.headers.get('content-length') === '0') return undefined;
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json') || contentType.includes('application/problem+json')) {
    return response.json();
  }
  const text = await response.text();
  return text || undefined;
}

function responseRequestId(response: Response, parsedRequestId?: string, fallback?: string): string | undefined {
  return response.headers.get('X-Request-ID') ?? parsedRequestId ?? fallback;
}

export class ApiClient {
  constructor(private readonly settings: ClientSettings) {}

  get apiBaseUrl(): string {
    return this.settings.apiBaseUrl;
  }

  private async fetchJson(url: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
    const headers = new Headers(init.headers);
    const clientRequestId = headers.get('X-Request-ID') ?? createRequestId();
    headers.set('Accept', 'application/json');
    headers.set('X-Client-Version', applicationVersion());
    headers.set('X-Request-ID', clientRequestId);

    if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    if (this.settings.authMode === 'bearer' && this.settings.bearerToken) {
      headers.set('Authorization', `Bearer ${this.settings.bearerToken}`);
    }
    const method = (init.method ?? 'GET').toUpperCase();
    if (this.settings.authMode === 'cookie' && this.settings.csrfToken && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      headers.set('X-CSRF-Token', this.settings.csrfToken);
    }

    try {
      const response = await fetch(url, {
        ...init,
        headers,
        credentials: 'include',
        signal: controller.signal,
      });
      const body = await parseResponseBody(response);
      if (!response.ok) {
        const parsed = parseApiProblem(body, response.status);
        throw new ApiError(parsed.message, {
          status: response.status,
          code: parsed.code,
          requestId: responseRequestId(response, parsed.requestId, clientRequestId),
          problem: parsed.problem,
        });
      }
      return body;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new ApiError('APIへの接続がタイムアウトしました。', {
          status: 408,
          requestId: clientRequestId,
          cause: error,
        });
      }
      throw new ApiError('ローカルREST APIサーバーへ接続できません。', {
        status: 0,
        requestId: clientRequestId,
        cause: error,
      });
    } finally {
      window.clearTimeout(timeout);
    }
  }

  async request(path: string, init: RequestInit = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
    return this.fetchJson(joinUrl(this.settings.apiBaseUrl, path), init, timeoutMs);
  }

  async requestUrl(url: string, init: RequestInit = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
    return this.fetchJson(this.resolveExternalUrl(url), init, timeoutMs);
  }

  async upload(instruction: UploadInstruction, blob: Blob, options: UploadOptions = {}): Promise<void> {
    const url = this.resolveExternalUrl(instruction.url);
    const target = new URL(url, window.location.href);
    const sameOrigin = target.origin === window.location.origin;
    const directR2 = isPresignedR2Target(target);
    if (!sameOrigin && !directR2) {
      throw new ApiError('信頼されていないファイルアップロード先を拒否しました。', {
        status: 0,
        code: 'untrusted_upload_target',
      });
    }
    const uploadHeaders = { ...instruction.headers };

    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const abort = () => xhr.abort();
      const finish = (callback: () => void) => {
        options.signal?.removeEventListener('abort', abort);
        callback();
      };

      xhr.open(instruction.method, url, true);
      xhr.withCredentials = sameOrigin;
      xhr.timeout = TRANSFER_TIMEOUT_MS;
      for (const [name, value] of Object.entries(uploadHeaders)) xhr.setRequestHeader(name, value);
      xhr.upload.onprogress = (event) => {
        const total = event.lengthComputable && event.total > 0 ? event.total : blob.size;
        options.onProgress?.(Math.min(event.loaded, total), total);
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          options.onProgress?.(blob.size, blob.size);
          finish(resolve);
          return;
        }
        let body: unknown = xhr.responseText || undefined;
        if ((xhr.getResponseHeader('Content-Type') ?? '').includes('json') && xhr.responseText) {
          try { body = JSON.parse(xhr.responseText); } catch { /* keep the response text */ }
        }
        const parsed = parseApiProblem(body, xhr.status);
        finish(() => reject(new ApiError(parsed.message || `ファイルのアップロードに失敗しました (${xhr.status})`, {
          status: xhr.status,
          code: parsed.code,
          requestId: xhr.getResponseHeader('X-Request-ID') ?? parsed.requestId,
          problem: parsed.problem,
        })));
      };
      xhr.onerror = () => finish(() => reject(new ApiError('ファイルのアップロード先へ接続できません。', { status: 0 })));
      xhr.ontimeout = () => finish(() => reject(new ApiError('ファイルのアップロードがタイムアウトしました。', { status: 408 })));
      xhr.onabort = () => finish(() => reject(new ApiError('ファイルのアップロードをキャンセルしました。', {
        status: 0,
        code: 'upload_cancelled',
      })));

      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) {
        finish(() => reject(new ApiError('ファイルのアップロードをキャンセルしました。', {
          status: 0,
          code: 'upload_cancelled',
        })));
        return;
      }
      xhr.send(blob);
    });
  }

  async downloadBlob(value: string): Promise<Blob> {
    const url = this.resolveExternalUrl(value);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), TRANSFER_TIMEOUT_MS);
    const target = new URL(url, window.location.href);
    const sameOrigin = target.origin === window.location.origin;

    try {
      const response = await fetch(url, {
        credentials: sameOrigin ? 'include' : 'omit',
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await parseResponseBody(response);
        const parsed = parseApiProblem(body, response.status);
        throw new ApiError(parsed.message || `ファイルのダウンロードに失敗しました (${response.status})`, {
          status: response.status,
          code: parsed.code,
          requestId: responseRequestId(response, parsed.requestId),
          problem: parsed.problem,
        });
      }
      return response.blob();
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new ApiError('ファイルのダウンロードがタイムアウトしました。', { status: 408, cause: error });
      }
      throw new ApiError('ファイルのダウンロード先へ接続できません。', { status: 0, cause: error });
    } finally {
      window.clearTimeout(timeout);
    }
  }

  resolveExternalUrl(value: string): string {
    try {
      if (/^https?:\/\//i.test(value)) return new URL(value).toString();
      if (/^https?:\/\//i.test(this.settings.apiBaseUrl)) {
        return new URL(value, this.settings.apiBaseUrl).toString();
      }
      return new URL(value, window.location.href).toString();
    } catch {
      return value;
    }
  }
}
