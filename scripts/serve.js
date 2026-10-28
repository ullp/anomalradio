#!/usr/bin/env node
/**
 * Anomalradio — M1 prototype server (zero dependencies, Node 20+).
 *
 * WHAT THIS IS
 *   A self-contained development/preview server that serves the design prototype in `public/`
 *   together with a *stub* API shaped exactly like the real one described in `_data/design-offer.md`
 *   (§5.2). It exists so the design can be reviewed — and heard — before the production
 *   backend (M2: SQLite + real tokens + storage drivers) replaces the stub internals.
 *
 * WHAT IS REAL HERE
 *   - the metadata catalogue (`data/tracks.json`, produced by `npm run import`)
 *   - the API contract and response shapes the frontend is written against
 *   - the simulated broadcast clock: `now-playing`, `history` (last 15) and `next` are a pure
 *     function of the current time, so the "live" state is identical across restarts
 *   - request gating behaviour: token required, referer/origin allowlist, ripper User-Agent
 *     denylist, per-IP rate limiting — so `curl` and stream rippers can be seen failing
 *
 * WHAT IS *NOT* PRODUCTION (deliberately, and flagged in the API as `dev: true`)
 *   - audio is streamed straight from LIBRARY_SOURCE_DIR (never do this in production: M2 copies
 *     files into private storage outside the web root / a private bucket and serves only by ID)
 *   - tokens are accepted as long as one was issued; the real HMAC + nonce + IP/UA binding lands in M2
 *   - counters (listeners, plays, stars) are simulated
 *
 * USAGE
 *   npm run dev            → http://localhost:3000
 *   PORT=4000 npm run dev
 *   DEMO_TIME_SCALE=0.05 npm run dev   → broadcast clock runs 20× faster (watch track changes)
 */

import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

/* ─────────────────────────── configuration ─────────────────────────── */

const ROOT = path.resolve(import.meta.dirname, '..');

/** Minimal .env loader (no dependency on dotenv). Real env vars always win. */
async function loadEnvFile() {
  try {
    const raw = await readFile(path.join(ROOT, '.env'), 'utf8');
    for (const line of raw.split('\n')) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (!match) continue;
      const [, key, value] = match;
      if (process.env[key] === undefined) process.env[key] = value.trim().replace(/^["']|["']$/g, '');
    }
  } catch {
    /* no .env — defaults below are used */
  }
}

await loadEnvFile();

const config = {
  port: Number(process.env.PORT ?? 3000),
  publicDir: path.join(ROOT, 'public'),
  libraryIndex: path.resolve(ROOT, process.env.LIBRARY_INDEX ?? './data/tracks.json'),
  librarySource: path.resolve(ROOT, process.env.LIBRARY_SOURCE_DIR ?? './_data/music'),
  timeScale: Number(process.env.DEMO_TIME_SCALE ?? 1) || 1,
  tokenTtlSeconds: Number(process.env.STREAM_TOKEN_TTL ?? 120),
  sessionRateLimit: Number(process.env.SESSION_RATE_LIMIT ?? 60),
  maxStreamsPerIp: Number(process.env.MAX_STREAMS_PER_IP ?? 3),
  blockedUserAgents: (
    process.env.BLOCKED_USER_AGENTS ??
    'streamripper,ffmpeg,ffprobe,wget,curl,python-requests,yt-dlp,aria2,HTTrack,IDM'
  )
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
};

// Broadcast clock epoch: fixed so the on-air position is a pure function of `now`.
const BROADCAST_EPOCH = Date.UTC(2026, 0, 1, 0, 0, 0);

/* ─────────────────────────── tiny helpers ─────────────────────────── */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

function sendJson(res, status, body, extraHeaders = {}) {
  const payload = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'Content-Type': MIME['.json'],
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex, nofollow',
    ...extraHeaders,
  });
  res.end(payload);
}

