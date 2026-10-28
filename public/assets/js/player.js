/* ═══════════════════════════════════════════════════════════════════════
   ANOMALRADIO · player.js — one audio engine, two modes, one docked bar.

   MODE "live"      joins the broadcast at the position it is on air right now
                    (mid-track) and follows track changes pushed by the server.
                    This is what SomaFM feels like. In M3 the source becomes a
                    single continuous Icecast mount instead of
                    "current track + seek offset".
   MODE "ondemand"  plays a chosen track from the beginning and continues
                    through the library, minting a fresh stream token per track
                    (tokens live ~120 s, so they cannot be shared).

   Audio never has a permanent URL: src is set to /api/stream/:id?t=<token>.
   ═══════════════════════════════════════════════════════════════════════ */

import * as api from './api.js';
import * as store from './store.js';
import { h, icon, fmtTime, toast, qs } from './ui.js';
import { coverArt } from './cover.js';
import { attachAudio, resumeAudioContext } from './visualizer.js';
import { openShare, copyTrackLink } from './share.js';

/* ─────────────────────────── engine state ─────────────────────────── */

const audio = new Audio();
audio.preload = 'metadata';
audio.volume = store.volume();

const events = new Set();
export const onPlayer = (fn) => {
  events.add(fn);
  return () => events.delete(fn);
};
const emit = (name, payload) => {
  for (const fn of events) fn(name, payload);
};

let current = null;
let queue = [];
let mode = store.mode();
let liveState = null;
let bar = null;
let staticPreview = false;

export const currentTrack = () => current;
export const isPlaying = () => !audio.paused && !audio.ended;
export const getMode = () => mode;
export const getLiveState = () => liveState;
export const audioElement = () => audio;

/* ─────────────────────────── playback ─────────────────────────── */

function seekWhenReady(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return;
  if (audio.readyState >= 1) audio.currentTime = seconds;
  else
    audio.addEventListener(
      'loadedmetadata',
      () => {
        audio.currentTime = seconds;
      },
      { once: true },
    );
}

async function start(track, { startAtMs = 0, nextMode = mode, autoplay = true } = {}) {
  if (!track) return;
  mode = nextMode;
  store.setMode(mode);
  current = track;

  try {
    const url = await api.streamUrlFor(track.id);
    audio.src = url;
    seekWhenReady(startAtMs / 1000);
    attachAudio(audio);
    resumeAudioContext();
    if (autoplay) await audio.play();
    store.pushRecent(track.id);
    updateBar();
    setMediaSession(track);
    emit('track', { track, mode, startAtMs });
  } catch (error) {
    updateBar();
    if (error.name === 'NotAllowedError') {
      // Browser refused autoplay without a gesture — expected; UI stays paused.
      toast('Press play to start listening', { iconName: 'info' });
    } else {
      toast(`Playback failed: ${error.message}`, { iconName: 'info' });
    }
    emit('error', error);
  }
}

/**
 * Tune in to the continuous mount (M3).
 *
 * One request, one endless stream: the client never switches sources and never holds a per-track
 * URL. The schedule feed only updates the metadata (title, elapsed, listeners).
 */
export async function tuneIn() {
  if (staticPreview) return explainStaticMode();
  try {
    const radio = await api.getRadio();
    if (!radio?.url) {
      toast('The station is not streaming right now', { iconName: 'info' });
      return undefined;
    }

    mode = 'live';
    store.setMode('live');
    current = radio.now?.track ?? current;
    liveState = { station: radio.station, now: radio.now, next: radio.next, history: liveState?.history ?? [] };

    audio.src = radio.url;
    attachAudio(audio);
    resumeAudioContext();
    await audio.play();

    updateBar();
    if (current) setMediaSession(current);
    emit('track', { track: current, mode: 'live', startAtMs: radio.now?.elapsedMs ?? 0 });
    toast('Tuned in · live', { iconName: 'radio' });
    return undefined;
  } catch (error) {
    toast(`Could not tune in: ${error.message}`, { iconName: 'info' });
    return undefined;
  }
}

/** Play one specific track from the start (library, favourites, permalink). */
export async function playTrack(track, options = {}) {
  if (staticPreview) return explainStaticMode();
  const list = options.queue ?? queue;
  queue = list.length ? [...list] : [track];
  const index = queue.findIndex((t) => t.id === track.id);
  if (index > 0) queue = [...queue.slice(index), ...queue.slice(0, index)];
  await start(track, { startAtMs: 0, nextMode: 'ondemand' });
}

/**
 * A file-only host has no stream endpoint, so say what is missing instead of failing obscurely.
 * The catalogue, the pages and the share cards still work.
 */
