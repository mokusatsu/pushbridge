CREATE TABLE IF NOT EXISTS account_deletion_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'failed', 'manual_intervention', 'completed')),
  requested_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  retry_at INTEGER,
  cursor_file_id TEXT,
  r2_objects_found INTEGER NOT NULL DEFAULT 0,
  r2_objects_deleted INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_account_deletion_jobs_retry
  ON account_deletion_jobs (state, retry_at, requested_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_account_deletion_jobs_active_user
  ON account_deletion_jobs (user_id) WHERE state != 'completed';

UPDATE schema_meta SET value = '12' WHERE key = 'schema_version';

PRAGMA optimize;
