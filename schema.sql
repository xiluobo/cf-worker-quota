-- Compatible with the original table. Existing usage is preserved.
CREATE TABLE IF NOT EXISTS traffic (
  uuid TEXT PRIMARY KEY,
  used_bytes INTEGER NOT NULL DEFAULT 0 CHECK (used_bytes >= 0),
  updated_at INTEGER
);
