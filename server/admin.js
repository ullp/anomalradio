/**
 * Admin (M6) — the station's own control room.
 *
 * Three choices here are deliberately conservative:
 *
 *   1. **It is off unless configured.** With no `ADMIN_PASSWORD_HASH` the whole area answers 404, so a
 *      deployment cannot expose a control panel by accident, and nothing has to be configured for the
 *      station to boot. `enabled()` is the single switch everything else defers to.
 *   2. **Sessions are rows, not signed cookies.** Logging out — and cutting off every session at once
 *      — are things a control panel must be able to do, so `admin_sessions` mirrors the account
 *      session table instead of inventing a stateless token that cannot be revoked.
 *   3. **No dependency for crypto.** scrypt comes from `node:crypto`, and TOTP is ~30 lines of
 *      HMAC-SHA1 — less code than the wrapper around a library would have been.
 */

import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { all, one, run } from './db.js';
import { parseCookies } from './accounts.js';

const sha256 = (value) => createHash('sha256').update(String(value)).digest('hex');

/* ─────────────────────────── passwords ─────────────────────────── */

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

const PASSWORD_HASH_RE = /^scrypt\$[0-9]+\$[0-9]+\$[0-9]+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/;

export const isPasswordHash = (value) => PASSWORD_HASH_RE.test(String(value ?? ''));

/** `scrypt$N$r$p$salt$hash` — self-describing, so the parameters can be raised later without a migration. */
export function hashPassword(password, { N = SCRYPT.N, r = SCRYPT.r, p = SCRYPT.p } = {}) {
  const salt = randomBytes(16);
  const derived = scryptSync(String(password), salt, SCRYPT.keylen, {
    N,
    r,
    p,
    maxmem: SCRYPT_MAXMEM,
  });
  return ['scrypt', N, r, p, salt.toString('base64url'), derived.toString('base64url')].join('$');
}

export function verifyPassword(password, stored) {
  if (!isPasswordHash(stored)) return false;
  const [, N, r, p, salt, expected] = stored.split('$');
  let derived;
  try {
    derived = scryptSync(String(password), Buffer.from(salt, 'base64url'), SCRYPT.keylen, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
      maxmem: SCRYPT_MAXMEM,
    });
  } catch {
    return false;
  }
  const want = Buffer.from(expected, 'base64url');
  // timingSafeEqual throws on a length mismatch, so check that first rather than letting it escape.
  if (want.length !== derived.length) return false;
  return timingSafeEqual(want, derived);
}

