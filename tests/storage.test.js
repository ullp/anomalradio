/**
 * Storage layer.
 *
 * The local driver is exercised end to end; SigV4 is checked against the worked example in the AWS
 * documentation and against a golden signature that was cross-verified with an independent
 * implementation (`aws4`), so the S3 driver is trustworthy even without a bucket in CI.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { contentTypeForKey, createStorage, hashFile } from '../server/storage/index.js';
import { createLocalStorage } from '../server/storage/local.js';
import {
  amzDate,
  canonicalQueryString,
  dateStamp,
  encodePath,
  presignUrl,
  signRequest,
} from '../server/storage/sigv4.js';

/* ─────────────────────────── SigV4 ─────────────────────────── */

describe('SigV4', () => {
  // Worked example from the AWS documentation: "Example: GET Object" (S3, us-east-1).
  const DOC_EXAMPLE = {
    method: 'GET',
    path: '/test.txt',
    headers: { host: 'examplebucket.s3.amazonaws.com', range: 'bytes=0-9' },
    payload: '',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    region: 'us-east-1',
    service: 's3',
    date: new Date('2013-05-24T00:00:00.000Z'),
  };

  it('builds the canonical request from the AWS documentation example byte for byte', () => {
    const { canonicalRequest } = signRequest(DOC_EXAMPLE);
    assert.equal(
      canonicalRequest,
      [
        'GET',
        '/test.txt',
        '',
        'host:examplebucket.s3.amazonaws.com',
        'range:bytes=0-9',
        'x-amz-content-sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        'x-amz-date:20130524T000000Z',
        '',
        'host;range;x-amz-content-sha256;x-amz-date',
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      ].join('\n'),
    );
    // The docs publish the SHA-256 of exactly this string; matching it proves the canonicalisation.
    const canonicalHash = createHash('sha256').update(canonicalRequest).digest('hex');
    assert.equal(canonicalHash, '7344ae5b7ee6c3e7e6b0fe0640412a37625d1fbfff95c48bbb2dc43964946972');
  });

  it('produces a signature that matches an independent implementation', () => {
    // Golden value cross-checked with the `aws4` package for the same request (no Range header, so
    // both implementations sign the same header set).
    const { signature, authorization } = signRequest({
      ...DOC_EXAMPLE,
      headers: { host: 'examplebucket.s3.amazonaws.com' },
    });
    assert.equal(signature, '14f6a0997b2b70a86f4726658a6575b5109092ccb5fd328f51b369c44b4ac958');
    assert.match(
      authorization,
      /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20130524\/us-east-1\/s3\/aws4_request/,
    );
    assert.match(authorization, /SignedHeaders=host;x-amz-content-sha256;x-amz-date/);
  });

  it('signs a precomputed body hash (how large uploads are streamed)', () => {
    const contentSha256 = createHash('sha256').update('hello').digest('hex');
    const { signature } = signRequest({
      ...DOC_EXAMPLE,
      contentSha256,
      headers: { host: 'examplebucket.s3.amazonaws.com' },
    });
    const explicit = signRequest({
      ...DOC_EXAMPLE,
      payload: 'hello',
      headers: { host: 'examplebucket.s3.amazonaws.com' },
    });
    assert.equal(signature, explicit.signature, 'a precomputed hash must sign identically to the body');
  });

  it('formats timestamps and encodes paths the S3 way', () => {
    const date = new Date('2026-10-28T13:20:45.123Z');
    assert.equal(amzDate(date), '20261028T132045Z');
    assert.equal(dateStamp(date), '20261028');
    assert.equal(encodePath('/tracks/ar_x y+z.mp3'), '/tracks/ar_x%20y%2Bz.mp3');
    assert.equal(encodePath('/a/b/c'), '/a/b/c', 'plain keys are untouched');
  });

  it('sorts query parameters by name then value', () => {
    assert.equal(
      canonicalQueryString({ 'X-Amz-Expires': '60', b: '2', a: '1', 'X-Amz-Algorithm': 'AWS4-HMAC-SHA256' }),
      'X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=60&a=1&b=2',
    );
  });

  it('presigns a URL with an expiry and a signature', () => {
    const url = new URL(
      presignUrl({
        url: 'https://bucket.example.com/tracks/ar_x.mp3',
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
        region: 'auto',
        expiresSeconds: 60,
        date: new Date('2026-10-28T13:20:45.123Z'),
      }),
    );
    assert.equal(url.searchParams.get('X-Amz-Expires'), '60');
    assert.equal(url.searchParams.get('X-Amz-Date'), '20261028T132045Z');
    assert.equal(url.searchParams.get('X-Amz-SignedHeaders'), 'host');
    assert.match(url.searchParams.get('X-Amz-Signature'), /^[0-9a-f]{64}$/);
  });
});

/* ─────────────────────────── local driver ─────────────────────────── */

