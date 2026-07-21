import type { IconName } from './Icon';
import { Icon } from './Icon';

export function EmptyState({ icon, title, body, action }: {
  icon: IconName;
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon"><Icon name={icon} size={32} /></div>
      <h2>{title}</h2>
      <p>{body}</p>
      {action}
    </div>
  );
}
