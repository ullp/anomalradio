/**
 * The state the station is actually in: no store connected.
 *
 * This gets its own file because `config` is read at import time — one process cannot hold two
 * CHECKOUT_DRIVER values — and because "nothing is for sale yet" is the default worth pinning.
 * The UI depends on it: the buy buttons must say so plainly rather than looking broken.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers/server.js';

let ctx;

before(async () => {
  // No CHECKOUT_* overrides at all: this is the out-of-the-box configuration.
  ctx = await startTestServer();
});

after(async () => {
  await ctx?.close();
});

describe('with no store configured', () => {
  it('defaults to the external driver', async () => {
    const { body } = await ctx.client.raw('/api/config');
    assert.equal(body.checkout.driver, 'external');
    assert.equal(body.checkout.storeName, null);
  });

  it('resolves every track to not-for-sale, with a reason the UI can act on', async () => {
    const { body } = await ctx.client.raw('/api/playlist');
    assert.ok(body.tracks.length > 0);
    for (const track of body.tracks) {
      assert.deepEqual(track.purchase, { kind: 'none', reason: 'no-store' });
    }
  });

  it('still prices the catalogue, so the UI can say what it will cost', async () => {
    const { body } = await ctx.client.raw('/api/playlist');
    for (const track of body.tracks) {
      assert.equal(typeof track.priceCents, 'number');
      assert.equal(typeof track.currency, 'string');
    }
  });

  it('keeps the audio contract unchanged: a purchase is not a stream', async () => {
    const { body } = await ctx.client.raw('/api/playlist');
    const { token } = await ctx.client.session({ trackId: body.tracks[0].id });
    const response = await ctx.client.stream(body.tracks[0].id, { token });
    assert.equal(response.status, 200);
    await response.body?.cancel();
  });
});
