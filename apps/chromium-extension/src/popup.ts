import type { Draft } from './shared';
import { element, errorMessage, message, setStatus } from './ui';

interface Status {
  linked: boolean;
  keyReady: boolean;
  deviceId?: string;
  defaultTarget: string;
  devices: Array<{ id: string; name: string; current: boolean }>;
}

interface HistoryItem {
  id: string;
  type: 'note' | 'link';
  title: string;
  body: string;
  url: string;
}

const target = element<HTMLSelectElement>('target');

function renderStatus(value: Status): void {
  if (!value.linked) {
    setStatus('未接続です。設定画面でdevice-link tokenを入力してください。', 'error');
  } else if (!value.keyReady) {
    setStatus('端末リンク済み。リンク元PWAの同期後、E2EE鍵を再確認してください。');
  } else {
    setStatus('接続済み・E2EE準備完了', 'success');
  }
  target.replaceChildren(new Option('自分のほかの全端末', 'all_other_devices'));
  for (const device of value.devices) {
    if (device.current || device.id === value.deviceId) continue;
    target.add(new Option(device.name || device.id, device.id));
  }
  target.value = [...target.options].some((option) => option.value === value.defaultTarget)
    ? value.defaultTarget
    : 'all_other_devices';
}

async function refresh(): Promise<void> {
  const value = await message<Status>({ type: 'STATUS' });
  renderStatus(value);
  const history = await message<HistoryItem[]>({ type: 'HISTORY' }).catch(() => []);
  const list = element<HTMLUListElement>('history');
  list.replaceChildren(...(history.length ? history : [{ id: '', type: 'note' as const, title: '履歴はありません', body: '', url: '' }]).map((item) => {
    const row = document.createElement('li');
    row.textContent = item.title || item.url || item.body || (item.type === 'link' ? 'Link' : 'Note');
    return row;
  }));
  const tab = await message<{ title: string; url: string }>({ type: 'CURRENT_TAB' }).catch(() => ({ title: '', url: '' }));
  if (tab.url) {
    element<HTMLInputElement>('link-title').value = tab.title;
    element<HTMLInputElement>('link-url').value = tab.url;
  }
}

async function send(draft: Draft): Promise<void> {
  setStatus('送信中…');
  try {
    await message({ type: 'SEND', draft, target: target.value });
    setStatus('暗号化して送信しました。', 'success');
    await refresh();
  } catch (error) {
    setStatus(errorMessage(error), 'error');
  }
}

target.addEventListener('change', () => void message({ type: 'SET_TARGET', target: target.value }));
element<HTMLButtonElement>('refresh').addEventListener('click', () => void refresh().catch((error) => setStatus(errorMessage(error), 'error')));
element<HTMLButtonElement>('send-tab').addEventListener('click', () => {
  void message<{ title: string; url: string }>({ type: 'CURRENT_TAB' })
    .then((tab) => send({ type: 'link', title: tab.title, url: tab.url }))
    .catch((error) => setStatus(errorMessage(error), 'error'));
});
element<HTMLButtonElement>('send-note').addEventListener('click', () => void send({
  type: 'note',
  title: element<HTMLInputElement>('note-title').value,
  body: element<HTMLTextAreaElement>('note-body').value,
}));
element<HTMLButtonElement>('send-link').addEventListener('click', () => void send({
  type: 'link',
  title: element<HTMLInputElement>('link-title').value,
  url: element<HTMLInputElement>('link-url').value,
}));

void refresh().catch((error) => setStatus(errorMessage(error), 'error'));
