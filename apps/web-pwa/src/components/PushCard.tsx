import type { PushRecord } from '@/types';
import { formatBytes, formatDateTime, formatRelativeTime } from '@/utils/format';
import { Icon, type IconName } from './Icon';

const typeLabels = { note: 'ノート', link: 'リンク', file: 'ファイル' } as const;
const typeIcons: Record<PushRecord['type'], IconName> = { note: 'note', link: 'link', file: 'file' };
const deliveryLabels = {
  pending: '配送待ち',
  notified: '通知済み',
  fetching: '取得中',
  cached: '保存済み',
  failed_retryable: '再試行中',
  missed: '取得不可',
} as const;

function contentForCopy(push: PushRecord): string {
  if (push.url) return push.url;
  return [push.title, push.body].filter(Boolean).join('\n') || push.file?.name || '';
}

function safeExternalUrl(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function heading(push: PushRecord): string {
  if (push.status === 'expired' && !push.title && !push.body && !push.url && !push.file) return '期限切れのPush';
  if (push.title) return push.title;
  if (push.type === 'link' && push.url) return push.url;
  if (push.type === 'file' && push.file) return push.file.name;
  if (push.type === 'file' && push.file_id) return `ファイル ${push.file_id}`;
  return '名称なしのノート';
}

function targetLabel(push: PushRecord): string {
  if (push.target.kind === 'device') return push.target.device_name || push.target.device_id || '指定端末';
  if (push.target.kind === 'all_devices') return 'すべての端末';
  return 'ほかの全端末';
}

export function PushCard({ push, currentDeviceId, onDismiss, onPin, onDelete, onDownload, onCopied }: {
  push: PushRecord;
  currentDeviceId?: string;
  onDismiss(dismissed: boolean): void;
  onPin(pinned: boolean): void;
  onDelete(): void;
  onDownload(): void;
  onCopied(): void;
}) {
  const dismissed = push.status === 'dismissed' || Boolean(push.dismissed_at);
  const expired = push.status === 'expired' || Boolean(push.expired_at);
  const serverDeleted = push.status === 'deleted' || Boolean(push.deleted_at);
  const archived = expired || serverDeleted;
  const retainedContent = Boolean(push.title || push.body || push.url || push.file);
  const fileState = push.file?.state;
  const fileExpired = expired || fileState === 'expired' || fileState === 'delete_pending' || fileState === 'deleted'
    || Boolean(push.file?.expires_at && new Date(push.file.expires_at).getTime() <= Date.now());
  const fileReady = push.local_file_cached || (!fileExpired && (fileState === undefined || fileState === 'ready'));
  const fileMissed = push.type === 'file' && !push.local_file_cached
    && push.is_for_current_device !== false
    && (push.local_file_delivery === 'missed' || fileState === 'expired' || fileState === 'delete_pending' || fileState === 'deleted');
  const fileActionLabel = push.local_file_cached ? '端末から保存' : fileExpired
    ? fileState === 'deleted' ? '削除済み' : '期限切れ'
    : fileReady ? '保存' : '準備中';
  const sentHere = Boolean(currentDeviceId && push.source_device_id === currentDeviceId);
  const externalUrl = safeExternalUrl(push.url);
  const deliveryCounts = push.file_deliveries?.reduce<Record<string, number>>((counts, delivery) => ({
    ...counts,
    [delivery.state]: (counts[delivery.state] ?? 0) + 1,
  }), {});
  const availabilityLabel = push.local_file_cached
    ? 'この端末に保存済み'
    : fileMissed
      ? 'この端末では取得不可'
      : fileReady
        ? 'サーバーから取得可能'
        : push.type === 'file'
          ? '配信準備中'
          : undefined;

  const copy = async () => {
    const text = contentForCopy(push);
    if (!text) return;
    await navigator.clipboard.writeText(text);
    onCopied();
  };

  return (
    <article className={`push-card${dismissed ? ' is-dismissed' : ''}${archived ? ' is-expired' : ''}`}>
      <div className={`push-type-icon push-type-${push.type}`}><Icon name={typeIcons[push.type]!} size={21} /></div>
      <div className="push-card-main">
        <div className="push-card-header">
          <div>
            <span className="eyebrow">{typeLabels[push.type]!}</span>
            <h2>{heading(push)}</h2>
          </div>
          <time title={formatDateTime(push.created_at)}>{formatRelativeTime(push.created_at)}</time>
        </div>

        {archived && <p className="push-body muted-copy">{retainedContent ? 'サーバー上では削除済みです。以下はこの端末に保存された内容です。' : 'サーバーから削除され、端末内にも内容が残っていません。'}</p>}
        {push.body && <p className="push-body">{push.body}</p>}
        {externalUrl && (
          <a className="link-preview" href={externalUrl} target="_blank" rel="noreferrer noopener">
            <Icon name="link" size={17} /><span>{push.url}</span><Icon name="open" size={15} />
          </a>
        )}
        {push.file && (
          <div className="file-preview">
            <Icon name="file" size={24} />
            <div><strong>{push.file.name}</strong><span>{formatBytes(push.file.size)}・{availabilityLabel}</span></div>
            <button className="button button-secondary button-small" type="button" onClick={onDownload} disabled={!fileReady}>
              <Icon name="download" size={16} />{fileActionLabel}
            </button>
          </div>
        )}
        {fileMissed && <p className="push-body muted-copy">この端末では同期できず、サーバーから削除されました。</p>}
        {sentHere && deliveryCounts && Object.keys(deliveryCounts).length > 0 && (
          <div className="delivery-statuses" aria-label="送信先端末のファイル配送状態">
            {Object.entries(deliveryLabels).map(([state, label]) => deliveryCounts[state] ? (
              <span className={`status-chip${state === 'missed' || state === 'failed_retryable' ? ' muted' : ''}`} key={state}>
                {label} {deliveryCounts[state]}台
              </span>
            ) : null)}
          </div>
        )}

        <div className="push-footer">
          <div className="meta-row">
            <span>{sentHere ? '送信先' : '受信元'}</span>
            <strong>{sentHere ? targetLabel(push) : push.source_device_name || push.source_device_id || '不明な端末'}</strong>
            {push.pinned && <span className="status-chip">ピン留め</span>}
            {dismissed && <span className="status-chip muted">非表示</span>}
            {expired && <span className="status-chip muted">期限切れ</span>}
            {serverDeleted && <span className="status-chip muted">サーバー削除済み</span>}
            {push.local_file_cached && <span className="status-chip">この端末に保存済み</span>}
            {fileMissed && <span className="status-chip muted">同期できず削除された</span>}
            {push.is_for_current_device === false && <span className="status-chip muted">この端末宛ではない</span>}
          </div>
          <div className="card-actions">
            <button className="icon-button" type="button" onClick={() => void copy()} aria-label="内容をコピー" disabled={!contentForCopy(push)}><Icon name="copy" size={18} /></button>
            {externalUrl && <a className="icon-button" href={externalUrl} target="_blank" rel="noreferrer noopener" aria-label="リンクを開く"><Icon name="open" size={18} /></a>}
            {!archived && (
              <button className="button button-ghost button-small" type="button" onClick={() => onPin(!push.pinned)}>
                {push.pinned ? 'ピン解除' : 'ピン留め'}
              </button>
            )}
            <button className="button button-ghost button-small" type="button" onClick={() => onDismiss(!dismissed)} disabled={archived}>
              {dismissed ? '再表示' : '非表示'}
            </button>
            <button className="icon-button danger" type="button" onClick={onDelete} aria-label="削除"><Icon name="delete" size={18} /></button>
          </div>
        </div>
      </div>
    </article>
  );
}
