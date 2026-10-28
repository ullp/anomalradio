-- ════════════════════════════════════════════════════════════════════════════════
--  Anomalradio · 001_init — the production schema
--
--  Design notes
--   · `tracks.storage_key` is the private id → file mapping. It never leaves the server:
--     `sanitizeTrack()` strips it (and `source_path` / `original_name`) from every response.
--   · `published = 0` means draft: nothing unpublished is ever listed or streamed.
--   · `content_hash` lets the importer recognise a file it has already stored, so moving or
--     renaming music on disk does not create duplicates and does not change public ids.
--   · Booleans are integers (SQLite has no boolean type); the API layer converts.
-- ════════════════════════════════════════════════════════════════════════════════

CREATE TABLE tracks (
  id             TEXT PRIMARY KEY,           -- opaque public id: ar_XXXXXXXXXX
  storage_key    TEXT NOT NULL,              -- PRIVATE: tracks/<id>.mp3 (or bucket key)
  stream_key     TEXT,                       -- optional loudness-normalised master for the radio
  title          TEXT NOT NULL,
  artist         TEXT NOT NULL,
  album          TEXT,
  album_artist   TEXT,
  year           INTEGER,
  genre          TEXT,
  composer       TEXT,
  bpm            INTEGER,
  musical_key    TEXT,
  track_number   INTEGER,
  disc           INTEGER,
  duration_ms    INTEGER NOT NULL,
  bitrate        INTEGER,
  sample_rate    INTEGER,
  channels       INTEGER,
  size_bytes     INTEGER NOT NULL,
  content_hash   TEXT,
  cover_key      TEXT,
  price_cents    INTEGER NOT NULL DEFAULT 199,
  currency       TEXT NOT NULL DEFAULT 'EUR',
  buy_url        TEXT,
  isrc           TEXT,
  license        TEXT,
  tags           TEXT NOT NULL DEFAULT '[]',
  published      INTEGER NOT NULL DEFAULT 0,
  featured       INTEGER NOT NULL DEFAULT 0,
  weight         INTEGER NOT NULL DEFAULT 1,   -- rotation weighting for the scheduler (M3)
  plays          INTEGER NOT NULL DEFAULT 0,
  stars          INTEGER NOT NULL DEFAULT 0,
  source_path    TEXT,                       -- PRIVATE: relative path in the import folder
  original_name  TEXT,                       -- PRIVATE: the file's own name
  added_at       TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE UNIQUE INDEX tracks_content_hash ON tracks (content_hash) WHERE content_hash IS NOT NULL;
CREATE INDEX tracks_published ON tracks (published, album, disc, track_number);
CREATE INDEX tracks_source_path ON tracks (source_path);

-- ── what has been on air (drives "recently played" and the charts) ──
CREATE TABLE play_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id   TEXT NOT NULL REFERENCES tracks (id) ON DELETE CASCADE,
  started_at TEXT NOT NULL,
  listeners  INTEGER
);
CREATE INDEX play_history_started ON play_history (started_at DESC);

-- ── ★ favourites: anonymous owner key now, claimed by an account later (M4) ──
CREATE TABLE favourites (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_key  TEXT NOT NULL,
  track_id   TEXT NOT NULL REFERENCES tracks (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  UNIQUE (owner_key, track_id)
);
CREATE INDEX favourites_owner ON favourites (owner_key, created_at DESC);

-- ── 🛒 basket ──
CREATE TABLE cart_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_key  TEXT NOT NULL,
  track_id   TEXT NOT NULL REFERENCES tracks (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  UNIQUE (owner_key, track_id)
);
CREATE INDEX cart_owner ON cart_items (owner_key, created_at DESC);

-- ── issued stream tokens: revocation, usage counting and a ripper signal ──
-- The token itself is a stateless HMAC; this table is what makes it revocable and measurable.
-- A token may be used for several HTTP requests (seeking issues many range requests), so `uses`
-- is counted and capped rather than the nonce being consumed on first use.
CREATE TABLE stream_tokens (
  nonce      TEXT PRIMARY KEY,
  track_id   TEXT,
  ip_hash    TEXT NOT NULL,
  ua_hash    TEXT NOT NULL,
  issued_at  TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  uses       INTEGER NOT NULL DEFAULT 0,
  revoked    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX stream_tokens_expires ON stream_tokens (expires_at);

-- ── shop (M5): created now so the data model is reviewable in one place ──
CREATE TABLE orders (
  id            TEXT PRIMARY KEY,
  email         TEXT,
  provider      TEXT NOT NULL,             -- stripe | paypal | manual
  provider_ref  TEXT,
  amount_cents  INTEGER NOT NULL,
  currency      TEXT NOT NULL,
  status        TEXT NOT NULL,             -- pending | paid | refunded
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE order_items (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id            TEXT NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  track_id            TEXT NOT NULL REFERENCES tracks (id),
  price_cents         INTEGER NOT NULL,
  download_token      TEXT,
  download_expires_at TEXT,
  downloads_used      INTEGER NOT NULL DEFAULT 0,
  max_downloads       INTEGER NOT NULL DEFAULT 3,
  UNIQUE (order_id, track_id)
);

-- ── who changed what in the admin (M6) ──
CREATE TABLE admin_audit (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  target TEXT,
  ip     TEXT,
  at     TEXT NOT NULL
);
