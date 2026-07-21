import type { OutboxJob } from '@/types';
import { formatBytes, formatRelativeTime, truncate } from '@/utils/format';
import { Icon } from './Icon';

function jobTitle(job: OutboxJob): string {
  if (job.file) return job.file.name;
  if (job.draft.title) return job.draft.title;
  if (job.draft.url) return job.draft.url;
  return truncate(job.draft.body || '名称なしのPush', 80);
}

export function OutboxCard({ job, onRetry, onDelete }: {
  job: OutboxJob;
  onRetry(): void;
  onDelete(): void;
}) {
  const label = job.status === 'sending' ? '送信中' : job.status === 'failed' ? '要確認' : '送信待ち';
  return (
    <article className={`outbox-card outbox-${job.status}`}>
      <div className="outbox-icon"><Icon name={job.status === 'failed' ? 'cloud-off' : 'clock'} size={20} /></div>
      <div className="outbox-body">
        <div className="outbox-heading">
          <strong>{jobTitle(job)}</strong>
          <span className="status-chip">{label}</span>
        </div>
        <div className="meta-row">
          <span>{job.draft.type === 'note' ? 'ノート' : job.draft.type === 'link' ? 'リンク' : 'ファイル'}</span>
          {job.file && <span>{formatBytes(job.file.size)}</span>}
          <span>{formatRelativeTime(job.created_at)}</span>
        </div>
        {job.last_error && <p className="error-text">{job.last_error}</p>}
      </div>
      <div className="card-actions">
        {job.status === 'failed' && (
          <button className="button button-secondary button-small" type="button" onClick={onRetry}>
            <Icon name="retry" size={16} />再試行
          </button>
        )}
        <button className="icon-button danger" type="button" onClick={onDelete} aria-label="送信箱から削除">
          <Icon name="delete" size={18} />
        </button>
      </div>
    </article>
  );
}
