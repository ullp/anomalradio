/* ═══════════════════════════════════════════════════════════════════════
   ANOMALRADIO · pages.js — page controllers.
   One entry point per page (`<body data-page="…">`), all sharing the docked
   player, the row-action delegation and the live now-playing feed.
   ═══════════════════════════════════════════════════════════════════════ */

import * as api from './api.js';
import * as store from './store.js';
import {
  h,
  icon,
  qs,
  qsa,
  fmtTime,
  fmtLong,
  fmtClock,
  fmtPrice,
  relTime,
  toast,
  renderChrome,
  staticPreviewBanner,
} from './ui.js';
import { coverNode, waveformStrip } from './cover.js';
import { initPlayer, tuneIn, playTrack, onPlayer, currentTrack } from './player.js';
import { mountVisualizer } from './visualizer.js';
import { bindShareButtons, copyTrackLink, trackUrl } from './share.js';
import { mountAccountPanel, syncFavourites } from './account.js';

let playlist = [];
let lastState = null;
const visualizers = [];

const findTrack = (id) =>
  playlist.find((t) => t.id === id) ?? store.favourites().find((t) => t.id === id) ?? null;

let previewAudio = null;

/**
 * Play the short public excerpt (M4).
 *
 * Deliberately not routed through the player: a preview is a 30-second taste, not a queue, so it
 * plays on its own and stops. The excerpt is the one audio URL with no token — it exists to be
 * heard by people who are not on the site yet.
 */
function togglePreview(track, button) {
  if (previewAudio?.dataset.track === track.id && !previewAudio.paused) {
    previewAudio.pause();
    button?.classList.remove('is-on');
    return;
  }
  previewAudio?.pause();
  for (const node of qsa('[data-preview]')) node.classList.remove('is-on');

  previewAudio = new Audio(api.previewUrl(track.id));
  previewAudio.dataset.track = track.id;
  previewAudio.volume = store.volume();
  previewAudio.addEventListener('ended', () => button?.classList.remove('is-on'));
  previewAudio
    .play()
    .then(() => {
      button?.classList.add('is-on');
      toast(`Preview — ${track.artist} — ${track.title}`, { iconName: 'play' });
    })
    .catch(() => toast('The preview could not be played', { iconName: 'info' }));
}

/* ─────────────────────────── row factory ─────────────────────────── */

function trackRow(track, { index = null, playedAt = null } = {}) {
  const meta = [];
  if (track.bpm) meta.push(h('span', { class: 'pill pill--ghost pill--optional' }, `${track.bpm} BPM`));
  if (track.musicalKey) meta.push(h('span', { class: 'pill pill--ghost pill--optional' }, track.musicalKey));
  if (track.year) meta.push(h('span', { class: 'pill pill--ghost pill--optional' }, String(track.year)));

  return h(
    'li',
    { class: 'track-row', dataset: { track: track.id } },
    index === null ? null : h('span', { class: 'track-row__index mono' }, String(index).padStart(2, '0')),
    h(
      'button',
      {
        class: 'track-row__play',
        type: 'button',
        dataset: { play: track.id },
        'aria-label': `Play ${track.title}`,
      },
      h('span', { class: 'flex', html: icon('play') }),
    ),
    coverNode(track, 'cover--sm'),
    h(
      'div',
      { class: 'track-row__main' },
      h('a', { class: 'track-row__title', href: `/track/${track.id}`, textContent: track.title }),
      h('span', {
        class: 'track-row__sub',
        textContent: `${track.artist}${track.album ? ` · ${track.album}` : ''}`,
      }),
    ),
    h('div', { class: 'track-row__meta' }, ...meta),
    h(
      'div',
      { class: 'track-row__actions' },
      h('button', {
        class: `btn btn--icon btn--sm ${store.isFavourite(track.id) ? 'is-on' : ''}`,
        type: 'button',
        dataset: { star: track.id },
        'aria-label': `Favourite ${track.title}`,
        html: icon('star'),
      }),
      h('button', {
        class: `btn btn--icon btn--sm ${store.isInCart(track.id) ? 'is-on' : ''}`,
        type: 'button',
        dataset: { cart: track.id },
        'aria-label': `Add ${track.title} to basket`,
        html: icon('cart'),
      }),
      h('button', {
        class: 'btn btn--icon btn--sm',
        type: 'button',
        dataset: { share: track.id },
        'aria-label': `Share ${track.title}`,
        html: icon('share'),
      }),
    ),
    h(
      'span',
      { class: 'track-row__time', title: playedAt ? `on air at ${new Date(playedAt).toLocaleString()}` : '' },
      playedAt ? h('span', { class: 'flex', html: icon('clock') }) : null,
      playedAt ? fmtClock(playedAt) : fmtTime(track.durationMs),
    ),
  );
}

