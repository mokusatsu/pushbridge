#!/usr/bin/env node

import { build } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const output = join(root, 'dist');
const apiOrigin = process.env.PUSHBRIDGE_EXTENSION_API_ORIGIN ?? 'https://pushbridge-dev.mokusatsu.workers.dev';
const parsedApiOrigin = new URL(apiOrigin);
if (!['http:', 'https:'].includes(parsedApiOrigin.protocol) || parsedApiOrigin.origin !== apiOrigin.replace(/\/+$/u, '')) {
  throw new Error('PUSHBRIDGE_EXTENSION_API_ORIGIN must be an HTTP(S) origin without a path.');
}

await rm(output, { recursive: true, force: true });
await mkdir(join(output, 'icons'), { recursive: true });

await build({
  entryPoints: {
    background: join(root, 'src/background.ts'),
    popup: join(root, 'src/popup.ts'),
    options: join(root, 'src/options.ts'),
  },
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'chrome116',
  outdir: output,
  define: {
    __PUSHBRIDGE_EXTENSION_API_ORIGIN__: JSON.stringify(apiOrigin.replace(/\/+$/u, '')),
  },
  legalComments: 'none',
  sourcemap: false,
});

for (const name of ['popup.html', 'options.html', 'extension.css']) {
  await cp(join(root, name), join(output, name));
}
await cp(join(root, '..', 'web-pwa', 'public', 'icons', 'icon-192.png'), join(output, 'icons', 'icon-128.png'));

const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
manifest.host_permissions = [`${parsedApiOrigin.origin}/*`];
manifest.content_security_policy.extension_pages =
  `script-src 'self'; object-src 'self'; connect-src ${parsedApiOrigin.origin}`;
if (JSON.stringify(manifest).includes('<all_urls>')) throw new Error('Extension package must not request <all_urls>.');
await writeFile(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(output);
