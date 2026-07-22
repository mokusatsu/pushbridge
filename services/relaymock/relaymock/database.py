from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator


SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    handle TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    public_key TEXT,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id, revoked_at);

CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_device ON sessions(device_id);

CREATE TABLE IF NOT EXISTS pushes (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source_device_id TEXT NOT NULL REFERENCES devices(id),
    target_kind TEXT NOT NULL,
    target_device_id TEXT REFERENCES devices(id),
    type TEXT NOT NULL,
    file_id TEXT REFERENCES files(id),
    payload_version INTEGER NOT NULL DEFAULT 1,
    payload_json TEXT,
    ciphertext TEXT,
    nonce TEXT,
    client_guid TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    pinned INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    modified_at TEXT NOT NULL,
    expires_at TEXT,
    expired_at TEXT,
    dismissed_at TEXT,
    deleted_at TEXT,
    UNIQUE(user_id, client_guid)
);
CREATE INDEX IF NOT EXISTS idx_pushes_sync ON pushes(user_id, modified_at, id);
CREATE INDEX IF NOT EXISTS idx_pushes_expiry ON pushes(expires_at, expired_at, pinned);
CREATE INDEX IF NOT EXISTS idx_pushes_deleted ON pushes(deleted_at);

CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    object_key TEXT NOT NULL UNIQUE,
    original_name TEXT NOT NULL,
    content_type TEXT NOT NULL,
    expected_size INTEGER NOT NULL,
    actual_size INTEGER,
    expected_sha256 TEXT,
    actual_sha256 TEXT,
    state TEXT NOT NULL,
    created_at TEXT NOT NULL,
    completed_at TEXT,
    expires_at TEXT NOT NULL,
    deleted_at TEXT,
    delete_reason TEXT,
    alias_expires_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_files_user ON files(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_files_expiry ON files(expires_at, state);

CREATE TABLE IF NOT EXISTS tickets (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    purpose TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tickets_expiry ON tickets(expires_at);

CREATE TABLE IF NOT EXISTS web_push_subscriptions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    storage_namespace TEXT,
    local_cache_max_bytes INTEGER,
    created_at TEXT NOT NULL,
    revoked_at TEXT,
    UNIQUE(device_id, endpoint)
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_device
    ON web_push_subscriptions(device_id, revoked_at);

CREATE TABLE IF NOT EXISTS file_deliveries (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    push_id TEXT NOT NULL REFERENCES pushes(id) ON DELETE CASCADE,
    file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    destination_device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    state TEXT NOT NULL,
    ack_token_hash TEXT UNIQUE,
    ack_token_expires_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    notified_at TEXT,
    fetching_at TEXT,
    cached_at TEXT,
    failed_at TEXT,
    missed_at TEXT,
    failure_code TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    UNIQUE(file_id, destination_device_id)
);
CREATE INDEX IF NOT EXISTS idx_file_deliveries_push
    ON file_deliveries(push_id, state);
CREATE INDEX IF NOT EXISTS idx_file_deliveries_device
    ON file_deliveries(destination_device_id, state);
"""


class Database:
    def __init__(self, path: Path) -> None:
        self.path = Path(path)

    def initialize(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connection() as conn:
            conn.executescript(SCHEMA)
            columns = {row["name"] for row in conn.execute("PRAGMA table_info(files)")}
            if "delete_reason" not in columns:
                conn.execute("ALTER TABLE files ADD COLUMN delete_reason TEXT")
            if "alias_expires_at" not in columns:
                conn.execute("ALTER TABLE files ADD COLUMN alias_expires_at TEXT")
            subscription_columns = {
                row["name"] for row in conn.execute("PRAGMA table_info(web_push_subscriptions)")
            }
            if "storage_namespace" not in subscription_columns:
                conn.execute("ALTER TABLE web_push_subscriptions ADD COLUMN storage_namespace TEXT")
            if "local_cache_max_bytes" not in subscription_columns:
                conn.execute("ALTER TABLE web_push_subscriptions ADD COLUMN local_cache_max_bytes INTEGER")
            conn.commit()

    @contextmanager
    def connection(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(
            str(self.path),
            timeout=5.0,
            check_same_thread=False,
        )
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA busy_timeout = 5000")
        # WAL gives a nicer local development experience when browser polling overlaps writes.
        conn.execute("PRAGMA journal_mode = WAL")
        try:
            yield conn
        finally:
            conn.close()

    def reset(self) -> None:
        with self.connection() as conn:
            conn.executescript(
                """
                DELETE FROM web_push_subscriptions;
                DELETE FROM file_deliveries;
                DELETE FROM tickets;
                DELETE FROM pushes;
                DELETE FROM files;
                DELETE FROM sessions;
                DELETE FROM devices;
                DELETE FROM users;
                """
            )
            conn.commit()
