/**
 * The admin is off unless configured.
 *
 * Its own file because `config` is read at import time — one process cannot be both configured and
 * unconfigured. This is the guarantee that matters most: a deployment cannot expose a control panel
 * by accident, and the station boots with nothing set.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers/server.js';

let ctx;

before(async () => {
  // Deliberately no ADMIN_* environment at all.
  ctx = await startTestServer();
});

after(async () => {
  await ctx?.close();
});

describe('with no ADMIN_PASSWORD_HASH', () => {
  it('answers 404, as if the path were not there', async () => {
    const paths = [
      '/admin',
      '/admin/',
      '/admin/admin.css',
      '/admin/admin.js',
      '/admin/api/summary',
      '/admin/api/tracks',
    ];
    for (const pathname of paths) {
      const response = await ctx.client.get(pathname, { headers: ctx.client.browserHeaders() });
      assert.equal(response.status, 404, pathname);
    }
  });

  it('refuses a sign-in attempt rather than half-working', async () => {
    const response = await fetch(`${ctx.baseUrl}/admin/login`, {
      method: 'POST',
      headers: {
        ...ctx.client.browserHeaders(),
        origin: ctx.baseUrl,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'password=anything',
      redirect: 'manual',
    });
    assert.equal(response.status, 404);
  });

  it('does not leak the shell through the ordinary static handler either', async () => {
    for (const pathname of ['/admin/index.html', '/admin/admin.js']) {
      const response = await ctx.client.get(pathname, { headers: ctx.client.browserHeaders() });
      assert.equal(response.status, 404, pathname);
    }
  });

  it('leaves the station itself completely unaffected', async () => {
    const health = await ctx.client.get('/healthz');
    assert.equal(health.status, 200);
    const playlist = await ctx.client.get('/api/playlist');
    assert.equal(playlist.status, 200);
    assert.ok((await playlist.json()).tracks.length > 0);
  });
});
