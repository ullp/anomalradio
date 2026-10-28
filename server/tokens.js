/**
 * Stream tokens.
 *
 * A token is a stateless HMAC — the server can verify it without a lookup — but it is *also*
 * recorded in the database, which is what makes it revocable and measurable:
 *
 *   · bound to one track, one IP and one browser (all hashed, so no PII is stored);
 *   · short-lived (`STREAM_TOKEN_TTL`, 120 s by default);
 *   · capped in request count (`MAX_REQUESTS_PER_TOKEN`). Seeking issues a handful of range
 *     requests per track, while a ripper pulling byte ranges in a loop blows past the cap — so the
 *     cap turns "someone is scraping" into a hard failure instead of a log line.
 *
 * Failure reasons are deliberately coarse: a forged token reports `unknown-token`, never
 * "almost valid signature".
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { one, run } from './db.js';
import { config } from './config.js';

const FAILURE = {
  MISSING: 'missing-token',
  UNKNOWN: 'unknown-token',
  EXPIRED: 'expired-token',
  IP: 'ip-mismatch',
  UA: 'ua-mismatch',
  TRACK: 'track-mismatch',
  EXHAUSTED: 'token-exhausted',
  REVOKED: 'token-revoked',
};

const b64url = (value) => Buffer.from(value).toString('base64url');
const unb64url = (value) => Buffer.from(value, 'base64url');

/** Short, stable fingerprint — enough to bind a token without storing anything identifying. */
export const fingerprint = (value) => createHash('sha256').update(String(value)).digest('hex').slice(0, 16);

export function createTokenService({
  secret = config.secret,
  ttlSeconds = config.streamTokenTtlSeconds,
  maxRequestsPerToken = config.maxRequestsPerToken,
  now = () => Date.now(),
} = {}) {
  const sign = (payload) => createHmac('sha256', secret).update(payload).digest();

  function issue({ trackId = null, ipHash, uaHash, ttlSeconds: ttl = ttlSeconds }) {
    const issuedAt = now();
    const expiresAt = issuedAt + ttl * 1000;
    const nonce = randomBytes(12).toString('base64url');

    const payload = b64url(
      JSON.stringify({ n: nonce, t: trackId, e: Math.floor(expiresAt / 1000), i: ipHash, u: uaHash }),
    );
    const token = `${payload}.${sign(payload).toString('base64url')}`;

    run(
      `INSERT INTO stream_tokens (nonce, track_id, ip_hash, ua_hash, issued_at, expires_at, uses)
       VALUES (?, ?, ?, ?, ?, ?, 0)`,
      nonce,
      trackId,
      ipHash,
      uaHash,
      new Date(issuedAt).toISOString(),
      new Date(expiresAt).toISOString(),
    );

    return { token, nonce, issuedAt, expiresAt: new Date(expiresAt).toISOString(), ttlSeconds: ttl };
  }

  /**
   * Verify a token for a specific track, IP and browser.
   * @returns {{ ok: true, nonce: string, uses: number } | { ok: false, reason: string }}
   */
  function verify({ token, trackId = null, ipHash, uaHash }) {
    if (!token || typeof token !== 'string') return { ok: false, reason: FAILURE.MISSING };

    const [payload, signature] = token.split('.');
    if (!payload || !signature) return { ok: false, reason: FAILURE.UNKNOWN };

    const expected = sign(payload);
    const provided = unb64url(signature);
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      return { ok: false, reason: FAILURE.UNKNOWN };
    }

    let claims;
    try {
      claims = JSON.parse(unb64url(payload).toString('utf8'));
    } catch {
      return { ok: false, reason: FAILURE.UNKNOWN };
    }

    if (!Number.isFinite(claims.e) || claims.e * 1000 < now()) return { ok: false, reason: FAILURE.EXPIRED };
    if (claims.t && trackId && claims.t !== trackId) return { ok: false, reason: FAILURE.TRACK };
    if (claims.i !== ipHash) return { ok: false, reason: FAILURE.IP };
    if (claims.u !== uaHash) return { ok: false, reason: FAILURE.UA };

    const record = one(
      'SELECT nonce, expires_at, uses, revoked FROM stream_tokens WHERE nonce = ?',
      claims.n,
    );
    if (!record) return { ok: false, reason: FAILURE.UNKNOWN };
    if (record.revoked) return { ok: false, reason: FAILURE.REVOKED };
    if (Date.parse(record.expires_at) < now()) return { ok: false, reason: FAILURE.EXPIRED };
    if (record.uses >= maxRequestsPerToken) return { ok: false, reason: FAILURE.EXHAUSTED };

    run('UPDATE stream_tokens SET uses = uses + 1 WHERE nonce = ?', claims.n);
    return { ok: true, nonce: claims.n, uses: record.uses + 1 };
  }

  /** Used by the admin (M6) to cut off a suspicious session immediately. */
  function revoke(nonce) {
    return run('UPDATE stream_tokens SET revoked = 1 WHERE nonce = ?', nonce).changes > 0;
  }

  /** Drop expired rows; cheap enough to run on a timer. */
  function cleanup() {
    return run('DELETE FROM stream_tokens WHERE expires_at < ?', new Date(now()).toISOString()).changes;
  }

  /** Issued-but-unused tokens for one IP — a simple "how many doors did you open" signal. */
  function statsFor(ipHash) {
    const row = one(
      `SELECT COUNT(*) AS tokens, COALESCE(SUM(uses), 0) AS uses
         FROM stream_tokens WHERE ip_hash = ? AND expires_at >= ?`,
      ipHash,
      new Date(now()).toISOString(),
    );
    return { tokens: row?.tokens ?? 0, uses: row?.uses ?? 0 };
  }

  return { issue, verify, revoke, cleanup, statsFor, ttlSeconds, maxRequestsPerToken, FAILURE };
}

let service = null;

export function getTokenService() {
  service ??= createTokenService();
  return service;
}

export function resetTokenService() {
  service = null;
}
