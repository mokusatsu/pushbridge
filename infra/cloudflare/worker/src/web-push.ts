import { base64UrlDecode, base64UrlEncode, decryptText, ownedBuffer } from "./crypto";
import { issueDeliveryToken, markDeliveryFailed, markDeliveryNotified } from "./deliveries";
import { issueDownloadTicket } from "./files";
import type { Env, FileDeliveryRow, Runtime, SubscriptionRow } from "./types";

const encoder = new TextEncoder();
const MAX_WEB_PUSH_PLAINTEXT_BYTES = 3_993;
const WEB_PUSH_RECORD_SIZE = 4_096;
const DELIVERY_ATTEMPT_LIMIT = 3;
const TRANSIENT_SEND_ATTEMPTS = 2;

function concatenate(...arrays: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(arrays.reduce((total, value) => total + value.byteLength, 0));
  let offset = 0;
  for (const value of arrays) {
    result.set(value, offset);
    offset += value.byteLength;
  }
  return result;
}

function uint32(value: number): Uint8Array {
  const result = new Uint8Array(4);
  new DataView(result.buffer).setUint32(0, value, false);
  return result;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ownedBuffer(ikm), "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({
    name: "HKDF",
    hash: "SHA-256",
    salt: ownedBuffer(salt),
    info: ownedBuffer(info),
  }, key, length * 8));
}

function validateWebPushKey(name: string, encoded: string, expectedLength: number): Uint8Array {
  const value = base64UrlDecode(encoded);
  if (value.byteLength !== expectedLength) throw new Error(`${name} has an invalid length`);
  return value;
}

export async function encryptWebPushPayload(
  plaintext: Uint8Array,
  receiverPublicKey: string,
  authenticationSecret: string,
): Promise<Uint8Array> {
  if (plaintext.byteLength > MAX_WEB_PUSH_PLAINTEXT_BYTES) throw new Error("Web Push payload exceeds the RFC 8291 limit");
  const uaPublic = validateWebPushKey("p256dh", receiverPublicKey, 65);
  if (uaPublic[0] !== 4) throw new Error("p256dh is not an uncompressed P-256 point");
  const authSecret = validateWebPushKey("auth", authenticationSecret, 16);
  const applicationKeys = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const applicationPublic = new Uint8Array(await crypto.subtle.exportKey("raw", applicationKeys.publicKey));
  const receiverKey = await crypto.subtle.importKey(
    "raw",
    ownedBuffer(uaPublic),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const sharedSecret = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "ECDH", public: receiverKey },
    applicationKeys.privateKey,
    256,
  ));
  const keyInfo = concatenate(encoder.encode("WebPush: info\0"), uaPublic, applicationPublic);
  const inputKeyMaterial = await hkdf(authSecret, sharedSecret, keyInfo, 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const contentEncryptionKey = await hkdf(salt, inputKeyMaterial, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, inputKeyMaterial, encoder.encode("Content-Encoding: nonce\0"), 12);
  const aesKey = await crypto.subtle.importKey("raw", ownedBuffer(contentEncryptionKey), "AES-GCM", false, ["encrypt"]);
  const record = concatenate(plaintext, new Uint8Array([2]));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: ownedBuffer(nonce) },
    aesKey,
    ownedBuffer(record),
  ));
  return concatenate(salt, uint32(WEB_PUSH_RECORD_SIZE), new Uint8Array([applicationPublic.byteLength]), applicationPublic, ciphertext);
}

function vapidPrivateKey(publicKey: Uint8Array, privateKey: Uint8Array): JsonWebKey {
  if (publicKey.byteLength !== 65 || publicKey[0] !== 4 || privateKey.byteLength !== 32) {
    throw new Error("VAPID keys must be an uncompressed P-256 public key and a 32-byte private key");
  }
  return {
    kty: "EC",
    crv: "P-256",
    x: base64UrlEncode(publicKey.slice(1, 33)),
    y: base64UrlEncode(publicKey.slice(33, 65)),
    d: base64UrlEncode(privateKey),
    ext: true,
    key_ops: ["sign"],
  };
}

