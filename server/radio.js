/**
 * The continuous radio stream.
 *
 * One mount, many listeners, no per-track resource: exactly what SomaFM hands a browser. A single
 * pump reads the track the schedule says is on air and fans the bytes out to every listener, which
 * means a listener can never obtain a whole file by asking for one — there is no file to ask for.
 *
 *   · the schedule (library.slotAt) decides what plays; the pump follows it and re-syncs at every
 *     track boundary, so a restart lands back on the right track
 *   · ICY metadata is interleaved into the stream (`icy-metaint`), so VLC/foobar and the site agree
 *     on the title; browsers ignore it
 *   · a listener that falls too far behind is dropped rather than buffered forever — standard for
 *     live audio, and it keeps memory bounded
 *   · every track change is recorded in `play_history`, which is what feeds the charts
 */

import { config } from './config.js';
import { run } from './db.js';
import { slotAt } from './library.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** `StreamTitle='Artist - Title';` padded to a 16-byte boundary, as ICY requires. */
function metadataBlock(title) {
  const text = `StreamTitle='${String(title).replace(/['\\]/g, '')}';`;
  const length = Math.ceil(Buffer.byteLength(text) / 16);
  const payload = Buffer.alloc(length * 16, 0);
  payload.write(text, 0, 'utf8');
  return Buffer.concat([Buffer.from([length]), payload]);
}

/** Approximate byte offset for a position in a CBR MP3 — how a late listener joins mid-track. */
function byteOffsetFor(track, elapsedMs) {
  const bytes = Math.floor(((track.bitrate ?? 128000) / 8) * (elapsedMs / 1000));
  return Math.max(0, Math.min(bytes, Math.max(0, (track.sizeBytes ?? 0) - 1)));
}

/** Real-time pace for a track: bytes per second at its own bitrate. */
const bytesPerSecondFor = (track) => Math.max(4000, (track.bitrate ?? 128000) / 8);

