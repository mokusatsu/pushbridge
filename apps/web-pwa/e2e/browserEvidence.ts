import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Page, Response } from '@playwright/test';

interface NetworkExchange {
  at: string;
  client: string;
  method: string;
  path: string;
  status: number;
}

interface IndexedDbSnapshot {
  database: string;
  push_count: number;
  cached_file_count: number;
  outbox_count: number;
  cursor_present: boolean;
}

interface EvidenceEntry {
  at: string;
  label: string;
  network: NetworkExchange[];
  indexedDb: IndexedDbSnapshot;
  screenshot: string;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character] ?? character);
}

function sanitizedPath(url: string): string {
  const path = new URL(url).pathname;
  return path
    .replace(/\/(fil|psh|dev|usr|sub|fdl)_[A-Za-z0-9_-]+/g, '/:id')
    .replace(/\/(files|devices|pushes|web-push-subscriptions)\/[^/]+/g, '/$1/:id');
}

async function indexedDbSnapshot(page: Page, namespace: string): Promise<IndexedDbSnapshot> {
  return page.evaluate(async (storageNamespace) => {
    const safe = storageNamespace.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
    const database = `pushbridge-${safe || 'default'}-v2`;
    const db = await new Promise<IDBDatabase>((resolveOpen, rejectOpen) => {
      const request = indexedDB.open(database);
      request.onsuccess = () => resolveOpen(request.result);
      request.onerror = () => rejectOpen(request.error);
    });
    const count = (storeName: string) => new Promise<number>((resolveCount, rejectCount) => {
      const request = db.transaction(storeName).objectStore(storeName).count();
      request.onsuccess = () => resolveCount(request.result);
      request.onerror = () => rejectCount(request.error);
    });
    const cursor = await new Promise<unknown>((resolveCursor, rejectCursor) => {
      const request = db.transaction('meta').objectStore('meta').get('cursor');
      request.onsuccess = () => resolveCursor(request.result);
      request.onerror = () => rejectCursor(request.error);
    });
    const [pushCount, cachedFileCount, outboxCount] = await Promise.all([
      count('pushes'), count('cachedFiles'), count('outbox'),
    ]);
    db.close();
    return {
      database,
      push_count: pushCount,
      cached_file_count: cachedFileCount,
      outbox_count: outboxCount,
      cursor_present: Boolean(cursor),
    };
  }, namespace);
}

export class BrowserEvidence {
  private readonly output = process.env.PUSHBRIDGE_EVIDENCE_OUTPUT;
  private readonly network: NetworkExchange[] = [];
  private readonly entries: EvidenceEntry[] = [];
  private consumedNetwork = 0;

  constructor(private readonly browserVersion: string) {}

  get enabled(): boolean {
    return Boolean(this.output);
  }

  observe(page: Page, client: string): void {
    if (!this.enabled) return;
    page.on('response', (response: Response) => {
      const path = new URL(response.url()).pathname;
      if (!path.startsWith('/api/')) return;
      this.network.push({
        at: new Date().toISOString(),
        client,
        method: response.request().method(),
        path: sanitizedPath(response.url()),
        status: response.status(),
      });
    });
  }

  async capture(page: Page, label: string, namespace: string): Promise<void> {
    if (!this.enabled) return;
    const screenshot = await page.screenshot({ type: 'jpeg', quality: 55, fullPage: true });
    this.entries.push({
      at: new Date().toISOString(),
      label,
      network: this.network.slice(this.consumedNetwork),
      indexedDb: await indexedDbSnapshot(page, namespace),
      screenshot: `data:image/jpeg;base64,${screenshot.toString('base64')}`,
    });
    this.consumedNetwork = this.network.length;
  }

  async write(): Promise<void> {
    if (!this.output || this.entries.length === 0) return;
    const outputPath = resolve(process.cwd(), this.output);
    const sections = this.entries.map((entry, index) => {
      const networkRows = entry.network.length > 0
        ? entry.network.map((exchange) => `<tr><td>${escapeHtml(exchange.at)}</td><td>${escapeHtml(exchange.client)}</td><td><code>${escapeHtml(exchange.method)} ${escapeHtml(exchange.path)}</code></td><td>${exchange.status}</td></tr>`).join('')
        : '<tr><td colspan="4">この区間に新しいAPI応答なし</td></tr>';
      return `<section>
        <h2>${index + 1}. ${escapeHtml(entry.label)}</h2>
        <p><time>${escapeHtml(entry.at)}</time></p>
        <div class="grid"><div><h3>APIリクエスト／レスポンス</h3><table><thead><tr><th>時刻</th><th>端末</th><th>リクエスト</th><th>HTTP</th></tr></thead><tbody>${networkRows}</tbody></table></div>
        <div><h3>IndexedDB状態</h3><pre>${escapeHtml(JSON.stringify(entry.indexedDb, null, 2))}</pre></div></div>
        <h3>実ブラウザースクリーンショット</h3><img src="${entry.screenshot}" alt="${escapeHtml(entry.label)}の実ブラウザースクリーンショット">
      </section>`;
    }).join('\n');
    const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Pushbridge Phase 5 browser evidence</title><style>
      :root{font-family:system-ui,sans-serif;color:#172033;background:#f5f7fb}body{max-width:1440px;margin:auto;padding:24px}header,section{background:#fff;border:1px solid #dce2ee;border-radius:14px;padding:20px;margin:0 0 20px;box-shadow:0 4px 18px #17203312}.grid{display:grid;grid-template-columns:2fr 1fr;gap:18px}table{border-collapse:collapse;width:100%;font-size:13px}th,td{border:1px solid #dce2ee;padding:7px;text-align:left}pre{background:#101827;color:#e7edf8;padding:12px;border-radius:8px;overflow:auto}img{width:100%;height:auto;border:1px solid #cfd7e6;border-radius:8px}code{word-break:break-all}@media(max-width:800px){.grid{grid-template-columns:1fr}body{padding:10px}}
    </style></head><body><header><h1>Pushbridge Phase 5 browser evidence</h1><p>Playwright Chromium ${escapeHtml(this.browserVersion)}で実行したローカル二端末E2Eの実測記録です。スクリーンショットは実撮影であり、ソースから再構成した画像ではありません。</p><p>認証ヘッダー、Bearer token、request/response body、Web Push endpoint、ファイルbytesは記録していません。APIはmethod・匿名化path・statusだけを示します。</p><p>生成日時: ${escapeHtml(new Date().toISOString())}</p></header>${sections}</body></html>`;
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, html, 'utf8');
  }
}
