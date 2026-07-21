import { describe, expect, it } from 'vitest';
import type { PushRecord } from '@/types';
import { filterTimelinePushes, needsAttention, timelineCounts } from './timelineModel';

const base: PushRecord = {
  id: 'push_1', client_guid: 'job_1', type: 'note', source_device_id: 'phone',
  source_device_name: 'Phone', target: { kind: 'all_other_devices' }, pinned: false,
  status: 'active', title: 'Meeting note', body: 'Bring the draft',
  created_at: '2026-07-21T00:00:00Z', modified_at: '2026-07-21T00:00:00Z',
  is_for_current_device: true,
};

describe('timelineModel', () => {
  it('separates received, sent, saved and attention views', () => {
    const sent = { ...base, id: 'sent', source_device_id: 'desktop' };
    const saved = { ...base, id: 'saved', pinned: true };
    const missed: PushRecord = {
      ...base, id: 'missed', type: 'file', file_id: 'file_1', local_file_delivery: 'missed',
      file: { id: 'file_1', name: 'report.pdf', mime_type: 'application/pdf', size: 10, state: 'deleted' },
    };
    const counts = timelineCounts([base, sent, saved, missed], 'desktop');
    expect(counts).toEqual({ inbox: 3, sent: 1, saved: 1, attention: 1, all: 4 });
    expect(needsAttention(missed)).toBe(true);
  });

  it('searches user-visible content and combines filters', () => {
    expect(filterTimelinePushes([base], {
      view: 'inbox', type: 'note', query: 'draft', showDismissed: true, currentDeviceId: 'desktop',
    })).toHaveLength(1);
    expect(filterTimelinePushes([base], {
      view: 'inbox', type: 'file', query: '', showDismissed: true, currentDeviceId: 'desktop',
    })).toHaveLength(0);
  });
});
