import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const reportPath = resolve(projectRoot, 'evidence', 'phase5-browser-evidence.html');
const report = await readFile(reportPath, 'utf8');

function count(pattern) {
  return [...report.matchAll(pattern)].length;
}

const screenshots = count(/data:image\/jpeg;base64,/g);
const sections = count(/<section>/g);
const indexedDbSnapshots = count(/push_count/g);
const apiRows = count(/<tr><td>\d{4}-\d{2}-\d{2}T/g);

if (screenshots !== 5 || sections !== 5 || indexedDbSnapshots !== 5 || apiRows < 5) {
  throw new Error(`browser evidence is incomplete: screenshots=${screenshots}, sections=${sections}, indexedDb=${indexedDbSnapshots}, apiRows=${apiRows}`);
}

for (const [label, pattern] of [
  ['Authorization header', /authorization\s*:/i],
  ['access token field', /access_token/i],
  ['Web Push endpoint', /https:\/\/[^<\s]+\/(?:wpush|send)\//i],
  ['fixture bytes', /cached-file-bytes|missed-file-bytes/i],
]) {
  if (pattern.test(report)) throw new Error(`browser evidence contains forbidden ${label}`);
}

console.log(`Browser evidence verified: ${screenshots} screenshots, ${apiRows} sanitized API rows, ${indexedDbSnapshots} IndexedDB snapshots.`);
