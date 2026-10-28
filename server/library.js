/**
 * Library.
 *
 * The catalogue now comes from the database instead of a JSON file, and this module is the only
 * place that decides what a client may see: `sanitizeTrack()` strips the id → file mapping from
 * every track object before it leaves the server.
 *
 * The broadcast clock is still a pure function of wall-clock time (no writes, no drift, trivially
 * testable). M3 replaces it with a real scheduler feeding Icecast and starts recording
 * `play_history` rows.
 */

import { all, one, rowToTrack } from './db.js';
import { config } from './config.js';

/**
 * Fields that exist only for the server. Stripping by name (rather than by omission) means adding a
 * new private field to the schema cannot accidentally start leaking it.
 */
const INTERNAL_TRACK_FIELDS = [
  'storageKey',
  'streamKey',
  'sourcePath',
  'sourceFile',
  'originalName',
  'contentHash',
];

/** The indirection rule: the public world only ever sees ids. Returns a copy. */
export function sanitizeTrack(track) {
  if (!track) return null;
  const publicTrack = { ...track };
  for (const field of INTERNAL_TRACK_FIELDS) delete publicTrack[field];
  return publicTrack;
}

/** Album/disc/track order — the rotation the scheduler follows, and how the library reads. */
const ROTATION_ORDER = `ORDER BY COALESCE(album, '') COLLATE NOCASE,
                                COALESCE(disc, 0),
                                COALESCE(track_number, 0),
                                title COLLATE NOCASE`;

const SORTS = {
  album: ROTATION_ORDER,
  title: 'ORDER BY title COLLATE NOCASE',
  artist: 'ORDER BY artist COLLATE NOCASE, title COLLATE NOCASE',
  duration: 'ORDER BY duration_ms DESC',
  bpm: 'ORDER BY COALESCE(bpm, 9999) ASC, title COLLATE NOCASE',
  added: 'ORDER BY added_at DESC',
};

/**
 * Published tracks, optionally searched, filtered and sorted.
 * Unpublished drafts are never returned here — that is the single rule protecting the catalogue.
 */
export function listTracks({ q = '', genre = '', sort = 'album', limit = null, offset = 0 } = {}) {
  const where = ['published = 1'];
  const params = [];

  if (q) {
    where.push('(title LIKE ? OR artist LIKE ? OR album LIKE ? OR genre LIKE ?)');
    const needle = `%${q}%`;
    params.push(needle, needle, needle, needle);
  }
  if (genre) {
    where.push('genre = ?');
    params.push(genre);
  }

  const order = SORTS[sort] ?? SORTS.album;
  const pagination = limit ? `LIMIT ${Number(limit)} OFFSET ${Number(offset)}` : '';

  return all(`SELECT * FROM tracks WHERE ${where.join(' AND ')} ${order} ${pagination}`, ...params).map(
    rowToTrack,
  );
}

/** The rotation the broadcast clock walks through. */
export const rotationTracks = () =>
  all(`SELECT * FROM tracks WHERE published = 1 ${ROTATION_ORDER}`).map(rowToTrack);

/** One track. `includeUnpublished` is only ever used by the admin (M6). */
export function getTrack(id, { includeUnpublished = false } = {}) {
  const track = rowToTrack(one('SELECT * FROM tracks WHERE id = ?', id));
  if (!track) return null;
  if (!includeUnpublished && !track.published) return null;
  return track;
}

export const genres = () =>
  all('SELECT DISTINCT genre FROM tracks WHERE published = 1 AND genre IS NOT NULL ORDER BY genre').map(
    (row) => row.genre,
  );

/** Envelope the playlist endpoint returns: album blurb, counts and total runtime. */
export function catalogue() {
  const tracks = listTracks();
  const first = tracks[0] ?? null;
  const totals = one(
    'SELECT COUNT(*) AS count, COALESCE(SUM(duration_ms), 0) AS duration FROM tracks WHERE published = 1',
  );

  return {
    album: first
      ? {
          album: first.album,
          artist: first.artist,
          year: first.year,
          genre: first.genre,
          composer: first.composer,
        }
      : null,
    trackCount: totals?.count ?? 0,
    totalDurationMs: totals?.duration ?? 0,
    tracks,
  };
}

