import type { Env, Runtime } from "./types";

export async function cleanupExpiredMetadata(env: Env, runtime: Runtime): Promise<void> {
  const now = runtime.now();
  const statements = [
    env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ? OR revoked_at IS NOT NULL").bind(now),
    env.DB.prepare("DELETE FROM bootstrap_rate_limits WHERE window_started_at < ?").bind(now - 24 * 60 * 60 * 1000),
    env.DB.prepare("UPDATE files SET state = 'expired' WHERE expires_at <= ? AND state = 'ready'").bind(now),
  ];
  for (const statement of statements) {
    try {
      await statement.run();
    } catch (error) {
      console.warn("cleanup statement failed", { error: error instanceof Error ? error.name : "unknown" });
    }
  }
}
