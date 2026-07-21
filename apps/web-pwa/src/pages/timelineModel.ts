import type { PushRecord, PushType } from '@/types';

export type TimelineView = 'inbox' | 'sent' | 'saved' | 'attention' | 'all';

export interface TimelineCounts {
  inbox: number;
  sent: number;
  saved: number;
  attention: number;
  all: number;
}

export function isArchived(push: PushRecord): boolean {
  return push.status === 'deleted' || push.status === 'expired'
    || Boolean(push.deleted_at || push.expired_at);
}

export function isSent(push: PushRecord, currentDeviceId?: string): boolean {
  return Boolean(currentDeviceId && push.source_device_id === currentDeviceId);
}

export function needsAttention(push: PushRecord): boolean {
  return push.type === 'file'
    && !push.local_file_cached
    && push.is_for_current_device !== false
    && (push.local_file_delivery === 'missed'
      || push.file?.state === 'expired'
      || push.file?.state === 'deleted');
}

export function belongsToView(push: PushRecord, view: TimelineView, currentDeviceId?: string): boolean {
  if (view === 'all') return true;
  if (view === 'sent') return isSent(push, currentDeviceId);
  if (view === 'saved') return Boolean(push.local_file_cached || push.pinned);
  if (view === 'attention') return needsAttention(push);
  return push.is_for_current_device !== false && !isSent(push, currentDeviceId);
}

export function matchesTimelineQuery(push: PushRecord, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase('ja');
  if (!needle) return true;
  return [
    push.title,
    push.body,
    push.url,
    push.file?.name,
    push.source_device_name,
    push.source_device_id,
    push.target.device_name,
  ].some((value) => value?.toLocaleLowerCase('ja').includes(needle));
}

export function filterTimelinePushes(pushes: PushRecord[], options: {
  view: TimelineView;
  type: 'all' | PushType;
  query: string;
  showDismissed: boolean;
  currentDeviceId?: string;
}): PushRecord[] {
  return pushes.filter((push) => {
    if (!belongsToView(push, options.view, options.currentDeviceId)) return false;
    if (options.type !== 'all' && push.type !== options.type) return false;
    if (!options.showDismissed && (push.status === 'dismissed' || push.dismissed_at)) return false;
    return matchesTimelineQuery(push, options.query);
  });
}

export function timelineCounts(pushes: PushRecord[], currentDeviceId?: string): TimelineCounts {
  return {
    inbox: pushes.filter((push) => belongsToView(push, 'inbox', currentDeviceId)).length,
    sent: pushes.filter((push) => belongsToView(push, 'sent', currentDeviceId)).length,
    saved: pushes.filter((push) => belongsToView(push, 'saved', currentDeviceId)).length,
    attention: pushes.filter(needsAttention).length,
    all: pushes.length,
  };
}
