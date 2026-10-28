/**
 * ★ favourites and ⇪ shares (M4).
 *
 * Both are per-track actions keyed to a caller — an account when signed in, an anonymous cookie
 * otherwise — which is why they share a file: the interesting cases are about *whose* rows they are
 * and whether the counters move exactly once.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers/server.js';

const OWNER = 'own_favetest000001';
let ctx;
let client;
let tracks;

before(async () => {
  // `env` is applied before the server modules are imported, which is what pins the scratch database.
  ctx = await startTestServer({ env: { MAIL_DRIVER: 'memory' } });
  client = ctx.client;
  tracks = ctx.library.tracks;
});

after(async () => {
  await ctx?.close();
});

const asOwner = (ownerKey = OWNER) => ({
  ...client.browserHeaders(),
  'content-type': 'application/json',
  cookie: `anomalradio_owner=${ownerKey}`,
});

const star = (trackId, headers = asOwner()) =>
  client.raw('/api/favourites', { method: 'POST', headers, body: JSON.stringify({ trackId }) });

const unstar = (trackId, headers = asOwner()) =>
  client.raw(`/api/favourites/${trackId}`, { method: 'DELETE', headers });

const list = (headers = asOwner()) => client.raw('/api/favourites', { headers });

describe('★ favourites', () => {
  it('starts empty, and hands an anonymous visitor an owner cookie', async () => {
    const { response, body } = await list({ ...client.browserHeaders() });
    assert.equal(response.status, 200);
    assert.equal(body.signedIn, false);
    assert.equal(body.count, 0);
    // A visitor with no cookie gets one, so their stars are stable without signing in.
    assert.match(response.headers.getSetCookie?.()[0] ?? '', /^anomalradio_owner=own_/);
  });

  it('stars, lists and unstars — and the count moves once', async () => {
    const trackId = tracks[0].id;

    const starred = await star(trackId);
    assert.equal(starred.response.status, 200);
    assert.equal(starred.body.starred, true);
    assert.equal(starred.body.stars, 1, 'the public star count follows');

    const again = await star(trackId);
    assert.equal(again.body.stars, 1, 'starring twice is idempotent, not a double count');

    const mine = await list();
    assert.equal(mine.body.count, 1);
    assert.equal(mine.body.tracks[0].id, trackId);
    assert.equal(mine.body.tracks[0].title, tracks[0].title);

    const removed = await unstar(trackId);
    assert.equal(removed.body.starred, false);
    assert.equal(removed.body.stars, 0);
    assert.equal((await list()).body.count, 0);
  });

  it('keeps one visitor\'s stars out of another\'s list', async () => {
    await star(tracks[1].id, asOwner('own_someoneelse0001'));
    const mine = await list(asOwner('own_a_different0001'));
    assert.equal(mine.body.count, 0, 'an owner key is not a shared bucket');
  });

  it('never leaks a storage path or a private field', async () => {
    await star(tracks[0].id, asOwner('own_leaktest0000001'));
    const { text } = await list(asOwner('own_leaktest0000001'));
    for (const forbidden of ['storageKey', 'previewKey', 'sourcePath', 'originalName', 'contentHash']) {
      assert.doesNotMatch(text, new RegExp(forbidden), `${forbidden} must not be served`);
    }
  });

  it('refuses a track that does not exist', async () => {
    const { response, body } = await star('ar_nosuchtrack');
    assert.equal(response.status, 404);
    assert.equal(body.error, 'track-not-found');
  });

  it('rejects a body that is not JSON', async () => {
    const { response } = await client.raw('/api/favourites', {
      method: 'POST',
      headers: asOwner('own_badjson00000001'),
      body: 'not json at all',
    });
    assert.equal(response.status, 400);
  });

  it('marks the track as starred for its owner only', async () => {
    await star(tracks[0].id, asOwner('own_marker000000001'));
    const mine = await client.raw(`/api/tracks/${tracks[0].id}`, {
      headers: { ...client.browserHeaders(), cookie: 'anomalradio_owner=own_marker000000001' },
    });
    assert.equal(mine.body.track.starred, true);

    const theirs = await client.raw(`/api/tracks/${tracks[0].id}`, {
      headers: { ...client.browserHeaders(), cookie: 'anomalradio_owner=own_someone00000001' },
    });
    assert.equal(theirs.body.track.starred, false);
  });
});

describe('⇪ share counter', () => {
  const share = (trackId, channel, headers = client.browserHeaders()) =>
    client.raw(`/api/tracks/${trackId}/share`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ channel }),
    });

  it('counts a share and reports the new total', async () => {
    const trackId = tracks[1].id;
    const first = await share(trackId, 'x');
    assert.equal(first.response.status, 200);
    assert.equal(first.body.channel, 'x');
    assert.equal(first.body.shares, 1);

    const second = await share(trackId, 'whatsapp');
    assert.equal(second.body.shares, 2);

    // The number the UI shows comes from the track itself.
    const track = await client.raw(`/api/tracks/${trackId}`, { headers: client.browserHeaders() });
    assert.equal(track.body.track.shares, 2);
  });

  it('counts an unknown channel as unknown rather than trusting it', async () => {
    const { body } = await share(tracks[1].id, '<script>alert(1)</script>');
    assert.equal(body.channel, 'unknown');
  });

  it('refuses a track that does not exist', async () => {
    const { response } = await share('ar_nosuchtrack', 'x');
    assert.equal(response.status, 404);
  });

  it('keeps the channel breakdown for later', async () => {
    const rows = ctx.query('SELECT channel, COUNT(*) AS n FROM share_events GROUP BY channel');
    const channels = Object.fromEntries(rows.map((row) => [row.channel, row.n]));
    assert.equal(channels.x, 1);
    assert.equal(channels.whatsapp, 1);
    assert.equal(channels.unknown, 1);
  });
});
