/* ═══════════════════════════════════════════════════════════════════════
   ANOMALRADIO · admin.js — the control room dashboard.

   Standalone on purpose: it imports nothing from the public site, so a change
   to the listener experience cannot break the admin, or the other way round.
   Everything it renders comes from /admin/api/*, which is gated server-side —
   this file holds no data and no secrets.
   ═══════════════════════════════════════════════════════════════════════ */

const signedIn = document.body.dataset.signedIn === 'true';

/** Relative to the admin path, which the server always serves with a trailing slash. */
async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: options.body ? { 'content-type': 'application/json' } : {},
    ...options,
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* a non-JSON error page is still an error */
  }
  if (!response.ok) {
    const error = new Error(body?.error ?? `request failed (${response.status})`);
    error.status = response.status;
    error.detail = body;
    throw error;
  }
  return body;
}

const qs = (selector, root = document) => root.querySelector(selector);

/** Same shape as the site's helper: text always goes in through textContent. */
function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'text') node.textContent = value;
    else if (key in node) node[key] = value;
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

const fmtDuration = (ms) => {
  const total = Math.round((ms ?? 0) / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`;
};

const fmtBytes = (bytes) => {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes ?? 0;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
};

/** A page-level message that survives the re-render that follows every save. */
function notice(message, kind = 'warn') {
  const node = qs('#admin-notice');
  if (!node) return;
  node.textContent = message ?? '';
  node.className = `admin-banner${kind ? ` admin-banner--${kind}` : ''}`;
  node.hidden = !message;
}

function setStatus(node, message, kind = '') {
  if (!node) return;
  node.textContent = message;
  node.className = `admin-status${kind ? ` admin-status--${kind}` : ''}`;
}

/* ─────────────────────────── stats ─────────────────────────── */

function renderStats(summary) {
  const host = qs('#admin-stats');
  if (!host) return;
  const totals = summary.totals ?? {};

  const cards = [
    ['published', `${totals.published ?? 0}`, `${totals.tracks ?? 0} in the catalogue`],
    ['drafts', `${totals.drafts ?? 0}`, 'invisible to listeners'],
    ['listeners', `${summary.listeners ?? 0}`, 'open mount connections'],
    [
      'on air',
      summary.onAir ? summary.onAir.title : '—',
      summary.onAir
        ? `${summary.onAir.artist}${summary.next ? ` · next: ${summary.next}` : ''}`
        : 'nothing playing',
    ],
    ['plays', `${totals.plays ?? 0}`, 'recorded track changes'],
    ['stars / shares', `${totals.stars ?? 0} / ${totals.shares ?? 0}`, '★ and ⇪ across the catalogue'],
    ['catalogue', fmtBytes(totals.bytes ?? 0), fmtDuration(totals.durationMs ?? 0)],
    ['checkout', summary.checkout?.driver ?? '—', summary.checkout?.storeName ?? 'no store connected'],
  ];

  host.replaceChildren(
    ...cards.map(([label, value, note]) =>
      h(
        'div',
        { class: 'panel panel--tight stack' },
        h('span', { class: 'stat__label', text: label }),
        h('span', { class: 'stat__value', text: value }),
        h('span', { class: 'muted text-xs', text: note }),
      ),
    ),
  );
}

/* ─────────────────────────── the track editor ─────────────────────────── */

/** Only these are editable — the same list the server validates against. */
const FIELDS = [
  { name: 'title', label: 'title' },
  { name: 'artist', label: 'artist' },
  { name: 'album', label: 'album' },
  { name: 'albumArtist', label: 'album artist' },
  { name: 'genre', label: 'genre' },
  { name: 'composer', label: 'composer' },
  { name: 'year', label: 'year', type: 'number' },
  { name: 'bpm', label: 'bpm', type: 'number' },
  { name: 'musicalKey', label: 'key' },
  { name: 'priceCents', label: 'price (cents)', type: 'number' },
  { name: 'currency', label: 'currency' },
  { name: 'weight', label: 'rotation weight', type: 'number' },
  { name: 'buyUrl', label: 'buy URL' },
];

function trackCard(track, refresh) {
  const inputs = new Map();
  const status = h('span', { class: 'admin-status' });

  const fields = FIELDS.map((field) => {
    const input = h('input', {
      class: 'admin-input',
      type: field.type ?? 'text',
      value: track[field.name] ?? '',
    });
    inputs.set(field.name, input);
    return h('label', { class: 'field' }, h('span', { text: field.label }), input);
  });

  const save = h('button', { class: 'btn btn--sm btn--primary', type: 'button', text: 'Save' });
  const publish = h('button', {
    class: 'btn btn--sm',
    type: 'button',
    text: track.published ? 'Unpublish' : 'Publish',
  });

  // Clear any previous page-level warning when the operator starts editing again.
  for (const input of inputs.values()) input.addEventListener('input', () => notice(''));

  save.addEventListener('click', async () => {
    const patch = {};
    for (const [name, input] of inputs) {
      const raw = input.value.trim();
      const next = raw === '' ? null : raw;
      // Compared as strings, so "199" and 199 are not treated as a change.
      if (String(track[name] ?? '') === String(next ?? '')) continue;
      patch[name] = next;
    }

    if (Object.keys(patch).length === 0) {
      setStatus(status, 'nothing changed');
      return;
    }

    save.disabled = true;
    setStatus(status, 'saving…');
    try {
      const result = await api(`api/tracks/${encodeURIComponent(track.id)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      // Saved either way — but if the server could not reach the buy URL, say so where it will not
      // be wiped by the refresh below.
      if (result.warning) notice(result.warning, 'warn');
      else notice('');
      setStatus(status, `saved: ${result.changed.join(', ')}`, 'ok');
      await refresh();
    } catch (error) {
      const details = error.detail?.details;
      setStatus(status, Array.isArray(details) ? details.join('; ') : error.message, 'error');
      save.disabled = false;
    }
  });

  publish.addEventListener('click', async () => {
    publish.disabled = true;
    try {
      await api(`api/tracks/${encodeURIComponent(track.id)}/publish`, {
        method: 'POST',
        body: JSON.stringify({ published: !track.published }),
      });
      await refresh();
    } catch (error) {
      setStatus(status, error.message, 'error');
      publish.disabled = false;
    }
  });

  return h(
    'div',
    { class: `admin-track${track.published ? '' : ' admin-track--draft'}` },
    h(
      'div',
      { class: 'admin-track__head' },
      h(
        'div',
        { class: 'stack' },
        h('strong', { text: `${track.artist} — ${track.title}` }),
        h('span', {
          class: 'admin-status',
          text: `${track.id} · ${fmtDuration(track.durationMs)} · ${track.plays ?? 0} play(s) · ${track.stars ?? 0} ★ · ${track.shares ?? 0} ⇪`,
        }),
      ),
      h(
        'div',
        { class: 'admin-actions' },
        h('span', { class: 'pill', text: track.published ? 'published' : 'draft' }),
        publish,
        save,
      ),
    ),
    h('div', { class: 'admin-grid' }, ...fields),
    status,
  );
}

