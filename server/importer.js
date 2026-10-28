/**
 * Library import pipeline.
 *
 * Exported as a function so it can be driven programmatically (the test harness imports the fixture
 * library this way) and from the CLI (`npm run import`).
 *
 * Per file:
 *   1. hash it (SHA-256) and probe it with ffprobe
 *   2. work out its id — an existing database row wins, so ids survive moves and renames
 *   3. copy the audio into private storage (`tracks/<id>.mp3`, or a private bucket)
 *   4. upsert the database row, keeping publication state, price and cover that were already set
 *   5. optionally write a loudness-normalised master for the radio (`normalise`)
 *   6. write the human-readable metadata export (`data/tracks.json`)
 *
 * Publication rules, deliberately conservative so a new file cannot go live by accident:
 *   · an existing database row keeps its own published/featured flags
 *   · otherwise the previous JSON export is honoured — this is how the original catalogue stays live
 *   · otherwise the track is a draft unless `publish` is set
 *   · `publishExisting` is the explicit escape hatch for "publish everything that is currently a
 *     draft" (needed after a first import without `--publish`; the admin does this per track in M6)
 */

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config, storageKeys } from './config.js';
import { closeDatabase, one, openDatabase, upsertTrack } from './db.js';
import { sanitizeTrack } from './library.js';
import { createStorage, hashFile } from './storage/index.js';
import { normaliseToLufs, probe } from './ffprobe.js';

const AUDIO_EXT = new Set(['.mp3', '.m4a', '.flac', '.wav', '.aac', '.ogg', '.opus']);
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function base62(buffer, length) {
  let out = '';
  for (const byte of buffer) {
    out += ALPHABET[byte % 62];
    if (out.length === length) break;
  }
  return out;
}

/**
 * Id for a file we have never seen before.
 * Derived from path + size so the original catalogue keeps the ids it was published with; from then
 * on the database is the authority and the id survives moves and renames.
 */
export function deriveId(relPath, sizeBytes) {
  return `ar_${base62(createHash('sha256').update(`${relPath}|${sizeBytes}`).digest(), 10)}`;
}

/** Every audio file under `dir`, in deterministic order. */
export async function listAudioFiles(dir) {
  const found = [];
  const walk = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && AUDIO_EXT.has(path.extname(entry.name).toLowerCase())) found.push(full);
    }
  };
  await walk(dir);
  return found.sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

const num = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
};

export const mmss = (ms) => {
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

/** The previous JSON export, keyed by id — the bridge from the prototype catalogue to the database. */
export async function readPreviousExport(file) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    return new Map((parsed.tracks ?? []).map((track) => [track.id, track]));
  } catch {
    return new Map();
  }
}

/* ─────────────────────────── the pipeline ─────────────────────────── */

/**
 * Import everything under `source`.
 * @param {object} options
 * @param {string}  [options.source]       import folder
 * @param {string}  [options.out]          JSON export path
 * @param {string}  [options.db]           database path
 * @param {boolean} [options.publish]      publish tracks with no previous state
 * @param {boolean} [options.normalise]    also write a loudness-normalised stream master
 * @param {boolean} [options.metadataOnly] probe + export only (no storage copy, no database writes)
 * @param {boolean} [options.dryRun]       write nothing at all
 * @param {(line: string) => void} [options.log]
 */
