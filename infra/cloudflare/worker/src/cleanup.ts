import { markUndeliveredMissed } from "./deliveries";
import { processAccountDeletionJobs } from "./account";
import type { Env, FileRow, Runtime } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;
const TOMBSTONE_TTL_MS = 7 * DAY_MS;
const TICKET_RECORD_TTL_MS = DAY_MS;
const DEFAULT_STORAGE_BUDGET_BYTES = 8 * 1024 * 1024 * 1024;
const DEFAULT_HIGH_WATERMARK_PERCENT = 95;
const DEFAULT_CLEANUP_TARGET_PERCENT = 85;
const MAX_DELETE_RETRY_MS = 60 * 60 * 1000;

export interface StoragePolicy {
  budgetBytes: number;
  highWatermarkPercent: number;
  cleanupTargetPercent: number;
  monthlyByteDayBudget: number | null;
}

export interface StorageTotals {
  usedBytes: number;
  reservedBytes: number;
  totalBytes: number;
}

export interface CleanupReport extends StorageTotals {
  effectiveBudgetBytes: number;
  expiredReservations: number;
  expiredFiles: number;
  pressureEvictedFiles: number;
  pressureEvictedBytes: number;
  deletedObjects: number;
  deleteFailures: number;
  expiredPushes: number;
  aliasTombstones: number;
  purgedTombstones: number;
  purgedFileAliases: number;
  errors: number;
  accountDeletionJobs: number;
}

interface UsageRow {
  used_bytes: number;
  reserved_bytes: number;
}

interface UsageHistoryRow {
  day: string;
  peak_bytes: number;
  kibibyte_seconds: number;
  last_sample_at: number;
  last_bytes: number;
}

function integerSetting(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

export function storagePolicy(env: Env): StoragePolicy {
  const monthly = Number(env.STORAGE_MONTHLY_BYTE_DAY_BUDGET);
  const highWatermarkPercent = integerSetting(env.STORAGE_PRESSURE_HIGH_PERCENT, DEFAULT_HIGH_WATERMARK_PERCENT, 1, 100);
  const requestedTarget = integerSetting(env.STORAGE_CLEANUP_TARGET_PERCENT, DEFAULT_CLEANUP_TARGET_PERCENT, 1, 100);
  return {
    budgetBytes: integerSetting(env.STORAGE_BUDGET_BYTES, DEFAULT_STORAGE_BUDGET_BYTES, 1, Number.MAX_SAFE_INTEGER),
    highWatermarkPercent,
    cleanupTargetPercent: Math.min(requestedTarget, Math.max(0, highWatermarkPercent - 1)),
    monthlyByteDayBudget: Number.isSafeInteger(monthly) && monthly > 0 ? monthly : null,
  };
}

export async function storageTotals(env: Env): Promise<StorageTotals> {
  const row = await env.DB.prepare(`SELECT
    COALESCE(SUM(CASE WHEN state IN ('ready', 'delete_pending') THEN COALESCE(actual_size, expected_size) ELSE 0 END), 0) AS used_bytes,
    COALESCE(SUM(CASE WHEN state IN ('pending', 'uploaded') THEN expected_size ELSE 0 END), 0) AS reserved_bytes
    FROM files`).first<UsageRow>();
  const usedBytes = Number(row?.used_bytes ?? 0);
  const reservedBytes = Number(row?.reserved_bytes ?? 0);
  return { usedBytes, reservedBytes, totalBytes: usedBytes + reservedBytes };
}

function utcDay(epoch: number): string {
  return new Date(epoch).toISOString().slice(0, 10);
}

function dayStart(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`);
}

async function recordUsageSample(env: Env, now: number, bytes: number): Promise<void> {
  const today = utcDay(now);
  const latest = await env.DB.prepare("SELECT * FROM storage_usage_daily ORDER BY day DESC LIMIT 1").first<UsageHistoryRow>();
  if (!latest) {
    await env.DB.prepare(`INSERT INTO storage_usage_daily
      (day, peak_bytes, kibibyte_seconds, last_sample_at, last_bytes, updated_at)
      VALUES (?, ?, 0, ?, ?, ?)`).bind(today, bytes, now, bytes, now).run();
    return;
  }

  const latestEnd = dayStart(latest.day) + DAY_MS;
  const elapsed = Math.max(0, Math.min(now, latestEnd) - Number(latest.last_sample_at));
  const elapsedSeconds = Math.floor(elapsed / 1000);
  const lastKibibytes = Math.ceil(Number(latest.last_bytes) / 1024);
  await env.DB.prepare(`UPDATE storage_usage_daily SET
    peak_bytes = MAX(peak_bytes, ?), kibibyte_seconds = kibibyte_seconds + ?,
    last_sample_at = ?, last_bytes = ?, updated_at = ? WHERE day = ?`)
    .bind(latest.day === today ? bytes : latest.last_bytes, elapsedSeconds * lastKibibytes,
      Math.min(now, latestEnd), latest.day === today ? bytes : latest.last_bytes, now, latest.day).run();

  if (latest.day !== today) {
    let cursor = latestEnd;
    let filled = 0;
    while (cursor + DAY_MS <= dayStart(today) && filled < 400) {
      const day = utcDay(cursor);
      await env.DB.prepare(`INSERT OR IGNORE INTO storage_usage_daily
        (day, peak_bytes, kibibyte_seconds, last_sample_at, last_bytes, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .bind(day, latest.last_bytes, Math.ceil(Number(latest.last_bytes) / 1024) * 86_400, cursor + DAY_MS, latest.last_bytes, now).run();
      cursor += DAY_MS;
      filled += 1;
    }
    await env.DB.prepare(`INSERT OR REPLACE INTO storage_usage_daily
      (day, peak_bytes, kibibyte_seconds, last_sample_at, last_bytes, updated_at)
      VALUES (?, ?, 0, ?, ?, ?)`).bind(today, bytes, now, bytes, now).run();
  }
}

