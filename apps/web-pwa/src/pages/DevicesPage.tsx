import { useState } from 'react';
import { EmptyState } from '@/components/EmptyState';
import { Icon } from '@/components/Icon';
import { PageHeader } from '@/components/PageHeader';
import { useAppRuntime, useAppSnapshot } from '@/state/AppContext';
import type { DeviceCredential, DeviceKind } from '@/types';
import { formatDateTime, formatRelativeTime } from '@/utils/format';

export function DevicesPage() {
  const runtime = useAppRuntime();
  const snapshot = useAppSnapshot();
  const [editing, setEditing] = useState<string>();
  const [name, setName] = useState('');
  const [registrationName, setRegistrationName] = useState('追加テスト端末');
  const [registrationKind, setRegistrationKind] = useState<Exclude<DeviceKind, 'unknown'>>('test');
  const [linking, setLinking] = useState(false);
  const [linkedCredential, setLinkedCredential] = useState<DeviceCredential>();
  const maxDevices = snapshot.capabilities?.limits.max_devices ?? 10;
  const activeDeviceCount = snapshot.devices.filter((device) => device.active).length;
  const deviceLimitReached = activeDeviceCount >= maxDevices;

  const beginEdit = (deviceId: string, currentName: string) => {
    setEditing(deviceId);
    setName(currentName);
  };

  const linkDevice = async () => {
    setLinking(true);
    const credential = await runtime.linkDevice(registrationName.trim(), registrationKind);
    setLinking(false);
    if (credential) setLinkedCredential(credential);
  };

  const copyToken = async () => {
    if (!linkedCredential) return;
    await navigator.clipboard.writeText(linkedCredential.access_token);
    runtime.notify('success', '追加端末のBearer Tokenをコピーしました。');
  };

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="DEVICES"
        title="端末管理"
        description="RelayMockの端末一覧をローカルへキャッシュし、送信先選択と端末Tokenの失効に利用します。"
        actions={<button className="button button-secondary" type="button" onClick={() => void runtime.syncNow(true)}><Icon name="refresh" size={17} />更新</button>}
      />

      {snapshot.capabilities?.features.device_registration && runtime.settings.bearerToken && (
        <section className="section-card registration-card">
          <div>
            <span className="page-eyebrow">LINK DEVICE</span>
            <h2>追加端末をリンク</h2>
            <p>RelayMockの承認済みリンクを模擬します。返されるTokenは一度しか表示されないため、対象端末へ安全に転記してください。</p>
            <span className={`status-chip${deviceLimitReached ? ' muted' : ''}`}>{activeDeviceCount} / {maxDevices}台</span>
          </div>
          <div className="inline-form relaymock-link-form">
            <input value={registrationName} onChange={(event) => setRegistrationName(event.target.value)} aria-label="追加端末名" maxLength={100} />
            <select value={registrationKind} onChange={(event) => setRegistrationKind(event.target.value as Exclude<DeviceKind, 'unknown'>)} aria-label="追加端末種別">
              <option value="test">test</option>
              <option value="web">web</option>
              <option value="pwa">pwa</option>
              <option value="browser_extension">browser_extension</option>
            </select>
            <button className="button button-primary" type="button" disabled={!registrationName.trim() || linking || deviceLimitReached} onClick={() => void linkDevice()}>{linking ? 'リンク中…' : deviceLimitReached ? '上限到達' : 'リンク'}</button>
          </div>
          {linkedCredential && (
            <div className="info-banner compact">
              <Icon name="check" size={18} />
              <div>
                <strong>{linkedCredential.device.name} のToken</strong>
                <code className="credential-token">{linkedCredential.access_token}</code>
                <span>有効期限: {formatDateTime(linkedCredential.expires_at)}</span>
              </div>
              <button className="button button-secondary button-small" type="button" onClick={() => void copyToken()}><Icon name="copy" size={16} />コピー</button>
            </div>
          )}
        </section>
      )}

      {snapshot.devices.length === 0 ? (
        <EmptyState icon="devices" title="端末が登録されていません" body="設定画面でRelayMockのBootstrapを実行するか、Bearer Tokenを設定してください。" />
      ) : (
        <div className="device-grid">
          {snapshot.devices.map((device) => {
            const current = device.id === runtime.settings.currentDeviceId || device.is_current;
            return (
              <article key={device.id} className={`device-card${current ? ' is-current' : ''}${!device.active ? ' is-inactive' : ''}`}>
                <div className="device-card-top">
                  <div className="device-icon"><Icon name="devices" size={24} /></div>
                  <div className="device-heading">
                    {editing === device.id ? (
                      <div className="inline-edit">
                        <input value={name} onChange={(event) => setName(event.target.value)} autoFocus maxLength={100} />
                        <button className="icon-button" type="button" aria-label="保存" onClick={() => { if (name.trim()) void runtime.renameDevice(device.id, name.trim()); setEditing(undefined); }}><Icon name="check" size={18} /></button>
                        <button className="icon-button" type="button" aria-label="キャンセル" onClick={() => setEditing(undefined)}><Icon name="x" size={18} /></button>
                      </div>
                    ) : <h2>{device.name}</h2>}
                    <div className="meta-row"><span>{device.kind}</span>{current && <span className="status-chip">現在の端末</span>}{!device.active && <span className="status-chip muted">失効済み</span>}</div>
                  </div>
                </div>
                <dl className="device-details">
                  <div><dt>端末ID</dt><dd><code>{device.id}</code></dd></div>
                  <div><dt>最終接続</dt><dd title={formatDateTime(device.last_seen_at)}>{device.last_seen_at ? formatRelativeTime(device.last_seen_at) : '記録なし'}</dd></div>
                  <div><dt>登録日</dt><dd>{formatDateTime(device.created_at)}</dd></div>
                </dl>
                <div className="device-actions">
                  <button className="button button-ghost button-small" type="button" disabled={!device.active} onClick={() => beginEdit(device.id, device.name)}>名前変更</button>
                  <button className="button button-ghost button-small danger-text" type="button" disabled={!device.active} onClick={() => {
                    const message = current
                      ? '現在の端末を失効すると、このBearer Tokenでは以後アクセスできません。最後の1台はRelayMockが拒否します。続行しますか？'
                      : 'この端末と、その端末のSession／Subscriptionを失効しますか？';
                    if (window.confirm(message)) void runtime.revokeDevice(device.id);
                  }}>失効</button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
