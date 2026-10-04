-- SnapIQ v0: one account, its phones, and the documents they send.
--
-- Everything a second user would need - row-level security, per-tenant keys,
-- quotas - is absent on purpose (docs/api.md section 9). The tables are kept
-- narrow and dull so that moving them to Postgres later is a translation
-- rather than a redesign, and every query lives in src/db.js so there is one
-- place to change.

CREATE TABLE IF NOT EXISTS accounts (
  id          TEXT PRIMARY KEY,
  created_at  TEXT NOT NULL
);

-- A paired phone. The key itself is never stored, only its hash, so the table
-- is worthless to anyone who reads it.
CREATE TABLE IF NOT EXISTS devices (
  id           TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL REFERENCES accounts(id),
  key_hash     TEXT NOT NULL UNIQUE,
  label        TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  expires_at   TEXT NOT NULL,
  revoked_at   TEXT
);
CREATE INDEX IF NOT EXISTS devices_by_account ON devices (account_id, created_at DESC);

-- A QR waiting to be scanned. Single use: claimed_at is what makes a
-- photographed QR worthless afterwards.
CREATE TABLE IF NOT EXISTS pairings (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts(id),
  claim_hash  TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  claimed_at  TEXT
);

-- A computer waiting for a scan.
CREATE TABLE IF NOT EXISTS channels (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts(id),
  label       TEXT,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  closed_at   TEXT
);
CREATE INDEX IF NOT EXISTS channels_live ON channels (account_id, expires_at DESC);

CREATE TABLE IF NOT EXISTS scans (
  id           TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL REFERENCES accounts(id),
  device_id    TEXT REFERENCES devices(id),
  channel_id   TEXT REFERENCES channels(id),
  state        TEXT NOT NULL DEFAULT 'open',   -- open | closed
  created_at   TEXT NOT NULL,
  closed_at    TEXT,
  last_page_at TEXT
);
CREATE INDEX IF NOT EXISTS scans_by_account ON scans (account_id, created_at DESC);
-- Used to decide whether a page shared a moment later joins the open scan.
CREATE INDEX IF NOT EXISTS scans_open_by_device ON scans (device_id, state, last_page_at DESC);

CREATE TABLE IF NOT EXISTS pages (
  id           TEXT PRIMARY KEY,
  scan_id      TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  idx          INTEGER NOT NULL,
  variant      TEXT NOT NULL DEFAULT 'clean',  -- clean | original
  object_key   TEXT NOT NULL,
  content_type TEXT NOT NULL,
  bytes        INTEGER NOT NULL,
  sha256       TEXT NOT NULL,
  width        INTEGER,
  height       INTEGER,
  created_at   TEXT NOT NULL,
  committed_at TEXT                            -- NULL until the bytes arrived and matched
);
CREATE INDEX IF NOT EXISTS pages_by_scan ON pages (scan_id, idx);

-- Makes every write safe to retry on a phone that lost signal mid-request:
-- the same key returns the same answer instead of a second page.
CREATE TABLE IF NOT EXISTS idempotency (
  actor      TEXT NOT NULL,
  key        TEXT NOT NULL,
  response   TEXT NOT NULL,
  status     INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (actor, key)
);

INSERT OR IGNORE INTO accounts (id, created_at) VALUES ('owner', datetime('now'));