/** One delegated listener for every row action on the page. */
function bindRowActions() {
  document.addEventListener('click', (event) => {
    const play = event.target.closest('[data-play]');
    if (play) {
      const track = findTrack(play.dataset.play);
      if (track) playTrack(track, { queue: playlist.length ? playlist : [track] });
      return;
    }
    const preview = event.target.closest('[data-preview]');
    if (preview) {
      const track = findTrack(preview.dataset.preview);
      if (track) togglePreview(track, preview);
      return;
    }
    const star = event.target.closest('[data-star]');
    if (star) {
      const track = findTrack(star.dataset.star);
      if (!track) return;
      const on = store.toggleFavourite(track);
      star.classList.toggle('is-on', on);
      toast(on ? `★ ${track.title} added to favourites` : `Removed ${track.title} from favourites`);
      return;
    }
    const cart = event.target.closest('[data-cart]');
    if (cart) {
      const track = findTrack(cart.dataset.cart);
      if (!track) return;
      const added = store.toggleCart(track);
      cart.classList.toggle('is-on', added);
      toast(added ? `🛒 ${track.title} added to basket` : `Removed ${track.title} from basket`);
    }
  });

  bindShareButtons(document, findTrack);
}

/* ─────────────────────────── live bits ─────────────────────────── */

function highlightCurrent() {
  const track = currentTrack();
  qsa('.track-row').forEach((row) => row.classList.toggle('is-current', row.dataset.track === track?.id));
}

function renderLiveBits(state) {
  if (!state) return;
  lastState = state;
  const set = (selector, text) => {
    const node = qs(selector);
    if (node) node.textContent = text;
  };
  set('#live-onair', `${state.now.track.artist} — ${state.now.track.title}`);
  set('#live-next', state.next ? `${state.next.track.artist} — ${state.next.track.title}` : '—');
  set('#live-listeners', String(state.station.listeners));
  set('#live-progress', `${fmtTime(state.now.elapsedMs)} / ${fmtTime(state.now.track.durationMs)}`);
  set('#live-cycle', `${fmtLong(state.cycle.totalMs)} loop`);
  set('#home-now-title', state.now.track.title);
  set('#home-now-artist', state.now.track.artist);
}

/* ─────────────────────────── home ─────────────────────────── */

