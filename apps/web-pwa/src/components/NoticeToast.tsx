import { useEffect } from 'react';
import { useAppRuntime, useAppSnapshot } from '@/state/AppContext';
import { Icon } from './Icon';

export function NoticeToast() {
  const runtime = useAppRuntime();
  const notice = useAppSnapshot().notice;

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => runtime.clearNotice(), 4_500);
    return () => window.clearTimeout(timeout);
  }, [notice, runtime]);

  if (!notice) return null;
  return (
    <div className={`toast toast-${notice.kind}`} role="status" aria-live="polite">
      <span>{notice.message}</span>
      <button className="icon-button" type="button" onClick={() => runtime.clearNotice()} aria-label="通知を閉じる">
        <Icon name="x" size={17} />
      </button>
    </div>
  );
}
