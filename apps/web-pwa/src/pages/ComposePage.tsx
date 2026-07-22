import { useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { Icon } from '@/components/Icon';
import { PageHeader } from '@/components/PageHeader';
import { navigate } from '@/hooks/useHashRoute';
import { useAppRuntime, useAppSnapshot } from '@/state/AppContext';
import type { PushTarget, PushType, SendPushDraft } from '@/types';
import { formatBytes } from '@/utils/format';

function validateHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function ttlLabel(seconds: number, isDefault: boolean): string {
  const duration = seconds < 86_400
    ? `${Math.round(seconds / 3_600)}時間`
    : `${Math.round(seconds / 86_400)}日`;
  return isDefault ? `サーバー既定（${duration}）` : duration;
}

export function ComposePage() {
  const runtime = useAppRuntime();
  const snapshot = useAppSnapshot();
  const fileInput = useRef<HTMLInputElement>(null);
  const [type, setType] = useState<PushType>('note');
  const [targetValue, setTargetValue] = useState('all_other');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [url, setUrl] = useState('');
  const [file, setFile] = useState<File>();
  const [expiresIn, setExpiresIn] = useState(2_592_000);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [dragActive, setDragActive] = useState(false);

  const capabilities = snapshot.capabilities;
  const maxFileBytes = capabilities?.limits.max_file_bytes ?? 25 * 1024 * 1024;
  const maxPushPayloadBytes = capabilities?.limits.max_push_payload_bytes ?? 2_000_000;
  const fileUpload = capabilities ? capabilities.transports.upload.length > 0 : true;
  const defaultPushTtl = capabilities?.limits.default_push_ttl_seconds ?? 2_592_000;
  const defaultFileTtl = capabilities?.limits.default_file_ttl_seconds ?? 86_400;

  const fileTtls = useMemo(() => {
    const values = capabilities?.limits.file_ttl_seconds ?? [86_400, 604_800, 2_592_000];
    return Array.from(new Set(values)).sort((a, b) => a - b).map((value) => ({
      value,
      label: ttlLabel(value, value === defaultFileTtl),
    }));
  }, [capabilities, defaultFileTtl]);

  const generalTtls = useMemo(() => {
    const choices = capabilities
      ? [...capabilities.limits.file_ttl_seconds, defaultPushTtl]
      : [86_400, 259_200, 2_592_000];
    return Array.from(new Set(choices)).sort((a, b) => a - b).map((value) => ({
      value,
      label: ttlLabel(value, value === defaultPushTtl),
    }));
  }, [capabilities, defaultPushTtl]);

  const ttlOptions = type === 'file' ? fileTtls : generalTtls;

  useEffect(() => {
    if (!ttlOptions.some((item) => item.value === expiresIn)) {
      setExpiresIn(type === 'file' ? defaultFileTtl : defaultPushTtl);
    }
  }, [defaultFileTtl, defaultPushTtl, expiresIn, ttlOptions, type]);

  const payloadSize = useMemo(() => {
    const payload = type === 'note'
      ? { ...(title.trim() ? { title: title.trim() } : {}), ...(body.trim() ? { body: body.trim() } : {}) }
      : type === 'link'
        ? { url: url.trim(), ...(title.trim() ? { title: title.trim() } : {}), ...(body.trim() ? { body: body.trim() } : {}) }
        : {
            ...(title.trim() ? { title: title.trim() } : {}),
            ...(body.trim() ? { body: body.trim() } : {}),
            file: {
              name: file?.name ?? '',
              mime_type: file?.type || 'application/octet-stream',
              size: file?.size ?? 0,
            },
          };
    return new TextEncoder().encode(JSON.stringify(payload)).byteLength;
  }, [body, file, title, type, url]);

  const chooseType = (next: PushType) => {
    if (next === 'file' && !fileUpload) {
      setError('接続先APIはファイルアップロードに対応していません。');
      return;
    }
    setType(next);
    setError('');
    setExpiresIn(next === 'file' ? defaultFileTtl : defaultPushTtl);
  };

  const acceptFile = (candidate?: File) => {
    if (!candidate) return;
    if (!fileUpload) {
      setError('接続先APIはファイルアップロードに対応していません。');
      return;
    }
    if (candidate.size > maxFileBytes) {
      setError(`ファイルサイズは${formatBytes(maxFileBytes)}以下にしてください。`);
      return;
    }
    setFile(candidate);
    setError('');
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragActive(false);
    acceptFile(event.dataTransfer.files[0]);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');

    if (type === 'note' && !title.trim() && !body.trim()) {
      setError('タイトルまたは本文を入力してください。');
      return;
    }
    if (type === 'link' && !validateHttpUrl(url.trim())) {
      setError('http:// または https:// で始まる有効なURLを入力してください。');
      return;
    }
    if (type === 'file' && !file) {
      setError('送信するファイルを選択してください。');
      return;
    }
    if (payloadSize > maxPushPayloadBytes) {
      setError(`Push Payloadは${formatBytes(maxPushPayloadBytes)}以下にしてください（現在 ${formatBytes(payloadSize)}）。`);
      return;
    }

    const target: PushTarget = targetValue === 'all_other'
      ? { kind: 'all_other_devices' }
      : targetValue === 'all_devices'
        ? { kind: 'all_devices' }
        : {
            kind: 'device',
            device_id: targetValue,
            device_name: snapshot.devices.find((device) => device.id === targetValue)?.name,
          };

    const draft: SendPushDraft = {
      type,
      target,
      title: title.trim() || undefined,
      body: body.trim() || undefined,
      url: type === 'link' ? url.trim() : undefined,
      expires_in: expiresIn,
    };

    setSubmitting(true);
    try {
      await runtime.enqueuePush(draft, type === 'file' ? file : undefined);
      setTitle('');
      setBody('');
      setUrl('');
      setFile(undefined);
      if (fileInput.current) fileInput.current.value = '';
      navigate('timeline');
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : '送信箱へ保存できませんでした。');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="page-stack compose-page">
      <PageHeader
        eyebrow="COMPOSE"
        title="新しいPush"
        description="送信操作は先にブラウザーへ保存され、ローカルAPIが利用可能になった時点で確実に処理されます。"
      />

      {runtime.settings.authMode === 'bearer' && !runtime.settings.bearerToken && (
        <div className="info-banner warning">
          <Icon name="cloud-off" size={19} />
          <div><strong>RelayMockの端末Tokenがありません。</strong><span>設定画面でBootstrapするまで送信項目は送信箱に保持されます。</span></div>
        </div>
      )}

      <form className="compose-card" onSubmit={(event) => void submit(event)}>
        <div className="form-section">
          <span className="form-section-label">種類</span>
          <div className="segmented compose-types">
            <button type="button" className={type === 'note' ? 'active' : ''} onClick={() => chooseType('note')}><Icon name="note" size={19} />ノート</button>
            <button type="button" className={type === 'link' ? 'active' : ''} onClick={() => chooseType('link')}><Icon name="link" size={19} />リンク</button>
            <button type="button" className={type === 'file' ? 'active' : ''} disabled={!fileUpload} title={fileUpload ? undefined : '接続先APIが非対応'} onClick={() => chooseType('file')}><Icon name="file" size={19} />ファイル</button>
          </div>
        </div>

        <div className="form-grid two-columns">
          <label className="field">
            <span>送信先</span>
            <select value={targetValue} onChange={(event) => setTargetValue(event.target.value)}>
              <option value="all_other">ほかの全端末</option>
              <option value="all_devices">すべての端末（送信元を含む）</option>
              {snapshot.devices.filter((device) => device.active && !device.is_current && device.id !== runtime.settings.currentDeviceId).map((device) => (
                <option key={device.id} value={device.id}>{device.name}（{device.kind}）</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>保存期限</span>
            <select value={expiresIn} onChange={(event) => setExpiresIn(Number(event.target.value))}>
              {ttlOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
        </div>

        <label className="field">
          <span>タイトル <small>任意</small></span>
          <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={500} placeholder={type === 'file' ? 'ファイルについてのメモ' : '短い見出し'} />
        </label>

        {type === 'link' && (
          <label className="field">
            <span>URL</span>
            <input type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/article" autoCapitalize="none" autoCorrect="off" />
          </label>
        )}

        {type === 'file' && (
          <div
            className={`drop-zone${dragActive ? ' is-active' : ''}${file ? ' has-file' : ''}`}
            onDragEnter={(event) => { event.preventDefault(); setDragActive(true); }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={() => setDragActive(false)}
            onDrop={onDrop}
          >
            <input ref={fileInput} id="file-input" type="file" onChange={(event) => acceptFile(event.target.files?.[0])} />
            <label htmlFor="file-input">
              <Icon name={file ? 'check' : 'arrow-up'} size={28} />
              {file ? (
                <><strong>{file.name}</strong><span>{formatBytes(file.size)}・{file.type || 'application/octet-stream'}</span></>
              ) : (
                <><strong>ファイルを選択またはドロップ</strong><span>最大 {formatBytes(maxFileBytes)}。期限後は取得できなくなります。</span></>
              )}
            </label>
          </div>
        )}

        <label className="field">
          <span>{type === 'note' ? '本文' : 'メモ'} <small>{type === 'note' ? 'タイトルとどちらか必須' : '任意'}</small></span>
          <textarea value={body} onChange={(event) => setBody(event.target.value)} rows={6} maxLength={100_000} placeholder={type === 'note' ? '別の端末へ送りたい内容を入力します。' : '補足情報を入力できます。'} />
          <small className="field-counter">{body.length.toLocaleString('ja-JP')} / 100,000・Payload {formatBytes(payloadSize)} / {formatBytes(maxPushPayloadBytes)}</small>
        </label>

        {error && <div className="form-error" role="alert">{error}</div>}

        <div className="compose-footer">
          <div className="source-device"><span>送信元</span><strong>{snapshot.currentDevice?.name || snapshot.devices.find((device) => device.id === runtime.settings.currentDeviceId)?.name || runtime.settings.currentDeviceId || '未接続'}</strong></div>
          <button className="button button-primary button-large" type="submit" disabled={submitting}>
            <Icon name="send" size={19} />{submitting ? '保存中…' : snapshot.connection === 'online' ? '送信する' : '送信箱へ保存'}
          </button>
        </div>
      </form>
    </div>
  );
}
