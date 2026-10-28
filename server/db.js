/**
 * Database access.
 *
 * SQLite through Node's built-in `node:sqlite` — no native build, no dependency. The module is
 * still marked experimental upstream, so the whole database hides behind this file: swapping to
 * `better-sqlite3` would touch only what is below.
 *
 * Rows are plain objects; booleans are stored as 0/1 and converted here (`rowToTrack`).
 * Timestamps are ISO-8601 UTC strings so the database stays readable.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { config } from './config.js';

const MIGRATIONS_DIR = path.join(import.meta.dirname, 'migrations');

let db = null;
let openPath = null;

/**
 * Open and migrate the database. Safe to call from anywhere.
 * Requesting a *different* path closes the current handle first: silently ignoring the requested
 * path (which is what a naive "already open" cache does) makes multi-database use — tests, the
 * importer, tooling — operate on the wrong file.
 */
export function openDatabase(file = config.dbPath) {
  const target = path.resolve(file);
  if (db && openPath === target) return db;
  if (db) {
    db.close();
    db = null;
    openPath = null;
  }

  mkdirSync(path.dirname(target), { recursive: true });
  db = new DatabaseSync(target);
  openPath = target;

  // WAL keeps readers (the API) from blocking on the writer (the importer).
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA synchronous = NORMAL;');

  migrate(db);
  return db;
}

export const getDatabase = () => db ?? openDatabase();

export function closeDatabase() {
  if (!db) return;
  db.close();
  db = null;
  openPath = null;
}

/** Apply every migration that has not run yet, in filename order, each in its own transaction. */
export function migrate(database = getDatabase()) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set(
    database
      .prepare('SELECT version FROM schema_migrations')
      .all()
      .map((row) => row.version),
  );

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  const record = database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)');
  const ran = [];

  for (const file of files) {
    const version = path.basename(file, '.sql');
    if (applied.has(version)) continue;

    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    database.exec('BEGIN');
    try {
      database.exec(sql);
      record.run(version, new Date().toISOString());
      database.exec('COMMIT');
      ran.push(version);
    } catch (error) {
      database.exec('ROLLBACK');
      throw new Error(`migration ${version} failed: ${error.message}`);
    }
  }

  return ran;
}

/* ─────────────────────────── tiny query helpers ─────────────────────────── */

/** Single row or undefined. */
export const one = (sql, ...params) =>
  getDatabase()
    .prepare(sql)
    .get(...params);

/** All rows. */
export const all = (sql, ...params) =>
  getDatabase()
    .prepare(sql)
    .all(...params);

/** Write statement → `{ changes, lastInsertRowid }`. */
export const run = (sql, ...params) =>
  getDatabase()
    .prepare(sql)
    .run(...params);

/** Run a function inside a transaction, rolling back on error. */
export function transaction(fn) {
  const database = getDatabase();
  database.exec('BEGIN');
  try {
    const result = fn(database);
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export const isOpen = () => db !== null;

process.on('exit', () => {
  try {
    closeDatabase();
  } catch {
    /* already closed */
  }
});

/* ─────────────────────────── row mapping ─────────────────────────── */

/**
 * Database row → the object the rest of the app works with.
 * Internal fields (storage_key, source_path, original_name) stay on the object so the server can
 * use them; `sanitizeTrack()` is what keeps them out of responses.
 */
export function rowToTrack(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    artist: row.artist,
    album: row.album,
    albumArtist: row.album_artist,
    year: row.year,
    genre: row.genre,
    composer: row.composer,
    bpm: row.bpm,
    musicalKey: row.musical_key,
    trackNumber: row.track_number,
    disc: row.disc,
    durationMs: row.duration_ms,
    bitrate: row.bitrate,
    sampleRate: row.sample_rate,
    channels: row.channels,
    sizeBytes: row.size_bytes,
    contentHash: row.content_hash,
    coverKey: row.cover_key,
    priceCents: row.price_cents,
    currency: row.currency,
    buyUrl: row.buy_url,
    isrc: row.isrc,
    license: row.license,
    tags: safeJson(row.tags),
    published: Boolean(row.published),
    featured: Boolean(row.featured),
    weight: row.weight,
    plays: row.plays,
    stars: row.stars,
    addedAt: row.added_at,
    updatedAt: row.updated_at,
    // ── server-side only: stripped by sanitizeTrack() ──
    storageKey: row.storage_key,
    streamKey: row.stream_key,
    sourcePath: row.source_path,
    originalName: row.original_name,
  };
}

function safeJson(value) {
  try {
    const parsed = JSON.parse(value ?? '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Track object → database row.
 * Keeping this in one place means the column list cannot drift from the schema: the INSERT is
 * generated from these keys, and a test round-trips every column through the database.
 */
function toRow(track, existing) {
  const now = new Date().toISOString();
  return {
    id: track.id,
    storage_key: track.storageKey,
    stream_key: track.streamKey ?? null,
    title: track.title,
    artist: track.artist,
    album: track.album ?? null,
    album_artist: track.albumArtist ?? null,
    year: track.year ?? null,
    genre: track.genre ?? null,
    composer: track.composer ?? null,
    bpm: track.bpm ?? null,
    musical_key: track.musicalKey ?? null,
    track_number: track.trackNumber ?? null,
    disc: track.disc ?? null,
    duration_ms: track.durationMs,
    bitrate: track.bitrate ?? null,
    sample_rate: track.sampleRate ?? null,
    channels: track.channels ?? null,
    size_bytes: track.sizeBytes,
    content_hash: track.contentHash ?? null,
    cover_key: track.coverKey ?? null,
    price_cents: track.priceCents ?? 199,
    currency: track.currency ?? 'EUR',
    buy_url: track.buyUrl ?? null,
    isrc: track.isrc ?? null,
    license: track.license ?? null,
    tags: JSON.stringify(track.tags ?? []),
    published: track.published ? 1 : 0,
    featured: track.featured ? 1 : 0,
    weight: track.weight ?? 1,
    source_path: track.sourcePath ?? null,
    original_name: track.originalName ?? null,
    added_at: existing?.added_at ?? now,
    updated_at: now,
  };
}

/** Insert a new track or update an existing one, preserving `added_at`. */
export function upsertTrack(track) {
  const existing = one('SELECT added_at FROM tracks WHERE id = ?', track.id);
  const row = toRow(track, existing);
  const columns = Object.keys(row);
  const placeholders = columns.map(() => '?').join(', ');
  const updates = columns
    .filter((column) => column !== 'id' && column !== 'added_at')
    .map((column) => `${column} = excluded.${column}`)
    .join(', ');

  run(
    `INSERT INTO tracks (${columns.join(', ')}) VALUES (${placeholders})
     ON CONFLICT (id) DO UPDATE SET ${updates}`,
    ...Object.values(row),
  );

  return rowToTrack(one('SELECT * FROM tracks WHERE id = ?', track.id));
}
