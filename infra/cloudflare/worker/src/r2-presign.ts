import type { Env } from "./types";

const encoder = new TextEncoder();

interface PresignOptions {
  method: "GET" | "PUT";
  key: string;
  expiresSeconds: number;
  now: number;
  headers?: Record<string, string>;
  query?: Record<string, string>;
}

export interface PresignedRequest {
  url: string;
  headers: Record<string, string>;
  expiresAt: number;
}

function encode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function canonicalQuery(values: Record<string, string>): string {
  return Object.entries(values)
    .map(([key, value]) => [encode(key), encode(value)])
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

function owned(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}

async function sha256(value: string | Uint8Array): Promise<Uint8Array> {
  const input = typeof value === "string" ? encoder.encode(value) : value;
  return new Uint8Array(await crypto.subtle.digest("SHA-256", owned(input)));
}

function hex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hmac(key: Uint8Array, value: string): Promise<Uint8Array> {
  const imported = await crypto.subtle.importKey("raw", owned(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", imported, owned(encoder.encode(value))));
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required for R2 presigning`);
  return value;
}

export function directR2Enabled(env: Env): boolean {
  return env.R2_DIRECT_UPLOAD === "true"
    && Boolean(env.R2_ACCOUNT_ID && env.R2_BUCKET_NAME && env.R2_S3_ACCESS_KEY_ID && env.R2_S3_SECRET_ACCESS_KEY);
}

export async function presignR2(env: Env, options: PresignOptions): Promise<PresignedRequest> {
  if (!directR2Enabled(env)) throw new Error("R2 direct upload is not configured");
  if (!Number.isSafeInteger(options.expiresSeconds) || options.expiresSeconds < 1 || options.expiresSeconds > 900) {
    throw new Error("R2 presigned URL lifetime must be from 1 through 900 seconds");
  }
  const accountId = required(env.R2_ACCOUNT_ID, "R2_ACCOUNT_ID");
  const bucket = required(env.R2_BUCKET_NAME, "R2_BUCKET_NAME");
  const accessKeyId = required(env.R2_S3_ACCESS_KEY_ID, "R2_S3_ACCESS_KEY_ID");
  const secretAccessKey = required(env.R2_S3_SECRET_ACCESS_KEY, "R2_S3_SECRET_ACCESS_KEY");
  const timestamp = new Date(options.now).toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = timestamp.slice(0, 8);
  const region = "auto";
  const service = "s3";
  const scope = `${date}/${region}/${service}/aws4_request`;
  const host = `${accountId}.r2.cloudflarestorage.com`;
  const path = `/${encode(bucket)}/${options.key.split("/").map(encode).join("/")}`;
  const signedHeaderValues = Object.fromEntries(Object.entries({
    host,
    ...(options.headers ?? {}),
  }).map(([key, value]) => [key.toLowerCase(), value.trim().replace(/\s+/g, " ")]));
  const signedHeaders = Object.keys(signedHeaderValues).sort().join(";");
  const query = {
    ...(options.query ?? {}),
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${accessKeyId}/${scope}`,
    "X-Amz-Date": timestamp,
    "X-Amz-Expires": String(options.expiresSeconds),
    "X-Amz-SignedHeaders": signedHeaders,
  };
  const canonicalHeaders = Object.keys(signedHeaderValues).sort()
    .map((key) => `${key}:${signedHeaderValues[key]}\n`).join("");
  const canonicalRequest = [
    options.method,
    path,
    canonicalQuery(query),
    canonicalHeaders,
    signedHeaders,
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    timestamp,
    scope,
    hex(await sha256(canonicalRequest)),
  ].join("\n");
  const dateKey = await hmac(encoder.encode(`AWS4${secretAccessKey}`), date);
  const regionKey = await hmac(dateKey, region);
  const serviceKey = await hmac(regionKey, service);
  const signingKey = await hmac(serviceKey, "aws4_request");
  const signature = hex(await hmac(signingKey, stringToSign));
  const url = `https://${host}${path}?${canonicalQuery({ ...query, "X-Amz-Signature": signature })}`;
  const headers = Object.fromEntries(Object.entries(signedHeaderValues).filter(([name]) => name !== "host"));
  return { url, headers, expiresAt: options.now + options.expiresSeconds * 1000 };
}
