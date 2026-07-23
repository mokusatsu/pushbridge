import { bodyJson, json, problem } from "./response";
import { iso } from "./runtime";
import type { AuthContext, Env, Runtime } from "./types";

const MAX_RETRY_MS = 60 * 60 * 1000;
const MAX_ATTEMPTS = 20;
const DELETE_BATCH_SIZE = 100;

interface DeletionJob {
  id: string;
  user_id: string;
  state: "pending" | "failed" | "manual_intervention" | "completed";
  requested_at: number;
  updated_at: number;
  attempts: number;
  retry_at: number | null;
  cursor_file_id: string | null;
  r2_objects_found: number;
  r2_objects_deleted: number;
  last_error_code: string | null;
  completed_at: number | null;
}

function retryDelay(attempts: number): number {
  return Math.min(MAX_RETRY_MS, 60_000 * 2 ** Math.min(6, Math.max(0, attempts)));
}

function deletionOut(job: DeletionJob): Record<string, unknown> {
  return {
    id: job.id,
    state: job.state,
    requested_at: iso(job.requested_at),
    completed_at: iso(job.completed_at),
  };
}

async function disconnectRealtime(env: Env, userId: string): Promise<void> {
  try {
    const stub = env.USER_HUB.get(env.USER_HUB.idFromName(userId));
    await stub.fetch("https://user-hub.internal/disconnect", {
      method: "POST",
      headers: { "x-pushbridge-user-id": userId },
    });
  } catch {
    // Authentication has already been revoked in D1. Stale sockets also fail
    // their next heartbeat/message even if this best-effort close fails.
  }
}

async function failJob(env: Env, job: DeletionJob, now: number, code: string): Promise<void> {
  const attempts = Number(job.attempts) + 1;
  const state = attempts >= MAX_ATTEMPTS ? "manual_intervention" : "failed";
  const retryAt = attempts >= MAX_ATTEMPTS ? null : now + retryDelay(attempts);
  await env.DB.prepare(`UPDATE account_deletion_jobs SET state = ?, attempts = ?,
    retry_at = ?, updated_at = ?, last_error_code = ? WHERE id = ? AND state != 'completed'`)
    .bind(state, attempts, retryAt, now, code, job.id).run();
}

async function finalizeAccount(env: Env, job: DeletionJob, now: number): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM realtime_tickets WHERE user_id = ?").bind(job.user_id),
    env.DB.prepare("DELETE FROM device_links WHERE user_id = ?").bind(job.user_id),
    env.DB.prepare("DELETE FROM file_tickets WHERE user_id = ?").bind(job.user_id),
    env.DB.prepare("DELETE FROM file_deliveries WHERE user_id = ?").bind(job.user_id),
    env.DB.prepare("DELETE FROM web_push_subscriptions WHERE user_id = ?").bind(job.user_id),
    env.DB.prepare("DELETE FROM device_key_envelopes WHERE user_id = ?").bind(job.user_id),
    env.DB.prepare("DELETE FROM account_key_versions WHERE user_id = ?").bind(job.user_id),
    env.DB.prepare("DELETE FROM passkey_credentials WHERE user_id = ?").bind(job.user_id),
    env.DB.prepare("DELETE FROM auth_challenges WHERE user_id = ? OR pending_user_id = ?").bind(job.user_id, job.user_id),
    env.DB.prepare("DELETE FROM pushes WHERE user_id = ?").bind(job.user_id),
    env.DB.prepare("DELETE FROM files WHERE user_id = ?").bind(job.user_id),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(job.user_id),
    env.DB.prepare("DELETE FROM quota_daily WHERE user_id = ?").bind(job.user_id),
    env.DB.prepare("DELETE FROM api_tokens WHERE user_id = ?").bind(job.user_id),
    env.DB.prepare("DELETE FROM devices WHERE user_id = ?").bind(job.user_id),
    env.DB.prepare("DELETE FROM users WHERE id = ? AND deleted_at IS NOT NULL").bind(job.user_id),
    env.DB.prepare(`UPDATE account_deletion_jobs SET state = 'completed', updated_at = ?,
      retry_at = NULL, last_error_code = NULL, completed_at = ? WHERE id = ?`)
      .bind(now, now, job.id),
  ]);
}

