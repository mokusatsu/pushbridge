import { describe, expect, it } from 'vitest';
import { REALTIME_HEARTBEAT_INTERVAL_MS, realtimeReconnectDelayMs } from './realtime';

describe('realtime reconnect policy', () => {
  it('uses bounded exponential backoff with jitter', () => {
    expect(realtimeReconnectDelayMs(1, () => 0)).toBe(1_000);
    expect(realtimeReconnectDelayMs(1, () => 0.5)).toBe(2_000);
    expect(realtimeReconnectDelayMs(1, () => 1)).toBe(3_000);
    expect(realtimeReconnectDelayMs(20, () => 1)).toBe(60_000);
  });

  it('uses a heartbeat interval shorter than the REST fallback poll', () => {
    expect(REALTIME_HEARTBEAT_INTERVAL_MS).toBe(30_000);
  });
});
