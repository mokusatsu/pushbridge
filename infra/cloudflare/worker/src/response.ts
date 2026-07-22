const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

export function json(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  for (const [name, headerValue] of Object.entries(JSON_HEADERS)) {
    if (!headers.has(name)) headers.set(name, headerValue);
  }
  return new Response(JSON.stringify(value), { ...init, headers });
}

export function problem(status: number, code: string, message: string, requestId: string, headers: HeadersInit = {}): Response {
  return json({ detail: { code, message, request_id: requestId } }, {
    status,
    headers: { ...Object.fromEntries(new Headers(headers)), "x-request-id": requestId },
  });
}

export function getRequestId(request: Request): string {
  return request.headers.get("cf-ray") ?? request.headers.get("x-request-id") ?? crypto.randomUUID();
}

export async function bodyJson<T extends Record<string, unknown>>(request: Request, requestId: string): Promise<T> {
  try {
    return await request.json<T>();
  } catch {
    throw problem(400, "invalid_json", "Request body must be valid JSON.", requestId);
  }
}
