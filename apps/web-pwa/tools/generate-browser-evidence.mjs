import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const playwrightCli = resolve(projectRoot, 'node_modules', '@playwright', 'test', 'cli.js');
const result = spawnSync(process.execPath, [
  playwrightCli,
  'test',
  '--project=desktop',
  '--grep',
  'two devices preserve',
  '--reporter=line',
], {
  cwd: projectRoot,
  env: {
    ...process.env,
    PUSHBRIDGE_PLAYWRIGHT_CHANNEL: 'bundled',
    PUSHBRIDGE_EVIDENCE_OUTPUT: 'evidence/phase5-browser-evidence.html',
  },
  stdio: 'inherit',
  shell: false,
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
