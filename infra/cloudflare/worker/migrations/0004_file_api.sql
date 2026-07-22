CREATE TABLE files_v4 (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  original_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  expected_size INTEGER NOT NULL CHECK (expected_size >= 0),
  actual_size INTEGER CHECK (actual_size IS NULL OR actual_size >= 0),
  expected_sha256 TEXT,
  actual_sha256 TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending', 'uploaded', 'ready', 'delete_pending', 'expired', 'deleted')),
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  expires_at INTEGER NOT NULL,
  deleted_at INTEGER,
  delete_reason TEXT CHECK (delete_reason IS NULL OR delete_reason IN ('retention_expired', 'storage_pressure', 'user_deleted')),
  alias_expires_at INTEGER NOT NULL,
  upload_reservation_expires_at INTEGER,
  r2_delete_attempts INTEGER NOT NULL DEFAULT 0,
  r2_delete_retry_at INTEGER,
  r2_delete_error_code TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

INSERT INTO files_v4 (
  id, user_id, r2_key, original_name, content_type,
  expected_size, actual_size, expected_sha256, actual_sha256,
  state, created_at, completed_at, expires_at, deleted_at,
  delete_reason, alias_expires_at, upload_reservation_expires_at,
  r2_delete_attempts, r2_delete_retry_at, r2_delete_error_code
)
SELECT
  id, user_id, r2_key, 'encrypted-file.bin', 'application/octet-stream',
  encrypted_size,
  CASE WHEN state IN ('ready', 'expired', 'deleted') THEN encrypted_size ELSE NULL END,
  CASE WHEN ciphertext_sha256 IS NULL THEN NULL ELSE lower(hex(ciphertext_sha256)) END,
  CASE WHEN ciphertext_sha256 IS NULL THEN NULL ELSE lower(hex(ciphertext_sha256)) END,
  state, created_at, completed_at, expires_at, deleted_at,
  CASE WHEN state IN ('expired', 'deleted') THEN 'retention_expired' ELSE NULL END,
  expires_at + 12960000000, NULL, 0, NULL, NULL
FROM files;

DROP TABLE files;
ALTER TABLE files_v4 RENAME TO files;

CREATE INDEX idx_files_user_expiry ON files (user_id, expires_at);
CREATE INDEX idx_files_state_expiry ON files (state, expires_at);
CREATE INDEX idx_files_reservation_expiry ON files (state, upload_reservation_expires_at);
CREATE INDEX idx_files_delete_retry ON files (state, r2_delete_retry_at);

CREATE TABLE file_tickets (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('upload', 'download')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
);

CREATE INDEX idx_file_tickets_file ON file_tickets (file_id, purpose);
CREATE INDEX idx_file_tickets_expiry ON file_tickets (expires_at);

INSERT OR REPLACE INTO schema_meta (key, value)
VALUES ('schema_version', '4');
