/**
 * API contract.
 *
 * The frontend is written against these shapes (`_data/design-offer.md` §5.2) and M2 must keep
 * them, so they are pinned here: response shape, status codes, MIME types and the small pure
 * helpers the server exposes.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers/server.js';

let ctx;
let client;

before(async () => {
  ctx = await startTestServer();
  client = ctx.client;
});

after(async () => {
  await ctx?.close();
});

/* ─────────────────────────── catalogue ─────────────────────────── */

describe('GET /api/playlist', () => {
  it('returns the documented envelope', async () => {
    const { response, body } = await client.raw('/api/playlist');
    assert.equal(response.status, 200);
    assert.equal(typeof body.dev, 'boolean');
    assert.equal(body.trackCount, body.tracks.length);
    assert.equal(typeof body.totalDurationMs, 'number');
    assert.equal(
      body.totalDurationMs,
      body.tracks.reduce((sum, t) => sum + t.durationMs, 0),
    );
    assert.ok(body.album && typeof body.album.album === 'string');
  });

  it('describes every track with the fields the UI needs', async () => {
    const { tracks } = await (await client.get('/api/playlist')).json();
    for (const track of tracks) {
      assert.match(track.id, /^ar_[A-Za-z0-9]{10}$/);
      assert.equal(typeof track.title, 'string');
      assert.equal(typeof track.artist, 'string');
      assert.ok(track.durationMs > 0, 'duration is required for the player and the seek bar');
      assert.ok(Number.isInteger(track.priceCents));
      assert.match(track.currency, /^[A-Z]{3}$/);
      assert.equal(track.published, true, 'unpublished drafts must never reach the API');
    }
  });

  it('supports search, sort and single-track lookup', async () => {
    const { tracks } = await (await client.get('/api/playlist?q=two')).json();
    assert.equal(tracks.length, 1);
    assert.equal(tracks[0].title, 'Fixture Two');

    const byTitle = await (await client.get('/api/playlist?sort=title')).json();
    assert.deepEqual(
      byTitle.tracks.map((t) => t.title),
      [...byTitle.tracks.map((t) => t.title)].sort((a, b) => a.localeCompare(b, 'en')),
    );

    const { response, body } = await client.raw(`/api/tracks/${ctx.track.id}`);
    assert.equal(response.status, 200);
    assert.equal(body.track.id, ctx.track.id);
  });

  it('answers an unknown track id with 404', async () => {
    const { response, body } = await client.raw('/api/tracks/ar_doesnotexist');
    assert.equal(response.status, 404);
    assert.equal(body.error, 'track-not-found');
  });

  it('answers an unknown endpoint with 404', async () => {
    const { response, body } = await client.raw('/api/nope');
    assert.equal(response.status, 404);
    assert.equal(body.error, 'unknown-endpoint');
  });
});

/* ─────────────────────────── now playing ─────────────────────────── */

describe('GET /api/now-playing', () => {
  it('returns the documented envelope', async () => {
    const { response, body } = await client.raw('/api/now-playing');
    assert.equal(response.status, 200);

    assert.equal(body.simulated, true, 'the prototype clock is simulated — the UI must say so');
    assert.equal(body.station.name, 'Anomalradio');
    assert.ok(body.station.listeners >= 0);
    assert.ok(body.station.bitrate > 0);

    assert.ok(body.now.track.id);
    assert.ok(body.now.elapsedMs >= 0);
    assert.ok(body.now.remainingMs > 0);
    assert.ok(body.now.progress >= 0 && body.now.progress <= 1, 'progress must be a 0..1 ratio');
    assert.equal(typeof body.now.startedAt, 'string');
    assert.ok(!Number.isNaN(Date.parse(body.now.startedAt)));

    assert.ok(body.next.track.id);
    assert.ok(Array.isArray(body.history));
    assert.ok(body.history.length <= 15, 'history is capped at 15 entries, like the reference station');

    assert.ok(Number.isInteger(body.cycle.index));
    assert.ok(body.cycle.totalMs > 0);
    assert.ok(body.cycle.positionMs >= 0 && body.cycle.positionMs < body.cycle.totalMs);
  });

  it('streams the same shape over server-sent events', async () => {
    const response = await fetch(`${client.baseUrl}/api/now-playing/stream`, {
      headers: client.browserHeaders(),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);

    const reader = response.body.getReader();
    const { value } = await reader.read();
    const chunk = new TextDecoder().decode(value);
    await reader.cancel();

    assert.match(chunk, /event: track/);
    const dataLine = chunk.split('\n').find((line) => line.startsWith('data: '));
    assert.ok(dataLine, 'the first event must carry a data line');
    const state = JSON.parse(dataLine.slice('data: '.length));
    assert.ok(state.now.track.id, 'the SSE payload matches the polling payload');
  });
});

/* ─────────────────────────── static delivery ─────────────────────────── */

describe('static delivery', () => {
  const assets = [
    ['/', 'text/html'],
    ['/player/', 'text/html'],
    ['/tracks/', 'text/html'],
    ['/favourites/', 'text/html'],
    ['/cart/', 'text/html'],
    ['/about/', 'text/html'],
    ['/track/ar_s6SPf8D6Bw', 'text/html'],
    ['/assets/css/tokens.css', 'text/css'],
    ['/assets/js/pages.js', 'text/javascript'],
    ['/assets/img/logo-mark.png', 'image/png'],
    ['/assets/fonts/orbitron-900.woff2', 'font/woff2'],
    ['/assets/img/og-default.jpg', 'image/jpeg'],
  ];

  for (const [pathname, type] of assets) {
    it(`serves ${pathname} as ${type}`, async () => {
      const response = await client.get(pathname);
      assert.equal(response.status, 200, `${pathname} should exist`);
      assert.match(
        response.headers.get('content-type') ?? '',
        new RegExp(type.replace('/', '\\/')),
        pathname,
      );
      await response.body?.cancel();
    });
  }

  it('serves a styled 404 page with a real 404 status', async () => {
    const { response, text } = await client.raw('/nothing-here');
    assert.equal(response.status, 404);
    assert.match(response.headers.get('content-type') ?? '', /text\/html/);
    assert.match(text, /Signal lost/);
  });

  it('never caches in development, so edits show up immediately', async () => {
    const response = await client.get('/assets/css/tokens.css');
    assert.match(response.headers.get('cache-control') ?? '', /no-store/);
    await response.body?.cancel();
  });

  it('answers /healthz for monitoring', async () => {
    const { response, body } = await client.raw('/healthz');
    assert.equal(response.status, 200);
    assert.equal(body.status, 'ok');
    assert.ok(body.onAir);
    assert.ok(body.uptimeSeconds >= 0);
  });
});

/* ─────────────────────────── pure helpers ─────────────────────────── */

describe('sanitizeTrack', () => {
  it('strips server-side fields without mutating the input', () => {
    const input = {
      id: 'ar_TEST000000',
      title: 'A track',
      durationMs: 1000,
      sourceFile: 'artist/album/01.mp3',
      storageKey: 'tracks/ar_TEST000000.mp3',
    };
    const snapshot = { ...input };
    const output = ctx.serverModule.sanitizeTrack(input);

    assert.equal(output.sourceFile, undefined, 'sourceFile is the id → file mapping — never public');
    assert.equal(output.storageKey, undefined);
    assert.equal(output.id, input.id);
    assert.equal(output.title, input.title);
    assert.deepEqual(input, snapshot, 'the caller’s object must not be modified');
  });
});