function renderHome(data) {
  const heroCanvas = qs('#hero-viz');
  if (heroCanvas) visualizers.push(mountVisualizer(heroCanvas, 'signal'));

  const stats = qs('#hero-stats');
  if (stats) {
    stats.append(
      h(
        'div',
        { class: 'stat' },
        h('span', { class: 'stat__label' }, 'tracks'),
        h('span', { class: 'stat__value mono' }, String(data.trackCount)),
      ),
      h(
        'div',
        { class: 'stat' },
        h('span', { class: 'stat__label' }, 'runtime'),
        h('span', { class: 'stat__value mono' }, fmtLong(data.totalDurationMs)),
      ),
      h(
        'div',
        { class: 'stat' },
        h('span', { class: 'stat__label' }, 'stream'),
        h('span', { class: 'stat__value mono' }, '320 kbps'),
      ),
      h(
        'div',
        { class: 'stat' },
        h('span', { class: 'stat__label' }, 'release'),
        h('span', { class: 'stat__value mono' }, data.album?.album ?? '—'),
      ),
    );
  }

  const nowCard = qs('#now-card');
  if (nowCard) {
    const track = lastState?.now.track ?? data.tracks[0];
    nowCard.append(
      coverNode(track, 'cover--md'),
      h(
        'div',
        { class: 'now__body grow' },
        h('div', { class: 'now__title', id: 'home-now-title', textContent: track.title }),
        h('div', { class: 'now__artist', id: 'home-now-artist', textContent: track.artist }),
        h(
          'div',
          { class: 'now__meta' },
          api.isStatic()
            ? h('span', { class: 'pill pill--warn' }, 'PREVIEW')
            : h('span', { class: 'pill pill--live' }, h('span', { class: 'live-dot' }), 'ON AIR'),
          h('span', { class: 'pill', id: 'live-progress' }, '—'),
          h('span', { class: 'pill pill--ghost', id: 'live-cycle' }, '—'),
        ),
      ),
      h(
        'div',
        { class: 'row gap-6' },
        h('button', {
          class: 'btn btn--icon btn--sm',
          type: 'button',
          dataset: { star: track.id },
          'aria-label': 'Favourite',
          html: icon('star'),
        }),
        h('button', {
          class: 'btn btn--icon btn--sm',
          type: 'button',
          dataset: { cart: track.id },
          'aria-label': 'Add to basket',
          html: icon('cart'),
        }),
        h('button', {
          class: 'btn btn--icon btn--sm',
          type: 'button',
          dataset: { share: track.id },
          'aria-label': 'Share',
          html: icon('share'),
        }),
      ),
    );
  }

  const recentList = qs('#recent-list');
  if (recentList) {
    const history = (lastState?.history ?? []).slice(0, 5);
    recentList.replaceChildren(
      ...(history.length
        ? history.map((entry) => trackRow(entry.track, { playedAt: entry.playedAt }))
        : [
            h('li', { class: 'track-row' }, h('span', { class: 'muted' }, 'waiting for the broadcast feed…')),
          ]),
    );
  }

  const featured = qs('#featured');
  if (featured) {
    featured.replaceChildren(...data.tracks.slice(0, 8).map(trackCard));
  }
}

function trackCard(track) {
  return h(
    'article',
    { class: 'card' },
    coverNode(track),
    h('div', { class: 'card__title' }, h('a', { href: `/track/${track.id}`, textContent: track.title })),
    h('div', { class: 'card__sub', textContent: `${track.artist} · ${fmtTime(track.durationMs)}` }),
    h(
      'div',
      { class: 'card__actions' },
      h('button', {
        class: 'btn btn--icon btn--sm',
        type: 'button',
        dataset: { play: track.id },
        'aria-label': `Play ${track.title}`,
        html: icon('play'),
      }),
      h('button', {
        class: `btn btn--icon btn--sm ${store.isFavourite(track.id) ? 'is-on' : ''}`,
        type: 'button',
        dataset: { star: track.id },
        'aria-label': `Favourite ${track.title}`,
        html: icon('star'),
      }),
      h('button', {
        class: `btn btn--icon btn--sm ${store.isInCart(track.id) ? 'is-on' : ''}`,
        type: 'button',
        dataset: { cart: track.id },
        'aria-label': `Add ${track.title} to basket`,
        html: icon('cart'),
      }),
      h('button', {
        class: 'btn btn--icon btn--sm',
        type: 'button',
        dataset: { share: track.id },
        'aria-label': `Share ${track.title}`,
        html: icon('share'),
      }),
    ),
  );
}

/* ─────────────────────────── library ─────────────────────────── */

