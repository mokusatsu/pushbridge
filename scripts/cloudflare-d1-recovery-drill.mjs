#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repositoryRoot = resolve(import.meta.dirname, '..');
const runtimeRoot = resolve(repositoryRoot, '.runtime');
mkdirSync(runtimeRoot, { recursive: true });
const drillRoot = mkdtempSync(join(runtimeRoot, 'd1-recovery-drill-'));
const wrangler = ['--yes', 'wrangler@4'];

function npxInvocation() {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath?.endsWith('npm-cli.js')) {
    return {
      command: process.execPath,
      prefix: [join(resolve(npmExecPath, '..'), '..', 'bin', 'npx-cli.js')],
    };
  }
  return {
    command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
    prefix: [],
  };
}

function run(args, { json = false } = {}) {
  const npx = npxInvocation();
  const result = spawnSync(npx.command, [...npx.prefix, ...wrangler, ...args], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    const detail = `${result.error?.message ?? ''}\n${result.stderr ?? ''}\n${result.stdout ?? ''}`
      .trim()
      .slice(-4_000);
    throw new Error(`Wrangler recovery drill command failed (${args[0]} ${args[1] ?? ''}).\n${detail}`);
  }
  if (!json) return result.stdout ?? '';
  try {
    return JSON.parse(result.stdout ?? '');
  } catch {
    throw new Error(`Wrangler did not return JSON for ${args[0]} ${args[1] ?? ''}.`);
  }
}

function createConfig(directory, name) {
  mkdirSync(directory, { recursive: true });
  cpSync(
    resolve(repositoryRoot, 'infra/cloudflare/worker/migrations'),
    join(directory, 'migrations'),
    { recursive: true },
  );
  const path = join(directory, 'wrangler.jsonc');
  writeFileSync(path, `${JSON.stringify({
    name,
    compatibility_date: '2026-07-22',
    d1_databases: [{
      binding: 'DB',
      database_name: name,
      database_id: '00000000-0000-0000-0000-000000000001',
      migrations_dir: 'migrations',
    }],
  }, null, 2)}\n`, 'utf8');
  return path;
}

const sourceDirectory = join(drillRoot, 'source');
const restoreDirectory = join(drillRoot, 'restore');
const sourceConfig = createConfig(sourceDirectory, 'pushbridge-recovery-source');
const restoreConfig = createConfig(restoreDirectory, 'pushbridge-recovery-restore');
const exportPath = join(drillRoot, 'pushbridge-d1-export.sql');
const fixturePath = join(drillRoot, 'fixture.sql');
const verificationPath = join(drillRoot, 'verify.sql');
const expectedCiphertext = 'synthetic-opaque-ciphertext';
let successSummary;

try {
  run(['d1', 'migrations', 'apply', 'DB', '--local', '--config', sourceConfig]);
  const publicKey = `p256.${'A'.repeat(87)}`;
  writeFileSync(fixturePath, `
    INSERT INTO users (id, handle, created_at, updated_at)
      VALUES ('usr_recovery', 'recovery_fixture', 1, 1);
    INSERT INTO devices (id, user_id, kind, name_ciphertext, public_key, created_at, updated_at)
      VALUES ('dev_recovery', 'usr_recovery', 'pwa', 'opaque-device', '${publicKey}', 1, 1);
    INSERT INTO pushes
      (id, user_id, source_device_id, target_device_id, type, payload_version, ciphertext, nonce,
       client_guid, created_at, modified_at, expires_at, target_kind, payload_json, status,
       key_version, encryption_salt)
      VALUES
      ('psh_recovery', 'usr_recovery', 'dev_recovery', NULL, 'note', 2,
       '${expectedCiphertext}', 'synthetic-nonce', 'recovery-guid', 1, 1, 9999999999999,
       'all_other_devices', NULL, 'active', 1, 'synthetic-salt');
  `, 'utf8');
  run([
    'd1', 'execute', 'DB', '--local', '--config', sourceConfig, '--yes', '--file', fixturePath,
  ]);
  run([
    'd1', 'export', 'DB', '--local', '--config', sourceConfig,
    '--output', exportPath, '--skip-confirmation',
  ]);
  const exportBytes = readFileSync(exportPath);
  if (exportBytes.byteLength === 0) throw new Error('D1 export was empty.');

  run(['d1', 'execute', 'DB', '--local', '--config', restoreConfig, '--file', exportPath, '--yes']);
  writeFileSync(verificationPath, `
    SELECT
      (SELECT value FROM schema_meta WHERE key = 'schema_version') AS schema_version,
      (SELECT COUNT(*) FROM users) AS users,
      (SELECT COUNT(*) FROM devices) AS devices,
      (SELECT COUNT(*) FROM pushes) AS pushes,
      (SELECT hex(ciphertext) FROM pushes WHERE id = 'psh_recovery') AS ciphertext_hex,
      (SELECT COUNT(*) FROM sqlite_master
        WHERE type = 'table' AND name = 'account_deletion_jobs') AS deletion_jobs_table;
  `, 'utf8');
  const query = run([
    'd1', 'execute', 'DB', '--local', '--config', restoreConfig, '--json', '--file',
    verificationPath,
  ], { json: true });
  const row = query?.[0]?.results?.[0];
  const expectedHex = Buffer.from(expectedCiphertext, 'utf8').toString('hex').toUpperCase();
  if (String(row?.schema_version) !== '12'
    || Number(row?.users) !== 1
    || Number(row?.devices) !== 1
    || Number(row?.pushes) !== 1
    || row?.ciphertext_hex !== expectedHex
    || Number(row?.deletion_jobs_table) !== 1) {
    throw new Error('Restored D1 data or schema did not match the source fixture.');
  }
  successSummary = [
    'Cloudflare local D1 recovery drill passed:',
    'schema_version=12',
    'users=1',
    'devices=1',
    'pushes=1',
    `export_sha256=${createHash('sha256').update(exportBytes).digest('hex')}`,
    'temporary_artifacts_removed=true',
  ].join(' ');
} finally {
  rmSync(drillRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

console.log(successSummary);
