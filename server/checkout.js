/**
 * Checkout — where a track's "buy" action resolves.
 *
 * There are three ways to sell, and they differ only in where the action lands:
 *
 *   external  a store we do not run (Payhip, Bandcamp, Ko-fi, itch.io). We hand the buyer a link
 *             and nothing else: no card data, no order record, no VAT registration on our side.
 *             This is the default, and it is the only mode that needs no business entity.
 *   stripe    our own Checkout session and download tokens. Cheapest per sale, but it makes us the
 *             merchant of record — so it stays off until CHECKOUT_DRIVER=stripe is set explicitly.
 *   disabled  no buying at all.
 *
 * Resolution happens **server-side, once** — in `catalogue()` (library.js), which feeds both
 * `/api/playlist` and the generated static snapshot. So the live API and the GitHub Pages build
 * cannot drift apart: they are the same function's output.
 *
 * `isSafeBuyUrl()` is the security boundary here. A buy link is operator-supplied data that ends
 * up in an `href`, which means a typo — or a pasted `javascript:` payload — is stored XSS. Schemes
 * are allowlisted rather than blocklisted, so a scheme nobody thought of cannot slip through.
 */

import { config } from './config.js';

/** Only these schemes may ever reach an href. Everything else (`javascript:`, `data:`, …) is out. */
const ALLOWED_SCHEMES = new Set(['https:', 'http:']);

/** Plain http is a development convenience; these are the only hosts allowed to use it. */
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** So the button reads "Buy on Payhip" rather than "Buy on payhip.com". */
const STORE_NAMES = new Map([
  ['payhip.com', 'Payhip'],
  ['bandcamp.com', 'Bandcamp'],
  ['ko-fi.com', 'Ko-fi'],
  ['itch.io', 'itch.io'],
  ['lemonsqueezy.com', 'Lemon Squeezy'],
  ['gumroad.com', 'Gumroad'],
  ['buymeacoffee.com', 'Buy Me a Coffee'],
]);

const MAX_URL_LENGTH = 2048;

/**
 * Is this a URL we are willing to put in an `href`?
 *
 * Deliberately strict, and deliberately not a blocklist: `javascript:`, `vbscript:` and `data:`
 * all die on the scheme allowlist.
 */
export function isSafeBuyUrl(value) {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > MAX_URL_LENGTH) return false;
  // Surrounding or embedded whitespace is how attribute/header injection starts.
  if (value !== value.trim() || /\s/.test(value)) return false;
  // Control characters (NUL through US, plus DEL) have no business in a URL.
  if (/[\u0000-\u001f\u007f]/.test(value)) return false;

  let url;
  try {
    url = new URL(value);
  } catch {
    // Includes protocol-relative "//evil.example", which has no base to resolve against.
    return false;
  }

  if (!ALLOWED_SCHEMES.has(url.protocol)) return false;
  if (!url.hostname) return false;
  if (url.protocol === 'http:' && !LOCAL_HOSTNAMES.has(url.hostname)) return false;
  // A "buy" link that points back at this site is a loop, not a purchase.
  if (isSelfReference(url)) return false;

  return true;
}

/**
 * Compare against our own hostnames so a self-link cannot masquerade as a store.
 *
 * Local hostnames are skipped: they are a development convenience, they cannot be our public
 * origin in production, and treating them as "us" would make the http allowance above dead code.
 */
function isSelfReference(url) {
  if (LOCAL_HOSTNAMES.has(url.hostname.toLowerCase())) return false;
  const ours = new Set();
  for (const origin of [config.publicOrigin, ...config.allowedOrigins]) {
    try {
      ours.add(new URL(origin.replace('*.', 'www.')).hostname.toLowerCase());
    } catch {
      /* an unparseable ALLOWED_ORIGINS entry is not this function's problem */
    }
  }
  return ours.has(url.hostname.toLowerCase());
}

/** "https://dwp.payhip.com/b/x1" → "Payhip". Falls back to the bare hostname. */
export function storeLabel(value) {
  try {
    const host = new URL(value).hostname.toLowerCase().replace(/^www\./, '');
    for (const [domain, name] of STORE_NAMES) {
      if (host === domain || host.endsWith(`.${domain}`)) return name;
    }
    return host;
  } catch {
    return 'the store';
  }
}

/**
 * Where does "buy" go for this track?
 *
 * Precedence:
 *   1. the track's own link (per-track `buy_url` in the database)
 *   2. the store-wide fallback (`CHECKOUT_EXTERNAL_DEFAULT_URL`)
 *   3. our own checkout, when `CHECKOUT_DRIVER=stripe`
 *   4. nothing — and the UI says "not for sale yet" rather than showing a dead button
 *
 * An *invalid* URL is reported as `invalid-url` rather than silently falling through to the next
 * rule: a broken link should be visible to the operator, not quietly become a different store.
 */
export function resolvePurchase(track, { checkout = config.checkout } = {}) {
  if (!track) return { kind: 'none', reason: 'unknown-track' };
  if (checkout.driver === 'disabled') return { kind: 'none', reason: 'disabled' };

  for (const candidate of [track.buyUrl, checkout.externalDefaultUrl]) {
    if (!candidate) continue;
    if (!isSafeBuyUrl(candidate)) return { kind: 'none', reason: 'invalid-url' };
    return {
      kind: 'external',
      url: candidate,
      store: checkout.storeName || storeLabel(candidate),
    };
  }

  if (checkout.driver === 'stripe') {
    return {
      kind: 'internal',
      priceCents: track.priceCents ?? checkout.defaultPriceCents,
      currency: track.currency ?? checkout.currency,
    };
  }

  return { kind: 'none', reason: 'no-store' };
}

/**
 * Attach the resolved action to a track. Only public data is added — the id → file mapping stays
 * stripped by `sanitizeTrack()`.
 */
export const withPurchase = (track) => ({ ...track, purchase: resolvePurchase(track) });
