CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO schema_meta (key, value)
VALUES ('schema_version', '1');

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  handle TEXT NOT NULL UNIQUE,
  display_name_ciphertext BLOB,
  quota_tier TEXT NOT NULL DEFAULT 'free',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('web', 'pwa', 'extension')),
  name_ciphertext BLOB,
  public_key BLOB NOT NULL,
  last_read_cursor TEXT,
  last_seen_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  revoked_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_devices_user_active
  ON devices (user_id, revoked_at);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash BLOB PRIMARY KEY,
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  rotated_at INTEGER,
  revoked_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_expiry
  ON sessions (expires_at, revoked_at);

CREATE TABLE IF NOT EXISTS pushes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  source_device_id TEXT NOT NULL,
  target_device_id TEXT,
  type TEXT NOT NULL CHECK (type IN ('note', 'link', 'file')),
  payload_version INTEGER NOT NULL DEFAULT 1,
  ciphertext BLOB NOT NULL,
  nonce BLOB NOT NULL,
  client_guid TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  modified_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  dismissed_at INTEGER,
  deleted_at INTEGER,
  pinned_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (source_device_id) REFERENCES devices(id),
  FOREIGN KEY (target_device_id) REFERENCES devices(id),
  UNIQUE (user_id, client_guid)
);

CREATE INDEX IF NOT EXISTS idx_pushes_user_cursor
  ON pushes (user_id, modified_at, id);

CREATE INDEX IF NOT EXISTS idx_pushes_expiry
  ON pushes (expires_at);

CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  encrypted_size INTEGER NOT NULL CHECK (encrypted_size >= 0),
  ciphertext_sha256 BLOB,
  state TEXT NOT NULL CHECK (state IN ('pending', 'ready', 'expired', 'deleted')),
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  expires_at INTEGER NOT NULL,
  deleted_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_files_user_expiry
  ON files (user_id, expires_at);

CREATE INDEX IF NOT EXISTS idx_files_state_expiry
  ON files (state, expires_at);

CREATE TABLE IF NOT EXISTS web_push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  endpoint_ciphertext BLOB NOT NULL,
  p256dh_ciphertext BLOB NOT NULL,
  auth_ciphertext BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  revoked_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_web_push_device_active
  ON web_push_subscriptions (device_id, revoked_at);

CREATE TABLE IF NOT EXISTS device_key_envelopes (
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  key_version INTEGER NOT NULL,
  algorithm TEXT NOT NULL,
  wrapped_key BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (device_id, key_version),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS quota_daily (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,
  push_count INTEGER NOT NULL DEFAULT 0,
  upload_bytes INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, day),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS api_tokens (
  token_hash BLOB PRIMARY KEY,
  user_id TEXT NOT NULL,
  name_ciphertext BLOB,
  scopes TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  last_used_at INTEGER,
  revoked_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_api_tokens_user_active
  ON api_tokens (user_id, revoked_at);

PRAGMA optimize;
