/**
 * Routes — the same public contract the frontend was written against (offer §5.2), now served from
 * the database with private storage behind it.
 *
 * Every response that contains a track goes through `sanitizeTrack()`; the audio route never reveals
 * where a file lives, only that a valid, unexpired, unexhausted token was presented.
 */

import { config } from './config.js';
import { getStorage } from './storage/index.js';
import { getTokenService } from './tokens.js';
import { broadcastState, catalogue, getTrack, listTracks, sanitizeTrack } from './library.js';
import { injectMeta, metaFor, metaForTrack, PAGE_META } from './render.js';
import { notFound, parseRange, sendJson, serveStatic } from './http.js';

const AUDIO_HEADERS = {
  'Content-Type': 'audio/mpeg',
  'Cache-Control': 'no-store, private',
  'Content-Disposition': 'inline',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'Accept-Ranges': 'bytes',
};

export function createRouter({ security, tokens = getTokenService(), storage = getStorage() } = {}) {
  const sseClients = new Set();
  let lastTrackId = null;

  // Push a state snapshot to connected players every 5 seconds, and immediately on a track change.
  const ticker = setInterval(() => {
    if (sseClients.size === 0) return;
    const state = broadcastState();
    if (!state) return;
    const changed = state.now.track.id !== lastTrackId;
    lastTrackId = state.now.track.id;
    for (const client of sseClients) sendEvent(client, changed ? 'track' : 'tick', state);
  }, 5000);
  ticker.unref?.();

  // Expired token rows are housekeeping, not a hot path.
  const janitor = setInterval(() => {
    try {
      tokens.cleanup();
    } catch {
      /* database busy — try again next time */
    }
  }, 300_000);
  janitor.unref?.();

  function close() {
    clearInterval(ticker);
    clearInterval(janitor);
    for (const client of sseClients) client.end();
    sseClients.clear();
  }

  /* ─────────────────────────── API ─────────────────────────── */

  async function handleApi(req, res, url) {
    const [, resource, param] = url.pathname.split('/').filter(Boolean);

    // GET /api/playlist — the public catalogue
    if (resource === 'playlist' && req.method === 'GET') {
      const tracks = listTracks({
        q: url.searchParams.get('q') ?? '',
        genre: url.searchParams.get('genre') ?? '',
        sort: url.searchParams.get('sort') ?? 'album',
      });
      return sendJson(res, 200, {
        dev: true,
        album: catalogue().album,
        trackCount: tracks.length,
        totalDurationMs: tracks.reduce((sum, track) => sum + track.durationMs, 0),
        tracks: tracks.map(sanitizeTrack),
      });
    }

    // GET /api/tracks/:id
    if (resource === 'tracks' && param && req.method === 'GET') {
      const track = getTrack(param);
      if (!track) return sendJson(res, 404, { error: 'track-not-found' });
      return sendJson(res, 200, { dev: true, track: sanitizeTrack(track), album: catalogue().album });
    }

    // GET /api/now-playing
    if (resource === 'now-playing' && !param && req.method === 'GET') {
      const state = broadcastState();
      if (!state) return sendJson(res, 503, { error: 'no-tracks-published' });
      return sendJson(res, 200, state);
    }

    // GET /api/now-playing/stream — server-sent events
    if (resource === 'now-playing' && param === 'stream' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(': connected to anomalradio\n\n');
      const state = broadcastState();
      if (state) sendEvent(res, 'track', state);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return undefined;
    }

    // GET /api/session — mint a short-lived stream token
    if (resource === 'session' && req.method === 'GET') {
      if (security.userAgentBlocked(req)) {
        return sendJson(res, 403, { error: 'blocked-user-agent', hint: 'curl/wget/rippers are refused' });
      }
      if (!security.originAllowed(req)) return sendJson(res, 403, { error: 'forbidden-origin' });
      if (security.sessionRateLimited(req)) return sendJson(res, 429, { error: 'rate-limited' });

      const issued = tokens.issue({
        trackId: url.searchParams.get('track'),
        ipHash: security.ipHash(req),
        uaHash: security.uaHash(req),
      });

      return sendJson(res, 200, {
        dev: true,
        token: issued.token,
        expiresAt: issued.expiresAt,
        ttlSeconds: issued.ttlSeconds,
        maxStreamsPerIp: security.limits.maxStreamsPerIp,
      });
    }

    // GET /api/radio — what "live" mode needs to join the broadcast
    if (resource === 'radio' && req.method === 'GET') {
      const state = broadcastState();
      if (!state) return sendJson(res, 503, { error: 'no-tracks-published' });
      return sendJson(res, 200, {
        dev: true,
        simulated: true,
        station: state.station,
        now: state.now,
        next: state.next,
        // M3 replaces this with a single continuous Icecast mount protected by stream_auth.
        join: { trackId: state.now.track.id, startAtMs: state.now.elapsedMs },
      });
    }

    // GET /api/stream/:id?t=… — audio, behind every gate
    if (resource === 'stream' && param && req.method === 'GET') {
      return handleStream(req, res, url, param);
    }

    return sendJson(res, 404, { error: 'unknown-endpoint', path: url.pathname });
  }

  async function handleStream(req, res, url, trackId) {
    if (security.userAgentBlocked(req)) return sendJson(res, 403, { error: 'blocked-user-agent' });
    if (!security.originAllowed(req)) return sendJson(res, 403, { error: 'forbidden-origin' });
    if (security.audioRateLimited(req)) return sendJson(res, 429, { error: 'rate-limited' });

    const verdict = tokens.verify({
      token: url.searchParams.get('t'),
      trackId,
      ipHash: security.ipHash(req),
      uaHash: security.uaHash(req),
    });
    if (!verdict.ok) return sendJson(res, 403, { error: 'stream-denied', reason: verdict.reason });

    if (!security.streamSlotAvailable(req)) return sendJson(res, 429, { error: 'too-many-streams' });
    // Slot taken before any await: see createSecurity().acquireStream
    const release = security.acquireStream(req);
    res.on('close', release);

    const track = getTrack(trackId);
    if (!track) return sendJson(res, 404, { error: 'track-not-found' });

    const range = parseRange(req.headers.range, track.sizeBytes);
    if (range === 'unsatisfiable') {
      res.writeHead(416, { 'Content-Range': `bytes */${track.sizeBytes}` });
      return res.end();
    }

    let stream;
    try {
      stream = await storage.createReadStream(track.storageKey, range ?? {});
    } catch (error) {
      console.error(`✗ storage read failed for ${trackId}: ${error.message}`);
      return sendJson(res, 503, { error: 'audio-unavailable' });
    }

    if (range) {
      res.writeHead(206, {
        ...AUDIO_HEADERS,
        'Content-Range': `bytes ${range.start}-${range.end}/${track.sizeBytes}`,
        'Content-Length': range.end - range.start + 1,
      });
    } else {
      res.writeHead(200, { ...AUDIO_HEADERS, 'Content-Length': track.sizeBytes });
    }

    stream.on('error', () => res.destroy());
    stream.pipe(res);
    return undefined;
  }

  /* ─────────────────────────── pages ─────────────────────────── */

  /**
   * Serve an HTML page with server-rendered meta tags.
   * Track permalinks are the interesting case: a shared link must unfurl with the real title.
   */
  async function handlePage(req, res, url, origin) {
    const permalink = /^\/track\/(ar_[A-Za-z0-9]+)\/?$/.exec(url.pathname);
    if (permalink) {
      const track = getTrack(permalink[1]);
      const transform = (html) =>
        injectMeta(
          html,
          track
            ? metaForTrack(track, { origin, pathname: `/track/${track.id}` })
            : metaFor({
                origin,
                pathname: url.pathname,
                title: 'Track not found — Anomalradio.com',
                description: 'That track is not in the Anomalradio library.',
              }),
        );
      const served = await serveStatic(req, res, {
        publicDir: config.publicDir,
        pathname: '/track/index.html',
        transform,
      });
      return served ?? notFound(req, res, config.publicDir);
    }

    const pageMeta = PAGE_META[url.pathname === '/' ? '/index.html' : url.pathname];
    const served = await serveStatic(req, res, {
      publicDir: config.publicDir,
      pathname: url.pathname,
      transform: pageMeta
        ? (html) => injectMeta(html, metaFor({ origin, pathname: url.pathname, ...pageMeta }))
        : null,
    });
    return served ?? notFound(req, res, config.publicDir);
  }

  /* ─────────────────────────── entry ─────────────────────────── */

  async function handle(req, res, origin) {
    const url = new URL(req.url ?? '/', origin);

    if (url.pathname === '/healthz') {
      const state = broadcastState();
      return sendJson(res, 200, {
        status: 'ok',
        mode: 'prototype over production storage',
        storage: storage.driver,
        onAir: state?.now.track.title ?? null,
        listeners: state?.station.listeners ?? 0,
        uptimeSeconds: Math.round(process.uptime()),
      });
    }

    if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
    return handlePage(req, res, url, origin);
  }

  return { handle, close, stats: () => ({ sseClients: sseClients.size }) };
}

function sendEvent(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
