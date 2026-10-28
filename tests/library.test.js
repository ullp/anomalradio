/**
 * Local catalogue.
 *
 * These tests need the real music folder (`_data/music`) and ffprobe, so they skip themselves on
 * a fresh clone. When they do run they protect two things the fixture suite cannot:
 *   1. the metadata index still matches the audio actually on disk,
 *   2. the id derivation is stable — a changed id would break every existing share link.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { REAL_INDEX, REAL_SOURCE, ROOT, startTestServer } from './helpers/server.js';

const execFileAsync = promisify(execFile);

/** `null` when the suite can run, otherwise the reason to skip. */
async function unavailableReason() {
  try {
    await access(REAL_INDEX);
    await access(REAL_SOURCE);
  } catch {
    return 'no local music library (_data/music or data/tracks.json missing) — run `npm run import`';
  }
  try {
    await execFileAsync('ffprobe', ['-version']);
  } catch {
    return 'ffprobe is not on PATH';
  }
  return null;
}

const skip = await unavailableReason();

let library;
let tempDir;
let firstScan;

describe('local catalogue', { skip: skip ?? false }, () => {
  before(async () => {
    library = JSON.parse(await readFile(REAL_INDEX, 'utf8'));
    tempDir = await mkdtemp(path.join(tmpdir(), 'anomalradio-scan-'));
  });

  after(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it('describes every track consistently', () => {
    assert.ok(library.tracks.length > 0);
    assert.equal(library.trackCount, library.tracks.length);

    const ids = library.tracks.map((track) => track.id);
    assert.equal(new Set(ids).size, ids.length, 'track ids must be unique');

    for (const track of library.tracks) {
      assert.match(track.id, /^ar_[A-Za-z0-9]{10}$/, `${track.title} has a malformed id`);
      assert.ok(track.durationMs > 0, `${track.title} has no duration`);
      assert.ok(track.sizeBytes > 0, `${track.title} has no size`);
      assert.equal(typeof track.published, 'boolean');
      assert.equal(typeof track.sourceFile, 'string', 'the index keeps the private mapping server-side');
    }
  });

  it('points at audio that exists, with sizes that match', async () => {
    for (const track of library.tracks) {
      const file = path.join(REAL_SOURCE, track.sourceFile);
      const info = await stat(file).catch(() => null);
      assert.ok(info, `${track.sourceFile} is missing from _data/music`);
      assert.equal(
        info.size,
        track.sizeBytes,
        `${track.sourceFile} changed size — re-run \`npm run import\``,
      );
    }
  });

  it('keeps ids stable across re-scans', async () => {
    const first = path.join(tempDir, 'scan-1.json');
    const second = path.join(tempDir, 'scan-2.json');
    const script = path.join(ROOT, 'scripts/import-tracks.js');

    for (const out of [first, second]) {
      await execFileAsync(process.execPath, [script, '--source', REAL_SOURCE, '--out', out], { cwd: ROOT });
    }

    const idsFrom = async (file) => (JSON.parse(await readFile(file, 'utf8')).tracks ?? []).map((t) => t.id);
    const [a, b, committed] = await Promise.all([idsFrom(first), idsFrom(second), idsFrom(REAL_INDEX)]);

    assert.deepEqual(a, b, 'two scans of the same folder must produce the same ids in the same order');
    assert.deepEqual(
      a,
      committed,
      'ids changed since the index was committed — existing share links and favourites would break',
    );

    firstScan = JSON.parse(await readFile(first, 'utf8'));
  });

  it('re-derives the same metadata the committed index holds', () => {
    assert.ok(firstScan, 'the re-scan must have run');
    const byId = new Map(firstScan.tracks.map((track) => [track.id, track]));
    for (const track of library.tracks) {
      const rescanned = byId.get(track.id);
      assert.ok(rescanned, `${track.id} disappeared from the scan`);
      assert.equal(rescanned.title, track.title);
      assert.equal(rescanned.artist, track.artist);
      assert.equal(rescanned.durationMs, track.durationMs);
    }
  });

  it('serves the real catalogue without leaking storage paths', async () => {
    const ctx = await startTestServer({ source: REAL_SOURCE, index: REAL_INDEX });
    try {
      const { tracks } = await (await ctx.client.get('/api/playlist')).json();
      assert.equal(tracks.length, library.trackCount);
      const serialised = JSON.stringify(tracks);
      assert.ok(!serialised.includes('sourceFile'));
      assert.ok(!serialised.includes('.mp3'));
      assert.ok(!serialised.includes('_data/'));
      for (const track of tracks) assert.ok(!JSON.stringify(track).includes('/'));
    } finally {
      await ctx.close();
    }
  });
});
