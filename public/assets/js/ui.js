/* ═══════════════════════════════════════════════════════════════════════
   ANOMALRADIO · ui.js — icons, formatting helpers, toasts, page chrome.
   No inline handlers anywhere (the CSP in scripts/serve.js forbids them);
   everything is bound with addEventListener.
   ═══════════════════════════════════════════════════════════════════════ */

/* ─────────────────────────── icons (24×24 stroke) ─────────────────────────── */

const S = (body, opts = '') =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" ` +
  `stroke-linejoin="round" aria-hidden="true" ${opts}>${body}</svg>`;

export const ICONS = {
  play: S('<path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none"/>'),
  pause: S('<path d="M9 5.5v13M15 5.5v13" stroke-width="2.6"/>'),
  prev: S('<path d="M18.5 6v12L9.5 12zM6 5.5v13" fill="currentColor" stroke="none"/>'),
  next: S('<path d="M5.5 6v12l9-6zM18 5.5v13" fill="currentColor" stroke="none"/>'),
  star: S('<path d="M12 4.2l2.4 5 5.4.8-3.9 3.8.9 5.4-4.8-2.6-4.8 2.6.9-5.4L4.2 10l5.4-.8z"/>'),
  cart: S(
    '<circle cx="9.5" cy="19" r="1.4"/><circle cx="17.5" cy="19" r="1.4"/>' +
      '<path d="M3 4h2.2l2.3 10.2h10.2l2-7.2H6"/>',
  ),
  share: S('<path d="M12 16V4m0 0L8 8m4-4l4 4"/><path d="M5 14v5.5h14V14"/>'),
  link: S(
    '<path d="M10 13.5a4 4 0 005.7 0l2.8-2.8a4 4 0 00-5.7-5.7L11.5 6"/>' +
      '<path d="M14 10.5a4 4 0 00-5.7 0l-2.8 2.8a4 4 0 005.7 5.7L12.5 18"/>',
  ),
  copy: S('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 5.5H6.5A1.5 1.5 0 005 7v8.5"/>'),
  check: S('<path d="M4.5 12.5l5 5 10-11"/>'),
  close: S('<path d="M6 6l12 12M18 6L6 18"/>'),
  search: S('<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/>'),
  volume: S('<path d="M4 9.5h3l4-3.5v12l-4-3.5H4z"/><path d="M15.5 9a4 4 0 010 6"/>'),
  mute: S('<path d="M4 9.5h3l4-3.5v12l-4-3.5H4z"/><path d="M16 9.5l4 5m0-5l-4 5"/>'),
  radio: S(
    '<circle cx="12" cy="13" r="3.2"/><path d="M12 3.5v4M5.5 6.5l2.6 2.6M18.5 6.5l-2.6 2.6M3 13h2.5M18.5 13H21"/>',
  ),
  external: S(
    '<path d="M14 4h6v6"/><path d="M20 4l-8.5 8.5"/>' +
      '<path d="M18 14.5V19a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h4.5"/>',
  ),
  clock: S('<circle cx="12" cy="12" r="8"/><path d="M12 7.5V12l3 2"/>'),
  info: S('<circle cx="12" cy="12" r="8"/><path d="M12 11v5.5M12 8.2v.3"/>'),
  chart: S('<path d="M4 19.5V15m5 4.5V9m5 10.5V5.5m5 14V12"/>'),
  list: S('<path d="M4 7h16M4 12h16M4 17h10"/>'),
  trash: S('<path d="M5 7h14M9.5 7V5.5h5V7M7 7l1 12h8l1-12"/>'),
  mail: S('<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="M4 7l8 6 8-6"/>'),
  x: S('<path d="M4.5 4.5l15 15M19.5 4.5l-15 15"/>'),
  facebook: S('<path d="M14.5 8.5h2.2M14.5 8.5V7a2 2 0 012-2h1M14.5 8.5V20M10 12.5h6"/>'),
  whatsapp: S(
    '<path d="M20 12a8 8 0 01-11.9 7L4 20l1.1-3.9A8 8 0 1120 12z"/><path d="M9 9.5c0 3 2.5 5.5 5.5 5.5"/>',
  ),
  telegram: S('<path d="M20.5 4.5L3.8 10.8l4.4 1.6 1.4 5.1 2.6-3 4.2 3z"/><path d="M8.2 12.4l9-6.2-6 8.4"/>'),
  reddit: S('<circle cx="12" cy="13.5" r="7"/><path d="M9 12.5v.2M15 12.5v.2M9.5 16c1.5 1.2 3.5 1.2 5 0"/>'),
  linkedin: S(
    '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 10v6M8 7.5v.2M12 16v-3.5a1.8 1.8 0 013.6 0V16"/>',
  ),
  mastodon: S(
    '<path d="M6 9.5c0-2.8 2.7-4.5 6-4.5s6 1.7 6 4.5v3.2c0 1.6-1.3 2.8-3 2.8h-2.2L11 19v-3.5H9c-1.7 0-3-1.2-3-2.8z"/>' +
      '<path d="M10 8.5v2M14 8.5v2"/>',
  ),
  wave: S('<path d="M2 12h4l2-6 3 12 3-9 2 3h6"/>'),
};

export const icon = (name, extra = '') => (ICONS[name] ?? '').replace('<svg', `<svg class="${extra}"`);

/* ─────────────────────────── tiny DOM helpers ─────────────────────────── */

export const qs = (selector, root = document) => root.querySelector(selector);
export const qsa = (selector, root = document) => [...root.querySelectorAll(selector)];

/**
 * h('div', { class: 'x' }, 'text', childNode) — element factory.
 * Text always goes in through textContent, so remote metadata can never inject markup.
 */
