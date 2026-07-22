export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digestInput = new Uint8Array(bytes.byteLength);
  digestInput.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", digestInput.buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function base64UrlEncode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid base64url");
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - value.length % 4) % 4);
  const raw = atob(padded);
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

export function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export async function hmac(key: string, value: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(value)));
}

async function aesKey(encodedKey: string, usages: KeyUsage[]): Promise<CryptoKey> {
  const raw = base64UrlDecode(encodedKey);
  if (raw.byteLength !== 32) throw new Error("WEB_PUSH_DATA_KEY must be a 32-byte base64url value");
  return crypto.subtle.importKey("raw", ownedBuffer(raw), { name: "AES-GCM" }, false, usages);
}

export async function encryptText(value: string, encodedKey: string, aad: string): Promise<{ ciphertext: string; nonce: string }> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: new TextEncoder().encode(aad) },
    await aesKey(encodedKey, ["encrypt"]),
    new TextEncoder().encode(value),
  );
  return { ciphertext: base64UrlEncode(new Uint8Array(ciphertext)), nonce: base64UrlEncode(nonce) };
}

export async function decryptText(ciphertext: string, nonce: string, encodedKey: string, aad: string): Promise<string> {
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: ownedBuffer(base64UrlDecode(nonce)), additionalData: new TextEncoder().encode(aad) },
    await aesKey(encodedKey, ["decrypt"]),
    ownedBuffer(base64UrlDecode(ciphertext)),
  );
  return new TextDecoder().decode(plaintext);
}
