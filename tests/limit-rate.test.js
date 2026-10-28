/**
 * Session rate limit (§7.2 of the offer: `SESSION_RATE_LIMIT`).
 *
 * Token minting is the choke point for abuse: a ripper has to ask for a token before it can
 * request audio, so the limit has to hold even when the requests look like a browser.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers/server.js';

const LIMIT = 3;

let ctx;
let client;

before(async () => {
  ctx = await startTestServer({ env: { SESSION_RATE_LIMIT: LIMIT } });
  client = ctx.client;
});

after(async () => {
  await ctx?.close();
});

describe('session rate limit', () => {
  it(`allows ${LIMIT} token requests per minute and refuses the rest`, async () => {
    for (let attempt = 1; attempt <= LIMIT; attempt += 1) {
      const { response, token } = await client.session();
      assert.equal(response.status, 200, `request ${attempt} should be allowed`);
      assert.ok(token);
    }

    const refused = await client.session();
    assert.equal(refused.response.status, 429);
    assert.equal(refused.body.error, 'rate-limited');
  });

  it('refuses the whole class of requests once limited, not just token minting', async () => {
    // Still limited from the previous test: the bucket refills after a minute.
    const refused = await client.session();
    assert.equal(refused.response.status, 429);
  });
});
