export interface ApiProblem {
  type?: string;
  title?: string;
  status?: number;
  detail?: unknown;
  instance?: string;
  code?: string;
  message?: string;
  request_id?: string;
  [key: string]: unknown;
}

interface ParsedProblem {
  message: string;
  code?: string;
  requestId?: string;
  problem?: ApiProblem;
}

function validationMessage(detail: unknown[]): string | undefined {
  const messages = detail.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const value = entry as Record<string, unknown>;
    const message = typeof value.msg === 'string' ? value.msg : undefined;
    const location = Array.isArray(value.loc)
      ? value.loc.filter((part) => typeof part === 'string' || typeof part === 'number').join('.')
      : undefined;
    if (!message) return [];
    return [location ? `${location}: ${message}` : message];
  });
  return messages.length > 0 ? messages.join(' / ') : undefined;
}

export function parseApiProblem(body: unknown, status: number): ParsedProblem {
  if (typeof body !== 'object' || body === null) {
    return { message: typeof body === 'string' && body ? body : `API request failed (${status})` };
  }

  const problem = body as ApiProblem;
  const nested = typeof problem.detail === 'object' && problem.detail !== null && !Array.isArray(problem.detail)
    ? problem.detail as Record<string, unknown>
    : undefined;
  const code = typeof nested?.code === 'string'
    ? nested.code
    : typeof problem.code === 'string'
      ? problem.code
      : undefined;
  const requestId = typeof nested?.request_id === 'string'
    ? nested.request_id
    : typeof problem.request_id === 'string'
      ? problem.request_id
      : undefined;
  const message = typeof nested?.message === 'string'
    ? nested.message
    : typeof problem.detail === 'string'
      ? problem.detail
      : Array.isArray(problem.detail)
        ? validationMessage(problem.detail) ?? `Validation failed (${status})`
        : typeof problem.message === 'string'
          ? problem.message
          : typeof problem.title === 'string'
            ? problem.title
            : `API request failed (${status})`;

  return { message, code, requestId, problem };
}

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly requestId?: string;
  readonly problem?: ApiProblem;
  readonly retryable: boolean;

  constructor(message: string, options: {
    status?: number;
    code?: string;
    requestId?: string;
    problem?: ApiProblem;
    cause?: unknown;
  } = {}) {
    super(message, { cause: options.cause });
    this.name = 'ApiError';
    this.status = options.status ?? 0;
    this.code = options.code;
    this.requestId = options.requestId;
    this.problem = options.problem;
    this.retryable = this.status === 0 || this.status === 408 || this.status === 425 || this.status === 429 || this.status >= 500;
  }
}

function appendRequestId(message: string, requestId?: string): string {
  return requestId ? `${message}（Request ID: ${requestId}）` : message;
}

export function apiErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    let message: string;
    if (error.status === 401) message = '端末トークンがありません、期限切れ、または端末が失効しています。設定からRelayMockへ接続してください。';
    else if (error.status === 403) message = error.message || 'この操作は許可されていません。';
    else if (error.status === 404) message = error.message || 'APIのエンドポイントまたは対象データが見つかりません。';
    else if (error.status === 409) message = error.message || '現在の状態と操作が競合しました。同期後に再試行してください。';
    else if (error.status === 410) message = error.message || 'ファイルまたはTicketは期限切れのため利用できません。';
    else if (error.status === 413) message = error.message || 'ファイルまたはリクエストが大きすぎます。';
    else if (error.status === 422) message = error.message || '入力値を確認してください。';
    else if (error.status === 429) message = '送信回数の上限に達しました。時間を置いて再試行してください。';
    else message = error.message;
    return appendRequestId(message, error.requestId);
  }
  if (error instanceof Error) return error.message;
  return '不明なエラーが発生しました。';
}