function sendText(res, status, text, contentType = MIME['.txt']) {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

const sha256 = (value) => createHash('sha256').update(String(value)).digest('hex');
const mmss = (ms) => {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

/**
 * The indirection rule from the offer (§6.1): internal fields never leave the server.
 * `sourceFile` is the mapping used by this dev server only.
 */
function sanitizeTrack(track) {
  const { sourceFile: _sourceFile, ...publicTrack } = track;
  return publicTrack;
}

/* ─────────────────────────── library ─────────────────────────── */

let libraryCache = { mtimeMs: 0, data: null };

async function loadLibrary() {
  const info = await stat(config.libraryIndex);
  if (libraryCache.data && libraryCache.mtimeMs === info.mtimeMs) return libraryCache.data;
  const data = JSON.parse(await readFile(config.libraryIndex, 'utf8'));
  libraryCache = { mtimeMs: info.mtimeMs, data };
  return data;
}

/* ─────────────────────────── broadcast clock (simulated) ─────────────────────────── */

/**
 * The station's on-air position is a pure function of wall-clock time:
 *   elapsedScaled = (now − EPOCH) × DEMO_TIME_SCALE
 *   cycleIndex    = floor(elapsedScaled / totalDuration)
 * Because EPOCH is fixed, restarts do not reshuffle the broadcast, and "what was on air
 * 20 minutes ago" can always be derived — that is how the history list is built.
 */
function broadcastState(nowMs = Date.now()) {
  const tracks = (libraryCache.data?.tracks ?? []).filter((t) => t.published);
  if (tracks.length === 0) return null;

  const cycleMs = tracks.reduce((sum, t) => sum + t.durationMs, 0);
  const scale = config.timeScale;
  const elapsed = Math.floor((nowMs - BROADCAST_EPOCH) * scale);
  const cycleIndex = Math.floor(elapsed / cycleMs);

  const slots = [];
  for (const cycle of [cycleIndex - 1, cycleIndex, cycleIndex + 1]) {
    let offset = cycle * cycleMs;
    for (const track of tracks) {
      slots.push({ track, start: offset, end: offset + track.durationMs });
      offset += track.durationMs;
    }
  }

  const index = slots.findIndex((s) => elapsed >= s.start && elapsed < s.end);
  const current = slots[index];
  const next = slots[index + 1];

  const toWallClock = (scaledMs) => new Date(BROADCAST_EPOCH + scaledMs / scale).toISOString();
  const history = slots
    .slice(Math.max(0, index - 15), index)
    .reverse()
    .map((s) => ({ track: sanitizeTrack(s.track), playedAt: toWallClock(s.start) }));

  const elapsedMs = elapsed - current.start;
  const remainingMs = current.end - elapsed;

  // Deterministic pseudo-random "listeners right now" so the UI has something plausible to show.
  const listeners = Math.max(
    3,
    Math.round(19 + 11 * Math.sin(elapsed / 900000) + 6 * Math.sin(elapsed / 73000) + (elapsed % 7)),
  );

  return {
    dev: true,
    simulated: true,
    station: {
      name: 'Anomalradio',
      tagline: 'Own music only. Live from the anomaly.',
      mount: '/radio-128.mp3',
      bitrate: 128,
      listeners,
      onAirSince: toWallClock(current.start),
    },
    now: {
      track: sanitizeTrack(current.track),
      startedAt: toWallClock(current.start),
      elapsedMs,
      remainingMs,
      progress: elapsedMs / current.track.durationMs,
    },
    next: next ? { track: sanitizeTrack(next.track), startsAt: toWallClock(next.start) } : null,
    history,
    cycle: { index: cycleIndex, totalMs: cycleMs, positionMs: elapsed % cycleMs },
  };
}

/* ─────────────────────────── tokens & request gating ─────────────────────────── */

/**
 * DEV token store. Production (M2) replaces this with stateless HMAC tokens:
 *   token = base64url(payload) + '.' + HMAC-SHA256(payload, SECRET)
 *   payload = { tid, nonce, exp, ip: sha256(ip+salt), ua: sha256(UA+salt) }
 * The *checks* below are already the real ones, so frontend code and tests stay unchanged.
 *
 * Note on single use: a token authorises ONE track (tid) for its TTL. Several HTTP range
 * requests are allowed against it, because seeking in an <audio> element issues new range
 * requests — a strictly single-use nonce would break seeking. Starting another track requires
 * a freshly minted token.
 */
const tokens = new Map(); // token → { tid, exp, ipHash, uaHash, uses }

function issueToken(req, tid = null) {
  const token = randomBytes(18).toString('base64url');
  tokens.set(token, {
    tid,
    exp: Date.now() + config.tokenTtlSeconds * 1000,
    ipHash: sha256(clientIp(req)),
    uaHash: sha256(req.headers['user-agent'] ?? ''),
    uses: 0,
  });
  return token;
}

function validateToken(req, token, tid) {
  if (!token) return { ok: false, reason: 'missing-token' };
  const entry = tokens.get(token);
  if (!entry) return { ok: false, reason: 'unknown-token' };
  if (entry.exp < Date.now()) {
    tokens.delete(token);
    return { ok: false, reason: 'expired-token' };
  }
  if (entry.ipHash !== sha256(clientIp(req))) return { ok: false, reason: 'ip-mismatch' };
  if (entry.uaHash !== sha256(req.headers['user-agent'] ?? '')) return { ok: false, reason: 'ua-mismatch' };
  if (entry.tid && tid && entry.tid !== tid) return { ok: false, reason: 'track-mismatch' };
  entry.uses += 1;
  return { ok: true };
}

// Expired-token housekeeping (keeps the Map from growing forever).
setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of tokens) if (entry.exp < now) tokens.delete(token);
}, 60_000).unref();

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress ?? 'unknown';
}

