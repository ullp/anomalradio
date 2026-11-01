/**
 * Checkout resolution.
 *
 * M5 takes no money. It decides *where* a buy action goes — and because that decision ends up in an
 * `href`, the URL check is the security boundary of this milestone rather than a formality.
 *
 * Two layers, tested separately:
 *   · the pure resolver (server/checkout.js) — no database, no server, no HTTP
 *   · the served contract — /api/playlist, /api/tracks/:id, /api/config, and the buy-links CLI
 *
 * Variants needing a *different* CHECKOUT_DRIVER live in their own file, because `config` is read at
 * import time and one process cannot hold two configurations.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { ROOT, startTestServer } from './helpers/server.js';

const execFileAsync = promisify(execFile);

const STORE = 'https://payhip.com/Anomalradio';
const BANDCAMP = 'https://dwp.bandcamp.com/track/breach';

let ctx;
let client;
let checkout;
let scratch;

before(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), 'anomalradio-checkout-'));
  ctx = await startTestServer({
    env: {
      CHECKOUT_DRIVER: 'external',
      CHECKOUT_EXTERNAL_DEFAULT_URL: STORE,
      PUBLIC_ORIGIN: 'https://anomalradio.com',
    },
  });
  client = ctx.client;
  // Imported *after* the harness has set the environment: `config` freezes on first import, and the
  // harness warns that importing a server module early pins it to the real database.
  checkout = await import('../server/checkout.js');
});

after(async () => {
  await ctx?.close();
  await rm(scratch, { recursive: true, force: true });
});

/** A checkout config, with only the fields a given case cares about. */
const cfg = (over = {}) => ({
  driver: 'external',
  storeName: '',
  externalDefaultUrl: '',
  currency: 'EUR',
  defaultPriceCents: 199,
  ...over,
});

/* ─────────────────────────── URL safety ─────────────────────────── */

describe('isSafeBuyUrl', () => {
  const allowed = [
    ['a store product page', 'https://payhip.com/b/come'],
    ['a subdomain store', 'https://dwp.bandcamp.com/track/breach'],
    ['a query string and fragment', 'https://store.example.com/buy?track=1&ref=radio#top'],
    ['a localhost dev store', 'http://localhost:3000/store/x'],
    ['a loopback dev store', 'http://127.0.0.1:8080/x'],
  ];
  for (const [label, url] of allowed) {
    it(`accepts ${label}`, () => assert.equal(checkout.isSafeBuyUrl(url), true));
  }

  const rejected = [
    ['a javascript: payload', 'javascript:alert(1)'],
    ['a mixed-case javascript: scheme', 'JavaScript:alert(document.cookie)'],
    ['a data: URL', 'data:text/html,<script>alert(1)</script>'],
    ['a vbscript: payload', 'vbscript:msgbox(1)'],
    ['a file: path', 'file:///etc/passwd'],
    ['a protocol-relative URL', '//evil.example/buy'],
    ['a bare hostname', 'payhip.com/b/come'],
    ['a relative path', '/store/x'],
    ['plain http off localhost', 'http://payhip.com/b/come'],
    ['a link back to this site', 'https://anomalradio.com/track/ar_Kt0j2bAUde'],
    ['a link to our own subdomain', 'https://www.anomalradio.com/x'],
    ['a trailing newline', 'https://payhip.com/b/come\n'],
    ['a trailing CR', 'https://payhip.com/b/come\r'],
    ['a leading space', ' https://payhip.com/b/come'],
    ['an embedded space', 'https://payhip.com/b come'],
    ['a NUL byte', 'https://payhip.com/b/come\u0000'],
    ['a scheme with no host', 'https://'],
    ['an empty string', ''],
  ];
  for (const [label, url] of rejected) {
    it(`rejects ${label}`, () => assert.equal(checkout.isSafeBuyUrl(url), false));
  }

  it('rejects anything that is not a string', () => {
    for (const value of [null, undefined, 42, true]) {
      assert.equal(checkout.isSafeBuyUrl(value), false, String(value));
    }
    assert.equal(checkout.isSafeBuyUrl(['https://payhip.com']), false);
  });

  it('rejects an absurdly long URL', () => {
    assert.equal(checkout.isSafeBuyUrl(`https://payhip.com/${'a'.repeat(3000)}`), false);
  });
});