/* ─────────────────────────── TOTP (RFC 6238) ─────────────────────────── */

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Decode(input) {
  const clean = String(input ?? '')
    .toUpperCase()
    .replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const char of clean) {
    value = (value << 5) | BASE32.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** A fresh base32 secret, sized for the 160-bit HMAC-SHA1 the spec assumes. */
export const generateTotpSecret = () => base32Encode(randomBytes(20));

/** Six digits, 30-second steps — what every authenticator app defaults to. */
export function totpAt(secret, atMs = Date.now(), { step = 30, digits = 6 } = {}) {
  const counter = Math.floor(atMs / 1000 / step);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', base32Decode(secret)).update(message).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const binary =
    ((mac[offset] & 0x7f) << 24) |
    ((mac[offset + 1] & 0xff) << 16) |
    ((mac[offset + 2] & 0xff) << 8) |
    (mac[offset + 3] & 0xff);
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/**
 * Accept the previous and next step as well as the current one: a phone clock and a server clock are
 * never exactly equal, and a one-step window is what every implementation does.
 */
export function verifyTotp(secret, code, atMs = Date.now(), { step = 30 } = {}) {
  const provided = String(code ?? '').replace(/[\s-]/g, '');
  if (!/^[0-9]{6}$/.test(provided)) return false;
  if (!secret) return false;
  const wanted = Buffer.from(provided);
  for (const drift of [-1, 0, 1]) {
    const candidate = Buffer.from(totpAt(secret, atMs + drift * step * 1000));
    if (timingSafeEqual(candidate, wanted)) return true;
  }
  return false;
}

/* ─────────────────────────── the control room ─────────────────────────── */

function cookieString(name, value, { maxAge, path: cookiePath, sameSite = 'Strict' } = {}) {
  const bits = [`${name}=${encodeURIComponent(value)}`, `Path=${cookiePath}`, `SameSite=${sameSite}`];
  if (maxAge !== undefined) bits.push(`Max-Age=${maxAge}`);
  bits.push('HttpOnly');
  if (config.isProduction) bits.push('Secure');
  return bits.join('; ');
}

/**
 * @param {object} [overrides]
 * @param {(req: import('node:http').IncomingMessage) => string} [overrides.clientIp] how to learn the
 *   caller's address. The server passes `security.clientIp` so the admin and the stream gates agree
 *   about who is calling — including the X-Forwarded-For rule.
 */
export function createAdmin(overrides = {}) {
  const settings = { ...config.admin, ...overrides };
  const clientIp = overrides.clientIp ?? ((req) => String(req.socket?.remoteAddress ?? ''));

  /** Everything defers to this. No hash, no admin. */
  const enabled = () => isPasswordHash(settings.passwordHash);
  const needsCode = () => Boolean(settings.totpSecret);

  function ipAllowed(req) {
    if (settings.ipAllowlist.length === 0) return true;
    return settings.ipAllowlist.includes(clientIp(req));
  }

  /* ── sessions ── */

  function sessionFor(req) {
    if (!enabled()) return null;
    const raw = parseCookies(req)[settings.sessionCookie];
    if (!raw) return null;
    const tokenHash = sha256(raw);
    const row = one('SELECT expires_at AS expiresAt FROM admin_sessions WHERE token_hash = ?', tokenHash);
    if (!row) return null;
    if (Date.parse(row.expiresAt) < Date.now()) {
      run('DELETE FROM admin_sessions WHERE token_hash = ?', tokenHash);
      return null;
    }
    run(
      'UPDATE admin_sessions SET last_seen_at = ? WHERE token_hash = ?',
      new Date().toISOString(),
      tokenHash,
    );
    return { tokenHash };
  }

  const signedIn = (req) => Boolean(sessionFor(req));

  function signIn({ password, code = null, ip = null, now = Date.now() }) {
    if (!enabled()) return { ok: false, reason: 'disabled' };
    if (!verifyPassword(password, settings.passwordHash)) return { ok: false, reason: 'bad-password' };
    if (needsCode() && !verifyTotp(settings.totpSecret, code, now)) {
      return { ok: false, reason: 'bad-code' };
    }

    const token = randomBytes(32).toString('base64url');
    const issuedAt = new Date(now).toISOString();
    run(
      `INSERT INTO admin_sessions (token_hash, created_at, last_seen_at, expires_at, ip)
       VALUES (?, ?, ?, ?, ?)`,
      sha256(token),
      issuedAt,
      issuedAt,
      new Date(now + settings.sessionTtlSeconds * 1000).toISOString(),
      ip,
    );

    return {
      ok: true,
      token,
      cookie: cookieString(settings.sessionCookie, token, {
        maxAge: settings.sessionTtlSeconds,
        path: settings.path,
      }),
    };
  }

  /** End this session only. */
  function signOut(req) {
    const session = sessionFor(req);
    if (session) run('DELETE FROM admin_sessions WHERE token_hash = ?', session.tokenHash);
    return {
      cookie: cookieString(settings.sessionCookie, '', { maxAge: 0, path: settings.path }),
      ended: Boolean(session),
    };
  }

  /** End every session — the panic button, for a laptop left in a taxi. */
  const revokeAllSessions = () => run('DELETE FROM admin_sessions').changes;

  /* ── audit ── */

  function audit({ action, target = null, ip = null }) {
    run(
      'INSERT INTO admin_audit (action, target, ip, at) VALUES (?, ?, ?, ?)',
      action,
      target,
      ip,
      new Date().toISOString(),
    );
  }

  const recentAudit = (limit = 50) =>
    all('SELECT id, action, target, ip, at FROM admin_audit ORDER BY id DESC LIMIT ?', limit);

  return {
    enabled,
    needsCode,
    ipAllowed,
    clientIp,
    signedIn,
    sessionFor,
    signIn,
    signOut,
    revokeAllSessions,
    audit,
    recentAudit,
    settings,
  };
}

let instance = null;

export function getAdmin() {
  if (!instance) instance = createAdmin();
  return instance;
}

/** Tests build their own, so the cached one is dropped between cases. */
export function resetAdmin() {
  instance = null;
}