/** Origin/Referer allowlist — blocks hotlinking from other sites. */
function originAllowed(req) {
  const value = req.headers.origin ?? req.headers.referer;
  if (!value) return false; // no browser context at all (curl, wget, scrapers)
  let hostname;
  try {
    hostname = new URL(value).hostname;
  } catch {
    return false;
  }
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return true;
  return config.allowedOrigins.some((allowed) => {
    try {
      const pattern = new URL(allowed).hostname;
      const bare = pattern.replace(/^\*\./, '');
      return pattern.startsWith('*.')
        ? hostname === bare || hostname.endsWith(`.${bare}`)
        : hostname === pattern;
    } catch {
      return false;
    }
  });
}

/** Stream-ripper / bot User-Agent denylist. */
function userAgentBlocked(req) {
  const ua = String(req.headers['user-agent'] ?? '').toLowerCase();
  if (!ua) return true;
  return config.blockedUserAgents.some((fragment) => ua.includes(fragment));
}

const rateBuckets = new Map(); // key → { count, resetAt }

function rateLimited(key, limitPerMinute) {
  const now = Date.now();
  const bucket = rateBuckets.get(key);
  if (!bucket || bucket.resetAt < now) {
    rateBuckets.set(key, { count: 1, resetAt: now + 60_000 });
    return false;
  }
  bucket.count += 1;
  return bucket.count > limitPerMinute;
}

const activeStreams = new Map(); // ipHash → count

function streamSlotAvailable(req) {
  return (activeStreams.get(sha256(clientIp(req))) ?? 0) < config.maxStreamsPerIp;
}

function acquireStream(req) {
  const key = sha256(clientIp(req));
  activeStreams.set(key, (activeStreams.get(key) ?? 0) + 1);
  return () => activeStreams.set(key, Math.max(0, (activeStreams.get(key) ?? 1) - 1));
}

/* ─────────────────────────── API routes ─────────────────────────── */

const sseClients = new Set();