function explainStaticMode() {
  toast('Playback needs the station server — this host only serves files', {
    iconName: 'info',
    actionLabel: 'Why?',
    onAction: () => window.location.assign('/about/#deployment'),
    timeout: 8000,
  });
  return undefined;
}

export async function toggle() {
  if (!current) return tuneIn();
  if (audio.paused) {
    resumeAudioContext();
    await audio.play().catch(() => {});
  } else {
    audio.pause();
  }
  updateBar();
  return undefined;
}

export async function next() {
  if (mode === 'live') return tuneIn();
  const index = queue.findIndex((t) => t.id === current?.id);
  const upcoming = queue[index + 1] ?? queue[0];
  return upcoming ? start(upcoming, { nextMode: 'ondemand' }) : undefined;
}

export async function previous() {
  if (mode === 'live') return tuneIn();
  if (audio.currentTime > 4) {
    audio.currentTime = 0;
    return undefined;
  }
  const index = queue.findIndex((t) => t.id === current?.id);
  const target = queue[index - 1] ?? queue[queue.length - 1];
  return target ? start(target, { nextMode: 'ondemand' }) : undefined;
}

export function seekTo(seconds) {
  if (mode === 'live') return; // live radio cannot be seeked
  if (Number.isFinite(seconds)) audio.currentTime = Math.max(0, seconds);
  updateBar();
}

export function setVolume(value) {
  const level = Math.min(1, Math.max(0, value));
  audio.volume = level;
  store.setVolume(level);
  updateBar();
}

export const getVolume = () => audio.volume;

export function setMode(nextMode) {
  mode = nextMode;
  store.setMode(nextMode);
  updateBar();
  emit('mode', nextMode);
}

/* ─────────────────────────── media session ─────────────────────────── */

function setMediaSession(track) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: track.title,
    artist: track.artist,
    album: track.album ?? 'Anomalradio',
    artwork: [{ src: coverArt(track, 512), sizes: '512x512', type: 'image/svg+xml' }],
  });
  navigator.mediaSession.setActionHandler('play', () => toggle());
  navigator.mediaSession.setActionHandler('pause', () => toggle());
  navigator.mediaSession.setActionHandler('nexttrack', () => next());
  navigator.mediaSession.setActionHandler('previoustrack', () => previous());
}

/* ─────────────────────────── the docked bar ─────────────────────────── */

