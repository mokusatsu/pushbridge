import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OutboxJob, PushRecord } from '@/types';
import { OutboxCard } from './OutboxCard';
import { PushCard } from './PushCard';

afterEach(cleanup);

describe('Phase 5 file delivery UI', () => {
  it('shows semantic upload progress and exposes cancellation while sending', () => {
    const cancel = vi.fn();
    const job: OutboxJob = {
      id: 'job_1',
      kind: 'send_push',
      status: 'sending',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      next_attempt_at: '2026-01-01T00:00:00Z',
      attempts: 1,
      draft: { type: 'file', target: { kind: 'all_other_devices' } },
      file: { blob: new Blob(['data']), name: 'sample.bin', mime_type: 'application/octet-stream', size: 4 },
      upload_progress: 50,
    };

    render(<OutboxCard job={job} onRetry={vi.fn()} onCancel={cancel} onDelete={vi.fn()} />);

    expect(screen.getByRole('progressbar', { name: 'sample.binのアップロード進捗' })).toHaveValue(50);
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('summarizes sender-side delivery states without treating notified as cached', () => {
    const push: PushRecord = {
      id: 'psh_1',
      client_guid: 'job_1',
      type: 'file',
      source_device_id: 'dev_sender',
      target: { kind: 'all_other_devices' },
      file_id: 'fil_1',
      file: { id: 'fil_1', name: 'sample.bin', mime_type: 'application/octet-stream', size: 4, state: 'ready' },
      pinned: false,
      status: 'active',
      created_at: '2026-01-01T00:00:00Z',
      modified_at: '2026-01-01T00:00:00Z',
      file_deliveries: [
        {
          id: 'fdl_1', push_id: 'psh_1', file_id: 'fil_1', destination_device_id: 'dev_a', state: 'notified',
          created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', notified_at: '2026-01-01T00:00:00Z',
          fetching_at: null, cached_at: null, failed_at: null, missed_at: null, failure_code: null, attempt_count: 1,
        },
        {
          id: 'fdl_2', push_id: 'psh_1', file_id: 'fil_1', destination_device_id: 'dev_b', state: 'cached',
          created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:01:00Z', notified_at: '2026-01-01T00:00:00Z',
          fetching_at: '2026-01-01T00:00:30Z', cached_at: '2026-01-01T00:01:00Z', failed_at: null, missed_at: null,
          failure_code: null, attempt_count: 1,
        },
      ],
    };

    render(<PushCard
      push={push}
      currentDeviceId="dev_sender"
      onDismiss={vi.fn()}
      onPin={vi.fn()}
      onDelete={vi.fn()}
      onDownload={vi.fn()}
      onCopied={vi.fn()}
    />);

    const status = screen.getByLabelText('送信先端末のファイル配送状態');
    expect(status).toHaveTextContent('通知済み 1台');
    expect(status).toHaveTextContent('保存済み 1台');
  });
});
