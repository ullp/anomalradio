/* ═══════════════════════════════════════════════════════════════════════
   ANOMALRADIO · api.js — the only place that talks to the backend.
   Contract is the one described in _data/design-offer.md §5.2. Audio is never
   a static URL: a short-lived token is minted per track, then the stream is
   requested through /api/stream/:id — the M2 backend keeps the same shape.
   ═══════════════════════════════════════════════════════════════════════ */

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

export const getPlaylist = (params = {}) => {
  const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v));
  return request(`/api/playlist${query.size ? `?${query}` : ''}`);
};

export const getTrack = (id) => request(`/api/tracks/${encodeURIComponent(id)}`);
export const getNowPlaying = () => request('/api/now-playing');
export const getRadio = () => request('/api/radio');
export const getHistory = () => request('/api/now-playing').then((state) => state.history ?? []);

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
 */
export function subscribeNowPlaying(onState, onError = () => {}) {
  let source = null;
  let poller = null;
  let closed = false;

  const startPolling = () => {
    if (poller || closed) return;
    const tick = async () => {
      try {
        onState(await getNowPlaying(), 'poll');
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
