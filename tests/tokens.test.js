/**
 * Token service.
 *
 * The stream tokens are the piece an attacker would try hardest to defeat, so their properties are
 * tested directly rather than only through HTTP: signature, expiry, binding to track/IP/browser, the
 * request cap that turns scraping into a hard failure, and revocation.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

let scratch;
let tokens;
let createTokenService;
let db;
let now;

before(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), 'anomalradio-tokens-'));
  process.env.ANOMALRADIO_DB = path.join(scratch, 'tokens.db');

  db = await import('../server/db.js');
  db.openDatabase();

  // A controllable clock so expiry can be tested without sleeping.
  now = Date.now();
  ({ createTokenService } = await import('../server/tokens.js'));
  tokens = createTokenService({
    secret: 'test-secret-that-is-long-enough-for-hmac',
    ttlSeconds: 60,
    maxRequestsPerToken: 3,
    now: () => now,
  });
});

after(async () => {
  db?.closeDatabase();
  await rm(scratch, { recursive: true, force: true });
});

const IDENTITY = { trackId: 'ar_TEST000001', ipHash: 'aaaa1111bbbb2222', uaHash: 'cccc3333dddd4444' };

describe('token service', () => {
  it('issues a token that verifies for its own track, IP and browser', () => {
    const issued = tokens.issue(IDENTITY);
    assert.match(issued.token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.equal(issued.ttlSeconds, 60);

    const verdict = tokens.verify({ token: issued.token, ...IDENTITY });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.nonce, issued.nonce);
  });

  it('records the token so it can be revoked and measured', () => {
    const issued = tokens.issue(IDENTITY);
    const row = db.one('SELECT * FROM stream_tokens WHERE nonce = ?', issued.nonce);
    assert.equal(row.track_id, IDENTITY.trackId);
    assert.equal(row.ip_hash, IDENTITY.ipHash);
    assert.equal(row.uses, 0);
  });

  it('rejects a missing token', () => {
    assert.deepEqual(tokens.verify({ ...IDENTITY }), { ok: false, reason: 'missing-token' });
  });

  it('rejects a tampered payload', () => {
    const issued = tokens.issue(IDENTITY);
    const [payload, signature] = issued.token.split('.');
    const forged = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), t: 'ar_OTHER00001' }),
    ).toString('base64url');
    assert.equal(tokens.verify({ token: `${forged}.${signature}`, ...IDENTITY }).reason, 'unknown-token');
  });

  it('rejects a token signed with a different secret', () => {
    const other = createTokenService({
      secret: 'a-completely-different-secret-value-here',
      ttlSeconds: 60,
      maxRequestsPerToken: 3,
      now: () => now,
    });
    const issued = other.issue(IDENTITY);
    assert.equal(tokens.verify({ token: issued.token, ...IDENTITY }).reason, 'unknown-token');
  });

  it('rejects a token presented for another track', () => {
    const issued = tokens.issue(IDENTITY);
    const verdict = tokens.verify({ token: issued.token, ...IDENTITY, trackId: 'ar_OTHER00001' });
    assert.equal(verdict.reason, 'track-mismatch');
  });

  it('rejects a token replayed from another IP or browser', () => {
    const issued = tokens.issue(IDENTITY);
    assert.equal(
      tokens.verify({ token: issued.token, ...IDENTITY, ipHash: 'ffff0000ffff0000' }).reason,
      'ip-mismatch',
    );
    assert.equal(
      tokens.verify({ token: issued.token, ...IDENTITY, uaHash: 'ffff0000ffff0000' }).reason,
      'ua-mismatch',
    );
  });

  it('expires on the configured TTL', () => {
    const issued = tokens.issue(IDENTITY);
    now += 60_001;
    try {
      assert.equal(tokens.verify({ token: issued.token, ...IDENTITY }).reason, 'expired-token');
    } finally {
      now -= 60_001;
    }
  });

  it('caps how many requests one token may serve', () => {
    const issued = tokens.issue(IDENTITY);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      assert.equal(tokens.verify({ token: issued.token, ...IDENTITY }).ok, true, `request ${attempt}`);
    }
    // Seeking issues a handful of range requests; a ripper looping over ranges blows straight past.
    assert.equal(tokens.verify({ token: issued.token, ...IDENTITY }).reason, 'token-exhausted');
  });

  it('can be revoked before it expires', () => {
    const issued = tokens.issue(IDENTITY);
    assert.equal(tokens.revoke(issued.nonce), true);
    assert.equal(tokens.verify({ token: issued.token, ...IDENTITY }).reason, 'token-revoked');
  });

  it('counts tokens and requests per IP', () => {
    const ipHash = 'feedfacefeedface';
    tokens.issue({ ...IDENTITY, ipHash });
    const issued = tokens.issue({ ...IDENTITY, ipHash });
    tokens.verify({ token: issued.token, ...IDENTITY, ipHash });

    const stats = tokens.statsFor(ipHash);
    assert.equal(stats.tokens, 2);
    assert.equal(stats.uses, 1);
  });

  it('drops expired rows on cleanup', () => {
    const issued = tokens.issue(IDENTITY);
    now += 120_000;
    try {
      assert.ok(tokens.cleanup() >= 1);
      assert.equal(db.one('SELECT 1 AS x FROM stream_tokens WHERE nonce = ?', issued.nonce), undefined);
    } finally {
      now -= 120_000;
    }
  });
});
