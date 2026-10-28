/**
 * Security contract.
 *
 * These tests pin the promises made in `_data/design-offer.md` §7 and on `/about/#security`.
 * They are the reason M2 can rewrite the server internals without silently losing protection:
 * if any of these fail, the site is leaking something it claims not to leak.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, BROWSER_UA } from './helpers/server.js';

let ctx;
let client;

before(async () => {
  ctx = await startTestServer();
  client = ctx.client;
});

after(async () => {
  await ctx?.close();
});

/* ─────────────────────────── the indirection rule (§6.1) ─────────────────────────── */

describe('indirection rule — ids are public, paths never are', () => {
  /** Fields and fragments that would reveal where audio actually lives. */
  const forbidden = ['sourceFile', 'storageKey', '_data/', 'tests/fixtures', '/Users/'];

  /** Every track object reachable from an API response. */
  const trackObjectsIn = (body) => [
    ...(body.tracks ?? []),
    ...(body.track ? [body.track] : []),
    ...(body.now?.track ? [body.now.track] : []),
    ...(body.next?.track ? [body.next.track] : []),
    ...(body.history ?? []).map((entry) => entry.track),
  ];

  const assertNoPathLeak = (body, label) => {
    const serialised = JSON.stringify(body);
    for (const needle of forbidden) {
      assert.ok(!serialised.includes(needle), `${label} must not contain "${needle}"`);
    }
    const tracks = trackObjectsIn(body);
    assert.ok(tracks.length > 0, `${label} should expose at least one track`);
    for (const track of tracks) {
      const text = JSON.stringify(track);
      // A track object is ids + metadata only: no path separators, no filenames, no extensions.
      assert.ok(!text.includes('/'), `${label}: track ${track.id} contains a path-like value`);
      assert.ok(!/\.(mp3|m4a|flac|wav|aac|ogg|opus)/i.test(text), `${label}: track ${track.id} names a file`);
    }
  };

  for (const endpoint of ['/api/playlist', '/api/now-playing']) {
    it(`${endpoint} leaks no storage path or filename`, async () => {
      const { response, body } = await client.raw(endpoint);
      assert.equal(response.status, 200);
      assertNoPathLeak(body, endpoint);
    });
  }

  it('/api/tracks/:id leaks no storage path', async () => {
    const { response, body } = await client.raw(`/api/tracks/${ctx.track.id}`);
    assert.equal(response.status, 200);
    assertNoPathLeak(body, '/api/tracks/:id');
  });

  it('exposes only opaque ids', async () => {
    const { tracks } = await (await client.get('/api/playlist')).json();
    for (const track of tracks) {
      assert.match(track.id, /^ar_[A-Za-z0-9]{10}$/, `id "${track.id}" must be opaque and non-sequential`);
    }
  });

  it('publishes the live mount name — that one *is* public by design', async () => {
    const { station } = await (await client.get('/api/now-playing')).json();
    // The mount is the address of the continuous stream (M3), not a path to a stored file.
    assert.match(station.mount, /^\/[A-Za-z0-9._-]+\.mp3$/);
  });
});

/* ─────────────────────────── layer 1: storage isolation (§7.1) ─────────────────────────── */

describe('storage isolation — audio is never served as a file', () => {
  const attempts = [
    ['the real music folder', '/_data/music/dwp/01-Come.mp3'],
    ['the fixture folder', '/tests/fixtures/library/fixture-one.mp3'],
    ['a private media folder', '/media/tracks/ar_s6SPf8D6Bw.mp3'],
    ['the metadata index', '/data/tracks.json'],
    ['the env file', '/.env'],
    ['a source file', '/scripts/serve.js'],
    ['an encoded traversal', '/%2e%2e%2f%2e%2e%2fetc/passwd'],
    ['an encoded dotfile', '/assets/%2e%2e/%2e%2e/.env'],
  ];

  for (const [label, pathname] of attempts) {
    it(`refuses ${label} (${pathname})`, async () => {
      const response = await client.get(pathname);
      assert.equal(response.status, 404, `${pathname} must 404 (not 403 — existence is not confirmed)`);
      await response.body?.cancel();
    });
  }
});

/* ─────────────────────────── layer 2: session gating (§7.2) ─────────────────────────── */

describe('session gating — tokens are only issued to a browser context', () => {
  it('refuses a CLI client (curl, wget, rippers)', async () => {
    for (const ua of ['curl/8.7.1', 'Wget/1.21.4', 'streamripper/1.64']) {
      const response = await client.get('/api/session', { headers: { 'user-agent': ua } });
      assert.equal(response.status, 403, `${ua} must be refused`);
      assert.equal((await response.json()).error, 'blocked-user-agent');
    }
  });

  it('refuses a non-browser client even when its User-Agent is unknown', async () => {
    // Node's fetch sends `user-agent: node`, which is not on the denylist — the missing
    // referer has to stop it instead. Either way the token is not issued.
    const response = await client.get('/api/session', { headers: { 'user-agent': 'node' } });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, 'forbidden-origin');
  });

  it('refuses a request without a referer', async () => {
    const response = await client.get('/api/session', { headers: { 'user-agent': BROWSER_UA } });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, 'forbidden-origin');
  });

  it('refuses a foreign referer (hotlinking)', async () => {
    const response = await client.get('/api/session', {
      headers: { 'user-agent': BROWSER_UA, referer: 'https://evil.example/embed' },
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, 'forbidden-origin');
  });

  it('refuses known stream rippers even with a valid referer', async () => {
    for (const ua of ['streamripper/1.64', 'ffmpeg/8.0', 'Wget/1.21', 'yt-dlp/2026.01.01', 'aria2/1.37']) {
      const response = await client.get('/api/session', {
        headers: { 'user-agent': ua, referer: `${client.baseUrl}/player/` },
      });
      assert.equal(response.status, 403, `${ua} must be refused`);
      await response.body?.cancel();
    }
  });

  it('issues a short-lived token to a browser', async () => {
    const { response, body } = await client.session();
    assert.equal(response.status, 200);
    assert.ok(typeof body.token === 'string' && body.token.length >= 16);
    assert.ok(body.ttlSeconds > 0 && body.ttlSeconds <= 300, 'tokens must be short-lived');
    const ttlMs = Date.parse(body.expiresAt) - Date.now();
    assert.ok(ttlMs > 0 && ttlMs <= body.ttlSeconds * 1000 + 1000);
  });
});

