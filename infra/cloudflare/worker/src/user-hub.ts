import { cursorHint } from "./realtime";
import { json, problem } from "./response";
import type { Env } from "./types";

interface ConnectionAttachment {
  userId: string;
  deviceId: string;
  sessionTokenHash: string;
  connectedAt: number;
}

interface ActiveConnection {
  cursor_secret: string | null;
}

const MAX_ACCOUNT_CONNECTIONS = 10;
const MAX_DEVICE_CONNECTIONS = 2;
const MAX_MESSAGE_BYTES = 65_536;
const MAX_BUFFERED_BYTES = 1_048_576;

export class UserHub {
  constructor(private readonly state: DurableObjectState, private readonly env: Env) {
    this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/connect") return this.connect(request);
    if (request.method === "POST" && url.pathname === "/tickle") return this.tickle(request);
    return problem(404, "not_found", "UserHub endpoint not found.", crypto.randomUUID());
  }

  private async active(attachment: ConnectionAttachment): Promise<ActiveConnection | null> {
    return this.env.DB.prepare(`SELECT d.cursor_secret FROM sessions s
      JOIN devices d ON d.id = s.device_id
      JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.user_id = ? AND s.device_id = ?
        AND s.revoked_at IS NULL AND s.expires_at > ?
        AND (s.absolute_expires_at IS NULL OR s.absolute_expires_at > ?)
        AND d.revoked_at IS NULL AND u.deleted_at IS NULL`)
      .bind(attachment.sessionTokenHash, attachment.userId, attachment.deviceId, Date.now(), Date.now())
      .first<ActiveConnection>();
  }

  private async connect(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return problem(426, "websocket_upgrade_required", "A WebSocket upgrade request is required.", crypto.randomUUID(), { upgrade: "websocket" });
    }
    const userId = request.headers.get("x-pushbridge-user-id");
    const deviceId = request.headers.get("x-pushbridge-device-id");
    const sessionTokenHash = request.headers.get("x-pushbridge-session-hash");
    if (!userId || !deviceId || !sessionTokenHash) {
      return problem(401, "invalid_realtime_context", "Realtime connection metadata is invalid.", crypto.randomUUID());
    }
    const attachment: ConnectionAttachment = { userId, deviceId, sessionTokenHash, connectedAt: Date.now() };
    if (!await this.active(attachment)) {
      return problem(401, "realtime_session_invalid", "The realtime session is no longer active.", crypto.randomUUID());
    }
    if (this.state.getWebSockets().length >= MAX_ACCOUNT_CONNECTIONS) {
      return problem(429, "realtime_account_limit", "The account realtime connection limit was reached.", crypto.randomUUID(), { "retry-after": "30" });
    }
    if (this.state.getWebSockets(`device:${deviceId}`).length >= MAX_DEVICE_CONNECTIONS) {
      return problem(429, "realtime_device_limit", "The device realtime connection limit was reached.", crypto.randomUUID(), { "retry-after": "30" });
    }

    const [client, server] = Object.values(new WebSocketPair());
    this.state.acceptWebSocket(server, [`device:${deviceId}`]);
    server.serializeAttachment(attachment);
    server.send(JSON.stringify({
      event_version: 1,
      event_id: crypto.randomUUID(),
      type: "connected",
    }));
    return new Response(null, {
      status: 101,
      headers: { "sec-websocket-protocol": "pushbridge.v1" },
      webSocket: client,
    });
  }

  private async tickle(request: Request): Promise<Response> {
    const userId = request.headers.get("x-pushbridge-user-id");
    let body: { reason?: unknown; entity_id?: unknown; modified_at?: unknown };
    try {
      body = await request.json<typeof body>();
    } catch {
      return json({ accepted: false }, { status: 400 });
    }
    if (!userId || typeof body.reason !== "string") return json({ accepted: false }, { status: 400 });

    let sent = 0;
    let disconnected = 0;
    for (const socket of this.state.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as ConnectionAttachment | null;
      if (!attachment || attachment.userId !== userId || !await this.active(attachment)) {
        socket.close(4401, "session revoked");
        disconnected += 1;
        continue;
      }
      if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
        socket.close(1013, "backpressure");
        disconnected += 1;
        continue;
      }
      const modifiedAt = typeof body.modified_at === "number" && Number.isSafeInteger(body.modified_at)
        ? body.modified_at
        : undefined;
      const entityId = typeof body.entity_id === "string" ? body.entity_id : undefined;
      const hint = modifiedAt != null && entityId
        ? await cursorHint(this.env, userId, attachment.deviceId, modifiedAt, entityId)
        : undefined;
      socket.send(JSON.stringify({
        event_version: 1,
        event_id: crypto.randomUUID(),
        type: "sync_required",
        reason: body.reason,
        ...(hint ? { cursor_hint: hint } : {}),
      }));
      sent += 1;
    }
    return json({ accepted: true, sent, disconnected });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const length = typeof message === "string" ? new TextEncoder().encode(message).byteLength : message.byteLength;
    if (length > MAX_MESSAGE_BYTES) {
      socket.close(1009, "message too large");
      return;
    }
    const attachment = socket.deserializeAttachment() as ConnectionAttachment | null;
    if (!attachment || !await this.active(attachment)) {
      socket.close(4401, "session revoked");
      return;
    }
    if (typeof message !== "string") {
      socket.close(1003, "text messages only");
      return;
    }
    try {
      const value = JSON.parse(message) as { type?: unknown };
      if (value.type !== "ping") throw new Error("unsupported");
      socket.send(JSON.stringify({ event_version: 1, event_id: crypto.randomUUID(), type: "ping" }));
    } catch {
      socket.close(1003, "unsupported message");
    }
  }

  webSocketClose(socket: WebSocket, code: number, reason: string): void {
    socket.close(code, reason);
  }
}