function sseSend(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// Push a state snapshot to every connected player every 5 seconds (plus on track change).
let lastTrackId = null;
setInterval(() => {
  const state = broadcastState();
  if (!state || sseClients.size === 0) return;
  const changed = state.now.track.id !== lastTrackId;
  lastTrackId = state.now.track.id;
  for (const res of sseClients) sseSend(res, changed ? 'track' : 'tick', state);
}, 5000).unref();

async function handleApi(req, res, url) {
  const segments = url.pathname.split('/').filter(Boolean); // ['api', …]
  const [, resource, param] = segments;
  const library = await loadLibrary();

  // GET /api/playlist — public catalogue, storage paths stripped
  if (resource === 'playlist' && req.method === 'GET') {
    const query = (url.searchParams.get('q') ?? '').trim().toLowerCase();
    const genre = url.searchParams.get('genre');
    const sort = url.searchParams.get('sort') ?? 'album';

    let tracks = library.tracks.filter((t) => t.published);
    if (query) {
      tracks = tracks.filter((t) =>
        [t.title, t.artist, t.album, t.genre].filter(Boolean).some((v) => v.toLowerCase().includes(query)),
      );
    }
    if (genre) tracks = tracks.filter((t) => t.genre === genre);
    if (sort === 'duration') tracks = [...tracks].sort((a, b) => a.durationMs - b.durationMs);
    if (sort === 'title') tracks = [...tracks].sort((a, b) => a.title.localeCompare(b.title, 'en'));

    return sendJson(res, 200, {
      dev: true,
      album: library.album,
      trackCount: tracks.length,
      totalDurationMs: tracks.reduce((sum, t) => sum + t.durationMs, 0),
      tracks: tracks.map(sanitizeTrack),
    });
  }

  // GET /api/tracks/:id
  if (resource === 'tracks' && param && req.method === 'GET') {
    const track = library.tracks.find((t) => t.id === param && t.published);
    if (!track) return sendJson(res, 404, { error: 'track-not-found' });
    return sendJson(res, 200, { dev: true, track: sanitizeTrack(track), album: library.album });
  }

  // GET /api/now-playing  (snapshot)
  if (resource === 'now-playing' && !param && req.method === 'GET') {
    const state = broadcastState();
    if (!state) return sendJson(res, 503, { error: 'no-tracks-published' });
    return sendJson(res, 200, state);
  }

  // GET /api/now-playing/stream  (SSE)
  if (resource === 'now-playing' && param === 'stream' && req.method === 'GET') {
    const state = broadcastState();
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected to anomalradio prototype\n\n');
    if (state) sseSend(res, 'track', state);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return undefined;
  }

  // GET /api/session — mint a short-lived stream token
  if (resource === 'session' && req.method === 'GET') {
    if (userAgentBlocked(req)) {
      return sendJson(res, 403, { error: 'blocked-user-agent', hint: 'curl/wget/rippers are refused' });
    }
    if (!originAllowed(req)) return sendJson(res, 403, { error: 'forbidden-origin' });
    if (rateLimited(`session:${sha256(clientIp(req))}`, config.sessionRateLimit)) {
      return sendJson(res, 429, { error: 'rate-limited' });
    }
    const token = issueToken(req, url.searchParams.get('track') ?? null);
    return sendJson(res, 200, {
      dev: true,
      token,
      expiresAt: new Date(Date.now() + config.tokenTtlSeconds * 1000).toISOString(),
      ttlSeconds: config.tokenTtlSeconds,
      maxStreamsPerIp: config.maxStreamsPerIp,
    });
  }

  // GET /api/radio — what "live" mode needs: current track + how far in we already are
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

  // GET /api/stream/:id?t=… — DEV ONLY audio delivery, with the real gating checks
  if (resource === 'stream' && param && req.method === 'GET') {
    return handleStream(req, res, url, param);
  }

  return sendJson(res, 404, { error: 'unknown-endpoint', path: url.pathname });
}

/* ─────────────────────────── audio delivery (dev) ─────────────────────────── */

async function handleStream(req, res, url, trackId) {
  if (userAgentBlocked(req)) return sendJson(res, 403, { error: 'blocked-user-agent' });
  if (!originAllowed(req)) return sendJson(res, 403, { error: 'forbidden-origin' });

  const verdict = validateToken(req, url.searchParams.get('t'), trackId);
  if (!verdict.ok) return sendJson(res, 403, { error: 'stream-denied', reason: verdict.reason });

  if (!streamSlotAvailable(req)) return sendJson(res, 429, { error: 'too-many-streams' });

  const library = await loadLibrary();
  const track = library.tracks.find((t) => t.id === trackId && t.published);
  if (!track) return sendJson(res, 404, { error: 'track-not-found' });

  // DEV ONLY: resolve the opaque id to the source file. M2 replaces this with the storage
  // driver (private `media/` folder or a private bucket) and never reads the source dir.
  const filePath = path.resolve(config.librarySource, track.sourceFile);
  if (!filePath.startsWith(`${config.librarySource}${path.sep}`)) {
    return sendJson(res, 403, { error: 'path-escape' });
  }

  let info;
  try {
    info = await stat(filePath);
  } catch {
    return sendJson(res, 404, { error: 'audio-missing' });
  }

  const release = acquireStream(req);
  res.on('close', release);

  const baseHeaders = {
    'Content-Type': 'audio/mpeg',
    'Cache-Control': 'no-store, private',
    'Content-Disposition': 'inline',
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
    'Accept-Ranges': 'bytes',
    'X-Anomalradio-Dev': 'dev-source-directory',
  };

  const range = req.headers.range;
  const match = typeof range === 'string' ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;

  if (match) {
    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Math.min(Number(match[2]), info.size - 1) : info.size - 1;
    if (Number.isNaN(start) || start > end || start >= info.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${info.size}` });
      return res.end();
    }
    res.writeHead(206, {
      ...baseHeaders,
      'Content-Range': `bytes ${start}-${end}/${info.size}`,
      'Content-Length': end - start + 1,
    });
    createReadStream(filePath, { start, end }).pipe(res);
    return undefined;
  }

  res.writeHead(200, { ...baseHeaders, 'Content-Length': info.size });
  createReadStream(filePath).pipe(res);
  return undefined;
}

/* ─────────────────────────── static files ─────────────────────────── */

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  // No inline scripts/styles/handlers anywhere in public/ — see public/assets/js/*.
  'Content-Security-Policy': [
    "default-src 'self'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "style-src 'self'",
    "script-src 'self'",
    "connect-src 'self'",
    "font-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
};

/** Layer 1 of the security design, demonstrated locally: audio is never served from the web root. */
const AUDIO_EXT_RE = /\.(mp3|m4a|flac|wav|aac|ogg|opus)$/i;

async function serveStatic(req, res, url) {
  let relative;
  try {
    relative = decodeURIComponent(url.pathname);
  } catch {
    return sendText(res, 400, 'bad request');
  }
  if (relative.includes('..') || relative.includes('\0')) return sendText(res, 404, 'not found');

  if (relative === '/') relative = '/index.html';
  if (relative.endsWith('/')) relative += 'index.html';

  const filePath = path.join(config.publicDir, relative);
  if (!filePath.startsWith(config.publicDir)) return sendText(res, 404, 'not found');
  if (AUDIO_EXT_RE.test(filePath)) return sendText(res, 404, 'not found');

  let info;
  try {
    info = await stat(filePath);
  } catch {
    return serveNotFound(req, res);
  }
  if (!info.isFile()) return serveNotFound(req, res);

  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Content-Length': info.size,
    // Prototype server: never cache, so edits to CSS/JS are picked up immediately.
    // Production (M2) serves hashed, immutable assets with long lifetimes instead.
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
  });
  if (req.method === 'HEAD') return res.end();
  createReadStream(filePath).pipe(res);
  return undefined;
}

async function serveNotFound(req, res) {
  try {
    const page = await readFile(path.join(config.publicDir, '404.html'));
    res.writeHead(404, {
      'Content-Type': MIME['.html'],
      'Content-Length': page.length,
      'Cache-Control': 'no-store',
      ...SECURITY_HEADERS,
    });
    return res.end(page);
  } catch {
    return sendText(res, 404, 'not found');
  }
}

/* ─────────────────────────── request router ─────────────────────────── */

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  try {
    if (url.pathname === '/healthz') {
      const state = broadcastState();
      return sendJson(res, 200, {
        status: 'ok',
        mode: 'prototype',
        onAir: state?.now.track.title ?? null,
        listeners: state?.station.listeners ?? 0,
        uptimeSeconds: Math.round(process.uptime()),
      });
    }

    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);

    // Pretty permalinks: /track/<id> is served by the track page (M2 renders its OG tags server-side)
    if (/^\/track\/ar_[A-Za-z0-9]+\/?$/.test(url.pathname)) {
      return await serveStatic(req, res, new URL('/track/index.html', 'http://localhost'));
    }

    return await serveStatic(req, res, url);
  } catch (error) {
    console.error(`✗ ${req.method} ${url.pathname} → ${error.message}`);
    return sendJson(res, 500, { error: 'internal-error' });
  }
});

await loadLibrary().catch((error) => {
  console.error(
    `✗ could not read the library index (${path.relative(ROOT, config.libraryIndex)}): ${error.message}`,
  );
  console.error('  Run `npm run import` first — it scans your music folder and writes the index.');
  process.exit(1);
});

server.listen(config.port, () => {
  const state = broadcastState();
  console.log('\n  ANOMALRADIO · prototype server');
  console.log('  ─────────────────────────────────────────────');
  console.log(`  local       http://localhost:${config.port}/`);
  console.log(
    `  library     ${path.relative(ROOT, config.libraryIndex)} (${libraryCache.data?.trackCount ?? '?'} tracks)`,
  );
  console.log(
    `  audio       ${path.relative(ROOT, config.librarySource)} — DEV ONLY (M2 moves this to private storage)`,
  );
  console.log(`  clock       ×${config.timeScale}${config.timeScale === 1 ? ' (real time)' : ''}`);
  if (state) {
    console.log(
      `  on air now  ${state.now.track.artist} — ${state.now.track.title} (${mmss(state.now.elapsedMs)} in)`,
    );
    console.log(`  next        ${state.next?.track.title ?? '—'}`);
    console.log(`  listeners   ${state.station.listeners} (simulated)`);
  }
  console.log('');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log('\n  shutting down prototype server');
    server.close(() => process.exit(0));
  });
}