export async function createVapidAuthorization(
  endpoint: string,
  publicKeyEncoded: string,
  privateKeyEncoded: string,
  subject: string,
  now: number,
): Promise<string> {
  const endpointUrl = new URL(endpoint);
  if (endpointUrl.protocol !== "https:") throw new Error("Web Push endpoint must use HTTPS");
  if (!subject.startsWith("mailto:") && !subject.startsWith("https://")) throw new Error("VAPID_SUBJECT must be a mailto or HTTPS URI");
  const publicKey = validateWebPushKey("VAPID_PUBLIC_KEY", publicKeyEncoded, 65);
  const privateKey = validateWebPushKey("VAPID_PRIVATE_KEY", privateKeyEncoded, 32);
  const header = base64UrlEncode(encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = base64UrlEncode(encoder.encode(JSON.stringify({
    aud: endpointUrl.origin,
    exp: Math.floor(now / 1000) + 12 * 60 * 60,
    sub: subject,
  })));
  const unsigned = `${header}.${claims}`;
  const signingKey = await crypto.subtle.importKey(
    "jwk",
    vapidPrivateKey(publicKey, privateKey),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    signingKey,
    encoder.encode(unsigned),
  ));
  return `vapid t=${unsigned}.${base64UrlEncode(signature)}, k=${publicKeyEncoded}`;
}

export interface WebPushRequest {
  endpoint: string;
  p256dh: string;
  auth: string;
  payload: Record<string, unknown>;
}

export interface WebPushSendResult {
  status: number;
  outcome: "delivered" | "gone" | "retryable";
}

export async function sendWebPush(
  request: WebPushRequest,
  env: Pick<Env, "VAPID_PUBLIC_KEY" | "VAPID_PRIVATE_KEY" | "VAPID_SUBJECT">,
  now: number,
  fetcher: typeof fetch = fetch,
): Promise<WebPushSendResult> {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) throw new Error("VAPID configuration is incomplete");
  const body = await encryptWebPushPayload(encoder.encode(JSON.stringify(request.payload)), request.p256dh, request.auth);
  const authorization = await createVapidAuthorization(
    request.endpoint,
    env.VAPID_PUBLIC_KEY,
    env.VAPID_PRIVATE_KEY,
    env.VAPID_SUBJECT,
    now,
  );
  const response = await fetcher(request.endpoint, {
    method: "POST",
    redirect: "manual",
    headers: {
      authorization,
      "content-encoding": "aes128gcm",
      "content-type": "application/octet-stream",
      ttl: "60",
      urgency: "high",
    },
    body: ownedBuffer(body),
  });
  if (response.status >= 200 && response.status < 300) return { status: response.status, outcome: "delivered" };
  if (response.status === 404 || response.status === 410) return { status: response.status, outcome: "gone" };
  return { status: response.status, outcome: "retryable" };
}

function asText(value: string | ArrayBuffer): string {
  return typeof value === "string" ? value : new TextDecoder().decode(value);
}

function subscriptionAad(row: SubscriptionRow, field: string): string {
  return `pushbridge:web-push:${row.user_id}:${row.device_id}:${row.id}:${field}`;
}

async function decryptSubscription(row: SubscriptionRow, dataKey: string): Promise<{ endpoint: string; p256dh: string; auth: string }> {
  return {
    endpoint: await decryptText(asText(row.endpoint_ciphertext), row.endpoint_nonce, dataKey, subscriptionAad(row, "endpoint")),
    p256dh: await decryptText(asText(row.p256dh_ciphertext), row.p256dh_nonce, dataKey, subscriptionAad(row, "p256dh")),
    auth: await decryptText(asText(row.auth_ciphertext), row.auth_nonce, dataKey, subscriptionAad(row, "auth")),
  };
}

interface DeliveryFileRow extends FileDeliveryRow {
  actual_size: number | null;
  expected_size: number;
  e2ee: number;
}

function deliveryPayload(
  row: DeliveryFileRow,
  subscription: SubscriptionRow,
  origin: string,
  downloadUrl: string,
  deliveryToken: string,
  deliveryTokenExpiresAt: number,
): Record<string, unknown> {
  return {
    version: 1,
    kind: "file",
    storage_namespace: subscription.storage_namespace,
    file_download: {
      push_id: row.push_id,
      file_id: row.file_id,
      size: Number(row.actual_size ?? row.expected_size),
      mime_type: "application/octet-stream",
      encrypted: Boolean(row.e2ee),
      download_url: downloadUrl,
    },
    file_delivery: {
      delivery_id: row.id,
      token: deliveryToken,
      token_expires_at: new Date(deliveryTokenExpiresAt).toISOString(),
      events_url: `${origin}/api/v1/file-deliveries/${encodeURIComponent(row.id)}/events`,
    },
  };
}