/* ─────────────────────────── activity ─────────────────────────── */

function renderAudit(rows) {
  const host = qs('#admin-audit');
  if (!host) return;
  if (!rows?.length) {
    host.replaceChildren(h('p', { class: 'muted text-xs', text: 'Nothing recorded yet.' }));
    return;
  }
  host.replaceChildren(
    ...rows.map((row) =>
      h(
        'div',
        { class: 'admin-audit-row' },
        h('span', { text: new Date(row.at).toLocaleString() }),
        h('code', { text: row.action }),
        h('span', { text: row.target ?? '' }),
        h('span', { text: row.ip ?? '' }),
      ),
    ),
  );
}

/* ─────────────────────────── wiring ─────────────────────────── */

let cache = { tracks: [] };

function renderTracks() {
  const host = qs('#admin-tracks');
  if (!host) return;
  const needle = (qs('#admin-filter')?.value ?? '').trim().toLowerCase();

  const visible = needle
    ? cache.tracks.filter((track) =>
        [track.title, track.artist, track.album, track.genre, track.id]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(needle)),
      )
    : cache.tracks;

  if (visible.length === 0) {
    host.replaceChildren(h('p', { class: 'muted text-sm', text: 'No tracks match.' }));
    return;
  }

  host.replaceChildren(...visible.map((track) => trackCard(track, refresh)));
}

async function refresh() {
  const [summary, tracks] = await Promise.all([api('api/summary'), api('api/tracks')]);
  cache = tracks;
  renderStats(summary);
  renderAudit(summary.audit);
  renderTracks();
}

async function main() {
  if (!signedIn) return;

  qs('#admin-filter')?.addEventListener('input', renderTracks);

  for (const [id, scope] of [
    ['#admin-revoke-tokens', 'tokens'],
    ['#admin-revoke-sessions', 'sessions'],
  ]) {
    qs(id)?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        const result = await api('api/revoke', { method: 'POST', body: JSON.stringify({ scope }) });
        button.textContent = `revoked ${result.revoked}`;
        setTimeout(() => {
          button.textContent = scope === 'tokens' ? 'Revoke stream tokens' : 'End other sessions';
          button.disabled = false;
        }, 2500);
      } catch (error) {
        button.textContent = error.message;
        button.disabled = false;
      }
    });
  }

  try {
    await refresh();
  } catch (error) {
    if (error.status === 401) {
      // The session expired between the server rendering the shell and this call.
      location.reload();
      return;
    }
    qs('#admin-tracks')?.replaceChildren(
      h('p', { class: 'muted text-sm', text: `Could not load: ${error.message}` }),
    );
  }
}

main();