function renderLibrary(data) {
  const list = qs('#library-list');
  const count = qs('#library-count');
  const search = qs('#library-search');
  const sort = qs('#library-sort');

  const draw = () => {
    const query = (search?.value ?? '').trim().toLowerCase();
    let tracks = data.tracks.filter((track) =>
      query
        ? [track.title, track.artist, track.album, track.genre]
            .filter(Boolean)
            .some((v) => v.toLowerCase().includes(query))
        : true,
    );
    if (sort?.value === 'duration') tracks = [...tracks].sort((a, b) => a.durationMs - b.durationMs);
    if (sort?.value === 'bpm') tracks = [...tracks].sort((a, b) => (a.bpm ?? 999) - (b.bpm ?? 999));
    if (sort?.value === 'title') tracks = [...tracks].sort((a, b) => a.title.localeCompare(b.title, 'en'));

    list.replaceChildren(...tracks.map((track, index) => trackRow(track, { index: index + 1 })));
    if (count) {
      count.textContent = `${tracks.length} of ${data.trackCount} tracks · ${fmtLong(
        tracks.reduce((sum, t) => sum + t.durationMs, 0),
      )}`;
    }
    highlightCurrent();
  };

  search?.addEventListener('input', draw);
  sort?.addEventListener('change', draw);
  draw();
}

/* ─────────────────────────── track permalink ─────────────────────────── */

async function renderTrackPage() {
  const id = location.pathname.split('/').filter(Boolean)[1];
  const host = qs('#track-detail');
  if (!host) return;

  let track = findTrack(id);
  if (!track) {
    try {
      ({ track } = await api.getTrack(id));
    } catch {
      host.replaceChildren(
        h(
          'div',
          { class: 'empty' },
          h('span', { class: 'flex', html: icon('info') }),
          h('p', {}, 'That track is not in the library (any more).'),
          h('p', {}, h('a', { href: '/tracks/', textContent: 'Browse all tracks →' })),
        ),
      );
      return;
    }
  }

  const facts = [
    track.album ? h('span', { class: 'pill' }, track.album) : null,
    track.year ? h('span', { class: 'pill' }, String(track.year)) : null,
    track.genre ? h('span', { class: 'pill' }, track.genre) : null,
    track.bpm ? h('span', { class: 'pill' }, `${track.bpm} BPM`) : null,
    track.musicalKey ? h('span', { class: 'pill' }, track.musicalKey) : null,
    h('span', { class: 'pill' }, fmtTime(track.durationMs)),
    track.bitrate ? h('span', { class: 'pill' }, `${Math.round(track.bitrate / 1000)} kbps`) : null,
  ].filter(Boolean);

  host.replaceChildren(
    h(
      'div',
      { class: 'console' },
      h(
        'div',
        { class: 'console__stage' },
        h('div', { class: 'console__art' }, coverNode(track)),
        h('div', { class: 'viz viz--bars' }, h('canvas', { id: 'track-viz', 'aria-hidden': 'true' })),
        h('img', { src: waveformStrip(track), alt: '', class: 'wave-strip' }),
      ),
      h(
        'div',
        { class: 'console__info' },
        h('span', { class: 'eyebrow' }, 'track'),
        h('h1', { class: 'console__title' }, track.title),
        h('p', {
          class: 'console__artist',
          textContent: `${track.artist}${track.composer ? ` · composed by ${track.composer}` : ''}`,
        }),
        h('div', { class: 'console__facts' }, ...facts),
        h(
          'div',
          { class: 'console__actions' },
          h(
            'button',
            { class: 'btn btn--primary', type: 'button', dataset: { play: track.id } },
            h('span', { html: icon('play') }),
            'Play this track',
          ),
          h(
            'button',
            { class: 'btn', type: 'button', dataset: { star: track.id } },
            h('span', { html: icon('star') }),
            store.isFavourite(track.id) ? 'In favourites' : 'Star',
          ),
          h(
            'button',
            { class: 'btn', type: 'button', dataset: { cart: track.id } },
            h('span', { html: icon('cart') }),
            store.isInCart(track.id) ? 'In basket' : 'Add to basket',
          ),
          h(
            'button',
            { class: 'btn', type: 'button', dataset: { share: track.id } },
            h('span', { html: icon('share') }),
            'Share',
          ),
          h(
            'button',
            { class: 'btn', type: 'button', dataset: { preview: track.id } },
            h('span', { html: icon('play') }),
            'Preview 30 s',
          ),
          h(
            'span',
            { class: 'muted text-sm', dataset: { shareCount: track.id } },
            track.shares ? `${track.shares} share${track.shares === 1 ? '' : 's'}` : '',
          ),
        ),
        h(
          'div',
          { class: 'panel panel--tight stack' },
          h(
            'div',
            { class: 'row-between' },
            h(
              'div',
              { class: 'stack' },
              h('span', { class: 'stat__label' }, 'buy the file'),
              h('span', { class: 'stat__value mono' }, fmtPrice(track.priceCents, track.currency)),
            ),
            h(
              'button',
              { class: 'btn btn--primary', type: 'button', dataset: { cart: track.id } },
              h('span', { html: icon('cart') }),
              'Add to basket',
            ),
          ),
          h(
            'p',
            { class: 'muted text-xs' },
            'Streaming here is protected and never exposes a file. Buying (M5) is the sanctioned way to download a ' +
              'watermarked copy of the master.',
          ),
        ),
        h(
          'div',
          { class: 'panel panel--tight stack' },
          h('span', { class: 'stat__label' }, 'share link'),
          h(
            'div',
            { class: 'row wrap' },
            h('code', { class: 'mono', textContent: trackUrl(track) }),
            h(
              'button',
              { class: 'btn btn--sm', type: 'button', id: 'track-copy' },
              h('span', { html: icon('copy') }),
              'Copy',
            ),
          ),
          h(
            'p',
            { class: 'muted text-xs' },
            'The link points at this page (with social preview tags), never at the audio stream.',
          ),
        ),
        h(
          'div',
          { class: 'panel panel--tight' },
          h('span', { class: 'stat__label' }, 'technical'),
          h(
            'ul',
            { class: 'list-tight mt-sm' },
            h('li', {}, `duration ${fmtTime(track.durationMs)}`),
            h('li', {}, `${track.sampleRate ?? 44100} Hz · ${track.channels ?? 2} channels`),
            h('li', {}, `added ${relTime(track.addedAt)}`),
            h('li', {}, `public id ${track.id}`),
          ),
        ),
      ),
    ),
  );

  const vizCanvas = qs('#track-viz');
  if (vizCanvas) visualizers.push(mountVisualizer(vizCanvas, 'bars'));

  qs('#track-copy')?.addEventListener('click', () => copyTrackLink(track));
  highlightCurrent();
}