describe('storeLabel', () => {
  const cases = [
    ['https://payhip.com/b/x', 'Payhip'],
    ['https://dwp.payhip.com/b/x', 'Payhip'],
    ['https://dwp.bandcamp.com/track/x', 'Bandcamp'],
    ['https://ko-fi.com/x', 'Ko-fi'],
    ['https://someone.itch.io/x', 'itch.io'],
    ['https://shop.example.org/x', 'shop.example.org'],
  ];
  for (const [url, expected] of cases) {
    it(`${url} becomes ${expected}`, () => assert.equal(checkout.storeLabel(url), expected));
  }
});

/* ─────────────────────────── precedence ─────────────────────────── */

describe('resolvePurchase', () => {
  it('prefers the track own link over the store-wide fallback', () => {
    const purchase = checkout.resolvePurchase(
      { buyUrl: BANDCAMP },
      { checkout: cfg({ externalDefaultUrl: STORE }) },
    );
    assert.equal(purchase.kind, 'external');
    assert.equal(purchase.url, BANDCAMP);
    assert.equal(purchase.store, 'Bandcamp');
  });

  it('falls back to the store-wide URL when the track has none', () => {
    const purchase = checkout.resolvePurchase(
      { buyUrl: null },
      { checkout: cfg({ externalDefaultUrl: STORE }) },
    );
    assert.equal(purchase.url, STORE);
    assert.equal(purchase.store, 'Payhip');
  });

  it('prefers an explicit store name over the derived one', () => {
    const purchase = checkout.resolvePurchase(
      { buyUrl: null },
      { checkout: cfg({ externalDefaultUrl: STORE, storeName: 'our shop' }) },
    );
    assert.equal(purchase.store, 'our shop');
  });

  it('refuses an unsafe per-track link instead of falling through to the fallback', () => {
    const purchase = checkout.resolvePurchase(
      { buyUrl: 'javascript:alert(1)' },
      { checkout: cfg({ externalDefaultUrl: STORE }) },
    );
    // The point: a broken link must not silently become a different store.
    assert.deepEqual(purchase, { kind: 'none', reason: 'invalid-url' });
  });

  it('says nothing is for sale when there is no store at all', () => {
    assert.deepEqual(checkout.resolvePurchase({ buyUrl: null }, { checkout: cfg() }), {
      kind: 'none',
      reason: 'no-store',
    });
  });

  it('resolves to our own checkout only when the driver is stripe', () => {
    const track = { buyUrl: null, priceCents: 250, currency: 'EUR' };
    const internal = checkout.resolvePurchase(track, { checkout: cfg({ driver: 'stripe' }) });
    assert.equal(internal.kind, 'internal');
    assert.equal(internal.priceCents, 250);
    assert.equal(internal.currency, 'EUR');
    // and not otherwise
    assert.equal(checkout.resolvePurchase(track, { checkout: cfg() }).kind, 'none');
  });

  it('falls back to the configured price when the track has none', () => {
    const internal = checkout.resolvePurchase(
      { buyUrl: null },
      { checkout: cfg({ driver: 'stripe', defaultPriceCents: 149, currency: 'CZK' }) },
    );
    assert.equal(internal.priceCents, 149);
    assert.equal(internal.currency, 'CZK');
  });

  it('reports disabled rather than pretending', () => {
    const purchase = checkout.resolvePurchase({ buyUrl: STORE }, { checkout: cfg({ driver: 'disabled' }) });
    assert.deepEqual(purchase, { kind: 'none', reason: 'disabled' });
  });

  it('handles a missing track', () => {
    assert.equal(checkout.resolvePurchase(null, { checkout: cfg() }).kind, 'none');
  });
});