export function createRadio({ storage, recordHistory = true, log = console } = {}) {
  /** @type {Set<{ res: import('node:http').ServerResponse, written: number, title: string }>} */
  const listeners = new Set();
  let pump = null;
  let stopping = false;
  let lastRecordedTrackId = null;
  let recorder = null;

  const listenerCount = () => listeners.size;

  /* ─────────────────────────── history ─────────────────────────── */

  /**
   * Record the track that is on air, once per change. One row per track, and it is what the charts
   * and an honest "recently played" read later.
   */
  function recordCurrent() {
    if (!recordHistory) return null;
    const slot = slotAt();
    if (!slot || slot.track.id === lastRecordedTrackId) return null;

    lastRecordedTrackId = slot.track.id;
    try {
      run(
        'INSERT INTO play_history (track_id, started_at, listeners) VALUES (?, ?, ?)',
        slot.track.id,
        slot.toWallClock(slot.startedScaled),
        listeners.size,
      );
      run('UPDATE tracks SET plays = plays + 1 WHERE id = ?', slot.track.id);
    } catch (error) {
      log.warn(`could not record play history: ${error.message}`);
    }
    return slot.track.id;
  }

  /* ─────────────────────────── fan-out ─────────────────────────── */

  function dropListener(listener) {
    listeners.delete(listener);
    try {
      listener.res.destroy();
    } catch {
      /* already gone */
    }
  }

  /**
   * Write audio to every listener, interleaving metadata at the configured interval.
   *
   * The metadata block must appear after *exactly* `icy-metaint` bytes of audio, so each chunk is
   * sliced to fill the current interval precisely — writing whole chunks would place the title at a
   * chunk boundary instead, and strict players (VLC, foobar) would read the stream as garbage.
   */
  function fanOut(chunk, title) {
    for (const listener of listeners) {
      if (listener.res.writableEnded || listener.res.destroyed) {
        listeners.delete(listener);
        continue;
      }
      // A listener that is not draining is a stalled client: drop it instead of buffering forever.
      if (listener.res.writableLength > config.listenerBufferLimitBytes) {
        log.warn('dropping a listener that stopped reading');
        dropListener(listener);
        continue;
      }

      try {
        let offset = 0;
        while (offset < chunk.length) {
          const room = config.icyMetaInterval - listener.written;
          const slice = chunk.subarray(offset, offset + room);
          listener.res.write(slice);
          listener.written += slice.length;
          offset += slice.length;

          if (listener.written >= config.icyMetaInterval) {
            listener.res.write(metadataBlock(title));
            listener.written = 0;
          }
        }
      } catch {
        dropListener(listener);
      }
    }
  }

  /* ─────────────────────────── the pump ─────────────────────────── */

  /**
   * Read the on-air track from the schedule's position and keep going: at every track boundary the
   * schedule decides what is next, which is also when history and the ICY title change.
   */
  async function runPump() {
    while (!stopping) {
      const slot = slotAt();
      if (!slot) {
        await sleep(2000);
        continue;
      }

      const track = slot.track;
      const title = `${track.artist} — ${track.title}`;
      recordCurrent();
      // The title change is carried by the next interval write in fanOut. Writing a metadata block
      // here instead would land it mid-interval and corrupt the layout for strict players.

      let stream;
      try {
        stream = await storage.createReadStream(
          track.storageKey,
          slot.elapsedMs > 1000 ? { start: byteOffsetFor(track, slot.elapsedMs) } : {},
        );
      } catch (error) {
        log.error(`radio: cannot read ${track.id} (${error.message}) — retrying`);
        await sleep(2000);
        continue;
      }

      pump = { trackId: track.id, title };

      // Pace the stream to the track's own bitrate. Without this the pump would hand out the file at
      // disk speed — a bulk download dressed up as a radio stream, which is exactly what the mount
      // exists to prevent.
      const bytesPerSecond = bytesPerSecondFor(track);
      let sent = 0;
      const startedAt = Date.now();

      for await (const chunk of stream) {
        if (stopping) break;
        if (listeners.size === 0) break; // nobody listening: stop reading, the schedule still records
        fanOut(chunk, title);

        sent += chunk.length;
        const behindMs = (sent / bytesPerSecond) * 1000 - (Date.now() - startedAt);
        // Sleep for the *whole* deficit: capping it short (say at 1 s) would let the stream run
        // faster than real time, which is the difference between radio and a download.
        if (behindMs > 5) await sleep(Math.min(behindMs, 10_000));
      }

      stream.destroy?.();
      pump = null;

      if (stopping) break;

      if (listeners.size === 0) {
        await sleep(1000);
        continue;
      }

      // The file ended: the next slot is what plays next. If the schedule still says the same track
      // (a short file, or a stalled read) pause briefly rather than spinning.
      const after = slotAt();
      if (after && after.track.id === track.id) await sleep(250);
    }
  }

  function ensurePump() {
    if (pump || stopping) return;
    runPump().catch((error) => log.error(`radio pump stopped: ${error.message}`));
  }

  /* ─────────────────────────── public surface ─────────────────────────── */

  /** Attach a listener to the mount. The caller has already validated the token. */
  function addListener(req, res) {
    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'no-store, private',
      'Content-Disposition': 'inline',
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
      // ICY headers: what external players read to show the station and the track.
      'icy-name': 'Anomalradio',
      'icy-genre': 'Electronic',
      'icy-br': String(Math.round((slotAt()?.track.bitrate ?? config.streamBitrate * 1000) / 1000)),
      'icy-metaint': String(config.icyMetaInterval),
      'icy-description': 'Own music only, 24/7',
    });
    res.flushHeaders?.();

    const listener = { res, written: 0, title: null };
    listeners.add(listener);
    req.on('close', () => listeners.delete(listener));

    // Note: no metadata block here. ICY metadata starts *after* the first `metaint` bytes of audio,
    // so the title goes out from the fan-out loop (and immediately on a track change).
    ensurePump();
    return listener;
  }

  function start() {
    stopping = false;
    // With nobody listening the schedule is all that matters, so it is recorded on a slow timer; the
    // pump itself only starts when a listener arrives.
    recordCurrent();
    recorder ??= setInterval(() => recordCurrent(), 10_000);
    recorder.unref?.();
  }

  function stop() {
    stopping = true;
    clearInterval(recorder);
    recorder = null;
    for (const listener of [...listeners]) dropListener(listener);
  }

  /** What the pump believes is on air — the schedule, materialised. */
  const nowPlaying = () => {
    const slot = slotAt();
    if (!slot) return null;
    return {
      trackId: slot.track.id,
      title: `${slot.track.artist} — ${slot.track.title}`,
      elapsedMs: slot.elapsedMs,
      pumping: pump !== null,
      listeners: listeners.size,
    };
  };

  return { start, stop, addListener, listenerCount, nowPlaying, recordCurrent, metadataBlock };
}