describe('local storage driver', () => {
  let dir;
  let sourceFile;
  let storage;

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'anomalradio-media-'));
    sourceFile = path.join(dir, 'incoming-track.mp3');
    await writeFile(sourceFile, Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x00abcdefghij', 'binary'));
    storage = createLocalStorage({ directory: path.join(dir, 'media'), contentTypeForKey });
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('stores a file and reports it back', async () => {
    const result = await storage.put('tracks/ar_TEST000001.mp3', sourceFile);
    assert.equal(result.size, 20);

    const info = await storage.stat('tracks/ar_TEST000001.mp3');
    assert.equal(info.size, 20);
    assert.equal(info.contentType, 'audio/mpeg');
    assert.equal(await storage.exists('tracks/ar_TEST000001.mp3'), true);
    assert.equal(await storage.exists('tracks/nope.mp3'), false);
    assert.equal(await storage.stat('tracks/nope.mp3'), null, 'missing objects report null, not an error');
  });

  it('copies rather than moves, so the import source is untouched', async () => {
    assert.ok(await readFile(sourceFile), 'the source file still exists after put()');
  });

  it('streams the whole object and any byte range', async () => {
    const all = await readAll(await storage.createReadStream('tracks/ar_TEST000001.mp3'));
    assert.equal(all.length, 20);
    assert.equal(all.subarray(0, 3).toString('binary'), 'ID3');

    const slice = await readAll(
      await storage.createReadStream('tracks/ar_TEST000001.mp3', { start: 3, end: 5 }),
    );
    assert.equal(slice.length, 3);
    assert.deepEqual(slice, all.subarray(3, 6));
  });

  it('refuses keys that try to escape the media directory', async () => {
    // A real file one level above the media root: it must stay unreachable through any key.
    const outside = path.join(dir, 'outside.mp3');
    await writeFile(outside, 'SECRET-CONTENT');

    for (const key of ['../outside.mp3', 'tracks/../../outside.mp3', '/etc/passwd']) {
      await assert.rejects(() => storage.stat(key), /storage key rejected/, `${key} must be refused`);
      await assert.rejects(() => storage.exists(key), /storage key rejected/);
      await assert.rejects(() => storage.createReadStream(key), /storage key rejected/);
      await assert.rejects(() => storage.put(key, sourceFile), /storage key rejected/);
      await assert.rejects(() => storage.delete(key), /storage key rejected/);
    }

    // Traversal specifically is named as such, and absolute keys are named separately.
    await assert.rejects(() => storage.stat('../outside.mp3'), /escapes the media directory/);
    await assert.rejects(() => storage.stat('/etc/passwd'), /absolute paths are not allowed/);

    // And nothing anywhere near the root was created by those attempts.
    const entries = await readdir(path.join(dir, 'media'));
    assert.deepEqual(entries, ['tracks'], 'no stray files were written outside the intended layout');
  });

  it('deletes objects', async () => {
    await storage.delete('tracks/ar_TEST000001.mp3');
    assert.equal(await storage.exists('tracks/ar_TEST000001.mp3'), false);
    await storage.delete('tracks/ar_TEST000001.mp3'); // idempotent
  });
});

/* ─────────────────────────── factory & helpers ─────────────────────────── */

describe('storage factory', () => {
  it('builds a local driver from configuration', () => {
    const driver = createStorage({ driver: 'local', storage: { directory: '/tmp/anomalradio-x' } });
    assert.equal(driver.driver, 'local');
    assert.deepEqual(driver.describe().directory, '/tmp/anomalradio-x');
  });

  it('builds an s3 driver and keeps it in proxy mode by default', () => {
    const driver = createStorage({
      driver: 's3',
      storage: {
        endpoint: 'https://account.r2.cloudflarestorage.com',
        bucket: 'anomalradio',
        region: 'auto',
        accessKeyId: 'key',
        secretAccessKey: 'secret',
      },
    });
    const described = driver.describe();
    assert.equal(described.driver, 's3');
    assert.equal(described.bucket, 'anomalradio');
    assert.equal(described.mode, 'proxy');
    assert.equal(driver.signedUrl('tracks/x.mp3'), null, 'proxy mode never hands out bucket URLs');
  });

  it('refuses an unknown driver', () => {
    assert.throws(() => createStorage({ driver: 'ftp' }), /unknown storage driver/);
  });

  it('maps content types and hashes files', async () => {
    assert.equal(contentTypeForKey('tracks/a.mp3'), 'audio/mpeg');
    assert.equal(contentTypeForKey('covers/a.webp'), 'image/webp');
    assert.equal(contentTypeForKey('weird.bin'), 'application/octet-stream');

    const dir = await mkdtemp(path.join(tmpdir(), 'anomalradio-hash-'));
    const file = path.join(dir, 'x.mp3');
    await writeFile(file, 'anomalradio');
    assert.equal(await hashFile(file), createHash('sha256').update('anomalradio').digest('hex'));
    await rm(dir, { recursive: true, force: true });
  });
});

/** Drain a readable into a single Buffer. */
async function readAll(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}
