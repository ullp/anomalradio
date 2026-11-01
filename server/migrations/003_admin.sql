-- ── admin sessions (M6) ──
-- Rows, not a signed cookie: a control panel has to be able to log out, and to cut off every
-- session at once. Only the SHA-256 of the cookie value is stored, so the database is not a
-- credential store. Same shape as `sessions`, which is what makes that reasoning reusable.
CREATE TABLE admin_sessions (
  token_hash   TEXT PRIMARY KEY,
  created_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  ip           TEXT
);

CREATE INDEX admin_sessions_expires ON admin_sessions (expires_at);