/* ─────────────────────────── favourites ─────────────────────────── */

function renderFavourites() {
  const list = qs('#fav-list');
  const summary = qs('#fav-summary');
  const empty = qs('#fav-empty');
  const tools = qs('#fav-tools');
  if (!list) return;

  const draw = () => {
    const items = store.favourites();
    list.replaceChildren(...items.map((track, index) => trackRow(track, { index: index + 1 })));
    if (summary) {
      summary.textContent = items.length
        ? `${items.length} starred track(s) · ${fmtLong(items.reduce((sum, t) => sum + t.durationMs, 0))}`
        : '';
    }
    if (empty) empty.hidden = items.length > 0;
    if (tools) tools.hidden = items.length === 0;
    highlightCurrent();
  };

  qs('#fav-play-all')?.addEventListener('click', () => {
    const items = store.favourites();
    if (items.length) playTrack(items[0], { queue: items });
  });

  qs('#fav-export')?.addEventListener('click', () => {
    const blob = new Blob([store.favouritesAsM3U()], { type: 'audio/x-mpegurl' });
    const url = URL.createObjectURL(blob);
    const link = h('a', { href: url, download: 'anomalradio-favourites.m3u' });
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    toast('Exported favourites as .m3u (page links, not audio files)', { iconName: 'list' });
  });

  qs('#fav-clear')?.addEventListener('click', () => {
    store.clearFavourites();
    toast('Favourites cleared', { iconName: 'trash' });
    draw();
  });

  store.subscribe(draw);
  draw();
}

/* ─────────────────────────── basket ─────────────────────────── */

