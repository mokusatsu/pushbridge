CREATE TABLE IF NOT EXISTS bootstrap_rate_limits (
  source_hash TEXT NOT NULL,
  window_started_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (source_hash, window_started_at)
);

CREATE INDEX IF NOT EXISTS idx_bootstrap_rate_limits_window
  ON bootstrap_rate_limits (window_started_at);

INSERT OR REPLACE INTO schema_meta (key, value)
VALUES ('schema_version', '3');
