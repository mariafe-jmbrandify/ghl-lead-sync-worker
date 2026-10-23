-- One row per GoHighLevel contact. Repeat webhooks for the same contact
-- update the row instead of creating a duplicate.
CREATE TABLE IF NOT EXISTS leads (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id   TEXT NOT NULL UNIQUE,
  first_name   TEXT,
  last_name    TEXT,
  email        TEXT,
  phone        TEXT,
  source       TEXT,
  tags         TEXT,
  location_id  TEXT,
  raw_json     TEXT NOT NULL,
  received_at  TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  synced_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_leads_unsynced ON leads (synced_at, received_at);

-- One row per scheduled (or manual) sync attempt, for the admin dashboard.
CREATE TABLE IF NOT EXISTS sync_runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger      TEXT NOT NULL,          -- 'cron' or 'manual'
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  rows_synced  INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL,          -- 'running' | 'success' | 'noop' | 'error'
  error        TEXT
);
