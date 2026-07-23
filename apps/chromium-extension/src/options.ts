import { API_ORIGIN } from './shared';
import { element, errorMessage, message, setStatus } from './ui';

interface Status {
  linked: boolean;
  keyReady: boolean;
  realtimeConnected: boolean;
  notificationsEnabled: boolean;
  lastSyncAt?: string;
  deviceId?: string;
  publicKey: string;
}

function render(value: Status): void {
  if (!value.linked) setStatus('未接続', 'error');
  else if (!value.keyReady) setStatus(`端末リンク済み。E2EE envelope待機中 (${value.deviceId})`);
  else setStatus(`接続済み・E2EE準備完了・Realtime ${value.realtimeConnected ? '接続中' : '再接続待ち'} (${value.deviceId})`, 'success');
  element<HTMLInputElement>('notifications-enabled').checked = value.notificationsEnabled;
  element<HTMLElement>('last-sync').textContent = value.lastSyncAt
    ? new Date(value.lastSyncAt).toLocaleString()
    : '未同期';
}

element<HTMLElement>('origin').textContent = API_ORIGIN;
element<HTMLButtonElement>('redeem').addEventListener('click', () => {
  const token = element<HTMLInputElement>('link-token');
  setStatus('端末リンク中…');
  void message<Status>({ type: 'REDEEM', token: token.value }).then((value) => {
    token.value = '';
    render(value);
  }).catch((error) => setStatus(errorMessage(error), 'error'));
});
element<HTMLButtonElement>('sync-key').addEventListener('click', () => {
  setStatus('E2EE鍵を確認中…');
  void message<Status>({ type: 'SYNC_KEY' }).then(render).catch((error) => setStatus(errorMessage(error), 'error'));
});
element<HTMLButtonElement>('sync-now').addEventListener('click', () => {
  setStatus('受信内容を同期中…');
  void message<Status>({ type: 'SYNC_NOW' }).then(render).catch((error) => setStatus(errorMessage(error), 'error'));
});
element<HTMLInputElement>('notifications-enabled').addEventListener('change', (event) => {
  void message<Status>({
    type: 'SET_NOTIFICATIONS',
    enabled: (event.currentTarget as HTMLInputElement).checked,
  }).then(render).catch((error) => setStatus(errorMessage(error), 'error'));
});
element<HTMLButtonElement>('disconnect').addEventListener('click', () => {
  if (!confirm('このChrome profile内のtokenと鍵を削除しますか？ サーバー上の端末は、別の接続済み端末から解除するまで残ります。')) return;
  void message<Status>({ type: 'DISCONNECT' }).then(render).catch((error) => setStatus(errorMessage(error), 'error'));
});

void message<Status>({ type: 'STATUS' }).then(render).catch((error) => setStatus(errorMessage(error), 'error'));
