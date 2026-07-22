ALTER TABLE devices ADD COLUMN cursor_secret TEXT;

CREATE TABLE IF NOT EXISTS device_links (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_by_device_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  device_name TEXT NOT NULL,
  device_kind TEXT NOT NULL CHECK (device_kind IN ('web', 'pwa', 'extension')),
  public_key TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  consumed_device_id TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by_device_id) REFERENCES devices(id) ON DELETE CASCADE,
  FOREIGN KEY (consumed_device_id) REFERENCES devices(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_device_links_user_active
  ON device_links (user_id, expires_at, consumed_at);

UPDATE schema_meta SET value = '9' WHERE key = 'schema_version';

PRAGMA optimize;
