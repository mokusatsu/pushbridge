import { describe, expect, it } from 'vitest';
import {
  REALTIME_HEARTBEAT_INTERVAL_MS,
  parseRealtimeEnvelope,
  realtimeReconnectDelayMs,
} from './realtime';

describe('Chromium extension realtime policy', () => {
  it('keeps the MV3 service worker active with a sub-30-second heartbeat', () => {
    expect(REALTIME_HEARTBEAT_INTERVAL_MS).toBe(20_000);
  });

  it('uses bounded exponential reconnect with jitter', () => {
    expect(realtimeReconnectDelayMs(1, () => 0)).toBe(1_000);
    expect(realtimeReconnectDelayMs(1, () => 0.5)).toBe(2_000);
    expect(realtimeReconnectDelayMs(1, () => 1)).toBe(3_000);
    expect(realtimeReconnectDelayMs(20, () => 1)).toBe(60_000);
  });

  it('accepts only versioned JSON envelopes within the frame limit', () => {
    expect(parseRealtimeEnvelope(JSON.stringify({
      event_version: 1,
      event_id: 'evt_1',
      type: 'sync_required',
      reason: 'push.created',
    }))).toMatchObject({ type: 'sync_required', reason: 'push.created' });
    expect(parseRealtimeEnvelope('{"event_version":2,"event_id":"evt","type":"sync_required"}')).toBeUndefined();
    expect(parseRealtimeEnvelope('not-json')).toBeUndefined();
    expect(parseRealtimeEnvelope('x'.repeat(65_537))).toBeUndefined();
  });
});