async function effectiveBudget(env: Env, policy: StoragePolicy, now: number): Promise<number> {
  if (policy.monthlyByteDayBudget == null) return policy.budgetBytes;
  const month = new Date(now).toISOString().slice(0, 7);
  const consumed = await env.DB.prepare(`SELECT COALESCE(SUM(kibibyte_seconds), 0) AS value
    FROM storage_usage_daily WHERE day >= ? AND day < ?`)
    .bind(`${month}-01`, `${month}-32`).first<{ value: number }>();
  const current = new Date(now);
  const daysInMonth = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + 1, 0)).getUTCDate();
  const remainingDays = Math.max(1, daysInMonth - current.getUTCDate() + 1);
  const remainingByteDays = Math.max(0, policy.monthlyByteDayBudget - Number(consumed?.value ?? 0) * 1024 / 86_400);
  return Math.min(policy.budgetBytes, Math.floor(remainingByteDays / remainingDays));
}

function retryDelay(attempts: number): number {
  return Math.min(MAX_DELETE_RETRY_MS, 60_000 * 2 ** Math.min(6, Math.max(0, attempts)));
}

async function transitionExpiredFiles(env: Env, now: number): Promise<{ reservations: number; files: number }> {
  const reservations = await env.DB.prepare(`UPDATE files SET state = 'delete_pending', deleted_at = COALESCE(deleted_at, ?),
    delete_reason = 'retention_expired', r2_delete_retry_at = ?
    WHERE state = 'pending' AND upload_reservation_expires_at IS NOT NULL AND upload_reservation_expires_at <= ?`)
    .bind(now, now, now).run();
  const files = await env.DB.prepare(`UPDATE files SET state = 'delete_pending', deleted_at = COALESCE(deleted_at, ?),
    delete_reason = 'retention_expired', r2_delete_retry_at = ?
    WHERE state IN ('pending', 'uploaded', 'ready') AND expires_at <= ?`)
    .bind(now, now, now).run();
  return { reservations: Number(reservations.meta.changes), files: Number(files.meta.changes) };
}

