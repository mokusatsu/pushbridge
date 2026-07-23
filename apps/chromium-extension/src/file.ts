import { API_BASE_PATH, API_ORIGIN, encryptFile } from './shared';
import { getAccountKey, getState } from './storage';

const MAX_ENCRYPTED_FILE_BYTES = 25 * 1024 * 1024;
const FILE_CONTAINER_OVERHEAD = 53;
const ALLOWED_TTLS = new Set([86_400, 604_800, 2_592_000]);

interface ApiProblem {
  detail?: string;
  message?: string;
}

interface FileRecord {
  id: string;
  expires_at: string;
}

interface FileInit {
  file: FileRecord;
  upload_url: string;
  upload_method: 'PUT';
  upload_headers: Record<string, string>;
}

function isPresignedR2Target(target: URL): boolean {
  return target.protocol === 'https:'
    && /^[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/u.test(target.hostname)
    && target.searchParams.get('X-Amz-Algorithm') === 'AWS4-HMAC-SHA256'
    && Boolean(target.searchParams.get('X-Amz-Signature'));
}

async function sha256Hex(value: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', value));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const state = await getState();
  if (!state.accessToken) throw new Error('拡張機能を端末リンクしてください。');
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  headers.set('Authorization', `Bearer ${state.accessToken}`);
  if (init.body) headers.set('Content-Type', 'application/json');
  const response = await fetch(`${API_ORIGIN}${API_BASE_PATH}${path}`, {
    ...init,
    headers,
    credentials: 'include',
  });
  const contentType = response.headers.get('content-type') ?? '';
  const body = contentType.includes('json') ? await response.json() as T & ApiProblem : undefined;
  if (!response.ok || !contentType.includes('json')) {
    if (response.status === 200 && !contentType.includes('json')) {
      throw new Error('Cloudflare Accessへのブラウザーログインが必要です。');
    }
    throw new Error(body?.detail || body?.message || `File API request failed (${response.status})`);
  }
  return body as T;
}

export interface UploadedEncryptedFile {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  expiresAt: string;
}

export async function uploadEncryptedFile(
  file: File,
  expiresIn: number,
  progress: (stage: 'encrypting' | 'uploading' | 'completing') => void,
): Promise<UploadedEncryptedFile> {
  if (!file.name || file.name.length > 255) throw new Error('ファイル名は1〜255文字にしてください。');
  if (!ALLOWED_TTLS.has(expiresIn)) throw new Error('保持期間が不正です。');
  if (file.size + FILE_CONTAINER_OVERHEAD > MAX_ENCRYPTED_FILE_BYTES) {
    throw new Error('暗号化後のファイルサイズは25 MiB以下にしてください。');
  }
  const accountKey = await getAccountKey();
  if (!accountKey) throw new Error('E2EE鍵を準備できていません。');
  const initialized = await request<FileInit>('/files/init', {
    method: 'POST',
    body: JSON.stringify({
      filename: 'encrypted.bin',
      content_type: 'application/octet-stream',
      size: file.size + FILE_CONTAINER_OVERHEAD,
      sha256: null,
      expires_in: expiresIn,
      encrypted: true,
    }),
  });
  try {
    progress('encrypting');
    const encrypted = await encryptFile(accountKey.bytes, accountKey.version, initialized.file.id, await file.arrayBuffer());
    progress('uploading');
    const uploadUrl = new URL(initialized.upload_url, API_ORIGIN);
    const sameOrigin = uploadUrl.origin === new URL(API_ORIGIN).origin;
    const directR2 = isPresignedR2Target(uploadUrl);
    if (!sameOrigin && !directR2) {
      throw new Error('信頼されていないアップロード先を拒否しました。');
    }
    const encryptedHash = await sha256Hex(encrypted);
    const uploadHeaders = { ...initialized.upload_headers };
    const upload = await fetch(uploadUrl, {
      method: initialized.upload_method,
      headers: uploadHeaders,
      body: encrypted,
      credentials: sameOrigin ? 'include' : 'omit',
    });
    if (!upload.ok) throw new Error(`暗号化ファイルのアップロードに失敗しました (${upload.status})`);
    progress('completing');
    const completed = await request<FileRecord>(`/files/${encodeURIComponent(initialized.file.id)}/complete`, {
      method: 'POST',
      body: JSON.stringify({ sha256: encryptedHash }),
    });
    return {
      id: completed.id,
      name: file.name,
      mimeType: file.type || 'application/octet-stream',
      size: file.size,
      expiresAt: completed.expires_at,
    };
  } catch (error) {
    await request(`/files/${encodeURIComponent(initialized.file.id)}`, { method: 'DELETE' }).catch(() => undefined);
    throw error;
  }
}

export async function deleteUploadedFile(fileId: string): Promise<void> {
  await request(`/files/${encodeURIComponent(fileId)}`, { method: 'DELETE' }).catch(() => undefined);
}
