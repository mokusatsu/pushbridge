CREATE TABLE IF NOT EXISTS account_key_versions (
  user_id TEXT NOT NULL,
  key_version INTEGER NOT NULL,
  algorithm TEXT NOT NULL,
  recovery_envelope BLOB NOT NULL,
  created_by_device_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, key_version),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by_device_id) REFERENCES devices(id)
);

ALTER TABLE pushes ADD COLUMN key_version INTEGER;
ALTER TABLE pushes ADD COLUMN encryption_salt TEXT;
ALTER TABLE files ADD COLUMN e2ee INTEGER NOT NULL DEFAULT 0;
ALTER TABLE auth_challenges ADD COLUMN device_public_key TEXT;

CREATE INDEX IF NOT EXISTS idx_device_key_envelopes_user_version
  ON device_key_envelopes (user_id, key_version, device_id);

UPDATE schema_meta SET value = '10' WHERE key = 'schema_version';

PRAGMA optimize;