async function transitionPressureCandidates(env: Env, reclaimBytes: number, now: number): Promise<{ files: number; bytes: number }> {
  if (reclaimBytes <= 0) return { files: 0, bytes: 0 };
  const candidates = await env.DB.prepare(`SELECT f.id, COALESCE(f.actual_size, f.expected_size) AS size,
    EXISTS(SELECT 1 FROM pushes p WHERE p.file_id = f.id AND p.pinned_at IS NOT NULL
      AND p.deleted_at IS NULL AND p.expired_at IS NULL) AS protected
    FROM files f WHERE f.state = 'ready'
    ORDER BY protected ASC, f.created_at ASC, size DESC, f.id ASC`).all<{ id: string; size: number; protected: number }>();
  let bytes = 0;
  let files = 0;
  for (const candidate of candidates.results) {
    if (bytes >= reclaimBytes) break;
    const result = await env.DB.prepare(`UPDATE files SET state = 'delete_pending', deleted_at = COALESCE(deleted_at, ?),
      delete_reason = 'storage_pressure', r2_delete_retry_at = ? WHERE id = ? AND state = 'ready'`)
      .bind(now, now, candidate.id).run();
    if (result.meta.changes === 1) {
      files += 1;
      bytes += Number(candidate.size);
    }
  }
  return { files, bytes };
}

async function processPendingDeletes(env: Env, runtime: Runtime, report: CleanupReport): Promise<void> {
  const now = runtime.now();
  const rows = await env.DB.prepare(`SELECT * FROM files WHERE state = 'delete_pending'
    AND (r2_delete_retry_at IS NULL OR r2_delete_retry_at <= ?) ORDER BY deleted_at, id LIMIT 100`).bind(now).all<FileRow>();
  for (const row of rows.results) {
    try {
      await env.FILES.delete(row.r2_key);
    } catch {
      report.deleteFailures += 1;
      try {
        await env.DB.prepare(`UPDATE files SET r2_delete_attempts = r2_delete_attempts + 1,
          r2_delete_retry_at = ?, r2_delete_error_code = 'r2_delete_failed' WHERE id = ? AND state = 'delete_pending'`)
          .bind(now + retryDelay(Number(row.r2_delete_attempts)), row.id).run();
      } catch { report.errors += 1; }
      continue;
    }

    try {
      const finalState = row.delete_reason === "retention_expired" && row.actual_size != null ? "expired" : "deleted";
      const results = await env.DB.batch([
        env.DB.prepare(`UPDATE files SET state = ?, original_name = 'expired-file.bin', content_type = 'application/octet-stream',
          expected_sha256 = NULL, actual_sha256 = NULL, upload_reservation_expires_at = NULL,
          r2_delete_retry_at = NULL, r2_delete_error_code = NULL WHERE id = ? AND state = 'delete_pending'`).bind(finalState, row.id),
        env.DB.prepare(`UPDATE pushes SET payload_json = NULL, ciphertext = '', nonce = '', modified_at = ?
          WHERE file_id = ?`).bind(now, row.id),
      ]);
      if (results[0].meta.changes === 1) {
        await markUndeliveredMissed(env, row.id, row.delete_reason ?? "retention_expired", runtime);
        report.deletedObjects += 1;
        if (row.delete_reason === "storage_pressure") {
          report.pressureEvictedFiles += 1;
          report.pressureEvictedBytes += Number(row.actual_size ?? row.expected_size);
        }
      }
    } catch {
      report.errors += 1;
      try {
        await env.DB.prepare(`UPDATE files SET r2_delete_attempts = r2_delete_attempts + 1,
          r2_delete_retry_at = ?, r2_delete_error_code = 'd1_finalize_failed' WHERE id = ? AND state = 'delete_pending'`)
          .bind(now + retryDelay(Number(row.r2_delete_attempts)), row.id).run();
      } catch { report.errors += 1; }
    }
  }
}

