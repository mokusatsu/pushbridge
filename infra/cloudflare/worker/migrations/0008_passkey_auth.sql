ALTER TABLE sessions ADD COLUMN session_kind TEXT NOT NULL DEFAULT 'bearer'
  CHECK (session_kind IN ('bearer', 'browser'));
ALTER TABLE sessions ADD COLUMN session_id TEXT;
ALTER TABLE sessions ADD COLUMN csrf_token_hash TEXT;
ALTER TABLE sessions ADD COLUMN last_seen_at INTEGER;
ALTER TABLE sessions ADD COLUMN idle_expires_at INTEGER;
ALTER TABLE sessions ADD COLUMN absolute_expires_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_sessions_user_active
  ON sessions (user_id, revoked_at, expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_public_id
  ON sessions (session_id) WHERE session_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS passkey_credentials (
  credential_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports_json TEXT NOT NULL DEFAULT '[]',
  device_type TEXT NOT NULL,
  backed_up INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_passkey_credentials_user_active
  ON passkey_credentials (user_id, revoked_at);

CREATE TABLE IF NOT EXISTS auth_challenges (
  id TEXT PRIMARY KEY,
  ceremony TEXT NOT NULL CHECK (ceremony IN ('registration', 'authentication')),
  challenge TEXT NOT NULL,
  user_id TEXT,
  pending_user_id TEXT,
  handle TEXT,
  device_name TEXT,
  device_kind TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_auth_challenges_expiry
  ON auth_challenges (expires_at, consumed_at);

CREATE TABLE IF NOT EXISTS auth_rate_limits (
  source_hash TEXT NOT NULL,
  action TEXT NOT NULL,
  window_started_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (source_hash, action, window_started_at)
);

CREATE INDEX IF NOT EXISTS idx_auth_rate_limits_window
  ON auth_rate_limits (window_started_at);

UPDATE schema_meta SET value = '8' WHERE key = 'schema_version';

PRAGMA optimize;
