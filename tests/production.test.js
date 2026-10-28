/**
 * Production mode.
 *
 * This is the configuration the station actually runs under on the box (`NODE_ENV=production`), and
 * until now it had never been executed: the suite runs in `test`, the dev server in `development`.
 * Two things only happen in production — the SECRET requirement, and responses that stop
 * advertising themselves as a development server — and both are pinned here.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BROWSER_UA, ROOT, startTestServer } from './helpers/server.js';

const execFileAsync = promisify(execFile);
const VLC_UA = 'VLC/3.0.21 LibVLC/3.0.21';

let ctx;

before(async () => {
  // The harness applies `env` after its own defaults, so this really is production mode.
  ctx = await startTestServer({ env: { NODE_ENV: 'production', SECRET: 'a'.repeat(64) } });
});

after(async () => {
  await ctx?.close();
});

describe('production mode', () => {
  it('does not advertise itself as a development server', async () => {
    const { body } = await ctx.client.raw('/api/playlist', { headers: ctx.client.browserHeaders() });
    assert.equal(body.dev, false);
    assert.equal(body.trackCount, ctx.library.tracks.length);
  });

  it('still serves the site, the API and the mount', async () => {
    const page = await ctx.client.get('/', { headers: ctx.client.browserHeaders() });
    assert.equal(page.status, 200);
    await page.body?.cancel();

    const health = await ctx.client.raw('/healthz');
    assert.equal(health.body.status, 'ok');
    assert.equal(health.body.streaming, true);
    assert.equal(health.body.storage, 'local');
  });

  it('hands a desktop player a usable station file', async () => {
    // The path the box actually uses for VLC: no referer, the player's own User-Agent.
    const { response, text } = await ctx.client.raw('/radio.pls', {
      headers: { 'user-agent': VLC_UA },
    });
    assert.equal(response.status, 200);
    assert.match(text, /^\[playlist\]/);
    assert.match(text, /File1=\S+radio-128\.mp3\?t=/);
  });

  it('keeps the private paths private', async () => {
    for (const pathname of ['/media/tracks/x.mp3', '/data/anomalradio.db', '/server/index.js']) {
      const response = await ctx.client.get(pathname, { headers: ctx.client.browserHeaders() });
      assert.equal(response.status, 404, pathname);
      await response.body?.cancel();
    }
  });

  it('refuses to start without a SECRET', async () => {
    // The production guard: a guessable secret means anyone can mint their own stream tokens.
    // SECRET is set to empty rather than unset, so a developer's local `.env` cannot mask this.
    await assert.rejects(
      execFileAsync(process.execPath, ['scripts/serve.js'], {
        cwd: ROOT,
        env: { ...process.env, NODE_ENV: 'production', SECRET: '', PORT: '0' },
        timeout: 15000,
      }),
      (error) => {
        const output = `${error.stderr ?? ''}${error.stdout ?? ''}${error.message ?? ''}`;
        assert.match(output, /SECRET/, `expected a SECRET complaint, got: ${output.slice(0, 200)}`);
        return true;
      },
    );
  });
});
