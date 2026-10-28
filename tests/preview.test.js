/**
 * Preview excerpts (M4).
 *
 * A preview is the one piece of audio served **without** a stream token, so what matters is that it
 * is genuinely not the master: a separate, short, low-bitrate file — and that the master route
 * still refuses to serve anything without a token. Both halves are asserted here, because a
 * "preview" that was really the original file would quietly undo the protection model.
 *
 * The excerpt is made with ffmpeg, so the suite skips itself when it is missing (as
 * tests/library.test.js does for the same reason).
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { BROWSER_UA, startTestServer } from './helpers/server.js';
// ffprobe.js imports nothing from the app config, so it is safe to load before the server starts.
import { probe } from '../server/ffprobe.js';

const has = (command) =>
  new Promise((resolve) => {
    execFile(command, ['-version'], (error) => resolve(!error));
  });

const ready = await has('ffmpeg');

describe('preview excerpts', { skip: ready ? false : 'ffmpeg is not installed' }, () => {
  let ctx;
  let client;

  before(async () => {
    // `import: true` runs the real import pipeline, which is what generates the excerpts.
    ctx = await startTestServer({ env: { MAIL_DRIVER: 'memory' }, import: true });
    client = ctx.client;
  });

  after(async () => {
    await ctx?.close();
  });

  const previewPath = (trackId) => path.join(ctx.mediaDir, 'previews', `${trackId}.mp3`);

  it('writes a shorter, mono excerpt next to the master at import', async () => {
    for (const track of ctx.library.tracks) {
      const preview = await stat(previewPath(track.id));
      assert.ok(preview.size > 0, 'the excerpt is not empty');
      // The public track must not carry the storage key…
      assert.equal(track.previewKey, undefined, 'sanitizeTrack strips the preview key');
      // …while the row keeps it, because that is how the route finds the file.
      const row = ctx.query('SELECT preview_key FROM tracks WHERE id = ?', track.id)[0];
      assert.match(row.preview_key ?? '', /^previews\//, 'the key is stored server-side');

      const excerpt = await probe(previewPath(track.id));
      const master = await probe(path.join(ctx.mediaDir, 'tracks', `${track.id}.mp3`));

      // Mono and shorter than the master — the properties that make it an excerpt rather than a
      // copy. (Not *smaller*: with the 800 ms test fixtures, 96 kbps × 0.6 s is actually larger than
      // 70 kbps × 0.8 s. On a real 320 kbps master the excerpt is roughly a fiftieth of the file.)
      assert.equal(excerpt.channels, 1, 'the excerpt is mono');
      assert.ok(
        excerpt.durationMs < master.durationMs,
        `excerpt (${excerpt.durationMs} ms) should be shorter than the master (${master.durationMs} ms)`,
      );
      assert.ok(excerpt.durationMs <= 30_000, 'never longer than the configured excerpt');
    }
  });

  it('serves it without a token, and it is not the master', async () => {
    const track = ctx.library.tracks[0];
    const response = await client.get(`/api/preview/${track.id}`, {
      headers: { 'user-agent': BROWSER_UA },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'audio/mpeg');
    assert.equal(response.headers.get('accept-ranges'), 'bytes');

    const served = Buffer.from(await response.arrayBuffer());
    const stored = await readFile(previewPath(track.id));
    assert.deepEqual(served, stored, 'the excerpt served is the excerpt stored');

    // The point of the whole file: this is not the music.
    const master = await ctx.readStoredFile(track);
    assert.notEqual(served.length, master.length);
    assert.ok(!served.equals(master), 'the bytes served are not the master file');
  });

  it('supports a range request, so a player can seek', async () => {
    const track = ctx.library.tracks[0];
    const response = await client.get(`/api/preview/${track.id}`, {
      headers: { 'user-agent': BROWSER_UA, range: 'bytes=0-99' },
    });
    assert.equal(response.status, 206);
    assert.match(response.headers.get('content-range') ?? '', /^bytes 0-99\/\d+$/);
    assert.equal((await response.arrayBuffer()).byteLength, 100);
  });

  it('refuses a stream ripper', async () => {
    const track = ctx.library.tracks[0];
    const response = await client.get(`/api/preview/${track.id}`, {
      headers: { 'user-agent': 'streamripper/1.64' },
    });
    assert.equal(response.status, 403);
    await response.body?.cancel();
  });

  it('answers 404 for an unknown track', async () => {
    const response = await client.get('/api/preview/ar_nosuchtrack', {
      headers: { 'user-agent': BROWSER_UA },
    });
    assert.equal(response.status, 404);
    await response.body?.cancel();
  });

  it('did not loosen the master: it still needs a token', async () => {
    const track = ctx.library.tracks[0];
    const response = await client.get(`/api/stream/${track.id}`, {
      headers: client.browserHeaders(),
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).reason, 'missing-token');
  });

  it('never exposes the preview key through the API', async () => {
    const { text } = await client.raw('/api/playlist', { headers: client.browserHeaders() });
    assert.doesNotMatch(text, /previewKey|previews\//);
  });
});