export function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'html')
      node.innerHTML = value; // static markup only (icons)
    else if (key === 'style')
      node.style.cssText = value; // CSSOM, so no CSP inline-style violation
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key in node) node[key] = value;
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/* ─────────────────────────── formatting ─────────────────────────── */

/** 976513 → "16:17" */
export function fmtTime(ms) {
  const value = Number.isFinite(ms) && ms > 0 ? ms : 0;
  const total = Math.round(value / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** 5890246 → "1 h 38 min" */
export function fmtLong(ms) {
  const minutes = Math.round((ms ?? 0) / 60000);
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours} h ${minutes % 60} min` : `${minutes} min`;
}

export const fmtClock = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export function relTime(iso) {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

export const fmtPrice = (cents, currency = 'EUR') =>
  new Intl.NumberFormat(undefined, { style: 'currency', currency }).format((cents ?? 0) / 100);

export const fmtBpm = (bpm) => (bpm ? `${bpm} BPM` : null);

/* ─────────────────────────── toasts ─────────────────────────── */

let toastStack = null;

export function toast(message, { actionLabel, onAction, iconName = 'check', timeout = 4200 } = {}) {
  if (!toastStack) {
    toastStack = h('div', { class: 'toast-stack', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastStack);
  }
  const node = h(
    'div',
    { class: 'toast' },
    h('span', { class: 'flex', html: icon(iconName) }),
    h('span', {}, message),
  );
  if (actionLabel && onAction) {
    node.append(
      h(
        'button',
        {
          type: 'button',
          onClick: () => {
            onAction();
            node.remove();
          },
        },
        actionLabel,
      ),
    );
  }
  toastStack.append(node);
  setTimeout(() => node.remove(), timeout);
  return node;
}

/* ─────────────────────────── clipboard ─────────────────────────── */

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for non-secure contexts and older browsers.
    const area = h('textarea', { value: text, style: 'position:fixed;opacity:0' });
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}

/* ─────────────────────────── page chrome ─────────────────────────── */

const NAV = [
  { href: '/player/', label: 'Radio' },
  { href: '/tracks/', label: 'Library' },
  { href: '/favourites/', label: 'Favourites' },
  { href: '/about/', label: 'About' },
];

export function renderChrome({ active = '' } = {}) {
  const header = h(
    'header',
    { class: 'site-header' },
    h(
      'div',
      { class: 'container' },
      h(
        'a',
        { class: 'brand', href: '/' },
        h('img', {
          class: 'brand__mark',
          src: '/assets/img/logo-mark.png',
          alt: 'Anomalradio',
          width: '42',
          height: '26',
        }),
        h('span', { class: 'brand__name' }, 'anomalradio', h('span', {}, '.com')),
      ),
      h(
        'nav',
        { class: 'site-nav', 'aria-label': 'Main' },
        ...NAV.map((item) =>
          h('a', {
            class: 'nav-link',
            href: item.href,
            textContent: item.label,
            ...(item.label.toLowerCase() === active ? { 'aria-current': 'page' } : {}),
          }),
        ),
      ),
      h(
        'div',
        { class: 'header-tools' },
        h(
          'span',
          { class: 'pill pill--live', id: 'hdr-live', hidden: true },
          h('span', { class: 'live-dot' }),
          h('span', { id: 'hdr-listeners', textContent: '—' }),
        ),
        h(
          'button',
          { class: 'btn btn--primary btn--tunein', type: 'button', dataset: { action: 'tune-in' } },
          h('span', { html: icon('radio') }),
          h('span', {}, 'Tune in'),
        ),
        h(
          'a',
          { class: 'btn btn--icon', href: '/cart/', 'aria-label': 'Basket', id: 'hdr-cart' },
          h('span', { html: icon('cart') }),
        ),
      ),
    ),
  );

  const footer = h(
    'footer',
    { class: 'site-footer' },
    h(
      'div',
      { class: 'container' },
      h(
        'div',
        { class: 'footer-grid' },
        h(
          'div',
          {},
          h('h4', {}, 'Anomalradio'),
          h('p', {}, 'Own music only, 24/7. Hand-picked electronic releases, streamed from our own library.'),
        ),
        h(
          'div',
          {},
          h('h4', {}, 'Listen'),
          h(
            'ul',
            {},
            h('li', {}, h('a', { href: '/player/', textContent: 'Radio console' })),
            h('li', {}, h('a', { href: '/tracks/', textContent: 'Track library' })),
            h('li', {}, h('a', { href: '/favourites/', textContent: 'Your favourites' })),
            h('li', {}, h('a', { href: '/cart/', textContent: 'Basket' })),
          ),
        ),
        h(
          'div',
          {},
          h('h4', {}, 'Station'),
          h(
            'ul',
            {},
            h('li', {}, h('a', { href: '/about/', textContent: 'About & how it works' })),
            h('li', {}, h('a', { href: '/about/#security', textContent: 'Stream protection' })),
            h('li', {}, h('a', { href: '/about/#contact', textContent: 'Contact' })),
          ),
        ),
        h(
          'div',
          {},
          h('h4', {}, 'Legal'),
          h(
            'ul',
            {},
            h('li', {}, h('a', { href: '/about/#terms', textContent: 'Terms of use' })),
            h('li', {}, h('a', { href: '/about/#privacy', textContent: 'Privacy' })),
          ),
        ),
      ),
      h(
        'div',
        { class: 'footer-note' },
        h('span', { id: 'foot-status', textContent: 'station status —' }),
        h('span', {}, `© ${new Date().getFullYear()} Anomalradio.com`),
        h('span', {}, 'prototype build M1 · audio protected by token-gated streaming'),
      ),
    ),
  );

  document.body.prepend(header);
  document.body.append(footer);
}
