/**
 * Static snapshot builder.
 *
 * The snapshot is what a file-only host serves (GitHub Pages, the shared host). Its whole reason to
 * exist is that the domain must show the real website rather than a repository README, while being
 * honest that playback needs the station server.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { REAL_INDEX, ROOT } from './helpers/server.js';

const execFileAsync = promisify(execFile);

let scratch;
let out;
let catalogue;

before(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), 'anomalradio-static-'));
  out = path.join(scratch, 'site');

  // No database and no music here on purpose: the builder must fall back to the committed export,
  // which is exactly what CI has.
  await execFileAsync(
    process.execPath,
    [path.join(ROOT, 'scripts/build-static.js'), '--out', out, '--base-url', 'https://anomalradio.test'],
    { cwd: ROOT, env: { ...process.env, ANOMALRADIO_DB: path.join(scratch, 'absent.db') } },
  );

  // The builder falls back to the committed export, so that is what the snapshot contains.
  catalogue = JSON.parse(await readFile(REAL_INDEX, 'utf8'));
});

after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe('static snapshot', () => {
  it('publishes the site itself', async () => {
    for (const file of ['index.html', '404.html', 'assets/css/tokens.css', 'assets/js/pages.js']) {
      const info = await stat(path.join(out, file));
      assert.ok(info.size > 0, `${file} should be published`);
    }
  });

  it('publishes a catalogue in the same shape as the API', async () => {
    const data = JSON.parse(await readFile(path.join(out, 'data', 'playlist.json'), 'utf8'));

    assert.equal(data.static, true, 'the client must be able to tell it is a snapshot');
    assert.equal(data.trackCount, data.tracks.length);
    assert.equal(
      data.totalDurationMs,
      data.tracks.reduce((sum, t) => sum + t.durationMs, 0),
    );
    const published = catalogue.tracks.filter((track) => track.published !== false);
    assert.equal(
      data.tracks.length,
      published.length,
      'the fallback export is used when there is no database',
    );

    for (const track of data.tracks) {
      assert.match(track.id, /^ar_[A-Za-z0-9]{10}$/);
      assert.ok(track.durationMs > 0);
      assert.equal(typeof track.title, 'string');
    }
  });

  it('never publishes anything private', async () => {
    const playlist = await readFile(path.join(out, 'data', 'playlist.json'), 'utf8');
    for (const needle of ['sourceFile', 'storageKey', 'streamKey', 'sourcePath', 'contentHash', '.mp3']) {
      assert.ok(!playlist.includes(needle), `the snapshot must not contain "${needle}"`);
    }
  });

  it('pre-renders one page per track with its own share card', async () => {
    const sample = catalogue.tracks[0];
    const html = await readFile(path.join(out, 'track', sample.id, 'index.html'), 'utf8');

    assert.match(html, new RegExp(`<title>${escapeRegExp(sample.title)} — ${escapeRegExp(sample.artist)}`));
    assert.match(html, /property="og:type" content="music\.song"/);
    assert.match(
      html,
      new RegExp(`property="og:url" content="https://anomalradio\\.test/track/${sample.id}"`),
    );
    assert.match(html, /"@type":"MusicRecording"/);
    assert.equal((html.match(/property="og:title"/g) ?? []).length, 1, 'exactly one og:title');
  });

  it('gives the landing page and the other pages their meta tags', async () => {
    const home = await readFile(path.join(out, 'index.html'), 'utf8');
    assert.match(home, /<title>Anomalradio\.com — own music only, 24\/7<\/title>/);
    assert.match(
      home,
      /property="og:image" content="https:\/\/anomalradio\.test\/assets\/img\/og-default\.jpg"/,
    );

    const library = await readFile(path.join(out, 'tracks', 'index.html'), 'utf8');
    assert.match(library, /<title>Track library — Anomalradio\.com<\/title>/);
  });

  it('says it is a preview rather than pretending to be the station', async () => {
    // The banner is added client-side, so assert the pieces it needs are present.
    const api = await readFile(path.join(out, 'assets', 'js', 'api.js'), 'utf8');
    assert.match(api, /STATIC_PLAYLIST = '\/data\/playlist\.json'/);
    assert.match(api, /isStatic/);

    const player = await readFile(path.join(out, 'assets', 'js', 'player.js'), 'utf8');
    assert.match(player, /playback needs the station server/);

    const about = await readFile(path.join(out, 'about', 'index.html'), 'utf8');
    assert.match(about, /id="deployment"/, 'the banner links to this anchor');
  });
});

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
