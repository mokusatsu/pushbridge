import { base64UrlDecode, decryptText, encryptText, sha256Hex } from "./crypto";
import { bodyJson, json, problem } from "./response";
import { iso } from "./runtime";
import type { AuthContext, Env, Runtime, SubscriptionRow } from "./types";
import { webPushDeliveryConfigured } from "./web-push";

function registrationEnabled(env: Env): boolean {
  return Boolean(env.VAPID_PUBLIC_KEY && env.WEB_PUSH_DATA_KEY);
}

function deliveryEnabled(env: Env): boolean {
  return registrationEnabled(env) && webPushDeliveryConfigured(env);
}

function validPublicKey(value: string): boolean {
  try {
    const bytes = base64UrlDecode(value);
    return bytes.byteLength === 65 && bytes[0] === 4;
  } catch {
    return false;
  }
}

export function webPushConfig(env: Env, requestId: string): Response {
  const registration = registrationEnabled(env) && validPublicKey(env.VAPID_PUBLIC_KEY ?? "");
  return json({
    subscription_registration: registration,
    delivery: registration && deliveryEnabled(env),
    vapid_public_key: registration ? env.VAPID_PUBLIC_KEY : "",
  }, { headers: { "x-request-id": requestId } });
}

function asText(value: string | ArrayBuffer): string {
  return typeof value === "string" ? value : new TextDecoder().decode(value);
}

function aad(row: Pick<SubscriptionRow, "user_id" | "device_id" | "id">, field: string): string {
  return `pushbridge:web-push:${row.user_id}:${row.device_id}:${row.id}:${field}`;
}

async function subscriptionOut(row: SubscriptionRow, env: Env): Promise<Record<string, unknown>> {
  const key = env.WEB_PUSH_DATA_KEY;
  if (!key) throw new Error("WEB_PUSH_DATA_KEY is unavailable");
  return {
    id: row.id,
    device_id: row.device_id,
    endpoint: await decryptText(asText(row.endpoint_ciphertext), row.endpoint_nonce, key, aad(row, "endpoint")),
    created_at: iso(row.created_at),
    revoked_at: iso(row.revoked_at),
  };
}

function parseSubscription(body: Record<string, unknown>, requestId: string): {
  endpoint: string;
  p256dh: string;
  auth: string;
  storageNamespace: string | null;
  localCacheMaxBytes: number | null;
} {
  const allowed = new Set(["endpoint", "p256dh", "auth", "storage_namespace", "local_cache_max_bytes"]);
  if (Object.keys(body).some((field) => !allowed.has(field))) throw problem(422, "unexpected_field", "The subscription contains an unsupported field.", requestId);
  const endpoint = typeof body.endpoint === "string" ? body.endpoint : "";
  let url: URL;
  try { url = new URL(endpoint); } catch { throw problem(422, "invalid_subscription_endpoint", "endpoint must be an absolute HTTPS URL.", requestId); }
  if (url.protocol !== "https:" || endpoint.length > 4096) throw problem(422, "invalid_subscription_endpoint", "endpoint must be an absolute HTTPS URL.", requestId);
  const p256dh = typeof body.p256dh === "string" ? body.p256dh : "";
  const auth = typeof body.auth === "string" ? body.auth : "";
  try {
    if (base64UrlDecode(p256dh).byteLength !== 65 || base64UrlDecode(auth).byteLength !== 16) throw new Error("invalid key length");
  } catch {
    throw problem(422, "invalid_subscription_keys", "p256dh and auth must be valid Web Push base64url keys.", requestId);
  }
  const storageNamespace = body.storage_namespace == null ? null : typeof body.storage_namespace === "string" ? body.storage_namespace.trim() : "";
  if (storageNamespace != null && (!storageNamespace || storageNamespace.length > 200)) throw problem(422, "invalid_storage_namespace", "storage_namespace must contain 1 to 200 characters.", requestId);
  const localCacheMaxBytes = body.local_cache_max_bytes == null ? null : typeof body.local_cache_max_bytes === "number" && Number.isSafeInteger(body.local_cache_max_bytes) ? body.local_cache_max_bytes : -1;
  if (localCacheMaxBytes != null && (localCacheMaxBytes < 0 || localCacheMaxBytes > 2_147_483_647)) throw problem(422, "invalid_local_cache_limit", "local_cache_max_bytes is outside the supported range.", requestId);
  return { endpoint, p256dh, auth, storageNamespace, localCacheMaxBytes };
}

