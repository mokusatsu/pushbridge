import { base64UrlDecode, base64UrlEncode, hmac } from "./crypto";
import { problem } from "./response";
import type { AuthContext } from "./types";

interface CursorPayload {
  v: 1;
  t: number;
  i: string;
  u: string;
  d: string;
}

export async function encodeCursor(time: number, id: string, auth: AuthContext): Promise<string> {
  return encodeCursorForDevice(time, id, auth.user_id, auth.device_id, auth.cursor_key);
}

export async function encodeCursorForDevice(
  time: number,
  id: string,
  userId: string,
  deviceId: string,
  cursorKey: string,
): Promise<string> {
  const payload: CursorPayload = { v: 1, t: time, i: id, u: userId, d: deviceId };
  const encoded = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  return `${encoded}.${base64UrlEncode(await hmac(cursorKey, encoded))}`;
}

export async function decodeCursor(value: string | null, auth: AuthContext, requestId: string): Promise<{ time: number; id: string } | null> {
  if (!value) return null;
  try {
    const [encoded, signature, extra] = value.split(".");
    if (!encoded || !signature || extra) throw new Error("invalid cursor shape");
    const expected = base64UrlEncode(await hmac(auth.cursor_key, encoded));
    if (signature.length !== expected.length) throw new Error("invalid cursor signature");
    let mismatch = 0;
    for (let index = 0; index < signature.length; index += 1) mismatch |= signature.charCodeAt(index) ^ expected.charCodeAt(index);
    if (mismatch !== 0) throw new Error("invalid cursor signature");
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(encoded))) as Partial<CursorPayload>;
    const time = Number(payload.t);
    if (payload.v !== 1 || !Number.isSafeInteger(time) || typeof payload.i !== "string" || !payload.i
      || payload.u !== auth.user_id || payload.d !== auth.device_id) throw new Error("invalid cursor payload");
    return { time, id: payload.i };
  } catch {
    throw problem(400, "invalid_cursor", "The cursor is invalid or has been modified.", requestId);
  }
}
