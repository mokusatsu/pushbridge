import { sha256Hex } from "./crypto";
import { deviceOut } from "./devices";
import { validDevicePublicKey } from "./device-key";
import { bodyJson, json, problem } from "./response";
import { iso } from "./runtime";
import type { AuthContext, DeviceRow, Env, Runtime } from "./types";

const LINK_TTL_MS = 10 * 60 * 1000;

interface DeviceLinkRow {
  id: string;
  user_id: string;
  created_by_device_id: string;
  device_name: string;
  device_kind: "web" | "pwa" | "extension";
  public_key: string;
  created_at: number;
  expires_at: number;
  consumed_at: number | null;
  consumed_device_id: string | null;
}

function kind(value: unknown): "web" | "pwa" | "extension" | null {
  if (value === "browser_extension") return "extension";
  return value === "web" || value === "pwa" || value === "extension" ? value : null;
}

async function activeDeviceCount(env: Env, userId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM devices WHERE user_id = ? AND revoked_at IS NULL")
    .bind(userId).first<{ count: number }>();
  return Number(row?.count ?? 0);
}

export async function createDeviceLink(request: Request, env: Env, auth: AuthContext, requestId: string, runtime: Runtime): Promise<Response> {
  const body = await bodyJson(request, requestId);
  const deviceName = typeof body.name === "string" ? body.name.trim() : "";
  const deviceKind = kind(body.kind);
  if (!deviceName || deviceName.length > 100 || !deviceKind) {
    return problem(422, "validation_error", "A valid device name and kind are required.", requestId);
  }
  if (await activeDeviceCount(env, auth.user_id) >= 10) return problem(409, "device_limit", "The device limit has been reached.", requestId);
  const pending = await env.DB.prepare(`SELECT COUNT(*) AS count FROM device_links
    WHERE user_id = ? AND consumed_at IS NULL AND expires_at > ?`).bind(auth.user_id, runtime.now()).first<{ count: number }>();
  if (Number(pending?.count ?? 0) >= 10) return problem(429, "pending_link_limit", "Too many pending device links.", requestId);

  const token = runtime.token();
  const linkId = runtime.id("lnk");
  const now = runtime.now();
  const expiresAt = now + LINK_TTL_MS;
  const publicKey = typeof body.public_key === "string" ? body.public_key : "";
  await env.DB.prepare(`INSERT INTO device_links
    (id, user_id, created_by_device_id, token_hash, device_name, device_kind, public_key, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(linkId, auth.user_id, auth.device_id, await sha256Hex(token), deviceName, deviceKind, publicKey, now, expiresAt).run();
  return json({ id: linkId, link_token: token, expires_at: iso(expiresAt), status: "pending" }, {
    status: 201,
    headers: { "x-request-id": requestId, pragma: "no-cache" },
  });
}

export async function deviceLinkStatus(env: Env, auth: AuthContext, requestId: string, linkId: string, runtime: Runtime): Promise<Response> {
  const row = await env.DB.prepare("SELECT * FROM device_links WHERE id = ? AND user_id = ?")
    .bind(linkId, auth.user_id).first<DeviceLinkRow>();
  if (!row) return problem(404, "device_link_not_found", "Device link not found.", requestId);
  const status = row.consumed_at != null ? "consumed" : row.expires_at <= runtime.now() ? "expired" : "pending";
  return json({ id: row.id, status, expires_at: iso(row.expires_at), consumed_at: iso(row.consumed_at), device_id: row.consumed_device_id }, {
    headers: { "x-request-id": requestId },
  });
}

export async function redeemDeviceLink(request: Request, env: Env, requestId: string, runtime: Runtime): Promise<Response> {
  const body = await bodyJson(request, requestId);
  if (typeof body.link_token !== "string" || !body.link_token) return problem(422, "validation_error", "link_token is required.", requestId);
  const now = runtime.now();
  const deviceId = runtime.id("dev");
  const tokenHash = await sha256Hex(body.link_token);
  const row = await env.DB.prepare("SELECT * FROM device_links WHERE token_hash = ?")
    .bind(tokenHash).first<DeviceLinkRow>();
  if (!row || row.consumed_at != null || row.expires_at <= now) {
    return problem(410, "device_link_invalid", "The device link is invalid, expired, or already used.", requestId);
  }
  const token = runtime.token();
  const redeemedPublicKey = typeof body.public_key === "string" && body.public_key ? body.public_key : row.public_key;
  if ((redeemedPublicKey && !validDevicePublicKey(redeemedPublicKey)) || (env.REQUIRE_E2EE === "true" && !redeemedPublicKey)) {
    return problem(422, "invalid_device_public_key", "A P-256 device public key is required when E2EE is enabled.", requestId);
  }
  const expiresAt = now + 30 * 24 * 60 * 60 * 1000;
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO devices
      (id, user_id, kind, name_ciphertext, public_key, last_seen_at, created_at, updated_at)
      SELECT ?, user_id, device_kind, device_name, ?, ?, ?, ? FROM device_links AS link
      WHERE id = ? AND token_hash = ? AND consumed_at IS NULL AND expires_at > ?
        AND (SELECT COUNT(*) FROM devices WHERE user_id = link.user_id AND revoked_at IS NULL) < 10`)
      .bind(deviceId, redeemedPublicKey, now, now, now, row.id, tokenHash, now),
    env.DB.prepare(`UPDATE device_links SET consumed_at = ?, consumed_device_id = ?
      WHERE id = ? AND token_hash = ? AND consumed_at IS NULL AND expires_at > ?
        AND EXISTS (SELECT 1 FROM devices WHERE id = ?)`)
      .bind(now, deviceId, row.id, tokenHash, now, deviceId),
    env.DB.prepare(`INSERT INTO sessions (token_hash, user_id, device_id, created_at, expires_at)
      SELECT ?, user_id, id, ?, ? FROM devices WHERE id = ?`)
      .bind(await sha256Hex(token), now, expiresAt, deviceId),
  ]);
  const created = await env.DB.prepare("SELECT id FROM devices WHERE id = ?").bind(deviceId).first();
  if (!created) {
    const count = await activeDeviceCount(env, row.user_id);
    return count >= 10
      ? problem(409, "device_limit", "The device limit has been reached.", requestId)
      : problem(410, "device_link_invalid", "The device link is invalid, expired, or already used.", requestId);
  }
  const device: DeviceRow = { id: deviceId, user_id: row.user_id, kind: row.device_kind, name_ciphertext: row.device_name, public_key: redeemedPublicKey, created_at: now, last_seen_at: now, revoked_at: null };
  return json({ device: deviceOut(device, deviceId), access_token: token, token_type: "bearer", expires_at: iso(expiresAt) }, {
    status: 201,
    headers: { "x-request-id": requestId, pragma: "no-cache" },
  });
}
