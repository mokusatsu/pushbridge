ALTER TABLE web_push_subscriptions ADD COLUMN endpoint_hash TEXT;
ALTER TABLE web_push_subscriptions ADD COLUMN endpoint_nonce TEXT;
ALTER TABLE web_push_subscriptions ADD COLUMN p256dh_nonce TEXT;
ALTER TABLE web_push_subscriptions ADD COLUMN auth_nonce TEXT;
ALTER TABLE web_push_subscriptions ADD COLUMN storage_namespace TEXT;
ALTER TABLE web_push_subscriptions ADD COLUMN local_cache_max_bytes INTEGER;
ALTER TABLE web_push_subscriptions ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE web_push_subscriptions ADD COLUMN last_failure_code TEXT;
ALTER TABLE web_push_subscriptions ADD COLUMN last_success_at INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS idx_web_push_device_endpoint
  ON web_push_subscriptions (device_id, endpoint_hash);

CREATE TABLE file_deliveries (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  push_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  destination_device_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'notified', 'fetching', 'cached', 'failed_retryable', 'missed')),
  ack_token_hash TEXT,
  ack_token_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  notified_at INTEGER,
  fetching_at INTEGER,
  cached_at INTEGER,
  failed_at INTEGER,
  missed_at INTEGER,
  failure_code TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (push_id) REFERENCES pushes(id) ON DELETE CASCADE,
  FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE,
  FOREIGN KEY (destination_device_id) REFERENCES devices(id) ON DELETE CASCADE,
  UNIQUE (file_id, destination_device_id)
);

CREATE INDEX idx_file_deliveries_push ON file_deliveries (push_id, state);
CREATE INDEX idx_file_deliveries_device ON file_deliveries (destination_device_id, state);
CREATE UNIQUE INDEX idx_file_deliveries_ack_token ON file_deliveries (ack_token_hash)
  WHERE ack_token_hash IS NOT NULL;

UPDATE schema_meta SET value = '5' WHERE key = 'schema_version';
