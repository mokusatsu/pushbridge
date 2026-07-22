import { useState, type FormEvent } from 'react';
import { ApiClient } from '@/api/client';
import { apiErrorMessage } from '@/api/errors';
import { LocalApi } from '@/api/localApi';
import { clearClientSettings, saveClientSettings } from '@/config';
import { Icon } from '@/components/Icon';
import { PageHeader } from '@/components/PageHeader';
import { webPushSupport } from '@/services/webPush';
import { authenticatePasskey, passkeysSupported, registerPasskey } from '@/services/passkeys';
import { useAppRuntime, useAppSnapshot } from '@/state/AppContext';
import type { AuthMode, ClientSettings, WebPushSubscriptionRecord } from '@/types';
import { formatBytes, formatDateTime } from '@/utils/format';

function validApiBase(value: string): boolean {
  if (value.startsWith('/')) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function safeNamespace(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'relaymock-local';
}

function endpointLabel(value: string): string {
  try {
    const url = new URL(value);
    const tail = url.pathname.split('/').filter(Boolean).at(-1);
    return `${url.hostname}${tail ? ` / …${tail.slice(-10)}` : ''}`;
  } catch {
    return value.length > 48 ? `${value.slice(0, 45)}…` : value;
  }
}

export function SettingsPage() {
  const runtime = useAppRuntime();
  const snapshot = useAppSnapshot();
  const [form, setForm] = useState<ClientSettings>({ ...runtime.settings });
  const [testing, setTesting] = useState(false);
  const [formError, setFormError] = useState('');
  const [bootstrapHandle, setBootstrapHandle] = useState('local-user');
  const [bootstrapDeviceName, setBootstrapDeviceName] = useState(() => `PWA ${navigator.platform || 'Browser'}`);
  const [bootstrapping, setBootstrapping] = useState(false);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [webPushBusy, setWebPushBusy] = useState(false);
  const pushSupport = webPushSupport();
  const passkeyBrowserSupported = passkeysSupported();

  const update = <K extends keyof ClientSettings>(key: K, value: ClientSettings[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const normalizedSettings = (): ClientSettings => ({
    ...form,
    apiBaseUrl: form.apiBaseUrl.trim().replace(/\/+$/, ''),
    realtimePath: form.realtimePath.trim(),
    currentDeviceId: form.currentDeviceId.trim(),
    storageNamespace: safeNamespace(form.storageNamespace),
    pollIntervalSeconds: Math.max(5, Number(form.pollIntervalSeconds) || 30),
    localFileCacheMaxBytes: Math.max(0, Number(form.localFileCacheMaxBytes) || 0),
  });

  const save = (event: FormEvent) => {
    event.preventDefault();
    setFormError('');
    if (!validApiBase(form.apiBaseUrl.trim())) {
      setFormError('APIベースURLには / で始まる相対パス、または http(s) URLを指定してください。');
      return;
    }
    if (!form.realtimePath.startsWith('/') && !/^wss?:\/\//.test(form.realtimePath)) {
      setFormError('リアルタイムパスには / で始まる相対パス、または ws(s) URLを指定してください。');
      return;
    }
    saveClientSettings(normalizedSettings());
    window.location.reload();
  };

  const bootstrap = async () => {
    setFormError('');
    if (!bootstrapHandle.trim() || !/^[A-Za-z0-9_.-]+$/.test(bootstrapHandle.trim())) {
      setFormError('Handleは英数字、_、.、-だけで入力してください。');
      return;
    }
    if (!bootstrapDeviceName.trim()) {
      setFormError('端末名を入力してください。');
      return;
    }

    setBootstrapping(true);
    try {
      const unauthenticated: ClientSettings = {
        ...normalizedSettings(),
        authMode: 'none',
        bearerToken: '',
      };
      const api = new LocalApi(new ApiClient(unauthenticated));
      const result = await api.bootstrap({
        handle: bootstrapHandle.trim(),
        device_name: bootstrapDeviceName.trim(),
        device_kind: 'pwa',
      });
      saveClientSettings({
        ...normalizedSettings(),
        authMode: 'bearer',
        bearerToken: result.access_token,
        rememberBearerToken: true,
        currentDeviceId: result.device.id,
        storageNamespace: safeNamespace(`relaymock-${result.user.id}`),
      });
      window.location.reload();
    } catch (error) {
      setFormError(apiErrorMessage(error));
    } finally {
      setBootstrapping(false);
    }
  };

  const testFormConnection = async () => {
    setTesting(true);
    setFormError('');
    try {
      const api = new LocalApi(new ApiClient(normalizedSettings()));
      const [capabilities, webPushConfig] = await Promise.all([
        api.getCapabilities(),
        api.getWebPushConfig(),
      ]);
      const device = form.authMode === 'cookie' || (form.authMode === 'bearer' && form.bearerToken)
        ? await api.getCurrentDevice()
        : undefined;
      runtime.notify('success', device
        ? `接続成功: ${device.name} / ${device.id} / API ${capabilities.api_version}`
        : `Health Check成功: RelayMock API ${capabilities.api_version}${webPushConfig ? ' / Web Push設定あり' : ''}`);
    } catch (error) {
      setFormError(apiErrorMessage(error));
    } finally {
      setTesting(false);
    }
  };

  const passkeyApi = () => new ApiClient({ ...normalizedSettings(), authMode: 'none', bearerToken: '', csrfToken: '' });

  const createPasskeyAccount = async () => {
    setFormError('');
    if (!passkeyBrowserSupported) { setFormError('このブラウザーはPasskeyに対応していません。'); return; }
    if (!/^[A-Za-z0-9_.-]{1,80}$/.test(bootstrapHandle.trim()) || !bootstrapDeviceName.trim()) {
      setFormError('有効なHandleと端末名を入力してください。'); return;
    }
    setPasskeyBusy(true);
    try {
      const result = await registerPasskey(passkeyApi(), { handle: bootstrapHandle.trim(), device_name: bootstrapDeviceName.trim() });
      if (!result.user || !result.device) throw new Error('Passkey登録応答にユーザーまたは端末がありません。');
      saveClientSettings({
        ...normalizedSettings(), authMode: 'cookie', bearerToken: '', csrfToken: result.csrf_token,
        currentDeviceId: result.device.id, storageNamespace: safeNamespace(`pushbridge-${result.user.id}`),
      });
      window.location.reload();
    } catch (error) { setFormError(apiErrorMessage(error)); } finally { setPasskeyBusy(false); }
  };

  const loginWithPasskey = async () => {
    setFormError('');
    if (!passkeyBrowserSupported) { setFormError('このブラウザーはPasskeyに対応していません。'); return; }
    setPasskeyBusy(true);
    try {
      const result = await authenticatePasskey(passkeyApi(), bootstrapHandle.trim() || undefined);
      const cookieSettings: ClientSettings = { ...normalizedSettings(), authMode: 'cookie', bearerToken: '', csrfToken: result.csrf_token };
      const device = await new LocalApi(new ApiClient(cookieSettings)).getCurrentDevice();
      saveClientSettings({ ...cookieSettings, currentDeviceId: device.id });
      window.location.reload();
    } catch (error) { setFormError(apiErrorMessage(error)); } finally { setPasskeyBusy(false); }
  };

  const logoutPasskey = async () => {
    setPasskeyBusy(true);
    setFormError('');
    try {
      await new ApiClient(normalizedSettings()).request('/auth/logout', { method: 'POST' });
      clearClientSettings();
      window.location.reload();
    } catch (error) { setFormError(apiErrorMessage(error)); } finally { setPasskeyBusy(false); }
  };

  const requestNotifications = async () => {
    if (!('Notification' in window)) {
      runtime.notify('error', 'このブラウザーは通知APIに対応していません。');
      return;
    }
    const permission = await Notification.requestPermission();
    runtime.notify(permission === 'granted' ? 'success' : 'info', permission === 'granted' ? '通知を許可しました。' : '通知は許可されませんでした。');
  };

  const registerWebPush = async () => {
    setWebPushBusy(true);
    try {
      await runtime.registerWebPushSubscription();
    } catch {
      // Runtime already reports the API/browser error with its Request ID.
    } finally {
      setWebPushBusy(false);
    }
  };

  const revokeWebPush = async (subscription: WebPushSubscriptionRecord) => {
    setWebPushBusy(true);
    try {
      await runtime.revokeWebPushSubscription(subscription);
    } catch {
      // Runtime already reports the error.
    } finally {
      setWebPushBusy(false);
    }
  };

  const canRegisterWebPush = Boolean(
    pushSupport.supported
    && (runtime.settings.authMode === 'cookie' || runtime.settings.bearerToken)
    && snapshot.capabilities?.features.web_push_subscription_registration
    && snapshot.webPushConfig?.subscription_registration,
  );

  return (
    <div className="page-stack settings-page">
      <PageHeader
        eyebrow="SETTINGS"
        title="RelayMock接続設定"
        description="Web/PWAは同一オリジンの /api/v1 を呼び、開発プロキシがRelayMockの /v1 へ変換します。"
      />

      {runtime.settings.authMode !== 'cookie' && !runtime.settings.bearerToken && (
        <>
        {snapshot.capabilities?.features.passkey_authentication && (
          <section className="section-card settings-form passkey-auth">
            <div className="section-heading"><div><span className="page-eyebrow">PASSKEY</span><h2>Passkeyで安全に接続</h2></div><span className="status-chip">正式認証</span></div>
            <p className="muted-copy">秘密鍵は端末のAuthenticatorから外へ出ません。ブラウザーセッションはHttpOnly Cookie、変更操作はCSRF tokenで保護されます。</p>
            <div className="form-grid two-columns">
              <label className="field"><span>Handle</span><input value={bootstrapHandle} onChange={(event) => setBootstrapHandle(event.target.value)} maxLength={80} autoComplete="username webauthn" /></label>
              <label className="field"><span>この端末の名前</span><input value={bootstrapDeviceName} onChange={(event) => setBootstrapDeviceName(event.target.value)} maxLength={100} /></label>
            </div>
            <div className="settings-actions align-start">
              <button className="button button-primary" type="button" disabled={passkeyBusy || !passkeyBrowserSupported} onClick={() => void loginWithPasskey()}>{passkeyBusy ? '確認中…' : 'Passkeyでログイン'}</button>
              <button className="button button-secondary" type="button" disabled={passkeyBusy || !passkeyBrowserSupported} onClick={() => void createPasskeyAccount()}>新規Passkeyを登録</button>
            </div>
          </section>
        )}
        <section className="section-card settings-form relaymock-bootstrap">
          <div className="section-heading"><div><span className="page-eyebrow">FIRST CONNECTION</span><h2>RelayMockをBootstrap</h2></div><span className="status-chip">開発専用</span></div>
          <p className="muted-copy">ユーザー、現在のPWA端末、端末スコープのBearer Tokenを一括作成します。この操作は外部公開環境では使用しないでください。</p>
          <div className="form-grid two-columns">
            <label className="field">
              <span>Handle</span>
              <input value={bootstrapHandle} onChange={(event) => setBootstrapHandle(event.target.value)} maxLength={80} pattern="[A-Za-z0-9_.-]+" autoCapitalize="none" spellCheck={false} />
            </label>
            <label className="field">
              <span>この端末の名前</span>
              <input value={bootstrapDeviceName} onChange={(event) => setBootstrapDeviceName(event.target.value)} maxLength={100} />
            </label>
          </div>
          <div className="settings-actions align-start">
            <button className="button button-primary" type="button" disabled={bootstrapping} onClick={() => void bootstrap()}><Icon name="devices" size={17} />{bootstrapping ? '作成中…' : 'アカウントと端末を作成'}</button>
          </div>
        </section>
        </>
      )}

      {runtime.settings.authMode === 'cookie' && (
        <section className="section-card settings-form passkey-auth">
          <div className="section-heading"><div><span className="page-eyebrow">PASSKEY SESSION</span><h2>ブラウザーセッション</h2></div><span className="status-chip">接続中</span></div>
          <p className="muted-copy">認証CookieはJavaScriptから読み取れません。CSRF tokenはこのタブのsessionStorageだけに保持します。</p>
          <div className="settings-actions align-start"><button className="button button-secondary" type="button" disabled={passkeyBusy} onClick={() => void logoutPasskey()}>ログアウト</button></div>
        </section>
      )}

      <form className="section-card settings-form" onSubmit={save}>
        <div className="section-heading"><div><span className="page-eyebrow">CONNECTION</span><h2>REST API</h2></div><span className="status-chip">再読み込みで反映</span></div>

        <label className="field">
          <span>APIベースURL</span>
          <input value={form.apiBaseUrl} onChange={(event) => update('apiBaseUrl', event.target.value)} placeholder="/api/v1" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
          <small>推奨値は`/api/v1`です。プロキシが`/api`を除去し、RelayMockの`/v1`へ転送します。</small>
        </label>

        <div className="form-grid two-columns">
          <label className="field">
            <span>フォールバック同期間隔（秒）</span>
            <input type="number" min={5} max={3600} value={form.pollIntervalSeconds} onChange={(event) => update('pollIntervalSeconds', Number(event.target.value))} />
            <small>Capabilities取得後はサーバーの推奨値（現在 {snapshot.capabilities?.recommended_poll_interval_seconds ?? '未取得'}秒）を優先します。</small>
          </label>
          <label className="field">
            <span>将来のリアルタイムパス</span>
            <input value={form.realtimePath} onChange={(event) => update('realtimePath', event.target.value)} placeholder="/realtime" autoCapitalize="none" spellCheck={false} />
            <small>現在は使用しません。Cloudflare移行後のtickle用に保持しています。</small>
          </label>
        </div>

        <div className="form-grid two-columns">
          <label className="field">
            <span>認証方式</span>
            <select value={form.authMode} onChange={(event) => update('authMode', event.target.value as AuthMode)}>
              <option value="bearer">Bearer Token（RelayMock）</option>
              <option value="none">認証なし（Health／Bootstrap用）</option>
              <option value="cookie">Passkey / HttpOnly Cookie</option>
            </select>
          </label>
          <label className="field">
            <span>Bearer Token</span>
            <input type="password" value={form.bearerToken} onChange={(event) => update('bearerToken', event.target.value)} disabled={form.authMode !== 'bearer'} autoComplete="off" />
          </label>
        </div>

        <label className="check-row">
          <input type="checkbox" checked={form.rememberBearerToken} onChange={(event) => update('rememberBearerToken', event.target.checked)} disabled={form.authMode !== 'bearer'} />
          このブラウザーにTokenを保存する
          <small>RelayMockはTokenを再表示しないため、ローカルPoCでは有効を推奨します。本番ではHttpOnly Cookieまたは安全な端末Credentialへ置換します。</small>
        </label>

        <div className="form-grid two-columns">
          <label className="field">
            <span>現在の端末ID <small>通常は自動取得</small></span>
            <input list="device-ids" value={form.currentDeviceId} onChange={(event) => update('currentDeviceId', event.target.value)} placeholder="Bearer Tokenから /devices/me で解決" />
            <datalist id="device-ids">{snapshot.devices.map((device) => <option key={device.id} value={device.id}>{device.name}</option>)}</datalist>
          </label>
          <label className="field">
            <span>IndexedDB名前空間</span>
            <input value={form.storageNamespace} onChange={(event) => update('storageNamespace', event.target.value)} pattern="[A-Za-z0-9_-]+" />
            <small>Bootstrap後はユーザーIDごとの名前空間へ自動的に分離します。</small>
          </label>
        </div>

        {formError && <div className="form-error" role="alert">{formError}</div>}

        <div className="settings-actions">
          <button className="button button-secondary" type="button" onClick={() => void testFormConnection()} disabled={testing}><Icon name="wifi" size={17} />{testing ? '確認中…' : 'この設定で疎通確認'}</button>
          <button className="button button-primary" type="submit"><Icon name="check" size={17} />保存して再読み込み</button>
        </div>
      </form>

      <section className="section-card settings-form">
        <div className="section-heading"><div><span className="page-eyebrow">OFFLINE INBOX</span><h2>端末内への永続保存</h2></div><span className="status-chip">IndexedDB</span></div>
        <p className="muted-copy">受信したメッセージは端末内に残し、ファイルは同期時に可能な限り自動保存します。サーバーの30日削除や容量整理後も、端末内保存に成功した内容は参照できます。</p>
        <label className="check-row">
          <input type="checkbox" checked={form.autoCacheReceivedFiles} onChange={(event) => update('autoCacheReceivedFiles', event.target.checked)} />
          受信ファイルを同期時に自動保存する
        </label>
        <label className="field">
          <span>ファイル保存上限（MiB）</span>
          <input type="number" min={0} max={16384} value={Math.round(form.localFileCacheMaxBytes / 1024 / 1024)} onChange={(event) => update('localFileCacheMaxBytes', Math.max(0, Number(event.target.value) || 0) * 1024 * 1024)} />
          <small>上限を超えた場合は、未ピン留め・最終利用が古い・大きいファイルから自動削除します。メッセージ本文は対象外です。</small>
        </label>
        <div className="settings-actions align-start"><button className="button button-primary" type="button" onClick={() => { saveClientSettings(normalizedSettings()); window.location.reload(); }}><Icon name="check" size={17} />保存して再読み込み</button></div>
      </section>

      <section className="section-card">
        <div className="section-heading">
          <div><span className="page-eyebrow">SERVER STORAGE</span><h2>サーバー上のファイル</h2></div>
          <span className={`status-chip${snapshot.storageUsage?.pressure === 'normal' ? '' : ' muted'}`}>
            {snapshot.storageUsage?.pressure === 'normal' ? '通常'
              : snapshot.storageUsage?.pressure === 'notice' ? '注意'
                : snapshot.storageUsage?.pressure === 'constrained' ? '逼迫'
                  : snapshot.storageUsage?.pressure === 'emergency' ? '緊急' : '未取得'}
          </span>
        </div>
        {snapshot.storageUsage ? (
          <>
            <div className="storage-meter" aria-label={`サーバー使用量 ${formatBytes(snapshot.storageUsage.used_bytes)} / ${formatBytes(snapshot.storageUsage.quota_bytes)}`}>
              <span style={{ width: `${Math.min(100, (snapshot.storageUsage.used_bytes + snapshot.storageUsage.reserved_bytes) / snapshot.storageUsage.quota_bytes * 100)}%` }} />
            </div>
            <div className="capability-grid storage-grid">
              <div><span>使用中</span><strong>{formatBytes(snapshot.storageUsage.used_bytes)}</strong></div>
              <div><span>アップロード予約</span><strong>{formatBytes(snapshot.storageUsage.reserved_bytes)}</strong></div>
              <div><span>運用上限</span><strong>{formatBytes(snapshot.storageUsage.quota_bytes)}</strong></div>
              <div><span>早期整理候補</span><strong>{formatBytes(snapshot.storageUsage.reclaimable_bytes)}</strong></div>
            </div>
            <p className="muted-copy">ファイル本体は最長{snapshot.storageUsage.default_retention_days}日です。無料運用では容量状況により早期削除される場合があります。端末内保存済みのファイルはサーバー整理後も利用できます。</p>
          </>
        ) : <p className="muted-copy">認証後の同期でサーバー使用量を取得します。古いAPIではこの表示を利用できません。</p>}
      </section>

      <section className="section-card">
        <div className="section-heading"><div><span className="page-eyebrow">CAPABILITIES</span><h2>サーバー機能</h2></div><button className="button button-ghost button-small" type="button" onClick={() => void runtime.testConnection()}>再取得</button></div>
        {snapshot.capabilities ? (
          <div className="capability-grid">
            <div><span>API</span><strong>{snapshot.capabilities.api_version}</strong></div>
            <div><span>環境</span><strong>{snapshot.capabilities.environment_id}</strong></div>
            <div><span>同期</span><strong>{snapshot.capabilities.features.realtime ? 'Realtime + REST' : `REST ${snapshot.capabilities.recommended_poll_interval_seconds}秒`}</strong></div>
            <div><span>アップロード</span><strong>{snapshot.capabilities.transports.upload.length > 0 ? snapshot.capabilities.transports.upload.join(', ') : '非対応'}</strong></div>
            <div><span>最大ファイル</span><strong>{formatBytes(snapshot.capabilities.limits.max_file_bytes)}</strong></div>
            <div><span>最大Payload</span><strong>{formatBytes(snapshot.capabilities.limits.max_push_payload_bytes)}</strong></div>
            <div><span>端末上限</span><strong>{snapshot.capabilities.limits.max_devices}台</strong></div>
            <div><span>現在の端末</span><strong>{snapshot.currentDevice?.name ?? '未認証'}</strong></div>
          </div>
        ) : <p className="muted-copy">APIへ接続すると機能情報が表示されます。</p>}
      </section>

      <section className="section-card web-push-card">
        <div className="section-heading"><div><span className="page-eyebrow">PWA / WEB PUSH</span><h2>通知先登録</h2></div><span className={`status-chip${snapshot.webPushConfig?.delivery ? '' : ' muted'}`}>{snapshot.webPushConfig?.delivery ? '配送対応' : 'RelayMockは保存のみ'}</span></div>
        <p className="muted-copy">0.1.1ではVAPID公開設定とSubscription CRUDを結合試験できます。RelayMock自身は通知を配送しません。</p>
        <div className="capability-grid compact-grid">
          <div><span>ブラウザー</span><strong>{pushSupport.supported ? '対応' : '非対応'}</strong></div>
          <div><span>通知権限</span><strong>{'Notification' in window ? Notification.permission : 'unsupported'}</strong></div>
          <div><span>登録API</span><strong>{snapshot.webPushConfig?.subscription_registration ? '有効' : '無効／未取得'}</strong></div>
          <div><span>登録済み</span><strong>{snapshot.webPushSubscriptions.length}件</strong></div>
        </div>
        {!pushSupport.supported && <div className="form-error">{pushSupport.reason}</div>}
        <div className="settings-actions align-start">
          <button className="button button-secondary" type="button" onClick={() => void requestNotifications()} disabled={!('Notification' in window)}>通知権限を確認</button>
          <button className="button button-primary" type="button" onClick={() => void registerWebPush()} disabled={!canRegisterWebPush || webPushBusy}><Icon name="wifi" size={17} />{webPushBusy ? '処理中…' : 'このPWAを登録／更新'}</button>
        </div>
        {snapshot.webPushSubscriptions.length > 0 && (
          <div className="subscription-list">
            {snapshot.webPushSubscriptions.map((subscription) => (
              <div className="subscription-row" key={subscription.id}>
                <div>
                  <strong>{endpointLabel(subscription.endpoint)}</strong>
                  <span>登録 {formatDateTime(subscription.created_at)}・{subscription.id}</span>
                </div>
                <button className="button button-ghost button-small danger-text" type="button" disabled={webPushBusy} onClick={() => void revokeWebPush(subscription)}>解除</button>
              </div>
            ))}
          </div>
        )}
        {!import.meta.env.PROD && <small className="muted-copy">ブラウザーPushManagerの実登録は、ビルド済みPWAを`npm run serve:local`で開いて確認してください。</small>}
      </section>

      <section className="section-card danger-zone">
        <div className="section-heading"><div><span className="page-eyebrow">LOCAL DATA</span><h2>ローカルデータ</h2></div></div>
        <dl className="diagnostic-list">
          <div><dt>IndexedDB</dt><dd><code>{runtime.db.name}</code></dd></div>
          <div><dt>キャッシュ済みPush</dt><dd>{snapshot.pushes.length}件</dd></div>
          <div><dt>端末内ファイル</dt><dd>{snapshot.localStorageUsage.cached_file_count}件・{formatBytes(snapshot.localStorageUsage.cached_file_bytes)} / {formatBytes(snapshot.localStorageUsage.cache_limit_bytes)}</dd></div>
          <div><dt>永続ストレージ</dt><dd>{snapshot.localStorageUsage.persistence === 'granted' ? '許可済み' : snapshot.localStorageUsage.persistence === 'not-granted' ? '未許可（ブラウザーが回収する場合あり）' : '未確認／非対応'}</dd></div>
          <div><dt>送信箱</dt><dd>{snapshot.outbox.length}件</dd></div>
          <div><dt>最終同期</dt><dd>{formatDateTime(snapshot.lastSyncAt)}</dd></div>
          <div><dt>アプリ版</dt><dd>{__APP_VERSION__}</dd></div>
        </dl>
        <div className="settings-actions align-start">
          <button className="button button-secondary" type="button" onClick={() => {
            if (window.confirm('端末内に保存したファイルだけを消去しますか？')) void runtime.clearCachedFiles();
          }}><Icon name="delete" size={17} />保存ファイルだけ消去</button>
          <button className="button button-secondary" type="button" onClick={() => {
            if (window.confirm('キャッシュ、同期カーソル、未送信のファイルを含む送信箱を消去しますか？')) void runtime.clearLocalData();
          }}><Icon name="delete" size={17} />キャッシュと送信箱を消去</button>
          <button className="button button-ghost danger-text" type="button" onClick={() => {
            if (window.confirm('Bearer Tokenを含む接続設定を初期化して再読み込みしますか？')) { clearClientSettings(); window.location.reload(); }
          }}>接続設定を初期化</button>
        </div>
      </section>
    </div>
  );
}
