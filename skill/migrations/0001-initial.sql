-- AgentState v0.1.0 — initial schema
-- Two tables: work_items (mutable) + events (append-only).
-- Per forge/design/agent-platform.md §"AgentState" and forge.md §"three primitives, one MVP".
--
-- Conventions:
--   - Timestamps: integer unix-epoch milliseconds (INTEGER NOT NULL).
--   - JSON columns store TEXT; the TS API does the marshaling.
--   - Foreign keys are enforced — callers MUST run `PRAGMA foreign_keys = ON;` per connection.
--   - The `events` table is append-only AT THE TS-API LAYER; SQL-level DELETE is technically possible
--     but never invoked from this bundle's scripts. If a future migration needs supersede semantics,
--     add a `superseded_by` column rather than mutating rows.

PRAGMA foreign_keys = ON;

-- work_items: mutable rows; agent labels its own kinds.
CREATE TABLE IF NOT EXISTS work_items (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  payload      TEXT NOT NULL,
  status       TEXT NOT NULL,
  owner_agent  TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  notes        TEXT,
  CHECK (status IN ('pending','in_flight','waiting_human','done','failed','cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_work_items_kind_status
  ON work_items(kind, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_work_items_owner
  ON work_items(owner_agent, updated_at DESC);

-- events: append-only timeline; never delete via the TS API.
CREATE TABLE IF NOT EXISTS events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            INTEGER NOT NULL,
  type          TEXT NOT NULL,
  actor         TEXT,
  work_item_id  TEXT,
  payload       TEXT NOT NULL,
  FOREIGN KEY (work_item_id) REFERENCES work_items(id)
);

CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts DESC);
CREATE INDEX IF NOT EXISTS idx_events_type_ts ON events(type, ts DESC);
CREATE INDEX IF NOT EXISTS idx_events_work_item ON events(work_item_id);

-- migrations bookkeeping — minimal, single column tracking applied versions.
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
