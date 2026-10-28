/**
 * Import pipeline.
 *
 * This is where M2's real work happens — audio leaves the import folder and lands in private storage
 * with a database row — so the behaviour is pinned here: id derivation, content-hash based rename
 * detection, the publication rules, idempotency, and the metadata-only mode that other tests rely on.
 *
 * Needs ffprobe; skips itself with a clear reason when it is missing.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FIXTURE_SOURCE, ROOT } from './helpers/server.js';

const execFileAsync = promisify(execFile);

const skip = await (async () => {
  try {
    await execFileAsync('ffprobe', ['-version']);
    return false;
  } catch {
    return 'ffprobe is not on PATH';
  }
})();

let scratch;
let importLibrary;
let db;
let storage;

before(async () => {
  // Nothing to prepare when the suite is going to be skipped (no ffmpeg on this machine/runner).
  if (skip) return;

  scratch = await mkdtemp(path.join(tmpdir(), 'anomalradio-import-'));
  process.env.ANOMALRADIO_DB = path.join(scratch, 'anomalradio.db');
  process.env.MEDIA_DIR = path.join(scratch, 'media');
  process.env.LIBRARY_SOURCE_DIR = path.join(scratch, 'incoming');
  process.env.LIBRARY_INDEX = path.join(scratch, 'tracks.json');

  await mkdir(process.env.LIBRARY_SOURCE_DIR, { recursive: true });
  await cp(FIXTURE_SOURCE, process.env.LIBRARY_SOURCE_DIR, { recursive: true });

  // A third file that is genuinely new audio: a copy of a fixture would (correctly) be recognised
  // as the same track by its content hash, which is not what the publication tests need.
  await execFileAsync('ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=330:duration=0.8',
    '-codec:a',
    'libmp3lame',
    '-b:a',
    '64k',
    '-metadata',
    'title=Fixture Three',
    '-metadata',
    'artist=Test Signal',
    '-y',
    path.join(process.env.LIBRARY_SOURCE_DIR, 'fixture-three.mp3'),
  ]);

  ({ importLibrary } = await import('../server/importer.js'));
  db = await import('../server/db.js');
  const { createStorage } = await import('../server/storage/index.js');
  storage = createStorage();
});

after(async () => {
  db?.closeDatabase();
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

const run = (options = {}) =>
  importLibrary({
    source: process.env.LIBRARY_SOURCE_DIR,
    db: process.env.ANOMALRADIO_DB,
    out: process.env.LIBRARY_INDEX,
    ...options,
  });

describe('import pipeline', { skip: skip || false }, () => {
  it('copies audio into private storage and records it in the database', async () => {
    const result = await run({ publish: true });
    assert.equal(result.tracks.length, 3);
    assert.equal(result.stored, 3, 'every file is new');
    assert.equal(result.unchanged, 0);

    for (const track of result.tracks) {
      const stored = await storage.stat(`tracks/${track.id}.mp3`);
      assert.ok(stored, `${track.id} must exist in private storage`);
      assert.equal(stored.size, track.sizeBytes);
    }

    const rows = db.all('SELECT id, storage_key, published, content_hash FROM tracks ORDER BY id');
    assert.equal(rows.length, 3);
    for (const row of rows) {
      assert.equal(row.storage_key, `tracks/${row.id}.mp3`);
      assert.equal(row.published, 1);
      assert.match(row.content_hash, /^[0-9a-f]{64}$/);
    }
  });

  it('is idempotent: a second run copies nothing and keeps the ids', async () => {
    const before = db.all('SELECT id FROM tracks ORDER BY id').map((row) => row.id);
    const result = await run({ publish: true });
    const after = db.all('SELECT id FROM tracks ORDER BY id').map((row) => row.id);

    assert.equal(result.stored, 0, 'nothing is copied twice');
    assert.equal(result.unchanged, 3);
    assert.deepEqual(after, before, 'ids do not move');
  });

  it('recognises the same audio after a rename and keeps its id', async () => {
    const sourceDir = process.env.LIBRARY_SOURCE_DIR;
    const [first] = db.all('SELECT id, source_path FROM tracks ORDER BY source_path LIMIT 1');
    await rename(path.join(sourceDir, first.source_path), path.join(sourceDir, 'renamed-track.mp3'));

    const result = await run({ publish: true });
    const renamed = result.tracks.find((track) => track.sourceFile === 'renamed-track.mp3');

    assert.ok(renamed, 'the renamed file is imported');
    assert.equal(renamed.id, first.id, 'the content hash wins over the derived id');
    assert.equal(result.tracks.length, 3, 'no duplicate row was created');

    // put it back so later tests see the original layout
    await rename(path.join(sourceDir, 'renamed-track.mp3'), path.join(sourceDir, first.source_path));
    await run({ publish: true });
  });
});

describe('import pipeline — publication rules', { skip: skip || false }, () => {
  it('treats a new file as a draft unless asked to publish', async () => {
    const sourceDir = process.env.LIBRARY_SOURCE_DIR;
    const fresh = path.join(sourceDir, 'draft-candidate.mp3');
    await execFileAsync('ffmpeg', [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=550:duration=0.5',
      '-codec:a',
      'libmp3lame',
      '-b:a',
      '64k',
      '-metadata',
      'title=Draft Candidate',
      '-metadata',
      'artist=Test Signal',
      '-y',
      fresh,
    ]);

    try {
      const draft = await run();
      assert.equal(
        draft.tracks.find((track) => track.sourceFile === 'draft-candidate.mp3').published,
        false,
        'a new file must not go live by accident',
      );

      // An existing row keeps its own state: `--publish` is for new tracks, not a bulk republish.
      const again = await run({ publish: true });
      assert.equal(
        again.tracks.find((track) => track.sourceFile === 'draft-candidate.mp3').published,
        false,
        '--publish must not resurrect an existing draft',
      );

      // The explicit escape hatch for that case.
      const forced = await run({ publishExisting: true });
      assert.equal(forced.tracks.find((track) => track.sourceFile === 'draft-candidate.mp3').published, true);

      // And it stays published on later runs.
      const settled = await run();
      assert.equal(
        settled.tracks.find((track) => track.sourceFile === 'draft-candidate.mp3').published,
        true,
      );
    } finally {
      await rm(fresh, { force: true });
      db.run('DELETE FROM tracks WHERE source_path = ?', 'draft-candidate.mp3');
    }
  });

  it('honours the previous export when there is no database row yet', async () => {
    const out = path.join(scratch, 'carry-over.json');
    await writeFile(
      out,
      JSON.stringify({
        tracks: [{ id: 'ar_s6SPf8D6Bw', published: true, priceCents: 499, currency: 'CZK' }],
      }),
    );

    // A fresh database, with the export carrying the previous publication state and price.
    const result = await run({ db: path.join(scratch, 'carry-over.db'), out, publish: false });
    const carried = result.tracks.find((track) => track.id === 'ar_s6SPf8D6Bw');

    assert.equal(carried.published, true, 'publication survives the migration from the JSON index');
    assert.equal(carried.priceCents, 499);
    assert.equal(carried.currency, 'CZK');
  });
});

describe('import pipeline — outputs', { skip: skip || false }, () => {
  it('writes an export that keeps the source path but no storage keys', async () => {
    await run({ publish: true });
    const exported = JSON.parse(await readFile(process.env.LIBRARY_INDEX, 'utf8'));
    const sample = exported.tracks[0];

    assert.equal(typeof sample.sourceFile, 'string', 'the export is readable by a human');
    for (const key of ['storageKey', 'streamKey', 'sourcePath', 'originalName', 'contentHash']) {
      assert.equal(sample[key], undefined, `${key} belongs to the database, not the export`);
    }
  });

  it('metadata-only mode writes nothing to storage or the database', async () => {
    const out = path.join(scratch, 'metadata-only.json');
    const dbPath = path.join(scratch, 'metadata-only.db');
    const result = await run({ metadataOnly: true, out, db: dbPath });

    assert.equal(result.tracks.length, 3);
    assert.equal(result.stored, 0);
    assert.equal(JSON.parse(await readFile(out, 'utf8')).trackCount, 3);
    await assert.rejects(() => stat(dbPath), 'no database is created in metadata-only mode');
  });

  it('dry-run reports without writing', async () => {
    const out = path.join(scratch, 'dry-run.json');
    await run({ dryRun: true, out });
    await assert.rejects(() => stat(out), 'dry-run must not write the export');
  });

  it('runs end to end from the command line', async () => {
    const out = path.join(scratch, 'cli.json');
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        path.join(ROOT, 'scripts/import-tracks.js'),
        '--source',
        process.env.LIBRARY_SOURCE_DIR,
        '--out',
        out,
        '--db',
        path.join(scratch, 'cli.db'),
        '--metadata-only',
      ],
      { cwd: ROOT },
    );

    assert.match(stdout, /Anomalradio import/);
    assert.match(stdout, /3 track\(s\)/);
    assert.match(stdout, /● published|○ draft/);
    assert.equal(JSON.parse(await readFile(out, 'utf8')).trackCount, 3);
  });
});
