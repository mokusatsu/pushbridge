import { describe, expect, it } from "vitest";
import { base64UrlDecode, base64UrlEncode, ownedBuffer } from "../src/crypto";
import { createVapidAuthorization, sendWebPush } from "../src/web-push";

const encoder = new TextEncoder();

function concatenate(...arrays: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(arrays.reduce((length, value) => length + value.byteLength, 0));
  let offset = 0;
  for (const value of arrays) {
    result.set(value, offset);
    offset += value.byteLength;
  }
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

async function decryptPayload(body: Uint8Array, receiverKeys: CryptoKeyPair, receiverPublic: Uint8Array, auth: Uint8Array): Promise<Uint8Array> {
  const salt = body.slice(0, 16);
  expect(new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0, false)).toBe(4096);
  const keyLength = body[20];
  expect(keyLength).toBe(65);
  const applicationPublic = body.slice(21, 21 + keyLength);
  const applicationKey = await crypto.subtle.importKey("raw", ownedBuffer(applicationPublic), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const sharedSecret = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "ECDH", public: applicationKey },
    receiverKeys.privateKey,
    256,
  ));
  const ikm = await hkdf(auth, sharedSecret, concatenate(encoder.encode("WebPush: info\0"), receiverPublic, applicationPublic), 32);
  const cek = await hkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", ownedBuffer(cek), "AES-GCM", false, ["decrypt"]);
  const plaintext = new Uint8Array(await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: ownedBuffer(nonce) },
    key,
    ownedBuffer(body.slice(21 + keyLength)),
  ));
  expect(plaintext.at(-1)).toBe(2);
  return plaintext.slice(0, -1);
}

describe("RFC 8291/8292 Web Push", () => {
  it("encrypts a payload the receiver can decrypt and signs valid VAPID claims", async () => {
    const receiverKeys = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const receiverPublic = new Uint8Array(await crypto.subtle.exportKey("raw", receiverKeys.publicKey));
    const receiverAuth = crypto.getRandomValues(new Uint8Array(16));
    const vapidKeys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const vapidPublic = new Uint8Array(await crypto.subtle.exportKey("raw", vapidKeys.publicKey));
    const vapidPrivate = await crypto.subtle.exportKey("jwk", vapidKeys.privateKey);
    const now = Date.UTC(2026, 6, 22, 0, 0, 0);
    const payload = {
      version: 1,
      kind: "file",
      file_id: "fil_test",
      download_url: "https://worker.test/mock-storage/downloads/secret-ticket",
      file_delivery: { id: "fdl_test", token: "secret-ack" },
    };
    let captured: { input: RequestInfo | URL; init?: RequestInit } | null = null;
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = { input, init };
      return new Response(null, { status: 201 });
    }) as typeof fetch;
    const result = await sendWebPush({
      endpoint: "https://push.example.test/subscription/opaque",
      p256dh: base64UrlEncode(receiverPublic),
      auth: base64UrlEncode(receiverAuth),
      payload,
    }, {
      VAPID_PUBLIC_KEY: base64UrlEncode(vapidPublic),
      VAPID_PRIVATE_KEY: vapidPrivate.d!,
      VAPID_SUBJECT: "mailto:pushbridge@example.test",
    }, now, fetcher);
    expect(result).toEqual({ status: 201, outcome: "delivered" });
    expect(captured).not.toBeNull();
    const requestInit = captured!.init!;
    const headers = new Headers(requestInit.headers);
    expect(headers.get("content-encoding")).toBe("aes128gcm");
    expect(headers.get("ttl")).toBe("60");
    const decrypted = await decryptPayload(new Uint8Array(requestInit.body as ArrayBuffer), receiverKeys, receiverPublic, receiverAuth);
    expect(JSON.parse(new TextDecoder().decode(decrypted))).toEqual(payload);

    const authorization = headers.get("authorization")!;
    const token = authorization.match(/^vapid t=([^,]+), k=(.+)$/)?.[1];
    expect(token).toBeTruthy();
    const [encodedHeader, encodedClaims, encodedSignature] = token!.split(".");
    expect(JSON.parse(new TextDecoder().decode(base64UrlDecode(encodedHeader)))).toEqual({ typ: "JWT", alg: "ES256" });
    expect(JSON.parse(new TextDecoder().decode(base64UrlDecode(encodedClaims)))).toEqual({
      aud: "https://push.example.test",
      exp: Math.floor(now / 1000) + 12 * 60 * 60,
      sub: "mailto:pushbridge@example.test",
    });
    expect(await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      vapidKeys.publicKey,
      ownedBuffer(base64UrlDecode(encodedSignature)),
      encoder.encode(`${encodedHeader}.${encodedClaims}`),
    )).toBe(true);
  });

  it("rejects invalid VAPID subjects and classifies gone subscriptions", async () => {
    const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const publicKey = base64UrlEncode(new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)));
    const privateKey = (await crypto.subtle.exportKey("jwk", keys.privateKey)).d!;
    await expect(createVapidAuthorization("https://push.example.test/x", publicKey, privateKey, "not-a-uri", Date.now()))
      .rejects.toThrow("VAPID_SUBJECT");
  });
});
