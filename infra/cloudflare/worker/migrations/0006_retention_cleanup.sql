CREATE TABLE storage_usage_daily (
  day TEXT PRIMARY KEY,
  peak_bytes INTEGER NOT NULL DEFAULT 0 CHECK (peak_bytes >= 0),
  byte_milliseconds INTEGER NOT NULL DEFAULT 0 CHECK (byte_milliseconds >= 0),
  last_sample_at INTEGER NOT NULL,
  last_bytes INTEGER NOT NULL DEFAULT 0 CHECK (last_bytes >= 0),
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_files_alias_purge ON files (alias_expires_at, state);
CREATE INDEX idx_pushes_tombstone_purge ON pushes (deleted_at, type);

UPDATE schema_meta SET value = '6' WHERE key = 'schema_version';
