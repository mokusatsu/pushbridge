export const REALTIME_HEARTBEAT_INTERVAL_MS = 20_000;

export interface RealtimeEnvelope {
  event_version: number;
  event_id: string;
  type: string;
  reason?: string;
  cursor_hint?: string;
}

export function realtimeReconnectDelayMs(
  attempts: number,
  random: () => number = Math.random,
): number {
  const exponent = Math.min(Math.max(1, attempts), 6);
  const base = Math.min(60_000, 1_000 * (2 ** exponent));
  const sample = Math.min(1, Math.max(0, random()));
  return Math.min(60_000, Math.round(base * (0.5 + sample)));
}

export function parseRealtimeEnvelope(value: unknown): RealtimeEnvelope | undefined {
  if (typeof value !== 'string' || new TextEncoder().encode(value).byteLength > 65_536) return undefined;
  try {
    const parsed = JSON.parse(value) as Partial<RealtimeEnvelope>;
    if (parsed.event_version !== 1 || typeof parsed.event_id !== 'string' || typeof parsed.type !== 'string') {
      return undefined;
    }
    return parsed as RealtimeEnvelope;
  } catch {
    return undefined;
  }
}
