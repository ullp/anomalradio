/**
 * Token lifetime (§7.2 of the offer: `STREAM_TOKEN_TTL`).
 *
 * Short expiry is what makes a copied stream URL useless: by the time it is pasted into another
 * player it is already dead. This test runs with a 1-second TTL so it stays fast.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers/server.js';

const TTL_SECONDS = 1;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let ctx;
let client;

before(async () => {
  ctx = await startTestServer({ env: { STREAM_TOKEN_TTL: TTL_SECONDS } });
  client = ctx.client;
});

after(async () => {
  await ctx?.close();
});

describe('token lifetime', () => {
  it('advertises the configured TTL', async () => {
    const { response, body } = await client.session();
    assert.equal(response.status, 200);
    assert.equal(body.ttlSeconds, TTL_SECONDS);
    const remaining = Date.parse(body.expiresAt) - Date.now();
    assert.ok(remaining > 0 && remaining <= TTL_SECONDS * 1000 + 500);
  });

  it('accepts a fresh token, then refuses it once the TTL has passed', async () => {
    const { token } = await client.session({ trackId: ctx.track.id });

    const fresh = await client.stream(ctx.track.id, { token, range: 'bytes=0-9' });
    assert.equal(fresh.status, 206, 'a fresh token must work');
    await fresh.body?.cancel();

    await sleep(TTL_SECONDS * 1000 + 250);

    const stale = await client.stream(ctx.track.id, { token });
    assert.equal(stale.status, 403, 'an expired token must be refused');
    assert.equal((await stale.json()).reason, 'expired-token');
  });
});