function renderCart() {
  const list = qs('#cart-list');
  const summary = qs('#cart-summary');
  const empty = qs('#cart-empty');
  const checkout = qs('#cart-checkout');
  if (!list) return;

  const draw = () => {
    const items = store.cart();
    list.replaceChildren(
      ...items.map((track) =>
        h(
          'li',
          { class: 'track-row' },
          coverNode(track, 'cover--sm'),
          h(
            'div',
            { class: 'track-row__main' },
            h('a', { class: 'track-row__title', href: `/track/${track.id}`, textContent: track.title }),
            h('span', {
              class: 'track-row__sub',
              textContent: `${track.artist} · ${fmtTime(track.durationMs)}`,
            }),
          ),
          h('span', { class: 'pill' }, fmtPrice(track.priceCents, track.currency)),
          h(
            'div',
            { class: 'track-row__actions' },
            h('button', {
              class: 'btn btn--icon btn--sm',
              type: 'button',
              dataset: { cart: track.id },
              'aria-label': `Remove ${track.title}`,
              html: icon('trash'),
            }),
          ),
        ),
      ),
    );

    if (summary) summary.textContent = items.length ? `${items.length} item(s)` : '';
    const total = qs('#cart-total');
    if (total) total.textContent = fmtPrice(store.cartTotal(), items[0]?.currency ?? 'EUR');
    if (empty) empty.hidden = items.length > 0;
    if (checkout) checkout.disabled = items.length === 0;
  };

  checkout?.addEventListener('click', () => {
    toast('Checkout arrives in M5 (Stripe or external buy links) — the basket already works', {
      iconName: 'info',
    });
  });

  qs('#cart-clear')?.addEventListener('click', () => {
    store.clearCart();
    toast('Basket emptied', { iconName: 'trash' });
    draw();
  });

  store.subscribe(draw);
  draw();
}

/* ─────────────────────────── radio console ─────────────────────────── */

function renderConsole(data) {
  const vizCanvas = qs('#console-viz');
  if (vizCanvas) visualizers.push(mountVisualizer(vizCanvas, 'bars'));

  // Inject the icons for the console controls (markup stays icon-free in the HTML).
  const setIcon = (selector, name) => {
    const node = qs(selector);
    if (node) node.innerHTML = icon(name);
  };
  setIcon('#console-star', 'star');
  setIcon('#console-cart', 'cart');
  setIcon('#console-share', 'share');
  const consolePlay = qs('#console-play');
  if (consolePlay) {
    consolePlay.replaceChildren(
      h('span', { class: 'flex', html: icon('play') }),
      document.createTextNode('Play'),
    );
  }

  // Keep the mode switch in sync with the engine.
  const syncModes = (active) => {
    const live = qs('#console-tunein');
    const ondemand = qs('#console-ondemand');
    if (live) live.setAttribute('aria-pressed', String(active === 'live'));
    if (ondemand) ondemand.setAttribute('aria-pressed', String(active !== 'live'));
  };
  syncModes(store.mode());
  onPlayer((event, payload) => {
    if (event === 'mode') syncModes(payload);
  });

  const history = qs('#console-history');
  const drawHistory = () => {
    if (!history) return;
    const entries = (lastState?.history ?? []).slice(0, 15);
    history.replaceChildren(
      ...(entries.length
        ? entries.map((entry, index) => trackRow(entry.track, { index: index + 1, playedAt: entry.playedAt }))
        : [
            h(
              'li',
              { class: 'track-row' },
              h(
                'span',
                { class: 'muted' },
                api.isStatic() ? 'history needs the station server' : 'loading history…',
              ),
            ),
          ]),
    );
    highlightCurrent();
  };

  const drawNow = () => {
    const track = currentTrack() ?? lastState?.now.track;
    if (!track) return;
    const title = qs('#console-title');
    const artist = qs('#console-artist');
    const art = qs('#console-art');
    const facts = qs('#console-facts');
    if (title) title.textContent = track.title;
    if (artist) artist.textContent = `${track.artist}${track.album ? ` · ${track.album}` : ''}`;
    if (art) art.replaceChildren(coverNode(track, 'disc'));
    if (facts) {
      facts.replaceChildren(
        ...[
          track.genre ? h('span', { class: 'pill' }, track.genre) : null,
          track.bpm ? h('span', { class: 'pill' }, `${track.bpm} BPM`) : null,
          track.musicalKey ? h('span', { class: 'pill' }, track.musicalKey) : null,
          track.year ? h('span', { class: 'pill' }, String(track.year)) : null,
          h('span', { class: 'pill' }, fmtTime(track.durationMs)),
          track.bitrate ? h('span', { class: 'pill' }, `${Math.round(track.bitrate / 1000)} kbps`) : null,
        ].filter(Boolean),
      );
    }
    const star = qs('#console-star');
    const cart = qs('#console-cart');
    star?.classList.toggle('is-on', store.isFavourite(track.id));
    cart?.classList.toggle('is-on', store.isInCart(track.id));
    if (star) star.dataset.star = track.id;
    if (cart) cart.dataset.cart = track.id;
    const share = qs('#console-share');
    if (share) share.dataset.share = track.id;
    const play = qs('#console-play');
    if (play) play.dataset.play = track.id;
    const permalink = qs('#console-permalink');
    if (permalink) permalink.href = `/track/${track.id}`;
  };

  qs('#console-tunein')?.addEventListener('click', () => tuneIn());
  qs('#console-ondemand')?.addEventListener('click', () => {
    const first = currentTrack() ?? data.tracks[0];
    playTrack(first, { queue: data.tracks });
  });

  onPlayer((event) => {
    if (event === 'track') {
      drawNow();
      highlightCurrent();
    }
    if (event === 'state') drawHistory();
  });

  store.subscribe(drawNow);
  drawNow();
  drawHistory();
}

