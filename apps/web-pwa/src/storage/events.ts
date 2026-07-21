const CHANNEL_NAME = 'pushbridge-data-events-v1';
const LOCAL_EVENT = 'pushbridge-data-changed';

let channel: BroadcastChannel | undefined;

function getChannel(): BroadcastChannel | undefined {
  if (typeof BroadcastChannel === 'undefined') return undefined;
  channel ??= new BroadcastChannel(CHANNEL_NAME);
  return channel;
}

export function notifyDataChanged(reason: string): void {
  window.dispatchEvent(new CustomEvent(LOCAL_EVENT, { detail: { reason } }));
  getChannel()?.postMessage({ type: 'changed', reason });
}

export function subscribeDataChanged(callback: (reason: string) => void): () => void {
  const onLocal = (event: Event) => {
    const detail = (event as CustomEvent<{ reason?: string }>).detail;
    callback(detail?.reason ?? 'local');
  };
  const onChannel = (event: MessageEvent<{ type?: string; reason?: string }>) => {
    if (event.data?.type === 'changed') callback(event.data.reason ?? 'remote');
  };

  window.addEventListener(LOCAL_EVENT, onLocal);
  const broadcast = getChannel();
  broadcast?.addEventListener('message', onChannel);

  return () => {
    window.removeEventListener(LOCAL_EVENT, onLocal);
    broadcast?.removeEventListener('message', onChannel);
  };
}