/* ─────────────────────────── layer 2: stream gating (§7.2) ─────────────────────────── */

describe('stream gating — every gate fails closed', () => {
  it('refuses a stream request with no token', async () => {
    const response = await client.stream(ctx.track.id, {});
    assert.equal(response.status, 403);
    assert.equal((await response.json()).reason, 'missing-token');
  });

  it('refuses an unknown token', async () => {
    const response = await client.stream(ctx.track.id, { token: 'not-a-real-token' });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).reason, 'unknown-token');
  });

  it('refuses a token replayed from a different browser', async () => {
    const { token } = await client.session({ trackId: ctx.track.id });
    const response = await client.stream(ctx.track.id, {
      token,
      headers: { 'user-agent': `${BROWSER_UA} (other)` },
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).reason, 'ua-mismatch');
  });

  it('refuses a token replayed from a different IP (shared link)', async () => {
    const { token } = await client.session({ trackId: ctx.track.id });
    const response = await client.stream(ctx.track.id, {
      token,
      headers: { 'x-forwarded-for': '203.0.113.9' },
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).reason, 'ip-mismatch');
  });

  it('refuses a token bound to another track', async () => {
    const other = ctx.library.tracks[1];
    const { token } = await client.session({ trackId: ctx.track.id });
    const response = await client.stream(other.id, { token });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).reason, 'track-mismatch');
  });

  it('serves audio when every gate passes', async () => {
    const { token } = await client.session({ trackId: ctx.track.id });
    const response = await client.stream(ctx.track.id, { token });
    assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer());
    const expected = await ctx.readSourceFile(ctx.track);
    assert.equal(bytes.length, expected.length, 'the full file is delivered');
    assert.ok(bytes.equals(expected), 'delivered bytes match the stored master');
  });
});

/* ─────────────────────────── response hardening (§7.2, §7.4) ─────────────────────────── */

describe('response hardening', () => {
  it('marks audio as non-cacheable, non-indexable and without a filename hint', async () => {
    const { token } = await client.session({ trackId: ctx.track.id });
    const response = await client.stream(ctx.track.id, { token, range: 'bytes=0-99' });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-type'), 'audio/mpeg');
    assert.match(response.headers.get('cache-control') ?? '', /no-store/);
    assert.equal(response.headers.get('content-disposition'), 'inline');
    assert.match(response.headers.get('x-robots-tag') ?? '', /noindex/);
    assert.equal(response.headers.get('accept-ranges'), 'bytes');
    await response.body?.cancel();
  });

  it('sends a strict CSP and framing protection on HTML', async () => {
    const response = await client.get('/');
    const csp = response.headers.get('content-security-policy') ?? '';
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.ok(!csp.includes('unsafe-inline'), 'no inline scripts or styles are allowed');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.match(response.headers.get('referrer-policy') ?? '', /strict-origin/);
    await response.body?.cancel();
  });
});

/* ─────────────────────────── range support ─────────────────────────── */

describe('range requests — needed for seeking, still token-gated', () => {
  it('answers a byte range with 206 and the exact slice', async () => {
    const { token } = await client.session({ trackId: ctx.track.id });
    const source = await ctx.readSourceFile(ctx.track);
    const response = await client.stream(ctx.track.id, { token, range: 'bytes=100-199' });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), `bytes 100-199/${source.length}`);
    assert.equal(response.headers.get('content-length'), '100');
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.ok(bytes.equals(source.subarray(100, 200)));
  });

  it('rejects an unsatisfiable range with 416', async () => {
    const { token } = await client.session({ trackId: ctx.track.id });
    const source = await ctx.readSourceFile(ctx.track);
    const response = await client.stream(ctx.track.id, { token, range: `bytes=${source.length + 10}-` });
    assert.equal(response.status, 416);
    await response.body?.cancel();
  });

  it('does not serve a range without a token', async () => {
    const response = await client.stream(ctx.track.id, { range: 'bytes=0-99' });
    assert.equal(response.status, 403);
    await response.body?.cancel();
  });
});

/* ─────────────────────────── method safety ─────────────────────────── */

describe('method safety — read-only endpoints do not accept writes', () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    it(`${method} is refused on the public API`, async () => {
      for (const pathname of ['/api/playlist', '/api/session', `/api/stream/${ctx.track.id}`]) {
        const response = await client.get(pathname, { method, headers: client.browserHeaders() });
        assert.ok(
          response.status === 404 || response.status === 405,
          `${method} ${pathname} returned ${response.status} — expected 404/405`,
        );
        await response.body?.cancel();
      }
    });
  }
});