async function createSubscription(request: Request, env: Env, authContext: AuthContext, requestId: string, runtime: Runtime): Promise<Response> {
  if (!registrationEnabled(env)) return problem(409, "web_push_registration_disabled", "Web Push subscription registration is disabled.", requestId);
  const input = parseSubscription(await bodyJson(request, requestId), requestId);
  const key = env.WEB_PUSH_DATA_KEY!;
  const endpointHash = await sha256Hex(input.endpoint);
  const existing = await env.DB.prepare(`SELECT * FROM web_push_subscriptions
    WHERE user_id = ? AND device_id = ? AND endpoint_hash = ?`)
    .bind(authContext.user_id, authContext.device_id, endpointHash).first<SubscriptionRow>();
  const now = runtime.now();
  const id = existing?.id ?? runtime.id("sub");
  const rowKey = { id, user_id: authContext.user_id, device_id: authContext.device_id };
  const endpoint = await encryptText(input.endpoint, key, aad(rowKey, "endpoint"));
  const p256dh = await encryptText(input.p256dh, key, aad(rowKey, "p256dh"));
  const auth = await encryptText(input.auth, key, aad(rowKey, "auth"));
  if (existing) {
    await env.DB.prepare(`UPDATE web_push_subscriptions SET endpoint_ciphertext = ?, endpoint_nonce = ?,
      p256dh_ciphertext = ?, p256dh_nonce = ?, auth_ciphertext = ?, auth_nonce = ?, storage_namespace = ?,
      local_cache_max_bytes = ?, updated_at = ?, revoked_at = NULL WHERE id = ?`)
      .bind(endpoint.ciphertext, endpoint.nonce, p256dh.ciphertext, p256dh.nonce, auth.ciphertext, auth.nonce,
        input.storageNamespace, input.localCacheMaxBytes, now, id).run();
  } else {
    await env.DB.prepare(`INSERT INTO web_push_subscriptions
      (id, user_id, device_id, endpoint_ciphertext, endpoint_hash, endpoint_nonce, p256dh_ciphertext,
       p256dh_nonce, auth_ciphertext, auth_nonce, storage_namespace, local_cache_max_bytes,
       created_at, updated_at, revoked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`)
      .bind(id, authContext.user_id, authContext.device_id, endpoint.ciphertext, endpointHash, endpoint.nonce,
        p256dh.ciphertext, p256dh.nonce, auth.ciphertext, auth.nonce, input.storageNamespace,
        input.localCacheMaxBytes, now, now).run();
  }
  const row = await env.DB.prepare("SELECT * FROM web_push_subscriptions WHERE id = ?").bind(id).first<SubscriptionRow>();
  if (!row) throw new Error("created subscription is missing");
  return json(await subscriptionOut(row, env), { status: existing ? 200 : 201, headers: { "x-request-id": requestId } });
}

async function listSubscriptions(env: Env, authContext: AuthContext, requestId: string): Promise<Response> {
  if (!registrationEnabled(env)) return problem(409, "web_push_registration_disabled", "Web Push subscription registration is disabled.", requestId);
  const rows = await env.DB.prepare(`SELECT * FROM web_push_subscriptions
    WHERE user_id = ? AND device_id = ? AND revoked_at IS NULL ORDER BY created_at, id`)
    .bind(authContext.user_id, authContext.device_id).all<SubscriptionRow>();
  return json(await Promise.all(rows.results.map((row) => subscriptionOut(row, env))), { headers: { "x-request-id": requestId } });
}

async function revokeSubscription(env: Env, authContext: AuthContext, requestId: string, subscriptionId: string, runtime: Runtime): Promise<Response> {
  const result = await env.DB.prepare(`UPDATE web_push_subscriptions SET revoked_at = ?, updated_at = ?
    WHERE id = ? AND user_id = ? AND device_id = ? AND revoked_at IS NULL`)
    .bind(runtime.now(), runtime.now(), subscriptionId, authContext.user_id, authContext.device_id).run();
  if (result.meta.changes === 0) return problem(404, "subscription_not_found", "Active subscription not found for the current device.", requestId);
  return new Response(null, { status: 204, headers: { "x-request-id": requestId, "cache-control": "no-store" } });
}

export async function handleSubscriptionRoute(
  request: Request,
  env: Env,
  authContext: AuthContext,
  requestId: string,
  path: string,
  runtime: Runtime,
): Promise<Response | null> {
  if (path === "/v1/web-push-subscriptions" && request.method === "POST") return createSubscription(request, env, authContext, requestId, runtime);
  if (path === "/v1/web-push-subscriptions" && request.method === "GET") return listSubscriptions(env, authContext, requestId);
  const match = path.match(/^\/v1\/web-push-subscriptions\/([^/]+)$/);
  if (match && request.method === "DELETE") return revokeSubscription(env, authContext, requestId, decodeURIComponent(match[1]), runtime);
  return null;
}
