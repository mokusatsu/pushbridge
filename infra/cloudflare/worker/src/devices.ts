import { bodyJson, json, problem } from "./response";
import { validDevicePublicKey } from "./device-key";
import { iso } from "./runtime";
import { sha256Hex } from "./crypto";
import type { AuthContext, DeviceRow, Env, Runtime } from "./types";
import { tickleUser } from "./realtime";

export function deviceOut(row: DeviceRow, currentDeviceId: string): Record<string, unknown> {
  return {
    id: row.id,
    user_id: row.user_id,
    kind: row.kind === "extension" ? "browser_extension" : row.kind,
    name: typeof row.name_ciphertext === "string" ? row.name_ciphertext : "Linked device",
    public_key: typeof row.public_key === "string" && row.public_key ? row.public_key : null,
    created_at: iso(row.created_at),
    last_seen_at: iso(row.last_seen_at ?? row.created_at),
    revoked_at: iso(row.revoked_at),
    is_current: row.id === currentDeviceId,
  };
}

export async function listDevices(env: Env, auth: AuthContext): Promise<Record<string, unknown>[]> {
  const result = await env.DB.prepare("SELECT * FROM devices WHERE user_id = ? ORDER BY created_at").bind(auth.user_id).all<DeviceRow>();
  return result.results.map((row) => deviceOut(row, auth.device_id));
}

export async function currentDevice(env: Env, auth: AuthContext): Promise<Record<string, unknown>> {
  const row = await env.DB.prepare("SELECT * FROM devices WHERE id = ? AND user_id = ?").bind(auth.device_id, auth.user_id).first<DeviceRow>();
  if (!row) throw new Error("authenticated device is missing");
  return deviceOut(row, auth.device_id);
}

export async function linkDevice(request: Request, env: Env, auth: AuthContext, requestId: string, runtime: Runtime): Promise<Response> {
  const body = await bodyJson(request, requestId);
  if (typeof body.name !== "string" || !body.name.trim()) return problem(422, "validation_error", "Device name is required.", requestId);
  const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM devices WHERE user_id = ? AND revoked_at IS NULL").bind(auth.user_id).first<{ count: number }>();
  if (Number(count?.count) >= 10) return problem(409, "device_limit", "The device limit has been reached.", requestId);
  const now = runtime.now();
  const deviceId = runtime.id("dev");
  const token = runtime.token();
  const expiresAt = now + 30 * 24 * 60 * 60 * 1000;
  const kind = body.kind === "browser_extension" ? "extension" : typeof body.kind === "string" ? body.kind : "web";
  if (!["web", "pwa", "extension"].includes(kind)) return problem(422, "validation_error", "Invalid device kind.", requestId);
  const publicKey = typeof body.public_key === "string" ? body.public_key : "";
  if ((publicKey && !validDevicePublicKey(publicKey)) || (env.REQUIRE_E2EE === "true" && !publicKey)) {
    return problem(422, "invalid_device_public_key", "A P-256 device public key is required when E2EE is enabled.", requestId);
  }
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO devices
      (id, user_id, kind, name_ciphertext, public_key, last_seen_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(deviceId, auth.user_id, kind, body.name.trim(), publicKey, now, now, now),
    env.DB.prepare("INSERT INTO sessions (token_hash, user_id, device_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
      .bind(await sha256Hex(token), auth.user_id, deviceId, now, expiresAt),
  ]);
  const row = await env.DB.prepare("SELECT * FROM devices WHERE id = ?").bind(deviceId).first<DeviceRow>();
  if (!row) throw new Error("linked device was not created");
  return json({ device: deviceOut(row, auth.device_id), access_token: token, token_type: "bearer", expires_at: iso(expiresAt) }, { status: 201, headers: { "x-request-id": requestId } });
}

export async function mutateDevice(request: Request, env: Env, auth: AuthContext, requestId: string, deviceId: string, runtime: Runtime): Promise<Response> {
  const row = await env.DB.prepare("SELECT * FROM devices WHERE id = ? AND user_id = ?").bind(deviceId, auth.user_id).first<DeviceRow>();
  if (!row) return problem(404, "not_found", "Device not found.", requestId);
  if (request.method === "DELETE") {
    if (deviceId === auth.device_id) return problem(409, "current_device", "The current device cannot revoke itself.", requestId);
    const now = runtime.now();
    await env.DB.batch([
      env.DB.prepare("UPDATE devices SET revoked_at = ?, updated_at = ? WHERE id = ?").bind(now, now, deviceId),
      env.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE device_id = ?").bind(now, deviceId),
    ]);
    await tickleUser(env, auth.user_id, { reason: "device.revoked" });
    return new Response(null, { status: 204, headers: { "x-request-id": requestId } });
  }
  const body = await bodyJson(request, requestId);
  if (typeof body.name !== "string" || !body.name.trim()) return problem(422, "validation_error", "Device name is required.", requestId);
  await env.DB.prepare("UPDATE devices SET name_ciphertext = ?, updated_at = ? WHERE id = ?").bind(body.name.trim(), runtime.now(), deviceId).run();
  const updated = await env.DB.prepare("SELECT * FROM devices WHERE id = ?").bind(deviceId).first<DeviceRow>();
  if (!updated) throw new Error("updated device is missing");
  await tickleUser(env, auth.user_id, { reason: "device.changed" });
  return json(deviceOut(updated, auth.device_id), { headers: { "x-request-id": requestId } });
}
