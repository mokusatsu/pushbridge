import { bodyJson, json, problem } from "./response";
import { validDevicePublicKey } from "./device-key";
import { iso } from "./runtime";
import type { AuthContext, Env, Runtime } from "./types";

const ALGORITHM = "P256-HKDF-SHA256-A256GCM-v1";
const MAX_ENVELOPE_BYTES = 16 * 1024;
const encoder = new TextEncoder();

interface AccountKeyRow {
  key_version: number;
  algorithm: string;
  recovery_envelope: string | ArrayBuffer;
  created_at: number;
}

function encodedEnvelope(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const encoded = JSON.stringify(value);
  return encoder.encode(encoded).byteLength <= MAX_ENVELOPE_BYTES ? encoded : null;
}

function keyVersion(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 2_147_483_647 ? value : null;
}

function envelopeVersion(value: unknown): number | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return keyVersion((value as Record<string, unknown>).key_version);
}

function text(value: string | ArrayBuffer): string {
  return typeof value === "string" ? value : new TextDecoder().decode(value);
}

export async function e2eeStatus(env: Env, auth: AuthContext, requestId: string): Promise<Response> {
  const current = await env.DB.prepare(`SELECT key_version, algorithm, created_at FROM account_key_versions
    WHERE user_id = ? ORDER BY key_version DESC LIMIT 1`).bind(auth.user_id).first<Pick<AccountKeyRow, "key_version" | "algorithm" | "created_at">>();
  const devices = await env.DB.prepare(`SELECT d.id, d.public_key,
      CASE WHEN e.device_id IS NULL THEN 0 ELSE 1 END AS has_envelope
    FROM devices d LEFT JOIN device_key_envelopes e
      ON e.device_id = d.id AND e.key_version = ?
    WHERE d.user_id = ? AND d.revoked_at IS NULL ORDER BY d.created_at, d.id`)
    .bind(current?.key_version ?? -1, auth.user_id).all<{ id: string; public_key: string | ArrayBuffer; has_envelope: number }>();
  return json({
    initialized: Boolean(current),
    current_key_version: current?.key_version ?? null,
    algorithm: current?.algorithm ?? ALGORITHM,
    created_at: iso(current?.created_at ?? null),
    current_device_has_envelope: devices.results.some((device) => device.id === auth.device_id && Boolean(device.has_envelope)),
    devices: devices.results.map((device) => ({
      id: device.id,
      public_key: typeof device.public_key === "string" ? device.public_key : new TextDecoder().decode(device.public_key),
      has_envelope: Boolean(device.has_envelope),
    })),
  }, { headers: { "x-request-id": requestId } });
}