async function processJob(env: Env, job: DeletionJob, runtime: Runtime): Promise<void> {
  const now = runtime.now();
  const total = await env.DB.prepare("SELECT COUNT(*) AS count FROM files WHERE user_id = ?")
    .bind(job.user_id).first<{ count: number }>();
  const files = await env.DB.prepare(`SELECT id, r2_key FROM files WHERE user_id = ?
    AND (? IS NULL OR id > ?) ORDER BY id LIMIT ?`)
    .bind(job.user_id, job.cursor_file_id, job.cursor_file_id, DELETE_BATCH_SIZE)
    .all<{ id: string; r2_key: string }>();
  let deleted = 0;
  let cursor = job.cursor_file_id;
  for (const file of files.results) {
    try {
      await env.FILES.delete(file.r2_key);
      deleted += 1;
      cursor = file.id;
    } catch {
      await env.DB.prepare(`UPDATE account_deletion_jobs SET r2_objects_found = ?,
        r2_objects_deleted = r2_objects_deleted + ?, cursor_file_id = ?, updated_at = ? WHERE id = ?`)
        .bind(Number(total?.count ?? 0), deleted, cursor, now, job.id).run();
      await failJob(env, job, now, "r2_delete_failed");
      return;
    }
  }
  const remaining = cursor == null ? null : await env.DB.prepare(`SELECT id FROM files
    WHERE user_id = ? AND id > ? ORDER BY id LIMIT 1`).bind(job.user_id, cursor).first<{ id: string }>();
  await env.DB.prepare(`UPDATE account_deletion_jobs SET r2_objects_found = ?,
    r2_objects_deleted = r2_objects_deleted + ?, cursor_file_id = ?, updated_at = ?,
    state = 'pending', retry_at = NULL, last_error_code = NULL WHERE id = ?`)
    .bind(Number(total?.count ?? 0), deleted, cursor, now, job.id).run();
  if (remaining) return;
  try {
    await finalizeAccount(env, job, now);
  } catch {
    await failJob(env, job, now, "d1_finalize_failed");
  }
}

export async function processAccountDeletionJobs(
  env: Env,
  runtime: Runtime,
  onlyUserId?: string,
): Promise<number> {
  const now = runtime.now();
  const jobs = await env.DB.prepare(`SELECT * FROM account_deletion_jobs
    WHERE state IN ('pending', 'failed') AND (retry_at IS NULL OR retry_at <= ?)
      AND (? IS NULL OR user_id = ?)
    ORDER BY requested_at, id LIMIT 20`)
    .bind(now, onlyUserId ?? null, onlyUserId ?? null).all<DeletionJob>();
  for (const job of jobs.results) await processJob(env, job, runtime);
  return jobs.results.length;
}

export async function requestAccountDeletion(
  request: Request,
  env: Env,
  auth: AuthContext,
  requestId: string,
  runtime: Runtime,
): Promise<Response> {
  const body = await bodyJson(request, requestId);
  if (body.confirmation !== "DELETE") {
    return problem(422, "account_deletion_confirmation_required", "Set confirmation to DELETE to remove this account.", requestId);
  }
  const existing = await env.DB.prepare(`SELECT * FROM account_deletion_jobs
    WHERE user_id = ? AND state != 'completed' ORDER BY requested_at DESC LIMIT 1`)
    .bind(auth.user_id).first<DeletionJob>();
  if (existing) return json({ deletion: deletionOut(existing) }, { status: 202, headers: { "x-request-id": requestId } });

  const now = runtime.now();
  const jobId = runtime.id("del");
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL")
      .bind(now, now, auth.user_id),
    env.DB.prepare("UPDATE sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE user_id = ?").bind(now, auth.user_id),
    env.DB.prepare("UPDATE api_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE user_id = ?").bind(now, auth.user_id),
    env.DB.prepare("UPDATE devices SET revoked_at = COALESCE(revoked_at, ?), updated_at = ? WHERE user_id = ?")
      .bind(now, now, auth.user_id),
    env.DB.prepare("UPDATE web_push_subscriptions SET revoked_at = COALESCE(revoked_at, ?), updated_at = ? WHERE user_id = ?")
      .bind(now, now, auth.user_id),
    env.DB.prepare(`INSERT INTO account_deletion_jobs
      (id, user_id, state, requested_at, updated_at) VALUES (?, ?, 'pending', ?, ?)`)
      .bind(jobId, auth.user_id, now, now),
  ]);
  await disconnectRealtime(env, auth.user_id);
  await processAccountDeletionJobs(env, runtime, auth.user_id);
  const job = await env.DB.prepare("SELECT * FROM account_deletion_jobs WHERE id = ?").bind(jobId).first<DeletionJob>();
  return json({ deletion: deletionOut(job!) }, { status: 202, headers: { "x-request-id": requestId } });
}