function mountBar() {
  const idleCover = { id: 'anomalradio-idle', title: 'A' };
  const barCover = h(
    'div',
    { class: 'cover cover--sm' },
    h('img', { alt: '', src: coverArt(idleCover, 120) }),
  );

  const el = h(
    'div',
    { class: 'player-bar', id: 'player-bar' },
    h(
      'div',
      { class: 'container player-bar__inner' },
      // ── now playing ──
      h(
        'div',
        { class: 'player-bar__now' },
        barCover,
        h(
          'div',
          { class: 'player-bar__meta' },
          h('div', { class: 'player-bar__title', id: 'bar-title', textContent: 'Not playing' }),
          h(
            'div',
            { class: 'player-bar__sub' },
            h(
              'span',
              { class: 'pill pill--live', id: 'bar-mode', hidden: true },
              h('span', { class: 'live-dot' }),
              'LIVE',
            ),
            h('span', { id: 'bar-sub', textContent: 'press tune in' }),
          ),
        ),
      ),
      // ── transport + seek ──
      h(
        'div',
        { class: 'player-bar__center' },
        h(
          'div',
          { class: 'player-bar__transport' },
          h('button', {
            class: 'btn btn--icon btn--sm',
            type: 'button',
            'aria-label': 'Previous',
            id: 'bar-prev',
            html: icon('prev'),
          }),
          h('button', {
            class: 'btn btn--play',
            type: 'button',
            'aria-label': 'Play',
            id: 'bar-play',
            html: icon('play'),
          }),
          h('button', {
            class: 'btn btn--icon btn--sm',
            type: 'button',
            'aria-label': 'Next',
            id: 'bar-next',
            html: icon('next'),
          }),
        ),
        h(
          'div',
          { class: 'seek', id: 'bar-seek' },
          h('div', { class: 'seek__track' }, h('div', { class: 'seek__fill', id: 'bar-fill' })),
          h('input', {
            type: 'range',
            min: '0',
            max: '1000',
            value: '0',
            step: '1',
            'aria-label': 'Seek',
            id: 'bar-range',
          }),
        ),
        h(
          'div',
          { class: 'player-bar__time' },
          h('span', { id: 'bar-elapsed', textContent: '0:00' }),
          h('span', { class: 'grow' }),
          h('span', { id: 'bar-duration', textContent: '--:--' }),
        ),
      ),
      // ── volume + actions ──
      h(
        'div',
        { class: 'player-bar__right' },
        h(
          'div',
          { class: 'volume' },
          h('button', {
            class: 'btn btn--icon btn--sm',
            type: 'button',
            'aria-label': 'Mute',
            id: 'bar-mute',
            html: icon('volume'),
          }),
          h('input', {
            type: 'range',
            min: '0',
            max: '100',
            value: String(Math.round(audio.volume * 100)),
            'aria-label': 'Volume',
            id: 'bar-volume',
          }),
        ),
        h('button', {
          class: 'btn btn--icon btn--sm',
          type: 'button',
          'aria-label': 'Add to favourites',
          id: 'bar-star',
          html: icon('star'),
        }),
        h('button', {
          class: 'btn btn--icon btn--sm',
          type: 'button',
          'aria-label': 'Add to basket',
          id: 'bar-cart',
          html: icon('cart'),
        }),
        h('button', {
          class: 'btn btn--icon btn--sm',
          type: 'button',
          'aria-label': 'Share',
          id: 'bar-share',
          html: icon('share'),
        }),
        h('a', {
          class: 'btn btn--icon btn--sm',
          href: '/player/?popup=1',
          target: '_blank',
          rel: 'noopener',
          'aria-label': 'Open popup player',
          html: icon('external'),
        }),
      ),
    ),
  );

  document.body.append(el);

  bar = {
    root: el,
    cover: qs('img', barCover),
    title: qs('#bar-title'),
    modePill: qs('#bar-mode'),
    sub: qs('#bar-sub'),
    play: qs('#bar-play'),
    prev: qs('#bar-prev'),
    next: qs('#bar-next'),
    fill: qs('#bar-fill'),
    range: qs('#bar-range'),
    seek: qs('#bar-seek'),
    elapsed: qs('#bar-elapsed'),
    duration: qs('#bar-duration'),
    volume: qs('#bar-volume'),
    mute: qs('#bar-mute'),
    star: qs('#bar-star'),
    cart: qs('#bar-cart'),
    share: qs('#bar-share'),
  };

  bar.play.addEventListener('click', () => toggle());
  bar.prev.addEventListener('click', () => previous());
  bar.next.addEventListener('click', () => next());
  bar.mute.addEventListener('click', () => setVolume(audio.volume > 0 ? 0 : 0.8));
  bar.volume.addEventListener('input', (event) => setVolume(Number(event.target.value) / 100));
  bar.range.addEventListener('input', (event) => {
    if (!current || mode === 'live') return;
    seekTo((Number(event.target.value) / 1000) * (current.durationMs / 1000));
  });
  bar.star.addEventListener('click', () => {
    if (!current) return;
    const on = store.toggleFavourite(current);
    toast(on ? `★ ${current.title} added to favourites` : `Removed ${current.title} from favourites`);
  });
  bar.cart.addEventListener('click', () => {
    if (!current) return;
    const added = store.toggleCart(current);
    toast(added ? `🛒 ${current.title} added to basket` : `Removed ${current.title} from basket`);
  });
  bar.share.addEventListener('click', () => {
    if (current) openShare(bar.share, current);
  });
}

/* ─────────────────────────── bar rendering ─────────────────────────── */

function updateBar() {
  if (!bar) return;
  const playing = isPlaying();
  bar.play.innerHTML = icon(playing ? 'pause' : 'play');
  bar.play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  bar.mute.innerHTML = icon(audio.volume > 0 ? 'volume' : 'mute');
  bar.volume.value = String(Math.round(audio.volume * 100));

  if (!current) {
    bar.title.textContent = 'Not playing';
    bar.sub.textContent = 'press tune in';
    bar.modePill.hidden = true;
    bar.fill.style.width = '0%';
    bar.elapsed.textContent = '0:00';
    bar.duration.textContent = '--:--';
    bar.star.classList.remove('is-on');
    bar.cart.classList.remove('is-on');
    return;
  }

  bar.title.textContent = `${current.title} — ${current.artist}`;
  bar.cover.src = coverArt(current, 120);
  bar.modePill.hidden = mode !== 'live';
  bar.sub.textContent =
    mode === 'live'
      ? `${fmtTime(liveState?.now?.elapsedMs ?? 0)} into the set${
          liveState?.station ? ` · ${liveState.station.listeners} listening` : ''
        }`
      : `${current.album ?? 'single'}${current.year ? ` · ${current.year}` : ''} · on demand`;

  const durationMs = current.durationMs ?? 0;
  // On the mount, `audio.currentTime` counts from when this listener joined, so the position within
  // the track comes from the schedule instead.
  const elapsedMs =
    mode === 'live' ? (liveState?.now?.elapsedMs ?? 0) : Math.max(0, (audio.currentTime || 0) * 1000);
  const ratio = durationMs > 0 ? Math.min(1, elapsedMs / durationMs) : 0;
  bar.fill.style.width = `${(ratio * 100).toFixed(2)}%`;
  bar.range.value = String(Math.round(ratio * 1000));
  bar.range.disabled = mode === 'live';
  bar.seek.classList.toggle('seek--live', mode === 'live');
  bar.elapsed.textContent = mode === 'live' ? `live ${fmtTime(elapsedMs)}` : fmtTime(elapsedMs);
  bar.duration.textContent = mode === 'live' ? 'on air' : fmtTime(durationMs);

  bar.star.classList.toggle('is-on', store.isFavourite(current.id));
  bar.cart.classList.toggle('is-on', store.isInCart(current.id));

  document.title = playing
    ? `▶ ${current.title} — ${current.artist} · Anomalradio`
    : `${current.title} — ${current.artist} · Anomalradio`;
}

