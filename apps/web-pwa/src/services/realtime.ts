export const REALTIME_HEARTBEAT_INTERVAL_MS = 30_000;

export function realtimeReconnectDelayMs(
  attempts: number,
  random: () => number = Math.random,
): number {
  const base = Math.min(60_000, 1_000 * (2 ** Math.min(Math.max(1, attempts), 6)));
  const sample = Math.min(1, Math.max(0, random()));
  return Math.min(60_000, Math.round(base * (0.5 + sample)));
}
