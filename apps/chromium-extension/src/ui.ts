export interface RuntimeResponse<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

export async function message<T>(value: Record<string, unknown>): Promise<T> {
  const response = await chrome.runtime.sendMessage(value) as RuntimeResponse<T>;
  if (!response?.ok) throw new Error(response?.error || '拡張機能Service Workerへ接続できません。');
  return response.value as T;
}

export function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing element: ${id}`);
  return value as T;
}

export function setStatus(text: string, kind: 'normal' | 'success' | 'error' = 'normal'): void {
  const target = element<HTMLDivElement>('status');
  target.textContent = text;
  target.className = `status${kind === 'normal' ? '' : ` ${kind}`}`;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