/* ─────────────────────────── init ─────────────────────────── */

function bindShortcuts() {
  document.addEventListener('keydown', (event) => {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;

    switch (event.key) {
      case ' ':
        event.preventDefault();
        toggle();
        break;
      case 'ArrowRight':
        if (mode === 'live') return;
        seekTo((audio.currentTime || 0) + 10);
        break;
      case 'ArrowLeft':
        if (mode === 'live') return;
        seekTo((audio.currentTime || 0) - 10);
        break;
      case 'ArrowUp':
        event.preventDefault();
        setVolume(audio.volume + 0.05);
        break;
      case 'ArrowDown':
        event.preventDefault();
        setVolume(audio.volume - 0.05);
        break;
      case 's':
      case 'S':
        if (current) {
          const on = store.toggleFavourite(current);
          toast(on ? `★ ${current.title} added to favourites` : `Removed ${current.title} from favourites`);
        }
        break;
      case 'b':
      case 'B':
        if (current) {
          const added = store.toggleCart(current);
          toast(added ? `🛒 ${current.title} added to basket` : `Removed ${current.title} from basket`);
        }
        break;
      case 'c':
      case 'C':
        if (current) copyTrackLink(current);
        break;
      default:
        break;
    }
  });
}

function bindGlobalTuneIn() {
  document.addEventListener('click', (event) => {
    const trigger = event.target.closest('[data-action="tune-in"]');
    if (!trigger) return;
    event.preventDefault();
    if (current && isPlaying() && mode === 'live') {
      audio.pause();
      updateBar();
    } else {
      tuneIn();
    }
  });
}

function updateHeader(state) {
  const pill = qs('#hdr-live');
  const listeners = qs('#hdr-listeners');
  const status = qs('#foot-status');
  if (!state) return;
  if (pill) pill.hidden = false;
  if (listeners) listeners.textContent = `${state.station.listeners} listening`;
  if (status) {
    status.textContent = `on air — ${state.now.track.artist} · ${state.now.track.title} · ${state.station.listeners} listening`;
  }
}

/** Boot the player: mount the bar, subscribe to the live feed, bind input. */
export function initPlayer({ playlist = [], staticPreview: isPreview = false } = {}) {
  queue = playlist;
  staticPreview = isPreview;
  mountBar();
  bindShortcuts();
  bindGlobalTuneIn();

  if (staticPreview) {
    // Nothing to follow and nothing to mint: say so in the bar rather than showing a dead control.
    bar.sub.textContent = 'playback needs the station server';
    return { audio, tuneIn, playTrack, toggle, next, previous, seekTo, setVolume, setMode };
  }

  // Follow the broadcast in live mode.
  api.subscribeNowPlaying((state, kind) => {
    liveState = state;
    updateHeader(state);
    emit('state', state);
    if (kind === 'track' && mode === 'live' && isPlaying()) {
      // A new track just started on air — jump to it.
      start(state.now.track, { startAtMs: 0, nextMode: 'live' });
    } else if (mode === 'live') {
      updateBar();
    }
  });

  audio.addEventListener('play', () => {
    updateBar();
    emit('play');
  });
  audio.addEventListener('pause', () => {
    updateBar();
    emit('pause');
  });
  audio.addEventListener('timeupdate', updateBar);
  audio.addEventListener('ended', () => {
    // The mount should never end; if it does, reconnect rather than falling through to the queue.
    if (mode === 'live') tuneIn();
    else next();
  });
  audio.addEventListener('error', () => {
    // A token may have expired mid-track (TTL ~120 s): mint a new one and resume.
    if (current && !audio.paused) {
      start(current, { startAtMs: audio.currentTime * 1000, nextMode: mode });
    }
  });

  store.subscribe(() => updateBar());
  updateBar();

  return { audio, tuneIn, playTrack, toggle, next, previous, seekTo, setVolume, setMode };
}

/** Expose the playlist order so pages can hand a queue to the engine. */
export function setQueue(tracks) {
  queue = [...tracks];
}
