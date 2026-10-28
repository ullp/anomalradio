/**
 * Test harness.
 *
 * The M2 server reads its configuration at import time, so every override is applied to
 * `process.env` *before* the server module is imported (each test file runs in its own process).
 *
 * Three ways to get a library:
 *   · default             — a seeded fixture library: the two committed 800 ms MP3s are copied into
 *                           a temporary private media directory and their rows inserted into a
 *                           temporary database. Hermetic, fast, and needs no ffprobe.
 *   · `import: true`      — run the real import pipeline against `source` (needs ffprobe).
 *   · `dbPath`/`mediaDir` — point at an existing database and media directory (real catalogue).
 */

import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '..', '..');
export const FIXTURE_SOURCE = path.join(ROOT, 'tests/fixtures/library');
export const FIXTURE_INDEX = path.join(ROOT, 'tests/fixtures/tracks.json');
export const REAL_SOURCE = path.join(ROOT, '_data/music');
export const REAL_INDEX = path.join(ROOT, 'data/tracks.json');
export const REAL_DB = path.join(ROOT, 'data/anomalradio.db');
export const REAL_MEDIA = path.join(ROOT, 'media');

/** A realistic desktop-browser User-Agent — the server refuses anything less. */
export const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

/**
 * @param {object} options
 * @param {Record<string, string|number>} [options.env]  extra environment overrides
 * @param {string}  [options.source]   import folder (with `import: true`)
 * @param {string}  [options.indexPath] metadata index describing `source` (seeded mode)
 * @param {boolean} [options.import]   run the real import pipeline instead of seeding
 * @param {string}  [options.dbPath]   use an existing database
 * @param {string}  [options.mediaDir] use an existing media directory
 * @param {boolean} [options.publish]  publish imported tracks (default true in tests)
 */
export async function startTestServer(options = {}) {
  const scratch = await mkdtemp(path.join(tmpdir(), 'anomalradio-test-'));
  const dbPath = options.dbPath ?? path.join(scratch, 'anomalradio.db');
  const mediaDir = options.mediaDir ?? path.join(scratch, 'media');
  const source = options.source ?? FIXTURE_SOURCE;
  const fixtureIndex = options.indexPath ?? FIXTURE_INDEX;
  const exportPath = path.join(scratch, 'tracks.json');

  process.env.ANOMALRADIO_DB = dbPath;
  process.env.MEDIA_DIR = mediaDir;
  process.env.LIBRARY_SOURCE_DIR = source;
  process.env.LIBRARY_INDEX = options.import ? exportPath : fixtureIndex;
  process.env.NODE_ENV = 'test';
  for (const [key, value] of Object.entries(options.env ?? {})) process.env[key] = String(value);

  if (options.import) {
    const { importLibrary } = await import('../../server/importer.js');
    await importLibrary({ source, db: dbPath, out: exportPath, publish: options.publish ?? true });
  } else if (!options.dbPath) {
    await seedFixtureLibrary({ dbPath, mediaDir, source, indexPath: fixtureIndex });
  }

  const serverModule = await import('../../server/index.js');
  // `overrides` is a passthrough for injected collaborators. Careful: importing any server module
  // *before* calling this helper freezes `config` on the default paths (the real database), which is
  // why collaborators should be built here, from `options`, or configured through `env`.
  const server = await serverModule.startServer({ port: 0, ...(options.overrides ?? {}) });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const libraryModule = await import('../../server/library.js');
  const dbModule = await import('../../server/db.js');
  const catalogue = libraryModule.catalogue();

  return {
    baseUrl,
    dbPath,
    mediaDir,
    library: { ...catalogue, tracks: catalogue.tracks.map(libraryModule.sanitizeTrack) },
    track: libraryModule.sanitizeTrack(catalogue.tracks[0]),
    serverModule,
    libraryModule,
    /** The bytes the server actually serves for a track (the private master). */
    readStoredFile: (track) => readFile(path.join(mediaDir, 'tracks', `${track.id}.mp3`)),
    /** Run raw SQL against the test database. */
    query: (sql, ...params) => dbModule.all(sql, ...params),
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      dbModule.closeDatabase();
      await rm(scratch, { recursive: true, force: true });
    },
    client: createClient(baseUrl),
  };
}

/**
 * Build a database + private media directory from the committed fixture export.
 * This is what keeps the security suite hermetic: no ffprobe, no private music folder.
 */
async function seedFixtureLibrary({ dbPath, mediaDir, source, indexPath }) {
  const { openDatabase, upsertTrack } = await import('../../server/db.js');
  const fixture = JSON.parse(await readFile(indexPath, 'utf8'));

  openDatabase(dbPath);
  await mkdir(path.join(mediaDir, 'tracks'), { recursive: true });

  for (const track of fixture.tracks) {
    const stored = path.join(mediaDir, 'tracks', `${track.id}.mp3`);
    await copyFile(path.join(source, track.sourceFile), stored);
    const bytes = await readFile(stored);

    upsertTrack({
      ...track,
      storageKey: `tracks/${track.id}.mp3`,
      contentHash: createHash('sha256').update(bytes).digest('hex'),
      published: track.published ?? true,
      sourcePath: track.sourceFile,
      originalName: track.sourceFile,
    });
  }
}

/**
 * Small HTTP client with browser-like defaults, so tests read as
 * "a browser asked for X and got Y" rather than a wall of header plumbing.
 */
export function createClient(baseUrl) {
  const browserHeaders = (overrides = {}) => ({
    'user-agent': BROWSER_UA,
    referer: `${baseUrl}/player/`,
    ...overrides,
  });

  return {
    baseUrl,
    browserHeaders,

    /** Plain fetch with optional header overrides. */
    async get(pathname, { headers = {}, ...rest } = {}) {
      return fetch(`${baseUrl}${pathname}`, { headers, redirect: 'manual', ...rest });
    },

    /** Raw response with text, parsed JSON and content type — for leak assertions. */
    async raw(pathname, { headers = {}, ...rest } = {}) {
      const response = await fetch(`${baseUrl}${pathname}`, {
        headers,
        redirect: 'manual',
        ...rest,
      });
      const text = await response.text();
      let body = null;
      try {
        body = JSON.parse(text);
      } catch {
        /* not JSON — callers that need JSON assert on body themselves */
      }
      return { response, text, body, contentType: response.headers.get('content-type') };
    },

    /** Mint a stream token the way the browser does. */
    async session({ trackId = null, headers = {} } = {}) {
      const query = trackId ? `?track=${encodeURIComponent(trackId)}` : '';
      const response = await fetch(`${baseUrl}/api/session${query}`, { headers: browserHeaders(headers) });
      const body = await response.json().catch(() => ({}));
      return { response, body, token: body.token };
    },

    /** Request audio. Every gate is individually overridable so tests can trip one at a time. */
    async stream(trackId, { token, headers = {}, range } = {}) {
      const query = token ? `?t=${encodeURIComponent(token)}` : '';
      return fetch(`${baseUrl}/api/stream/${encodeURIComponent(trackId)}${query}`, {
        headers: browserHeaders({ ...(range ? { range } : {}), ...headers }),
        redirect: 'manual',
      });
    },
  };
}
