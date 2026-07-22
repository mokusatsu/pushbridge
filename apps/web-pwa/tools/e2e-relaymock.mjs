import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const pythonCandidates = process.platform === 'win32'
  ? [join(repositoryRoot, '.runtime', 'venv', 'Scripts', 'python.exe')]
  : [join(repositoryRoot, '.runtime', 'venv', 'bin', 'python3'), join(repositoryRoot, '.runtime', 'venv', 'bin', 'python')];
const python = process.env.PYTHON_BIN || pythonCandidates.find(existsSync);
if (!python) {
  console.error('RelayMock用Pythonがありません。先にリポジトリのsetupを実行してください。');
  process.exit(1);
}

const runtimeDirectory = mkdtempSync(join(tmpdir(), 'pushbridge-playwright-'));
const child = spawn(python, [
  '-m', 'uvicorn', 'relaymock.main:app',
  '--app-dir', join(repositoryRoot, 'services', 'relaymock'),
  '--host', '127.0.0.1',
  '--port', '8765',
], {
  cwd: repositoryRoot,
  env: {
    ...process.env,
    RELAYMOCK_DATABASE_PATH: join(runtimeDirectory, 'relaymock.db'),
    RELAYMOCK_STORAGE_DIR: join(runtimeDirectory, 'objects'),
    RELAYMOCK_ENVIRONMENT_ID: 'playwright-local',
    RELAYMOCK_RECOMMENDED_POLL_INTERVAL_SECONDS: '5',
  },
  stdio: 'inherit',
});

let stopping = false;
function stop(signal = 'SIGTERM') {
  if (stopping) return;
  stopping = true;
  if (!child.killed) child.kill(signal);
}
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('exit', () => {
  rmSync(runtimeDirectory, { recursive: true, force: true });
});
child.on('exit', (code, signal) => {
  rmSync(runtimeDirectory, { recursive: true, force: true });
  process.exitCode = signal ? 0 : code ?? 1;
});
