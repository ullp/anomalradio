/* ═══════════════════════════════════════════════════════════════════════
   ANOMALRADIO · store.js — client state: favourites (★), basket (🛒),
   volume, play mode. Persisted in localStorage plus an anonymous owner key
   cookie, exactly as described in the offer §8.1 (v1: no login required;
   M4/M8 can claim these rows into a real account later).
   ═══════════════════════════════════════════════════════════════════════ */

const STORAGE_KEY = 'anomalradio.v1';

const defaults = {
  favourites: [], // [{ id, title, artist, durationMs, priceCents, currency }]
  cart: [],
  volume: 0.8,
  mode: 'live', // 'live' | 'ondemand'
  recent: [], // locally played track ids, most recent first
};

function read() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? { ...defaults, ...JSON.parse(raw) } : { ...defaults };
  } catch {
    return { ...defaults };
  }
}

const state = read();
const listeners = new Set();

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* private mode / quota — the session still works in memory */
  }
  for (const listener of listeners) listener(state);
}

export const getState = () => state;

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Anonymous owner key — lets the server associate favourites/cart before login exists. */
export function ownerKey() {
  const name = 'anomalradio_owner';
  const existing = document.cookie.split('; ').find((c) => c.startsWith(`${name}=`));
  if (existing) return existing.split('=')[1];
  const value = `own_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
  document.cookie = `${name}=${value}; path=/; max-age=${60 * 60 * 24 * 365}; SameSite=Lax`;
  return value;
}

/* ─────────────────────────── favourites ─────────────────────────── */

const slim = (track) => ({
  id: track.id,
  title: track.title,
  artist: track.artist,
  album: track.album ?? null,
  year: track.year ?? null,
  genre: track.genre ?? null,
  bpm: track.bpm ?? null,
  durationMs: track.durationMs,
  priceCents: track.priceCents ?? null,
  currency: track.currency ?? 'EUR',
});

export const isFavourite = (id) => state.favourites.some((t) => t.id === id);

export function toggleFavourite(track) {
  const index = state.favourites.findIndex((t) => t.id === track.id);
  if (index >= 0) state.favourites.splice(index, 1);
  else state.favourites.unshift(slim(track));
  persist();
  return isFavourite(track.id);
}

export const favourites = () => state.favourites;
export const clearFavourites = () => {
  state.favourites = [];
  persist();
};

/* ─────────────────────────── basket ─────────────────────────── */

export const isInCart = (id) => state.cart.some((t) => t.id === id);

export function toggleCart(track) {
  const index = state.cart.findIndex((t) => t.id === track.id);
  if (index >= 0) state.cart.splice(index, 1);
  else state.cart.unshift(slim(track));
  persist();
  return isInCart(track.id);
}

export const cart = () => state.cart;
export const cartTotal = () => state.cart.reduce((sum, item) => sum + (item.priceCents ?? 0), 0);
export const clearCart = () => {
  state.cart = [];
  persist();
};

/* ─────────────────────────── player prefs ─────────────────────────── */

export const volume = () => state.volume;
export const setVolume = (value) => {
  state.volume = Math.min(1, Math.max(0, value));
  persist();
};

export const mode = () => state.mode;
export const setMode = (value) => {
  state.mode = value;
  persist();
};

export const recentlyPlayed = () => state.recent;

export function pushRecent(trackId) {
  state.recent = [trackId, ...state.recent.filter((id) => id !== trackId)].slice(0, 30);
  persist();
}

/* ─────────────────────────── M3U export ─────────────────────────── */

/**
 * Favourites export. Deliberately writes the *page* URLs, never the audio
 * stream: an M3U that pointed at files would defeat the whole protection model.
 */
export function favouritesAsM3U() {
  const lines = ['#EXTM3U', '# Anomalradio.com — favourites'];
  for (const track of state.favourites) {
    lines.push(`#EXTINF:${Math.round(track.durationMs / 1000)},${track.artist} - ${track.title}`);
    lines.push(`${location.origin}/track/${track.id}`);
  }
  return `${lines.join('\n')}\n`;
}