/* ─────────────────────────── broadcast clock ─────────────────────────── */

// Fixed epoch so the on-air position is reproducible across restarts and testable without waiting.
export const BROADCAST_EPOCH = Date.UTC(2026, 0, 1, 0, 0, 0);

/**
 * The rotation, materialised: which track is on air at `nowMs`, how far in, and what follows.
 * This is the single source of truth shared by `/api/now-playing`, the stream pump and the history
 * recorder — the schedule is the log, and everything else follows it.
 */
export function slotAt(nowMs = Date.now(), { tracks = null, scale = config.timeScale } = {}) {
  const rotation = tracks ?? rotationTracks();
  if (rotation.length === 0) return null;

  const cycleMs = rotation.reduce((sum, track) => sum + track.durationMs, 0);
  const elapsed = Math.floor((nowMs - BROADCAST_EPOCH) * scale);
  const cycleIndex = Math.floor(elapsed / cycleMs);

  const slots = [];
  for (const cycle of [cycleIndex - 1, cycleIndex, cycleIndex + 1]) {
    let offset = cycle * cycleMs;
    for (const track of rotation) {
      slots.push({ track, start: offset, end: offset + track.durationMs });
      offset += track.durationMs;
    }
  }

  const index = slots.findIndex((slot) => elapsed >= slot.start && elapsed < slot.end);
  const current = slots[index];
  const next = slots[index + 1];

  return {
    cycleMs,
    cycleIndex,
    positionMs: elapsed % cycleMs,
    slots,
    index,
    track: current.track,
    startedScaled: current.start,
    endsScaled: current.end,
    elapsedMs: elapsed - current.start,
    remainingMs: current.end - elapsed,
    next: next ? { track: next.track, startsScaled: next.start } : null,
    toWallClock: (scaledMs) => new Date(BROADCAST_EPOCH + scaledMs / scale).toISOString(),
  };
}

/** The station's on-air position at a given instant. Pure: same input, same output. */
export function broadcastState(nowMs = Date.now()) {
  const slot = slotAt(nowMs);
  if (!slot) return null;

  const history = slot.slots
    .slice(Math.max(0, slot.index - 15), slot.index)
    .reverse()
    .map((entry) => ({ track: sanitizeTrack(entry.track), playedAt: slot.toWallClock(entry.start) }));

  // Deterministic pseudo-random "listeners right now" for the prototype; the real count comes from
  // the stream pump (server/radio.js) and is merged in by the route layer.
  const scaled = slot.positionMs + slot.cycleIndex * slot.cycleMs;
  const listeners = Math.max(
    3,
    Math.round(19 + 11 * Math.sin(scaled / 900000) + 6 * Math.sin(scaled / 73000) + (scaled % 7)),
  );

  return {
    dev: !config.isProduction,
    simulated: true,
    station: {
      name: 'Anomalradio',
      tagline: 'Own music only. Live from the anomaly.',
      mount: config.mountPath,
      bitrate: config.streamBitrate,
      listeners,
      onAirSince: slot.toWallClock(slot.startedScaled),
    },
    now: {
      track: sanitizeTrack(slot.track),
      startedAt: slot.toWallClock(slot.startedScaled),
      elapsedMs: slot.elapsedMs,
      remainingMs: slot.remainingMs,
      progress: slot.elapsedMs / slot.track.durationMs,
    },
    next: slot.next
      ? { track: sanitizeTrack(slot.next.track), startsAt: slot.toWallClock(slot.next.startsScaled) }
      : null,
    history,
    cycle: { index: slot.cycleIndex, totalMs: slot.cycleMs, positionMs: slot.positionMs },
  };
}

/** Queue that "live" mode joins: the on-air track plus everything after it in this cycle. */
export function rotationFrom(trackId) {
  const tracks = rotationTracks();
  const index = tracks.findIndex((track) => track.id === trackId);
  if (index < 0) return tracks;
  return [...tracks.slice(index), ...tracks.slice(0, index)];
}