export async function importLibrary(options = {}) {
  const source = options.source ?? config.librarySource;
  const out = options.out ?? config.libraryExport;
  const dbPath = options.db ?? config.dbPath;
  const log = options.log ?? (() => {});

  const files = await listAudioFiles(source);
  if (files.length === 0) throw new Error(`no audio files under ${source}`);

  const previous = await readPreviousExport(out);
  const writes = !options.metadataOnly && !options.dryRun;
  const storage = writes ? createStorage() : null;
  if (writes) openDatabase(dbPath);

  log(`source   ${source} (${files.length} file(s))`);
  log(`storage  ${writes ? JSON.stringify(storage.describe()) : 'skipped (metadata only)'}`);
  log(`database ${writes ? dbPath : 'skipped'}`);

  const tracks = [];
  let stored = 0;
  let unchanged = 0;

  for (const file of files) {
    const relPath = path.relative(source, file).split(path.sep).join('/');
    const info = await stat(file);
    const metadata = await probe(file);

    const derivedId = deriveId(relPath, info.size);
    const previousRow = previous.get(derivedId);

    if (!writes) {
      tracks.push({
        ...metadataFields(metadata, info, relPath),
        id: derivedId,
        coverKey: previousRow?.coverKey ?? null,
        priceCents: previousRow?.priceCents ?? 199,
        currency: previousRow?.currency ?? 'EUR',
        buyUrl: previousRow?.buyUrl ?? null,
        published: previousRow?.published ?? Boolean(options.publish),
        featured: previousRow?.featured ?? false,
        plays: 0,
        stars: 0,
        addedAt: previousRow?.addedAt ?? new Date().toISOString(),
        sourceFile: relPath,
      });
      continue;
    }

    const contentHash = await hashFile(file);
    // Find the row this audio belongs to: by content first (the same audio under a new name keeps
    // its id), then by the id derived from its path. Whatever we find *is* the track we update —
    // looking the row up by a different id than the one we write would corrupt an existing track.
    const byContent = one('SELECT * FROM tracks WHERE content_hash = ?', contentHash);
    const existing = byContent ?? one('SELECT * FROM tracks WHERE id = ?', derivedId);
    const id = existing?.id ?? derivedId;

    const storageKey = storageKeys.track(id);
    if (await storage.exists(storageKey)) {
      unchanged += 1;
    } else {
      await storage.put(storageKey, file);
      stored += 1;
    }

    let streamKey = null;
    if (options.normalise) {
      const { mkdtemp } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const scratch = await mkdtemp(path.join(tmpdir(), 'anomalradio-normalise-'));
      const normalised = path.join(scratch, 'normalised.mp3');
      await normaliseToLufs(file, normalised);
      streamKey = storageKeys.streamMaster(id);
      await storage.put(streamKey, normalised);
    }

    const saved = upsertTrack({
      ...metadataFields(metadata, info, relPath),
      id,
      storageKey,
      streamKey,
      contentHash,
      isrc: metadata.tags.isrc ?? null,
      coverKey: existing?.cover_key ?? previousRow?.coverKey ?? null,
      priceCents: existing?.price_cents ?? previousRow?.priceCents ?? 199,
      currency: existing?.currency ?? previousRow?.currency ?? 'EUR',
      buyUrl: existing?.buy_url ?? previousRow?.buyUrl ?? null,
      tags: existing ? JSON.parse(existing.tags ?? '[]') : [],
      published:
        existing !== undefined
          ? options.publishExisting
            ? true
            : Boolean(existing.published)
          : (previousRow?.published ?? Boolean(options.publish)),
      featured: existing !== undefined ? Boolean(existing.featured) : (previousRow?.featured ?? false),
      weight: existing?.weight ?? 1,
      sourcePath: relPath,
      originalName: path.basename(file),
    });

    // The export is a human-readable, server-side artifact: it keeps the source path so a reader can
    // tell which file a row came from, and drops the storage keys (the database is the record).
    tracks.push({ ...sanitizeTrack(saved), sourceFile: relPath });
  }

  const totalDurationMs = tracks.reduce((sum, track) => sum + track.durationMs, 0);
  if (!options.dryRun) await writeExport(out, tracks, totalDurationMs);
  if (writes) closeDatabase();

  return { tracks, stored, unchanged, totalDurationMs };
}

/** Metadata shared by the export and the database row. */
function metadataFields(metadata, info, relPath) {
  const tags = metadata.tags ?? {};
  return {
    title: tags.title ?? path.basename(relPath, path.extname(relPath)),
    artist: tags.artist ?? tags.album_artist ?? 'Unknown artist',
    album: tags.album ?? null,
    albumArtist: tags.album_artist ?? tags.artist ?? null,
    year: num(tags.date),
    genre: tags.genre ?? null,
    composer: tags.composer ?? null,
    bpm: num(tags.TBPM),
    musicalKey: tags.TKEY ?? null,
    trackNumber: num(tags.track),
    disc: num(tags.disc),
    durationMs: metadata.durationMs,
    bitrate: metadata.bitrate,
    sampleRate: metadata.sampleRate,
    channels: metadata.channels,
    sizeBytes: info.size,
  };
}

/** Write the human-readable metadata export next to the database. */
async function writeExport(file, tracks, totalDurationMs) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        generator: 'scripts/import-tracks.js',
        album: tracks[0]
          ? {
              album: tracks[0].album,
              artist: tracks[0].artist,
              year: tracks[0].year,
              genre: tracks[0].genre,
              composer: tracks[0].composer,
            }
          : null,
        trackCount: tracks.length,
        totalDurationMs,
        tracks,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

/** Rows whose source file is gone — reported by `--prune`, never deleted automatically. */
export function orphans(trackIds) {
  const known = new Set(trackIds);
  return openDatabase()
    .prepare('SELECT id, title, source_path FROM tracks')
    .all()
    .filter((row) => !known.has(row.id));
}
