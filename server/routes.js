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
import {
  broadcastState,
  catalogue,
  favouritesFor,
  getTrack,
  isStarred,
  listTracks,
  recordShare,
  sanitizeTrack,
  starTrack,
  unstarTrack,
} from './library.js';
import { normalizeEmail, getAccounts } from './accounts.js';
import { injectMeta, metaFor, metaForTrack, PAGE_META } from './render.js';
import { notFound, parseRange, readJson, sendJson, sendText, serveStatic } from './http.js';

/** ⇪ channels the UI can report. Anything else is counted as `unknown` rather than trusted. */
const SHARE_CHANNELS = new Set([
  'x',
  'facebook',
  'whatsapp',
  'telegram',
  'reddit',
  'linkedin',
  'mastodon',
  'mail',
  'copy',
  'native',
  'qr',
]);

const AUDIO_HEADERS = {
  'Content-Type': 'audio/mpeg',
  'Cache-Control': 'no-store, private',
  'Content-Disposition': 'inline',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'Accept-Ranges': 'bytes',
};

export function createRouter({
  security,
  tokens = getTokenService(),
  storage = getStorage(),
  radio = null,
  accounts = getAccounts(),
} = {}) {
  const sseClients = new Set();
  let lastTrackId = null;

  /**
   * The continuous mount (M3). Same gates as a track stream, but the response never ends: the pump
   * keeps writing whatever the schedule says is on air, so there is no per-track resource to save.
   */
  async function handleMount(req, res, url) {
    if (!radio) return sendJson(res, 503, { error: 'stream-not-configured' });
    if (security.userAgentBlocked(req)) return sendJson(res, 403, { error: 'blocked-user-agent' });
    // A desktop player sends no Referer at all — that is not a foreign referer, it is just VLC.
    // The real anti-hotlink gate is `/api/session`, which still requires a browser context, and a
    // token is bound to the address that requested it, so one cannot be handed on to other people.
    if (security.foreignReferer(req)) return sendJson(res, 403, { error: 'forbidden-origin' });
    if (security.audioRateLimited(req)) return sendJson(res, 429, { error: 'rate-limited' });

    const verdict = tokens.verify({
      token: url.searchParams.get('t'),
      trackId: null,
      ipHash: security.ipHash(req),
      uaHash: security.uaHash(req),
    });
    if (!verdict.ok) return sendJson(res, 403, { error: 'stream-denied', reason: verdict.reason });

    if (!security.streamSlotAvailable(req)) return sendJson(res, 429, { error: 'too-many-streams' });
    const release = security.acquireStream(req);
    res.on('close', release);

    radio.addListener(req, res);
    return undefined;
  }

  /**
   * `.pls` / `.m3u` station files, for VLC, foobar and friends.
   *
   * This is the one place a token is issued without a browser fingerprint, and it has to be: the
   * player fetches the mount itself, with its own User-Agent and no Referer at all, so a
   * browser-bound token would make the file useless. What still holds:
   *   · the User-Agent denylist — these are for players, not for rippers;
   *   · the IP binding, so a station file copied elsewhere does not work;
   *   · a foreign referer is still refused, so the station cannot be embedded on someone
   *     else's page. A *missing* referer is not a foreign one: that is simply a player.
   */
  function handleStationFile(req, res, pathname, origin) {
    if (security.userAgentBlocked(req)) return sendText(res, 403, 'forbidden');
    if (security.foreignReferer(req)) return sendText(res, 403, 'forbidden');
    if (security.sessionRateLimited(req)) return sendText(res, 429, 'too many requests');

    const issued = tokens.issue({
      trackId: null,
      ipHash: security.ipHash(req),
      uaHash: '', // no browser binding — see above
      ttlSeconds: config.radioTokenTtlSeconds,
    });
    const url = `${origin}${config.mountPath}?t=${encodeURIComponent(issued.token)}`;

    if (pathname.endsWith('.m3u')) {
      return sendText(
        res,
        200,
        `#EXTM3U\n#EXTINF:-1,Anomalradio — own music only\n${url}\n`,
        'audio/x-mpegurl',
      );
    }
    return sendText(
      res,
      200,
      `[playlist]\nnumberofentries=1\nFile1=${url}\nTitle1=Anomalradio — own music only\nLength1=-1\nversion=2\n`,
      'audio/x-scpls',
    );
  }

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
        dev: !config.isProduction,
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
      // `starred` is per caller — offer §5.2 — so the page renders the right star without a second
      // request. The owner cookie is not minted here: reading must not have side effects.
      const { ownerKey } = accounts.ownerFor(req);
      return sendJson(res, 200, {
        dev: !config.isProduction,
        track: { ...sanitizeTrack(track), starred: isStarred(ownerKey, track.id) },
        album: catalogue().album,
      });
    }

    // GET /api/now-playing
    if (resource === 'now-playing' && !param && req.method === 'GET') {
      const state = broadcastState();
      if (!state) return sendJson(res, 503, { error: 'no-tracks-published' });
      // The real count comes from open mount connections; the schedule's number is the fallback.
      if (radio) {
        state.station.listeners = radio.listenerCount();
        state.station.streaming = true;
        state.station.pumping = radio.nowPlaying()?.pumping ?? false;
      }
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
        dev: !config.isProduction,
        token: issued.token,
        expiresAt: issued.expiresAt,
        ttlSeconds: issued.ttlSeconds,
        maxStreamsPerIp: security.limits.maxStreamsPerIp,
      });
    }

    // GET /api/radio — what live mode needs: the mount and a token for it
    if (resource === 'radio' && req.method === 'GET') {
      if (security.userAgentBlocked(req)) return sendJson(res, 403, { error: 'blocked-user-agent' });
      if (!security.originAllowed(req)) return sendJson(res, 403, { error: 'forbidden-origin' });

      const state = broadcastState();
      if (!state) return sendJson(res, 503, { error: 'no-tracks-published' });

      // A listener holds one long connection, so the mount token outlives the per-track one. It is
      // still bound to this IP and browser, and still expires.
      const issued = tokens.issue({
        trackId: null,
        ipHash: security.ipHash(req),
        uaHash: security.uaHash(req),
        ttlSeconds: config.radioTokenTtlSeconds,
      });

      const onAir = radio?.nowPlaying();
      return sendJson(res, 200, {
        dev: !config.isProduction,
        streaming: Boolean(radio),
        station: { ...state.station, listeners: radio ? radio.listenerCount() : state.station.listeners },
        now: state.now,
        next: state.next,
        mount: config.mountPath,
        url: `${config.mountPath}?t=${encodeURIComponent(issued.token)}`,
        bitrate: config.streamBitrate,
        tokenExpiresAt: issued.expiresAt,
        pumping: onAir?.pumping ?? false,
      });
    }

    /* ── accounts (M4): a sign-in link instead of a password ── */

    // POST /api/auth/magic-link — { email } → e-mail a single-use link
    if (resource === 'auth' && param === 'magic-link' && req.method === 'POST') {
      if (security.userAgentBlocked(req)) return sendJson(res, 403, { error: 'blocked-user-agent' });
      if (security.foreignReferer(req)) return sendJson(res, 403, { error: 'forbidden-origin' });
      if (security.rateLimited(`magic:${security.ipHash(req)}`, config.accounts.requestRateLimit)) {
        return sendJson(res, 429, { error: 'rate-limited' });
      }

      let body;
      try {
        body = await readJson(req);
      } catch (error) {
        return sendJson(res, 400, { error: error.message });
      }

      const { ownerKey, setCookie } = accounts.ownerFor(req);
      const result = await accounts.requestMagicLink({
        email: body.email,
        ownerKey,
        ipHash: security.ipHash(req),
      });
      if (!result.ok) {
        return sendJson(res, result.reason === 'rate-limited' ? 429 : 400, { error: result.reason });
      }

      // The same answer whether or not the address already has an account: this endpoint must not
      // be usable to find out who is registered.
      return sendJson(
        res,
        200,
        {
          ok: true,
          sentTo: normalizeEmail(body.email),
          expiresAt: result.expiresAt,
          link: result.link, // development only; null in production
        },
        setCookie ? { 'Set-Cookie': setCookie } : {},
      );
    }

    // GET /api/auth/verify?token=… — the link from the e-mail. Consumes it, sets the session cookie.
    if (resource === 'auth' && param === 'verify' && req.method === 'GET') {
      const result = accounts.verifyMagicLink(url.searchParams.get('token'));
      const location = result.ok
        ? '/favourites/?signed-in=1'
        : `/favourites/?sign-in-failed=${encodeURIComponent(result.reason)}`;
      res.writeHead(302, {
        Location: location,
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex, nofollow',
        ...(result.ok ? { 'Set-Cookie': accounts.sessionCookie(result.sessionToken) } : {}),
      });
      return res.end();
    }

    // GET /api/auth/session — is anyone signed in, and as whom?
    if (resource === 'auth' && param === 'session' && req.method === 'GET') {
      const user = accounts.sessionUser(req);
      return sendJson(res, 200, {
        dev: !config.isProduction,
        signedIn: Boolean(user),
        email: user?.email ?? null,
      });
    }

    // POST /api/auth/logout
    if (resource === 'auth' && param === 'logout' && req.method === 'POST') {
      accounts.signOut(req);
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': accounts.clearSessionCookie() });
    }

    /* ── ★ favourites (M4) — the same endpoints signed out (anonymous cookie) and signed in ── */

    if (resource === 'favourites') {
      const { ownerKey, user, setCookie } = accounts.ownerFor(req);
      const cookie = setCookie ? { 'Set-Cookie': setCookie } : {};

      if (!param && req.method === 'GET') {
        const tracks = favouritesFor(ownerKey);
        return sendJson(
          res,
          200,
          {
            dev: !config.isProduction,
            signedIn: Boolean(user),
            email: user?.email ?? null,
            count: tracks.length,
            tracks,
          },
          cookie,
        );
      }

      if (!param && req.method === 'POST') {
        if (security.rateLimited(`write:${security.ipHash(req)}`, config.writeRateLimit)) {
          return sendJson(res, 429, { error: 'rate-limited' });
        }
        let body;
        try {
          body = await readJson(req);
        } catch (error) {
          return sendJson(res, 400, { error: error.message });
        }
        const track = getTrack(body.trackId);
        if (!track) return sendJson(res, 404, { error: 'track-not-found' });
        return sendJson(res, 200, { ...starTrack(ownerKey, track.id), trackId: track.id }, cookie);
      }

      if (param && req.method === 'DELETE') {
        if (security.rateLimited(`write:${security.ipHash(req)}`, config.writeRateLimit)) {
          return sendJson(res, 429, { error: 'rate-limited' });
        }
        return sendJson(res, 200, { ...unstarTrack(ownerKey, param), trackId: param }, cookie);
      }
    }

    // POST /api/tracks/:id/share — ⇪ count. The share itself happens in the browser; this is the tally.
    if (resource === 'tracks' && param && req.method === 'POST' && url.pathname.endsWith('/share')) {
      if (security.rateLimited(`share:${security.ipHash(req)}`, config.writeRateLimit)) {
        return sendJson(res, 429, { error: 'rate-limited' });
      }
      let body;
      try {
        body = await readJson(req);
      } catch (error) {
        return sendJson(res, 400, { error: error.message });
      }
      const track = getTrack(param);
      if (!track) return sendJson(res, 404, { error: 'track-not-found' });
      const channel = SHARE_CHANNELS.has(String(body.channel ?? '')) ? String(body.channel) : 'unknown';
      return sendJson(res, 200, { ...recordShare(track.id, channel), trackId: track.id, channel });
    }

    // GET /api/preview/:id — the public excerpt. No token: see handlePreview for why.
    if (resource === 'preview' && param && req.method === 'GET') {
      return handlePreview(req, res, param);
    }

    // GET /api/stream/:id?t=… — audio, behind every gate
    if (resource === 'stream' && param && req.method === 'GET') {
      return handleStream(req, res, url, param);
    }

    return sendJson(res, 404, { error: 'unknown-endpoint', path: url.pathname });
  }

  /**
   * GET /api/preview/:id — the short excerpt (M4).
   *
   * The one audio route with no stream token, and that is a decision rather than an oversight: a
   * preview exists to be heard by people who have never been to the site — it is what a share card
   * plays — so a browser-context gate would defeat the point of having one. What protects the music
   * is that this is not the music: 30 s, 96 kbps mono, faded out, generated separately from the
   * master. The master keeps every gate; see handleStream above.
   */
  async function handlePreview(req, res, trackId) {
    if (security.userAgentBlocked(req)) return sendJson(res, 403, { error: 'blocked-user-agent' });
    if (security.rateLimited(`preview:${security.ipHash(req)}`, config.preview.rateLimit)) {
      return sendJson(res, 429, { error: 'rate-limited' });
    }

    const track = getTrack(trackId);
    if (!track?.previewKey) return sendJson(res, 404, { error: 'preview-not-found' });

    const info = await storage.stat(track.previewKey).catch(() => null);
    if (!info) return sendJson(res, 404, { error: 'preview-not-found' });

    const range = parseRange(req.headers.range, info.size);
    if (range === 'unsatisfiable') {
      res.writeHead(416, { 'Content-Range': `bytes */${info.size}` });
      return res.end();
    }

    let stream;
    try {
      stream = await storage.createReadStream(track.previewKey, range ?? {});
    } catch (error) {
      console.error(`✗ preview read failed for ${trackId}: ${error.message}`);
      return sendJson(res, 503, { error: 'audio-unavailable' });
    }

    const headers = {
      'Content-Type': 'audio/mpeg',
      // Public and small, so it may be cached briefly — but only briefly: the file changes only at
      // import, and a stale preview after re-importing would be confusing.
      'Cache-Control': 'public, max-age=300',
      'Content-Disposition': 'inline',
      'X-Robots-Tag': 'noindex, nofollow',
      'Accept-Ranges': 'bytes',
    };

    if (range) {
      res.writeHead(206, {
        ...headers,
        'Content-Range': `bytes ${range.start}-${range.end}/${info.size}`,
        'Content-Length': range.end - range.start + 1,
      });
    } else {
      res.writeHead(200, { ...headers, 'Content-Length': info.size });
    }

    stream.on('error', () => res.destroy());
    return stream.pipe(res);
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
        mode: 'station',
        storage: storage.driver,
        streaming: Boolean(radio),
        onAir: state?.now.track.title ?? null,
        // The real number of open mount connections, not a simulation.
        listeners: radio ? radio.listenerCount() : (state?.station.listeners ?? 0),
        uptimeSeconds: Math.round(process.uptime()),
      });
    }

    // The continuous mount lives at the site root, like a real station's stream URL.
    if (url.pathname === config.mountPath && req.method === 'GET') return handleMount(req, res, url);
    if ((url.pathname === '/radio.pls' || url.pathname === '/radio.m3u') && req.method === 'GET') {
      return handleStationFile(req, res, url.pathname, origin);
    }

    if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
    return handlePage(req, res, url, origin);
  }

  return { handle, close, stats: () => ({ sseClients: sseClients.size }) };
}

function sendEvent(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