export async function initializeAccountKey(request: Request, env: Env, auth: AuthContext, requestId: string, runtime: Runtime): Promise<Response> {
  const body = await bodyJson(request, requestId);
  const version = keyVersion(body.key_version);
  const recovery = encodedEnvelope(body.recovery_envelope);
  const device = encodedEnvelope(body.device_envelope);
  if (!version || !recovery || !device || envelopeVersion(body.recovery_envelope) !== version || envelopeVersion(body.device_envelope) !== version) {
    return problem(422, "invalid_key_envelope", "Valid matching key_version, recovery_envelope, and device_envelope are required.", requestId);
  }
  const existing = await env.DB.prepare("SELECT key_version FROM account_key_versions WHERE user_id = ? ORDER BY key_version DESC LIMIT 1")
    .bind(auth.user_id).first<{ key_version: number }>();
  if (existing) return problem(409, "account_key_exists", "The account key has already been initialized.", requestId);
  const now = runtime.now();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO account_key_versions
      (user_id, key_version, algorithm, recovery_envelope, created_by_device_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(auth.user_id, version, ALGORITHM, recovery, auth.device_id, now),
    env.DB.prepare(`INSERT INTO device_key_envelopes
      (user_id, device_id, key_version, algorithm, wrapped_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(auth.user_id, auth.device_id, version, ALGORITHM, device, now),
  ]);
  return json({ initialized: true, current_key_version: version, created_at: iso(now) }, {
    status: 201, headers: { "x-request-id": requestId },
  });
}

export async function currentDeviceEnvelope(env: Env, auth: AuthContext, requestId: string): Promise<Response> {
  const row = await env.DB.prepare(`SELECT e.key_version, e.algorithm, e.wrapped_key, e.created_at
    FROM device_key_envelopes e JOIN account_key_versions a
      ON a.user_id = e.user_id AND a.key_version = e.key_version
    WHERE e.user_id = ? AND e.device_id = ? ORDER BY e.key_version DESC LIMIT 1`)
    .bind(auth.user_id, auth.device_id).first<{ key_version: number; algorithm: string; wrapped_key: string | ArrayBuffer; created_at: number }>();
  return row ? json({ key_version: row.key_version, algorithm: row.algorithm, envelope: JSON.parse(text(row.wrapped_key)), created_at: iso(row.created_at) }, {
    headers: { "x-request-id": requestId },
  }) : problem(404, "device_envelope_not_found", "No account-key envelope exists for this device.", requestId);
}

export async function recoveryEnvelope(env: Env, auth: AuthContext, requestId: string): Promise<Response> {
  const row = await env.DB.prepare(`SELECT key_version, algorithm, recovery_envelope, created_at FROM account_key_versions
    WHERE user_id = ? ORDER BY key_version DESC LIMIT 1`).bind(auth.user_id).first<AccountKeyRow>();
  return row ? json({ key_version: row.key_version, algorithm: row.algorithm, envelope: JSON.parse(text(row.recovery_envelope)), created_at: iso(row.created_at) }, {
    headers: { "x-request-id": requestId },
  }) : problem(404, "account_key_not_found", "The account key is not initialized.", requestId);
}

export async function putDeviceEnvelope(request: Request, env: Env, auth: AuthContext, requestId: string, deviceId: string, runtime: Runtime): Promise<Response> {
  const target = await env.DB.prepare("SELECT id FROM devices WHERE id = ? AND user_id = ? AND revoked_at IS NULL")
    .bind(deviceId, auth.user_id).first();
  if (!target) return problem(404, "active_device_not_found", "The active target device does not exist.", requestId);
  const body = await bodyJson(request, requestId);
  const version = keyVersion(body.key_version);
  const envelope = encodedEnvelope(body.envelope);
  if (!version || !envelope || envelopeVersion(body.envelope) !== version
    || (body.envelope as Record<string, unknown>).recipient_device_id !== deviceId) {
    return problem(422, "invalid_key_envelope", "A matching device envelope is required.", requestId);
  }
  const accountKey = await env.DB.prepare("SELECT key_version FROM account_key_versions WHERE user_id = ? AND key_version = ?")
    .bind(auth.user_id, version).first();
  if (!accountKey) return problem(409, "unknown_key_version", "The account key version does not exist.", requestId);
  const existing = await env.DB.prepare("SELECT wrapped_key FROM device_key_envelopes WHERE device_id = ? AND key_version = ?")
    .bind(deviceId, version).first<{ wrapped_key: string | ArrayBuffer }>();
  if (existing) {
    return text(existing.wrapped_key) === envelope
      ? json({ device_id: deviceId, key_version: version, created: false }, { headers: { "x-request-id": requestId } })
      : problem(409, "device_envelope_exists", "A different envelope already exists for this device and key version.", requestId);
  }
  await env.DB.prepare(`INSERT INTO device_key_envelopes
    (user_id, device_id, key_version, algorithm, wrapped_key, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(auth.user_id, deviceId, version, ALGORITHM, envelope, runtime.now()).run();
  return json({ device_id: deviceId, key_version: version, created: true }, {
    status: 201, headers: { "x-request-id": requestId },
  });
}

export async function putCurrentDeviceKey(request: Request, env: Env, auth: AuthContext, requestId: string, runtime: Runtime): Promise<Response> {
  const body = await bodyJson(request, requestId);
  const publicKey = typeof body.public_key === "string" ? body.public_key : "";
  if (!validDevicePublicKey(publicKey)) {
    return problem(422, "invalid_device_public_key", "A P-256 device public key is required.", requestId);
  }
  const row = await env.DB.prepare("SELECT public_key FROM devices WHERE id = ? AND user_id = ? AND revoked_at IS NULL")
    .bind(auth.device_id, auth.user_id).first<{ public_key: string | ArrayBuffer }>();
  if (!row) return problem(404, "active_device_not_found", "The active current device does not exist.", requestId);
  const current = typeof row.public_key === "string" ? row.public_key : new TextDecoder().decode(row.public_key);
  if (current === publicKey) return json({ public_key: publicKey, updated: false }, { headers: { "x-request-id": requestId } });
  const envelope = await env.DB.prepare("SELECT device_id FROM device_key_envelopes WHERE device_id = ? LIMIT 1").bind(auth.device_id).first();
  if (envelope) return problem(409, "device_key_in_use", "The device key cannot change while account-key envelopes reference it.", requestId);
  await env.DB.prepare("UPDATE devices SET public_key = ?, updated_at = ? WHERE id = ? AND user_id = ?")
    .bind(publicKey, runtime.now(), auth.device_id, auth.user_id).run();
  return json({ public_key: publicKey, updated: true }, { headers: { "x-request-id": requestId } });
}
