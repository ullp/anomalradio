/**
 * The continuous stream (M3).
 *
 * The mount is the whole point of a radio: one endless response, no per-track resource, paced to
 * real time so it cannot be used as a bulk download. These tests run against the fixture library
 * (800 ms tracks), which makes track changes and history recording observable in seconds.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers/server.js';

const METAINT = 16384;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let ctx;
let client;
let radioInfo;

/** Read from a live response for a while, then close it. */
async function capture(pathname, { headers, ms = 1500 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const chunks = [];

  try {
    const response = await fetch(`${client.baseUrl}${pathname}`, { headers, signal: controller.signal });
    if (!response.ok) {
      clearTimeout(timer);
      return { response, bytes: Buffer.alloc(0) };
    }
    for await (const chunk of response.body) chunks.push(Buffer.from(chunk));
    clearTimeout(timer);
    return { response, bytes: Buffer.concat(chunks) };
  } catch (error) {
    clearTimeout(timer);
    if (error.name === 'AbortError') return { response: null, bytes: Buffer.concat(chunks) };
    throw error;
  }
}

/** Pull the ICY metadata block that must sit after exactly `interval` bytes of audio. */
function icyTitle(bytes, interval = METAINT) {
  if (bytes.length < interval + 1) return null;
  const length = bytes[interval];
  if (length === 0 || length > 64) return null;
  return bytes
    .subarray(interval + 1, interval + 1 + length * 16)
    .toString('utf8')
    .replace(/\0+$/, '');
}

before(async () => {
  ctx = await startTestServer();
  client = ctx.client;
  const radioResponse = await client.get('/api/radio', { headers: client.browserHeaders() });
  assert.equal(radioResponse.status, 200, 'the radio endpoint must answer a browser');
  radioInfo = await radioResponse.json();
});

after(async () => {
  await ctx?.close();
});

describe('continuous mount — gating', () => {
  it('refuses a listener without a token', async () => {
    const response = await client.get(radioInfo.mount, { headers: client.browserHeaders() });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).reason, 'missing-token');
  });

  it('refuses a ripper or a foreign referer', async () => {
    const { token } = await client.session();

    const ripper = await client.get(`${radioInfo.mount}?t=${token}`, {
      headers: { 'user-agent': 'streamripper/1.64', referer: `${client.baseUrl}/player/` },
    });
    assert.equal(ripper.status, 403);

    const foreign = await client.get(`${radioInfo.mount}?t=${token}`, {
      headers: client.browserHeaders({ referer: 'https://evil.example/' }),
    });
    assert.equal(foreign.status, 403);
    await foreign.body?.cancel();
  });

  it('refuses a token minted for a different browser', async () => {
    const { token } = await client.session();
    const response = await client.get(`${radioInfo.mount}?t=${token}`, {
      headers: client.browserHeaders({ 'user-agent': `${client.browserHeaders()['user-agent']} (other)` }),
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).reason, 'ua-mismatch');
  });
});

