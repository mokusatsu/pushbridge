#!/usr/bin/env node

import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

const root = dirname(fileURLToPath(import.meta.url));
const source = join(root, 'dist');
const output = resolve(process.argv[2] ?? join(root, '..', '..', '.runtime', 'pushbridge-extension-0.1.0.zip'));
const epoch = new Date('1980-01-01T00:00:00.000Z');

async function files(directory) {
  const result = [];
  for (const name of (await readdir(directory)).sort()) {
    const path = join(directory, name);
    if ((await stat(path)).isDirectory()) result.push(...await files(path));
    else result.push(path);
  }
  return result;
}

const entries = {};
for (const path of await files(source)) {
  const name = relative(source, path).split(sep).join('/');
  entries[name] = [new Uint8Array(await readFile(path)), { mtime: epoch }];
}
const archive = zipSync(entries, { level: 9 });
await writeFile(output, archive);
console.log(output);
