import { useMemo, useState } from 'react';
import { EmptyState } from '@/components/EmptyState';
import { Icon } from '@/components/Icon';
import { OutboxCard } from '@/components/OutboxCard';
import { PageHeader } from '@/components/PageHeader';
import { PushCard } from '@/components/PushCard';
import { navigate } from '@/hooks/useHashRoute';
import { useAppRuntime, useAppSnapshot } from '@/state/AppContext';
import type { PushType } from '@/types';
import { formatDateTime } from '@/utils/format';
import { filterTimelinePushes, timelineCounts, type TimelineView } from './timelineModel';

const views: Array<{ value: TimelineView; label: string; description: string }> = [
  { value: 'inbox', label: '受信', description: 'この端末で受け取ったPush' },
  { value: 'sent', label: '送信済み', description: 'この端末から送ったPush' },
  { value: 'saved', label: '保存済み', description: 'ピン留めまたは端末内保存済み' },
  { value: 'attention', label: '要確認', description: '取得できなかったファイル' },
  { value: 'all', label: 'すべて', description: '端末内に残る全履歴' },
];

export function TimelinePage() {
  const runtime = useAppRuntime();
  const snapshot = useAppSnapshot();
  const [view, setView] = useState<TimelineView>('inbox');
  const [filter, setFilter] = useState<'all' | PushType>('all');
  const [query, setQuery] = useState('');
  const [showDismissed, setShowDismissed] = useState(true);

  const currentDeviceId = snapshot.currentDevice?.id || runtime.settings.currentDeviceId;
  const counts = useMemo(
    () => timelineCounts(snapshot.pushes, currentDeviceId),
    [currentDeviceId, snapshot.pushes],
  );

  const pushes = useMemo(() => filterTimelinePushes(snapshot.pushes, {
    view,
    type: filter,
    query,
    showDismissed,
    currentDeviceId,
  }), [currentDeviceId, filter, query, showDismissed, snapshot.pushes, view]);

  const selectedView = views.find((item) => item.value === view)!;

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="TIMELINE"
        title="Pushを確認"
        description={snapshot.lastSyncAt ? `${selectedView.description}・最終同期 ${formatDateTime(snapshot.lastSyncAt)}` : `${selectedView.description}。ローカル保存済みの内容を表示しています。`}
        actions={(
          <button className="button button-primary" type="button" onClick={() => navigate('compose')}>
            <Icon name="send" size={18} />新しいPush
          </button>
        )}
      />

      {snapshot.connection !== 'online' && (
        <div className="info-banner warning">
          <Icon name="cloud-off" size={19} />
          <div><strong>ローカルAPIに接続できていません。</strong><span>送信内容はIndexedDBの送信箱へ保存され、接続回復後に再試行されます。</span></div>
        </div>
      )}

      {snapshot.outbox.length > 0 && (
        <section className="section-card outbox-section">
          <div className="section-heading">
            <div><span className="page-eyebrow">OUTBOX</span><h2>送信箱</h2></div>
            <span className="status-chip">{snapshot.outbox.length}件</span>
          </div>
          <div className="outbox-list">
            {snapshot.outbox.map((job) => (
              <OutboxCard
                key={job.id}
                job={job}
                onRetry={() => void runtime.retryOutbox(job.id)}
                onDelete={() => {
                  if (window.confirm('この送信待ち項目を削除しますか？')) void runtime.removeOutbox(job.id);
                }}
              />
            ))}
          </div>
        </section>
      )}

      <section className="timeline-overview" aria-label="Pushの分類">
        {views.map((item) => (
          <button
            key={item.value}
            type="button"
            className={`overview-card${view === item.value ? ' active' : ''}${item.value === 'attention' && counts.attention > 0 ? ' warning' : ''}`}
            onClick={() => setView(item.value)}
            aria-pressed={view === item.value}
          >
            <span>{item.label}</span>
            <strong>{counts[item.value].toLocaleString('ja-JP')}</strong>
            <small>{item.description}</small>
          </button>
        ))}
      </section>

      <section className="timeline-tools" aria-label="履歴の検索と絞り込み">
        <label className="timeline-search">
          <Icon name="search" size={18} />
          <span className="visually-hidden">Pushを検索</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="タイトル、本文、URL、ファイル名を検索" type="search" />
        </label>
        <div className="timeline-controls">
          <div className="segmented compact">
            {(['all', 'note', 'link', 'file'] as const).map((value) => (
              <button key={value} type="button" className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>
                {value === 'all' ? '全種類' : value === 'note' ? 'ノート' : value === 'link' ? 'リンク' : 'ファイル'}
              </button>
            ))}
          </div>
          <label className="check-row"><input type="checkbox" checked={showDismissed} onChange={(event) => setShowDismissed(event.target.checked)} />非表示を含む</label>
        </div>
      </section>

      {pushes.length === 0 ? (
        <EmptyState
          icon="inbox"
          title={snapshot.pushes.length === 0 ? 'まだPushはありません' : view === 'attention' ? '要確認のPushはありません' : '条件に一致するPushがありません'}
          body={snapshot.pushes.length === 0 ? 'ノート、リンク、短期ファイルを別の端末へ送信すると、ここに同期履歴が表示されます。' : view === 'attention' ? 'この端末で受け取れなかったファイルはありません。' : '分類、種類、検索語を変更して確認してください。'}
          action={snapshot.pushes.length === 0 ? <button className="button button-primary" type="button" onClick={() => navigate('compose')}><Icon name="send" size={18} />最初のPushを作る</button> : undefined}
        />
      ) : (
        <div className="push-list">
          {pushes.map((push) => (
            <PushCard
              key={push.id}
              push={push}
              currentDeviceId={currentDeviceId}
              onDismiss={(dismissed) => void runtime.setDismissed(push.id, dismissed)}
              onPin={(pinned) => void runtime.setPinned(push.id, pinned)}
              onDelete={() => {
                const archived = push.status === 'deleted' || push.status === 'expired' || Boolean(push.deleted_at || push.expired_at);
                if (archived) {
                  if (window.confirm('この端末に残したメッセージとファイルを完全に削除しますか？')) void runtime.deleteLocalPush(push.id);
                } else if (window.confirm('このPushをサーバーとこの端末の履歴から削除しますか？')) void runtime.deletePush(push.id);
              }}
              onDownload={() => push.file && void runtime.downloadFile(push.file)}
              onCopied={() => runtime.notify('success', 'クリップボードへコピーしました。')}
            />
          ))}
        </div>
      )}
    </div>
  );
}