/* ─────────────────────────── served contract ─────────────────────────── */

describe('the served contract', () => {
  it('resolves a purchase onto every track in the playlist', async () => {
    const { body } = await client.raw('/api/playlist');
    assert.ok(body.tracks.length > 0);
    for (const track of body.tracks) {
      assert.equal(track.purchase.kind, 'external');
      assert.equal(track.purchase.url, STORE);
      assert.equal(track.purchase.store, 'Payhip');
    }
  });

  it('does the same on the track endpoint', async () => {
    const { body } = await client.raw(`/api/tracks/${ctx.track.id}`);
    assert.equal(body.track.purchase.kind, 'external');
    assert.equal(body.track.purchase.url, STORE);
  });

  it('never leaks the id to file mapping alongside it', async () => {
    const { text } = await client.raw('/api/playlist');
    for (const field of ['sourceFile', 'storageKey', 'sourcePath', 'contentHash', 'originalName']) {
      assert.ok(!text.includes(field), `${field} leaked into the playlist`);
    }
  });

  it('describes checkout on /api/config without leaking a secret', async () => {
    const { response, body, text } = await client.raw('/api/config');
    assert.equal(response.status, 200);
    assert.equal(body.checkout.driver, 'external');
    assert.equal(body.checkout.storeName, null);
    assert.equal(typeof body.checkout.currency, 'string');
    assert.equal(typeof body.checkout.defaultPriceCents, 'number');
    assert.ok(!/sk_|whsec_|secret/i.test(text), 'config leaked something secret-shaped');
  });
});

/* ─────────────────────────── is the link actually there? ─────────────────────────── */

