import type { AuthContext, Env } from "./types";

export async function storageUsage(env: Env, auth: AuthContext): Promise<Record<string, unknown>> {
  const row = await env.DB.prepare(`SELECT
    COALESCE(SUM(CASE WHEN state = 'ready' THEN encrypted_size ELSE 0 END), 0) AS used_bytes,
    COALESCE(SUM(CASE WHEN state = 'pending' THEN encrypted_size ELSE 0 END), 0) AS reserved_bytes
    FROM files WHERE user_id = ?`).bind(auth.user_id).first<{ used_bytes: number; reserved_bytes: number }>();
  const quota = 8 * 1024 * 1024 * 1024;
  const usedBytes = Number(row?.used_bytes ?? 0);
  const reservedBytes = Number(row?.reserved_bytes ?? 0);
  const ratio = (usedBytes + reservedBytes) / quota;
  return {
    used_bytes: usedBytes,
    reserved_bytes: reservedBytes,
    quota_bytes: quota,
    reclaimable_bytes: usedBytes,
    pressure: ratio >= .95 ? "emergency" : ratio >= .85 ? "constrained" : ratio >= .7 ? "notice" : "normal",
    policy_id: "free-v1",
    default_retention_days: 30,
    early_eviction_possible: true,
  };
}

// Phase 2 owns the File routes. Keeping this boundary explicit prevents File
// lifecycle code from returning to the central router.
export async function handleFileRoute(): Promise<Response | null> {
  return null;
}