async function cleanupMetadata(env: Env, now: number, report: CleanupReport): Promise<void> {
  const statements = [
    env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ? OR revoked_at IS NOT NULL").bind(now),
    env.DB.prepare("DELETE FROM bootstrap_rate_limits WHERE window_started_at < ?").bind(now - DAY_MS),
    env.DB.prepare("DELETE FROM auth_challenges WHERE expires_at <= ? OR consumed_at IS NOT NULL").bind(now - DAY_MS),
    env.DB.prepare("DELETE FROM auth_rate_limits WHERE window_started_at < ?").bind(now - DAY_MS),
    env.DB.prepare("DELETE FROM device_links WHERE expires_at <= ? OR consumed_at IS NOT NULL").bind(now - DAY_MS),
    env.DB.prepare("DELETE FROM realtime_tickets WHERE expires_at <= ? OR consumed_at IS NOT NULL").bind(now - DAY_MS),
    env.DB.prepare("DELETE FROM file_tickets WHERE expires_at <= ?").bind(now - TICKET_RECORD_TTL_MS),
    env.DB.prepare("DELETE FROM storage_usage_daily WHERE day < ?").bind(utcDay(now - 400 * DAY_MS)),
  ];
  for (const statement of statements) {
    try { await statement.run(); } catch { report.errors += 1; }
  }

  try {
    const expired = await env.DB.prepare(`UPDATE pushes SET expired_at = ?, status = 'expired', modified_at = ?,
      payload_json = NULL, ciphertext = '', nonce = ''
      WHERE type != 'file' AND expires_at <= ? AND expired_at IS NULL AND deleted_at IS NULL AND pinned_at IS NULL`)
      .bind(now, now, now).run();
    report.expiredPushes = Number(expired.meta.changes);
  } catch { report.errors += 1; }

  try {
    const aliases = await env.DB.prepare(`UPDATE pushes SET deleted_at = ?, status = 'deleted', modified_at = ?,
      payload_json = NULL, ciphertext = '', nonce = ''
      WHERE type = 'file' AND deleted_at IS NULL AND file_id IN
        (SELECT id FROM files WHERE alias_expires_at <= ? AND state IN ('expired', 'deleted'))`)
      .bind(now, now, now).run();
    report.aliasTombstones = Number(aliases.meta.changes);
  } catch { report.errors += 1; }

  try {
    const tombstones = await env.DB.prepare("DELETE FROM pushes WHERE deleted_at IS NOT NULL AND deleted_at <= ?")
      .bind(now - TOMBSTONE_TTL_MS).run();
    report.purgedTombstones = Number(tombstones.meta.changes);
  } catch { report.errors += 1; }
  try {
    const aliases = await env.DB.prepare(`DELETE FROM files WHERE alias_expires_at <= ?
      AND state IN ('expired', 'deleted') AND NOT EXISTS (SELECT 1 FROM pushes WHERE pushes.file_id = files.id)`)
      .bind(now - TOMBSTONE_TTL_MS).run();
    report.purgedFileAliases = Number(aliases.meta.changes);
  } catch { report.errors += 1; }
}

export async function cleanupExpiredMetadata(env: Env, runtime: Runtime, requiredBytes = 0): Promise<CleanupReport> {
  const policy = storagePolicy(env);
  const initial = await storageTotals(env);
  const report: CleanupReport = {
    ...initial,
    effectiveBudgetBytes: policy.budgetBytes,
    expiredReservations: 0,
    expiredFiles: 0,
    pressureEvictedFiles: 0,
    pressureEvictedBytes: 0,
    deletedObjects: 0,
    deleteFailures: 0,
    expiredPushes: 0,
    aliasTombstones: 0,
    purgedTombstones: 0,
    purgedFileAliases: 0,
    errors: 0,
    accountDeletionJobs: 0,
  };
  const now = runtime.now();
  try {
    await recordUsageSample(env, now, initial.totalBytes);
    report.effectiveBudgetBytes = await effectiveBudget(env, policy, now);
  } catch { report.errors += 1; }

  try {
    const expired = await transitionExpiredFiles(env, now);
    report.expiredReservations = expired.reservations;
    report.expiredFiles = expired.files;
  } catch { report.errors += 1; }
  await processPendingDeletes(env, runtime, report);

  let current = await storageTotals(env);
  const highWatermark = Math.floor(report.effectiveBudgetBytes * policy.highWatermarkPercent / 100);
  const cleanupTarget = Math.floor(report.effectiveBudgetBytes * policy.cleanupTargetPercent / 100);
  if (current.totalBytes + Math.max(0, requiredBytes) > highWatermark) {
    try {
      await transitionPressureCandidates(
        env,
        current.totalBytes + Math.max(0, requiredBytes) - cleanupTarget,
        now,
      );
    } catch { report.errors += 1; }
    await processPendingDeletes(env, runtime, report);
    current = await storageTotals(env);
  }

  await cleanupMetadata(env, now, report);
  try {
    report.accountDeletionJobs = await processAccountDeletionJobs(env, runtime);
  } catch {
    report.errors += 1;
  }
  try { await recordUsageSample(env, now, current.totalBytes); } catch { report.errors += 1; }
  Object.assign(report, current);
  return report;
}
