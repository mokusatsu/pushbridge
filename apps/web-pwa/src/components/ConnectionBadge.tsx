import type { ConnectionState } from '@/types';
import { Icon } from './Icon';

const labels: Record<ConnectionState, string> = {
  online: 'API接続中',
  offline: 'オフライン',
  degraded: 'API切断',
  checking: '接続確認中',
};

export function ConnectionBadge({ state, realtime }: { state: ConnectionState; realtime: boolean }) {
  const icon = state === 'online' ? 'wifi' : 'cloud-off';
  const suffix = state === 'online' && realtime ? '・リアルタイム' : '';
  return (
    <span className={`connection-badge connection-${state}`} title={`${labels[state]}${suffix}`}>
      <Icon name={icon} size={15} />
      <span>{labels[state]}{suffix}</span>
    </span>
  );
}