/* ─────────────────────────── boot ─────────────────────────── */

async function boot() {
  const page = document.body.dataset.page ?? 'home';
  if (new URLSearchParams(location.search).has('popup')) document.body.classList.add('is-popup');

  renderChrome({ active: document.body.dataset.nav ?? '' });

  let data = { tracks: [], trackCount: 0, totalDurationMs: 0, album: null };
  try {
    data = await api.getPlaylist();
    playlist = data.tracks;
  } catch (error) {
    toast(`Could not load the library: ${error.message}`, { iconName: 'info' });
  }

  // A file-only host publishes a snapshot instead of an API: say so plainly, and stop asking for
  // things that cannot exist there.
  const staticPreview = api.isStatic();
  if (staticPreview) {
    qs('.site-header')?.insertAdjacentElement('afterend', staticPreviewBanner());
    document.body.dataset.static = 'true';
    // No broadcast clock here, so the on-air card must not claim to be on air.
    const label = qs('#now-label');
    if (label) label.textContent = 'catalogue preview';
    const cycle = qs('#live-cycle');
    if (cycle) cycle.textContent = 'static snapshot';
    qs('#live-footer')?.setAttribute('hidden', '');
  }

  initPlayer({ playlist, staticPreview });
  bindRowActions();

  // ★ favourites live on the station now (M4), keyed to this browser or to the signed-in account.
  // Sync before the page draws so a star is never wrong on first paint; if it fails, the local
  // cache simply stays as it was.
  if (!staticPreview) await syncFavourites();

  if (!staticPreview) {
    try {
      lastState = await api.getNowPlaying();
      renderLiveBits(lastState);
    } catch {
      /* the feed may not be up yet; the SSE subscription fills it in */
    }
  }

  switch (page) {
    case 'home':
      renderHome(data);
      break;
    case 'library':
      renderLibrary(data);
      break;
    case 'track':
      await renderTrackPage();
      break;
    case 'favourites':
      renderFavourites();
      await mountAccountPanel();
      break;
    case 'cart':
      renderCart();
      break;
    case 'player':
      renderConsole(data);
      break;
    default:
      break;
  }

  onPlayer((event, payload) => {
    if (event === 'state') {
      renderLiveBits(payload);
      if (page === 'home') renderHome(data);
    }
    if (event === 'track') highlightCurrent();
  });

  highlightCurrent();
}

boot();
