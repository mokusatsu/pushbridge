ALTER TABLE storage_usage_daily RENAME COLUMN byte_milliseconds TO kibibyte_seconds;

UPDATE schema_meta SET value = '7' WHERE key = 'schema_version';
