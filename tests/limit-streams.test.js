/**
 * Stream concurrency cap (§7.2 of the offer: `MAX_STREAMS_PER_IP`).
 *
 * The cap only means something if the slot is taken *before* the first await — a check-then-act
 * pattern lets parallel requests all pass the check. This test proves the invariant holds with
 * genuinely concurrent connections, which needs a file large enough that the server cannot
 * finish writing it while the client is not reading.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT, startTestServer } from './helpers/server.js';

const TMP_DIR = path.join(ROOT, 'tests/tmp/concurrency');
const CAP = 2;
const BIG_FILE_BYTES = 8 * 1024 * 1024; // comfortably past any socket/undici buffering

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A large fixture that never has to be committed: written to a temp dir at test time. */
async function createLargeFixture() {
  await mkdir(TMP_DIR, { recursive: true });
  const buffer = Buffer.alloc(BIG_FILE_BYTES);
  // Repeating MPEG-1 Layer III frame headers (0xFFFB) keep the file recognisably audio
  // without shelling out to ffmpeg.
  for (let offset = 0; offset + 4 <= BIG_FILE_BYTES; offset += 4) buffer.writeUInt32BE(0xfffb9064, offset);
  await writeFile(path.join(TMP_DIR, 'long-track.mp3'), buffer);

  const index = path.join(TMP_DIR, 'tracks.json');
  await writeFile(
    index,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        generator: 'tests/limit-streams.test.js',
        album: { album: 'Fixtures', artist: 'Test Signal', year: 2026, genre: 'Test', composer: null },
        trackCount: 1,
        totalDurationMs: 600_000,
        tracks: [
          {
            id: 'ar_LongTrack01',
            title: 'Long Track',
            artist: 'Test Signal',
            album: 'Fixtures',
            year: 2026,
            genre: 'Test',
            bpm: null,
            musicalKey: null,
            durationMs: 600_000,
            bitrate: 320_000,
            sampleRate: 44100,
            channels: 2,
            sizeBytes: BIG_FILE_BYTES,
            coverKey: null,
            priceCents: 199,
            currency: 'EUR',
            buyUrl: null,
            tags: [],
            published: true,
            featured: false,
            plays: 0,
            stars: 0,
            addedAt: new Date().toISOString(),
            sourceFile: 'long-track.mp3',
          },
        ],
      },
      null,
      2,
    )}\n`,
  );

  return { source: TMP_DIR, index };
}

let ctx;
let client;
let track;
let token;

before(async () => {
  const fixture = await createLargeFixture();
  ctx = await startTestServer({ ...fixture, env: { MAX_STREAMS_PER_IP: CAP } });
  client = ctx.client;
  track = ctx.library.tracks[0];
  ({ token } = await client.session({ trackId: track.id }));
});

after(async () => {
  await ctx?.close();
  await rm(TMP_DIR, { recursive: true, force: true });
});

/** Open a stream and read only its first chunk, so the server cannot finish sending. */
async function holdOpenStream() {
  const response = await client.stream(track.id, { token });
  assert.equal(response.status, 200, 'a held stream must be admitted');
  const reader = response.body.getReader();
  await reader.read();
  return reader;
}

describe('per-IP stream cap', () => {
  it(`allows ${CAP} concurrent streams and refuses the next one`, async () => {
    const readers = [];
    for (let i = 0; i < CAP; i += 1) readers.push(await holdOpenStream());

    const refused = await client.stream(track.id, { token });
    assert.equal(refused.status, 429, 'the cap must not be exceeded');
    assert.equal((await refused.json()).error, 'too-many-streams');

    for (const reader of readers) await reader.cancel();
  });

  it('frees the slot when a listener disconnects', async () => {
    const readers = [];
    for (let i = 0; i < CAP; i += 1) readers.push(await holdOpenStream());

    const refused = await client.stream(track.id, { token });
    assert.equal(refused.status, 429);
    await refused.body?.cancel();

    // Drop one listener, then wait for the server to notice the closed socket.
    await readers[0].cancel();
    let admitted = null;
    for (let attempt = 0; attempt < 40 && !admitted; attempt += 1) {
      const response = await client.stream(track.id, { token });
      if (response.status === 200) admitted = response;
      else await response.body?.cancel();
      if (!admitted) await sleep(25);
    }

    assert.ok(admitted, 'a new listener must get in once a slot is released');
    await admitted.body.cancel();
    for (const reader of readers.slice(1)) await reader.cancel();
  });
});
