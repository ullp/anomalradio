/* ═══════════════════════════════════════════════════════════════════════
   ANOMALRADIO · api.js — the only place that talks to the backend.
   Contract is the one described in _data/design-offer.md §5.2. Audio is never
   a static URL: a short-lived token is minted per track, then the stream is
   requested through /api/stream/:id.

   STATIC MODE
   A file-only host (GitHub Pages, or the shared host) publishes a generated
   snapshot with `data/playlist.json` instead of an API. When `/api/*` is not
   there, the client falls back to that file, renders the real catalogue, and
   says plainly that playback needs the station server — rather than showing a
   broken player. `isStatic()` tells the UI which world it is in.
   ═══════════════════════════════════════════════════════════════════════ */

const STATIC_PLAYLIST = '/data/playlist.json';

let staticMode = null; // null = not decided yet, then true/false

export const isStatic = () => staticMode === true;

async function request(path, options = {}) {
  const res = await fetch(path, { credentials: 'same-origin', ...options });
  if (!res.ok) {
    let detail = {};
    try {
      detail = await res.json();
    } catch {
      /* non-JSON error body */
    }
    const error = new Error(detail.error ?? `request failed (${res.status})`);
    error.status = res.status;
    error.detail = detail;
    throw error;
  }
  return res.json();
}

/** The published snapshot, if this host has one. */
async function staticPlaylist(params = {}) {
  const data = await request(STATIC_PLAYLIST);
  let tracks = data.tracks ?? [];
  const query = (params.q ?? '').trim().toLowerCase();

  if (query) {
    tracks = tracks.filter((track) =>
      [track.title, track.artist, track.album, track.genre]
        .filter(Boolean)
        .some((value) => value.toLowerCase().includes(query)),
    );
  }
  if (params.genre) tracks = tracks.filter((track) => track.genre === params.genre);
  if (params.sort === 'title') tracks = [...tracks].sort((a, b) => a.title.localeCompare(b.title, 'en'));
  if (params.sort === 'duration') tracks = [...tracks].sort((a, b) => a.durationMs - b.durationMs);
  if (params.sort === 'bpm') tracks = [...tracks].sort((a, b) => (a.bpm ?? 9999) - (b.bpm ?? 9999));

  return { ...data, trackCount: tracks.length, tracks };
}

/**
 * Catalogue. Falls back to the static snapshot when there is no API — and remembers which world we
 * are in, so the rest of the app stops asking for things that cannot exist here.
 */
export async function getPlaylist(params = {}) {
  const query = new URLSearchParams(Object.entries(params).filter(([, value]) => value));
  try {
    const data = await request(`/api/playlist${query.size ? `?${query}` : ''}`);
    staticMode = false;
    return data;
  } catch (error) {
    if (staticMode === false) throw error;
    try {
      const data = await staticPlaylist(params);
      staticMode = true;
      return data;
    } catch {
      staticMode = false;
      throw error;
    }
  }
}

export async function getTrack(id) {
  if (isStatic()) {
    const { tracks } = await request(STATIC_PLAYLIST);
    const track = tracks.find((candidate) => candidate.id === id);
    if (!track) throw new Error('track-not-found');
    return { track, album: null, static: true };
  }
  return request(`/api/tracks/${encodeURIComponent(id)}`);
}

/** `null` in static mode: there is no broadcast clock without the server. */
export const getNowPlaying = () => (isStatic() ? Promise.resolve(null) : request('/api/now-playing'));

export const getRadio = () => (isStatic() ? Promise.resolve(null) : request('/api/radio'));

export const getHistory = async () => (await getNowPlaying())?.history ?? [];

/** Mint a stream token (optionally bound to a single track id). */
export const createSession = (trackId = null) =>
  request(`/api/session${trackId ? `?track=${encodeURIComponent(trackId)}` : ''}`);

/** Token → protected stream URL. Tokens live ~120 s, so they are minted per track start. */
export async function streamUrlFor(trackId) {
  const { token } = await createSession(trackId);
  return `/api/stream/${encodeURIComponent(trackId)}?t=${encodeURIComponent(token)}`;
}

/**
 * Live now-playing feed. Server-sent events with an automatic polling fallback
 * (so the UI keeps working behind proxies that buffer streams).
 * In static mode there is nothing to subscribe to, and no error is reported.
 */
export function subscribeNowPlaying(onState, onError = () => {}) {
  if (isStatic()) return () => {};

  let source = null;
  let poller = null;
  let closed = false;

  const startPolling = () => {
    if (poller || closed) return;
    const tick = async () => {
      try {
        const state = await getNowPlaying();
        if (state) onState(state, 'poll');
      } catch (error) {
        onError(error);
      }
    };
    tick();
    poller = setInterval(tick, 15000);
  };

  try {
    source = new EventSource('/api/now-playing/stream');
    source.addEventListener('track', (event) => onState(JSON.parse(event.data), 'track'));
    source.addEventListener('tick', (event) => onState(JSON.parse(event.data), 'tick'));
    source.addEventListener('error', () => {
      // EventSource retries by itself; if it stays broken, fall back to polling.
      if (source.readyState === EventSource.CLOSED) {
        source.close();
        startPolling();
      }
    });
  } catch {
    startPolling();
  }

  return () => {
    closed = true;
    source?.close();
    if (poller) clearInterval(poller);
  };
}

/* ═══════════════════════════════════════════════════════════════════════
   M4 — accounts, ★ favourites, ⇄ shares, previews.
   Favourites work signed out (an anonymous owner cookie) and signed in (an
   account): the same endpoints either way, and the server becomes the
   authority once a page has synced. Sign-in is a magic link — there is no
   password anywhere to leak.
   ═══════════════════════════════════════════════════════════════════════ */

const json = (method, body) => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

/** The caller's stars: `{ signedIn, email, count, tracks }`. */
export const getFavourites = () =>
  isStatic()
    ? Promise.resolve({ signedIn: false, email: null, count: 0, tracks: [] })
    : request('/api/favourites');

export const starTrack = (trackId) => request('/api/favourites', json('POST', { trackId }));

export const unstarTrack = (trackId) =>
  request(`/api/favourites/${encodeURIComponent(trackId)}`, { method: 'DELETE' });

/** Count a share. The sharing happens in the browser; this is the tally. */
export const reportShare = (trackId, channel) =>
  request(`/api/tracks/${encodeURIComponent(trackId)}/share`, json('POST', { channel }));

/** Who is signed in, if anyone. */
export const getAccount = () =>
  isStatic() ? Promise.resolve({ signedIn: false, email: null }) : request('/api/auth/session');

/** Ask for a sign-in link. Outside production the response carries the link, for convenience. */
export const requestSignInLink = (email) => request('/api/auth/magic-link', json('POST', { email }));

export const signOut = () => request('/api/auth/logout', { method: 'POST' });

/**
 * The short public excerpt — the one audio URL that needs no token, because a preview exists to be
 * heard by people who are not on the site yet. Thirty seconds of 96 kbps mono, not the master.
 */
export const previewUrl = (trackId) => `/api/preview/${encodeURIComponent(trackId)}`;
