import type { PropsWithChildren } from 'react';
import type { AppRoute } from '@/hooks/useHashRoute';
import { useInstallPrompt } from '@/hooks/useInstallPrompt';
import { useServiceWorkerUpdate } from '@/hooks/useServiceWorkerUpdate';
import { useAppRuntime, useAppSnapshot } from '@/state/AppContext';
import { ConnectionBadge } from './ConnectionBadge';
import { Icon, type IconName } from './Icon';
import { NoticeToast } from './NoticeToast';

const navigation: Array<{ route: AppRoute; label: string; icon: IconName }> = [
  { route: 'timeline', label: '履歴', icon: 'inbox' },
  { route: 'compose', label: '送信', icon: 'send' },
  { route: 'devices', label: '端末', icon: 'devices' },
  { route: 'settings', label: '設定', icon: 'settings' },
];

export function AppShell({ route, children }: PropsWithChildren<{ route: AppRoute }>) {
  const runtime = useAppRuntime();
  const snapshot = useAppSnapshot();
  const installPrompt = useInstallPrompt();
  const serviceWorker = useServiceWorkerUpdate();

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#/timeline" aria-label="Pushbridge ホーム">
          <img src="/favicon.svg" alt="" width="38" height="38" />
          <span><strong>Pushbridge</strong><small>local-first relay</small></span>
        </a>
        <div className="topbar-actions">
          <ConnectionBadge state={snapshot.connection} realtime={snapshot.realtimeConnected} />
          {installPrompt.canInstall && (
            <button className="button button-secondary topbar-text-button" type="button" onClick={() => void installPrompt.install()}>
              <Icon name="install" size={17} />インストール
            </button>
          )}
          <button
            className="icon-button topbar-sync"
            type="button"
            onClick={() => void runtime.syncNow(true)}
            disabled={snapshot.syncing}
            aria-label="今すぐ同期"
            title="今すぐ同期"
          >
            <Icon name="refresh" size={20} className={snapshot.syncing ? 'spin' : undefined} />
          </button>
        </div>
      </header>

      {serviceWorker.updateAvailable && (
        <div className="update-banner" role="status">
          <span>新しいWeb/PWAバージョンを利用できます。</span>
          <button className="button button-small button-primary" type="button" onClick={() => serviceWorker.applyUpdate()}>更新</button>
        </div>
      )}

      {runtime.settings.authMode === 'bearer' && !runtime.settings.bearerToken && (
        <div className="update-banner relaymock-setup-banner" role="status">
          <span>RelayMockの端末Tokenが未設定です。Bootstrapまたは既存Tokenの入力が必要です。</span>
          <a className="button button-small button-primary" href="#/settings">設定を開く</a>
        </div>
      )}

      <div className="app-layout">
        <aside className="sidebar" aria-label="メインナビゲーション">
          <nav>
            {navigation.map((item) => (
              <a key={item.route} href={`#/${item.route}`} className={route === item.route ? 'active' : ''} aria-current={route === item.route ? 'page' : undefined}>
                <Icon name={item.icon} size={20} />
                <span>{item.label}</span>
                {item.route === 'timeline' && snapshot.outbox.length > 0 && <span className="nav-count">{snapshot.outbox.length}</span>}
              </a>
            ))}
          </nav>
          <div className="sidebar-foot">
            <span>API</span>
            <code>{runtime.settings.apiBaseUrl}</code>
            <small>v{__APP_VERSION__}</small>
          </div>
        </aside>

        <main className="main-content" id="main-content">
          {!snapshot.initialized ? (
            <div className="loading-panel"><span className="spinner" />ローカルデータを読み込んでいます…</div>
          ) : children}
        </main>
      </div>

      <nav className="bottom-nav" aria-label="モバイルナビゲーション">
        {navigation.map((item) => (
          <a key={item.route} href={`#/${item.route}`} className={route === item.route ? 'active' : ''} aria-current={route === item.route ? 'page' : undefined}>
            <Icon name={item.icon} size={21} />
            <span>{item.label}</span>
            {item.route === 'timeline' && snapshot.outbox.length > 0 && <span className="mobile-count">{snapshot.outbox.length}</span>}
          </a>
        ))}
      </nav>
      <NoticeToast />
    </div>
  );
}