describe('checkBuyUrlReachable', () => {
  const probe = async (url, options) =>
    (await import('../server/buy-links.js')).checkBuyUrlReachable(url, options);

  /**
   * A throwaway server that answers everything with one status, so the verdict table can be pinned
   * exactly rather than inferred from whatever routes this app happens to expose.
   */
  async function statusServer(status) {
    const server = createServer((_req, res) => {
      res.writeHead(status, { 'content-type': 'text/html' });
      res.end('<html></html>');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
      url: `http://127.0.0.1:${server.address().port}/store`,
      close: () => new Promise((resolve) => server.close(resolve)),
    };
  }

  it('a 2xx is reachable', async () => {
    const stub = await statusServer(200);
    try {
      const verdict = await probe(stub.url);
      assert.equal(verdict.reachable, true);
      assert.equal(verdict.verified, true);
      assert.equal(verdict.status, 200);
    } finally {
      await stub.close();
    }
  });

  it('a 404 is a confident "not found" — the useful answer', async () => {
    const stub = await statusServer(404);
    try {
      const verdict = await probe(stub.url);
      assert.equal(verdict.reachable, false);
      assert.equal(verdict.verified, true, 'a 404 is a real answer, not a failure to ask');
      assert.equal(verdict.reason, 'not-found');
    } finally {
      await stub.close();
    }
  });

  it('a 403 is *unverified*, not broken', async () => {
    // Storefronts refuse automated checks whether or not the page exists — Payhip answers 403 even
    // for its own homepage — so this must never be reported as a dead link.
    const stub = await statusServer(403);
    try {
      const verdict = await probe(stub.url);
      assert.equal(verdict.reachable, false);
      assert.equal(verdict.verified, false);
      assert.equal(verdict.reason, 'blocked');
      assert.equal(verdict.status, 403);
    } finally {
      await stub.close();
    }
  });

  it('a 500 is unverified too', async () => {
    const stub = await statusServer(500);
    try {
      const verdict = await probe(stub.url);
      assert.equal(verdict.reason, 'blocked');
    } finally {
      await stub.close();
    }
  });

  it('a host that will not answer is unverified, and does not throw', async () => {
    const verdict = await probe('http://127.0.0.1:1/nothing', { timeoutMs: 2000 });
    assert.equal(verdict.reachable, false);
    assert.equal(verdict.verified, false);
    assert.equal(verdict.status, null);
    assert.ok(verdict.error, 'it should say what went wrong');
  });

  it('a real page in this app is reachable', async () => {
    const verdict = await probe(`${ctx.baseUrl}/track/${ctx.track.id}`);
    assert.equal(verdict.reachable, true);
    assert.equal(verdict.status, 200);
  });
});

/* ─────────────────────────── the sidecar CLI ─────────────────────────── */

describe('npm run buy-links', () => {
  const run = (args) =>
    execFileAsync(process.execPath, [path.join(ROOT, 'scripts/buy-links.js'), ...args], {
      cwd: ROOT,
      env: { ...process.env, ANOMALRADIO_DB: ctx.dbPath },
    });

  const urlFor = async (id) => {
    const { body } = await client.raw('/api/playlist');
    return body.tracks.find((track) => track.id === id)?.purchase.url;
  };

  it('applies a valid sidecar to the catalogue', async () => {
    const file = path.join(scratch, 'buy-links.json');
    await writeFile(file, JSON.stringify({ [ctx.track.id]: BANDCAMP }), 'utf8');

    const { stdout } = await run(['--file', file]);
    assert.match(stdout, /applied\s+1 link/);
    assert.equal(await urlFor(ctx.track.id), BANDCAMP);

    // every other track keeps falling back to the store-wide URL
    const { body } = await client.raw('/api/playlist');
    for (const track of body.tracks.filter((t) => t.id !== ctx.track.id)) {
      assert.equal(track.purchase.url, STORE);
    }
  });

  it('writes nothing at all when one URL is unsafe', async () => {
    const before = await urlFor(ctx.track.id);
    const file = path.join(scratch, 'bad.json');
    await writeFile(file, JSON.stringify({ [ctx.track.id]: 'javascript:alert(1)' }), 'utf8');

    await assert.rejects(run(['--file', file]), (error) => {
      assert.match(error.stderr, /not an allowed https URL/);
      assert.match(error.stderr, /nothing was written/);
      return true;
    });

    assert.equal(await urlFor(ctx.track.id), before, 'a failed run changed the catalogue');
  });

  it('warns about ids that are not in the catalogue', async () => {
    const file = path.join(scratch, 'stray.json');
    await writeFile(file, JSON.stringify({ ar_NotARealId: STORE }), 'utf8');

    const { stdout, stderr } = await run(['--file', file]);
    assert.match(stderr, /not in the catalogue/);
    assert.match(stdout, /applied\s+0 link/);
  });

  it('--set writes a single link without a file', async () => {
    const { stdout } = await run(['--set', `${ctx.track.id}=https://shop.example.org/x`]);
    assert.match(stdout, /shop\.example\.org\/x/);
    assert.equal(await urlFor(ctx.track.id), 'https://shop.example.org/x');
  });

  it('--set refuses an unsafe URL', async () => {
    await assert.rejects(run(['--set', `${ctx.track.id}=javascript:alert(1)`]), (error) => {
      assert.match(error.stderr, /refusing to store an unsafe URL/);
      return true;
    });
    assert.equal(await urlFor(ctx.track.id), 'https://shop.example.org/x');
  });

  it('--list prints the current links as JSON', async () => {
    const { stdout } = await run(['--list']);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed[ctx.track.id], 'https://shop.example.org/x');
  });

  it('--dry-run reports without writing', async () => {
    const before = await urlFor(ctx.track.id);
    const file = path.join(scratch, 'dry.json');
    await writeFile(file, JSON.stringify({ [ctx.track.id]: 'https://other.example.org/y' }), 'utf8');

    const { stdout } = await run(['--file', file, '--dry-run']);
    assert.match(stdout, /nothing written/);
    assert.equal(await urlFor(ctx.track.id), before);
  });
});
