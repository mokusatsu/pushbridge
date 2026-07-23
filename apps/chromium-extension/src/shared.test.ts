import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  draftFromContextMenu,
  encryptPushPayload,
  payloadForDraft,
  targetFromValue,
} from './shared';

describe('Chromium extension security boundary', () => {
  it('uses only the minimal declared permissions and no all-URL access', async () => {
    const manifest = JSON.parse(await readFile('apps/chromium-extension/manifest.json', 'utf8'));
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.permissions).toEqual(['activeTab', 'alarms', 'contextMenus', 'notifications', 'storage']);
    expect(JSON.stringify(manifest)).not.toContain('<all_urls>');
    expect(manifest.content_scripts).toBeUndefined();
    expect(manifest.background.type).toBe('module');
  });

  it('maps page, link, selection and image context menus without content scripts', () => {
    expect(draftFromContextMenu({ menuItemId: 'pushbridge-page', pageUrl: 'https://example.test' }, { title: 'Page', url: 'https://example.test' }))
      .toEqual({ type: 'link', title: 'Page', url: 'https://example.test' });
    expect(draftFromContextMenu({ menuItemId: 'pushbridge-link', linkUrl: 'https://example.test/link' }, { title: 'Page' }))
      .toEqual({ type: 'link', title: 'Page', url: 'https://example.test/link' });
    expect(draftFromContextMenu({ menuItemId: 'pushbridge-selection', selectionText: 'selected' }, { title: 'Page' }))
      .toEqual({ type: 'note', title: 'Page', body: 'selected' });
    expect(draftFromContextMenu({ menuItemId: 'pushbridge-image', srcUrl: 'https://example.test/image.png' }, { title: 'Image' }))
      .toEqual({ type: 'link', title: 'Image', url: 'https://example.test/image.png' });
  });

  it('validates drafts and targets before encryption', () => {
    expect(payloadForDraft({ type: 'note', body: 'value' })).toEqual({ body: 'value' });
    expect(payloadForDraft({ type: 'link', url: 'https://example.test' })).toEqual({ url: 'https://example.test' });
    expect(() => payloadForDraft({ type: 'link', url: 'javascript:alert(1)' })).toThrow(/HTTP/u);
    expect(targetFromValue('all_other_devices')).toEqual({ kind: 'all_other_devices' });
    expect(targetFromValue('dev_2')).toEqual({ kind: 'device', device_id: 'dev_2' });
  });

  it('creates payload_version 2 material without plaintext in the envelope', async () => {
    let offset = 0;
    const random = (length: number) => Uint8Array.from({ length }, () => (offset++ % 251) + 1);
    const envelope = await encryptPushPayload(new Uint8Array(32).fill(7), 1, 'note', 'guid_fixture', {
      title: 'private title',
      body: 'private body',
    }, random);
    expect(envelope.key_version).toBe(1);
    expect(JSON.stringify(envelope)).not.toContain('private title');
    expect(JSON.stringify(envelope)).not.toContain('private body');
  });
});