async function recordSubscriptionSuccess(env: Env, subscriptionId: string, runtime: Runtime): Promise<void> {
  await env.DB.prepare(`UPDATE web_push_subscriptions SET consecutive_failures = 0, last_failure_code = NULL,
    last_success_at = ?, updated_at = ? WHERE id = ?`).bind(runtime.now(), runtime.now(), subscriptionId).run();
}

async function recordSubscriptionFailure(env: Env, subscriptionId: string, code: string, revoke: boolean, runtime: Runtime): Promise<void> {
  await env.DB.prepare(`UPDATE web_push_subscriptions SET consecutive_failures = consecutive_failures + 1,
    last_failure_code = ?, updated_at = ?, revoked_at = CASE WHEN ? THEN COALESCE(revoked_at, ?) ELSE revoked_at END
    WHERE id = ?`).bind(code, runtime.now(), revoke ? 1 : 0, runtime.now(), subscriptionId).run();
}

async function sendWithLimitedRetry(
  request: WebPushRequest,
  env: Env,
  runtime: Runtime,
  fetcher: typeof fetch,
): Promise<WebPushSendResult> {
  let result: WebPushSendResult = { status: 0, outcome: "retryable" };
  for (let attempt = 0; attempt < TRANSIENT_SEND_ATTEMPTS; attempt += 1) {
    try {
      result = await sendWebPush(request, env, runtime.now(), fetcher);
    } catch {
      result = { status: 0, outcome: "retryable" };
    }
    if (result.outcome !== "retryable") return result;
  }
  return result;
}

export function webPushDeliveryConfigured(env: Env): boolean {
  return Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT && env.WEB_PUSH_DATA_KEY);
}

export async function deliverFilePush(
  env: Env,
  pushId: string,
  origin: string,
  runtime: Runtime,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  if (!webPushDeliveryConfigured(env)) return;
  const deliveries = await env.DB.prepare(`SELECT d.*, f.actual_size, f.expected_size, f.e2ee
    FROM file_deliveries d JOIN files f ON f.id = d.file_id
    WHERE d.push_id = ? AND d.state IN ('pending', 'failed_retryable') AND d.attempt_count < ?
    ORDER BY d.id`).bind(pushId, DELIVERY_ATTEMPT_LIMIT).all<DeliveryFileRow>();
  for (const delivery of deliveries.results) {
    const subscriptions = await env.DB.prepare(`SELECT * FROM web_push_subscriptions
      WHERE user_id = ? AND device_id = ? AND revoked_at IS NULL ORDER BY created_at, id`)
      .bind(delivery.user_id, delivery.destination_device_id).all<SubscriptionRow>();
    if (subscriptions.results.length === 0) continue;
    const deliveryToken = await issueDeliveryToken(env, delivery.id, runtime);
    if (!deliveryToken) continue;
    let delivered = false;
    let failureCode = "web_push_failed";
    for (const subscription of subscriptions.results) {
      try {
        const ticket = await issueDownloadTicket(env, delivery.user_id, delivery.file_id, origin, runtime);
        if (!ticket) {
          failureCode = "file_not_ready";
          break;
        }
        const secrets = await decryptSubscription(subscription, env.WEB_PUSH_DATA_KEY!);
        const result = await sendWithLimitedRetry({
          ...secrets,
          payload: deliveryPayload(delivery, subscription, origin, ticket.downloadUrl, deliveryToken.token, deliveryToken.expiresAt),
        }, env, runtime, fetcher);
        if (result.outcome === "delivered") {
          delivered = true;
          await recordSubscriptionSuccess(env, subscription.id, runtime);
        } else {
          const gone = result.outcome === "gone";
          failureCode = gone ? "web_push_subscription_gone" : `web_push_http_${result.status || "network"}`;
          await recordSubscriptionFailure(env, subscription.id, failureCode, gone, runtime);
        }
      } catch {
        failureCode = "web_push_crypto_error";
        await recordSubscriptionFailure(env, subscription.id, failureCode, false, runtime);
      }
    }
    if (delivered) await markDeliveryNotified(env, delivery.id, runtime);
    else await markDeliveryFailed(env, delivery.id, failureCode, runtime);
  }
}
