import { useEffect, useState } from 'react';

export type AppRoute = 'timeline' | 'compose' | 'devices' | 'settings';

function parseHash(hash: string): AppRoute {
  const value = hash.replace(/^#\/?/, '').split(/[?&]/, 1)[0];
  if (value === 'compose' || value === 'devices' || value === 'settings') return value;
  return 'timeline';
}

export function navigate(route: AppRoute): void {
  window.location.hash = `#/${route}`;
}

export function useHashRoute(): AppRoute {
  const [route, setRoute] = useState<AppRoute>(() => parseHash(window.location.hash));

  useEffect(() => {
    const onHashChange = () => setRoute(parseHash(window.location.hash));
    const onServiceWorkerMessage = (event: MessageEvent<{ type?: string; url?: string }>) => {
      if (event.data?.type === 'NAVIGATE' && event.data.url) {
        const target = new URL(event.data.url, window.location.href);
        window.location.hash = target.hash || '#/timeline';
      }
    };
    window.addEventListener('hashchange', onHashChange);
    navigator.serviceWorker?.addEventListener('message', onServiceWorkerMessage);
    if (!window.location.hash) navigate('timeline');
    return () => {
      window.removeEventListener('hashchange', onHashChange);
      navigator.serviceWorker?.removeEventListener('message', onServiceWorkerMessage);
    };
  }, []);

  return route;
}