describe('continuous mount — the stream itself', () => {
  it('serves one endless response with ICY headers', async () => {
    const response = await client.get(radioInfo.url, { headers: client.browserHeaders() });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'audio/mpeg');
    assert.equal(response.headers.get('icy-name'), 'Anomalradio');
    assert.equal(response.headers.get('icy-metaint'), String(METAINT));
    assert.match(response.headers.get('icy-br') ?? '', /^\d+$/);
    assert.match(response.headers.get('cache-control') ?? '', /no-store/);
    await response.body?.cancel();
  });

  it('sends audio, paced to real time rather than at disk speed', async () => {
    const { bytes } = await capture(radioInfo.url, { headers: client.browserHeaders(), ms: 1500 });

    assert.ok(bytes.length > 5000, `expected audio, got ${bytes.length} bytes`);

    // The fixture tracks run at ~70 kbps (~8.8 kB/s). A file dump would be orders of magnitude
    // faster — this is the difference between a radio stream and a download.
    const bytesPerSecond = 70_000 / 8;
    const ceiling = bytesPerSecond * 1.5 * 6; // generous: the initial buffering burst is normal
    assert.ok(
      bytes.length < ceiling,
      `${bytes.length} bytes in 1.5 s exceeds the paced ceiling of ${Math.round(ceiling)} — the mount is not throttled`,
    );
  });

  it('carries the track title as ICY metadata at exact intervals', async () => {
    const { bytes } = await capture(radioInfo.url, { headers: client.browserHeaders(), ms: 3000 });
    const title = icyTitle(bytes);

    assert.ok(title, `no valid metadata block after ${METAINT} bytes of audio`);
    assert.match(title, /^StreamTitle='.+ — .+';$/, `unexpected metadata: ${title}`);
  });

  it('fans out to several listeners at once and reports the count', async () => {
    const [first, second] = await Promise.all([
      capture(radioInfo.url, { headers: client.browserHeaders(), ms: 1200 }),
      capture(radioInfo.url, { headers: client.browserHeaders(), ms: 1200 }),
    ]);

    assert.ok(first.bytes.length > 1000 && second.bytes.length > 1000, 'both listeners receive audio');

    const during = await (await client.get('/api/now-playing', { headers: client.browserHeaders() })).json();
    assert.equal(during.station.streaming, true, 'now-playing reports that the mount is live');
    assert.ok(Number.isInteger(during.station.listeners), 'the listener count is real');
  });
});

describe('continuous mount — the schedule behind it', () => {
  it('records what goes on air', async () => {
    const total = () => ctx.query('SELECT COUNT(*) AS count FROM play_history')[0].count;
    const before = total();

    await capture(radioInfo.url, { headers: client.browserHeaders(), ms: 3000 });
    await sleep(200);

    assert.ok(total() > before, 'listening to the station records play history');

    const rows = ctx.query('SELECT track_id FROM play_history ORDER BY started_at DESC LIMIT 5');
    assert.ok(rows.length > 0);
    for (const row of rows) assert.match(row.track_id, /^ar_/);
  });

  it('counts plays per track', () => {
    const played = ctx.query('SELECT id, plays FROM tracks WHERE plays > 0');
    assert.ok(played.length > 0, 'the plays counter follows the schedule');
  });
});

describe('station files', () => {
  it('offers a .pls for VLC and foobar', async () => {
    const { response, text } = await client.raw('/radio.pls', { headers: client.browserHeaders() });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /scpls/);
    assert.match(text, /^\[playlist\]/);
    assert.match(
      text,
      new RegExp(`File1=${escapeRegExp(client.baseUrl)}${escapeRegExp(radioInfo.mount)}\\?t=`),
    );
    assert.match(text, /Length1=-1/);
  });

  it('offers an .m3u too', async () => {
    const { response, text } = await client.raw('/radio.m3u', { headers: client.browserHeaders() });
    assert.equal(response.status, 200);
    assert.match(text, /^#EXTM3U/);
    assert.match(text, new RegExp(`${escapeRegExp(radioInfo.mount)}\\?t=`));
  });

  it('keeps the station files behind the same gates', async () => {
    const response = await client.get('/radio.pls', {
      headers: { 'user-agent': 'curl/8.7.1', referer: `${client.baseUrl}/player/` },
    });
    assert.equal(response.status, 403);
    await response.body?.cancel();
  });
});

describe('/api/radio', () => {
  it('describes the mount and hands out a longer-lived token', async () => {
    const { response, body } = await client.raw('/api/radio', { headers: client.browserHeaders() });
    assert.equal(response.status, 200);
    assert.equal(body.mount, radioInfo.mount);
    assert.match(body.url, new RegExp(`^${escapeRegExp(radioInfo.mount)}\\?t=`));
    assert.equal(body.streaming, true);

    // A listener holds one long connection, so this token has to outlive the per-track one.
    const ttlSeconds = (Date.parse(body.tokenExpiresAt) - Date.now()) / 1000;
    assert.ok(ttlSeconds > 60, `radio token should last hours, got ${Math.round(ttlSeconds)}s`);
  });

  it('is gated like everything else', async () => {
    const response = await client.get('/api/radio', { headers: { 'user-agent': 'curl/8.7.1' } });
    assert.equal(response.status, 403);
    await response.body?.cancel();
  });
});

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
