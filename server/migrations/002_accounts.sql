-- ════════════════════════════════════════════════════════════════════════════
--  Anomalradio · 002_accounts — M4: magic-link accounts, share counters, previews
--
--  Design notes
--   · No passwords anywhere. A sign-in is a single-use, short-lived link token, and
--     only its SHA-256 is stored — so a leaked database does not hand over accounts,
--     and there is nothing to phish or reuse.
--   · `favourites.owner_key` / `cart_items.owner_key` already hold either
--     `own_<random>` (anonymous, from the cookie) or `usr_<id>` (an account).
--     Signing in *claims* the anonymous rows by rewriting that one column, which is
--     why the M2 schema needed no change for this — and why nobody loses a star
--     they saved before signing up.
--   · `tracks.shares` is the counter the UI shows; `share_events` keeps the channel
--     breakdown, so "which button actually gets used" is answerable later.
--   · `tracks.preview_key` points at a short, low-bitrate excerpt in private storage.
--     Like `storage_key` it is a private field and is stripped from every response.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE users (
  id           TEXT PRIMARY KEY,             -- usr_XXXXXXXX
  email        TEXT NOT NULL UNIQUE,         -- lower-cased and trimmed on the way in
  created_at   TEXT NOT NULL,
  last_seen_at TEXT
);

-- ── one row per sign-in attempt; the link is the credential, so it is hashed ──
CREATE TABLE magic_links (
  token_hash TEXT PRIMARY KEY,               -- sha256(token) — the token itself is never stored
  email      TEXT NOT NULL,
  owner_key  TEXT,                           -- the anonymous key to claim on success
  ip_hash    TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at    TEXT
);
CREATE INDEX magic_links_email ON magic_links (email, created_at DESC);
CREATE INDEX magic_links_expires ON magic_links (expires_at);

-- ── a signed-in browser holds one of these in an HttpOnly cookie ──
CREATE TABLE sessions (
  token_hash   TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  last_seen_at TEXT
);
CREATE INDEX sessions_user ON sessions (user_id);
CREATE INDEX sessions_expires ON sessions (expires_at);

-- ── ⇪ share events: the counter is on `tracks`, this is the detail ──
CREATE TABLE share_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id   TEXT NOT NULL REFERENCES tracks (id) ON DELETE CASCADE,
  channel    TEXT NOT NULL,                  -- x | facebook | whatsapp | … | copy | native
  created_at TEXT NOT NULL
);
CREATE INDEX share_events_track ON share_events (track_id, created_at DESC);

ALTER TABLE tracks ADD COLUMN shares INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tracks ADD COLUMN preview_key TEXT;
