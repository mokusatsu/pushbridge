import { encodeCursorForDevice } from "./cursor";
import { sha256Hex } from "./crypto";
import { json, problem } from "./response";
import { iso } from "./runtime";
import type { AuthContext, Env, Runtime } from "./types";

const TICKET_TTL_MS = 30_000;

interface RealtimeTicketRow {
  user_id: string;
  device_id: string;
  session_token_hash: string;
}

interface TickleInput {
  entityId?: string;
  modifiedAt?: number;
  reason: string;
}

export async function issueRealtimeTicket(
  env: Env,
  auth: AuthContext,
  requestId: string,
  runtime: Runtime,
): Promise<Response> {
  const ticket = runtime.token();
  const now = runtime.now();
  const expiresAt = now + TICKET_TTL_MS;
  await env.DB.prepare(`INSERT INTO realtime_tickets
    (token_hash, user_id, device_id, session_token_hash, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(await sha256Hex(ticket), auth.user_id, auth.device_id, auth.session_token_hash, now, expiresAt)
    .run();
  return json({
    ticket,
    url: "/realtime",
    expires_at: iso(expiresAt),
  }, { status: 201, headers: { "x-request-id": requestId } });
}

async function failedTicketResponse(
  env: Env,
  tokenHash: string,
  now: number,
  requestId: string,
): Promise<Response> {
  const ticket = await env.DB.prepare("SELECT expires_at, consumed_at FROM realtime_tickets WHERE token_hash = ?")
    .bind(tokenHash).first<{ expires_at: number; consumed_at: number | null }>();
  if (!ticket) return problem(401, "invalid_realtime_ticket", "The realtime ticket is invalid.", requestId);
  if (ticket.consumed_at != null) return problem(409, "realtime_ticket_used", "The realtime ticket was already used.", requestId);
  if (Number(ticket.expires_at) <= now) return problem(410, "realtime_ticket_expired", "The realtime ticket has expired.", requestId);
  return problem(401, "realtime_session_invalid", "The session or device bound to this ticket is no longer active.", requestId);
}

export async function connectRealtime(
  request: Request,
  env: Env,
  requestId: string,
  runtime: Runtime,
): Promise<Response> {
  if (request.method !== "GET" || request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return problem(426, "websocket_upgrade_required", "A WebSocket upgrade request is required.", requestId, { upgrade: "websocket" });
  }
  const ticketProtocols = (request.headers.get("sec-websocket-protocol") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.startsWith("pushbridge-ticket."));
  const ticket = ticketProtocols.length === 1 ? ticketProtocols[0].slice("pushbridge-ticket.".length) : null;
  if (!ticket || ticket.length > 512) return problem(401, "invalid_realtime_ticket", "The realtime ticket is invalid.", requestId);
  const tokenHash = await sha256Hex(ticket);
  const now = runtime.now();
  const row = await env.DB.prepare(`UPDATE realtime_tickets SET consumed_at = ?
    WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?
      AND EXISTS (
        SELECT 1 FROM sessions s
        JOIN devices d ON d.id = s.device_id
        JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = realtime_tickets.session_token_hash
          AND s.user_id = realtime_tickets.user_id
          AND s.device_id = realtime_tickets.device_id
          AND s.revoked_at IS NULL AND s.expires_at > ?
          AND (s.absolute_expires_at IS NULL OR s.absolute_expires_at > ?)
          AND d.revoked_at IS NULL AND u.deleted_at IS NULL
      )
    RETURNING user_id, device_id, session_token_hash`)
    .bind(now, tokenHash, now, now, now)
    .first<RealtimeTicketRow>();
  if (!row) return failedTicketResponse(env, tokenHash, now, requestId);

  const stub = env.USER_HUB.get(env.USER_HUB.idFromName(row.user_id));
  const headers = new Headers({
    upgrade: "websocket",
    "sec-websocket-protocol": "pushbridge.v1",
    "x-pushbridge-user-id": row.user_id,
    "x-pushbridge-device-id": row.device_id,
    "x-pushbridge-session-hash": row.session_token_hash,
  });
  return stub.fetch(new Request("https://user-hub.internal/connect", { headers }));
}

export async function tickleUser(env: Env, userId: string, input: TickleInput): Promise<void> {
  try {
    const stub = env.USER_HUB.get(env.USER_HUB.idFromName(userId));
    await stub.fetch(new Request("https://user-hub.internal/tickle", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-pushbridge-user-id": userId,
      },
      body: JSON.stringify({
        reason: input.reason,
        ...(input.entityId ? { entity_id: input.entityId } : {}),
        ...(input.modifiedAt == null ? {} : { modified_at: input.modifiedAt }),
      }),
    }));
  } catch {
    // Realtime is best-effort. D1 and REST cursor synchronization remain authoritative.
  }
}

export async function cursorHint(
  env: Env,
  userId: string,
  deviceId: string,
  time: number,
  entityId: string,
): Promise<string | undefined> {
  const row = await env.DB.prepare("SELECT cursor_secret FROM devices WHERE id = ? AND user_id = ?")
    .bind(deviceId, userId).first<{ cursor_secret: string | null }>();
  return row?.cursor_secret
    ? encodeCursorForDevice(time, entityId, userId, deviceId, row.cursor_secret)
    : undefined;
}
