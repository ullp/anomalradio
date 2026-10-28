/**
 * Test harness for the Anomalradio prototype server.
 *
 * `scripts/serve.js` reads its configuration at import time, so environment overrides
 * (library paths, token TTL, rate limits, stream caps) must be applied *before* it is
 * imported. That is why this helper sets `process.env` and then imports the server
 * lazily — each test file gets its own process, so the overrides stay isolated.
 *
 * The default target is the committed fixture library (two 800 ms MP3s plus an index
 * produced by the real scanner), which keeps the security suite hermetic: it does not
 * depend on the developer's private music folder.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '..', '..');
export const FIXTURE_SOURCE = path.join(ROOT, 'tests/fixtures/library');
export const FIXTURE_INDEX = path.join(ROOT, 'tests/fixtures/tracks.json');
export const REAL_SOURCE = path.join(ROOT, '_data/music');
export const REAL_INDEX = path.join(ROOT, 'data/tracks.json');

/** A realistic desktop-browser User-Agent — the server refuses anything less. */
export const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

/**
 * Start the server on an ephemeral port.
 * @param {{ env?: Record<string, string|number>, source?: string, index?: string }} options
 */
export async function startTestServer({ env = {}, source = FIXTURE_SOURCE, index = FIXTURE_INDEX } = {}) {
  process.env.LIBRARY_SOURCE_DIR = source;
  process.env.LIBRARY_INDEX = index;
  for (const [key, value] of Object.entries(env)) process.env[key] = String(value);

  const serverModule = await import('../../scripts/serve.js');
  const server = await serverModule.startServer({ port: 0 });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const library = JSON.parse(await readFile(index, 'utf8'));

  return {
    baseUrl,
    library,
    /** The already-imported server module — its internals are configured for this test run. */
    serverModule,
    /** The first fixture track — what most tests play with. */
    track: library.tracks[0],
    /** Read the bytes of a fixture track straight off disk, for byte-level assertions. */
    readSourceFile: (track) => readFile(path.join(source, track.sourceFile)),
    close: () => new Promise((resolve) => server.close(resolve)),
    client: createClient(baseUrl),
  };
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
    async raw(pathname, { headers = {} } = {}) {
      const response = await fetch(`${baseUrl}${pathname}`, { headers, redirect: 'manual' });
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
