ALTER TABLE pushes ADD COLUMN target_kind TEXT NOT NULL DEFAULT 'all_other_devices';
ALTER TABLE pushes ADD COLUMN payload_json TEXT;
ALTER TABLE pushes ADD COLUMN file_id TEXT;
ALTER TABLE pushes ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE pushes ADD COLUMN expired_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_pushes_user_client_guid
  ON pushes (user_id, client_guid);

INSERT OR REPLACE INTO schema_meta (key, value)
VALUES ('schema_version', '2');
