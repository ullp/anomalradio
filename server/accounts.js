/**
 * Accounts (M4).
 *
 * Sign-in is a magic link: no password to store, leak, reuse or phish. The link token is
 * single-use, expires in minutes, and only its SHA-256 is stored — so the database is not a
 * credential store, and a dump of it cannot be replayed against the station.
 *
 * The interesting part is `claimAnonymous()`. Someone who starred tracks before signing in keeps
 * them, because favourites and cart rows are keyed by an owner key that starts as `own_<random>`
 * (from a cookie) and becomes `usr_<id>` (the account). That is why the M2 schema needed no change
 * to support accounts at all.
 */

import { createHash, randomBytes } from 'node:crypto';
import { config } from './config.js';
import { one, run } from './db.js';
import { createMailer, getMailer, signInEmail } from './mail.js';

const sha256 = (value) => createHash('sha256').update(String(value)).digest('hex');
const newToken = () => randomBytes(32).toString('base64url');
const newUserId = () => `usr_${randomBytes(8).toString('hex')}`;

/** Deliberately permissive: the link is the proof of ownership, not the address syntax. */
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;
export const normalizeEmail = (value) => String(value ?? '').trim().toLowerCase();
export const isEmail = (value) => EMAIL_RE.test(normalizeEmail(value));

const ANONYMOUS_OWNER_RE = /^own_[A-Za-z0-9_-]{6,64}$/;

export function parseCookies(req) {
  const jar = {};
  const header = req?.headers?.cookie;
  if (!header) return jar;
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    try {
      jar[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      /* a malformed cookie is simply not there */
    }
  }
  return jar;
}

function cookieString(name, value, { maxAge, httpOnly = true } = {}) {
  const bits = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'SameSite=Lax'];
  if (maxAge !== undefined) bits.push(`Max-Age=${maxAge}`);
  if (httpOnly) bits.push('HttpOnly');
  if (config.isProduction) bits.push('Secure');
  return bits.join('; ');
}

export function createAccounts(overrides = {}) {
  const settings = { ...config.accounts, ...overrides };
  // The shared mailer instance, so what was sent is inspectable (tests, and the admin later).
  const mailer = overrides.mailer ?? getMailer();

  /** The signed-in user for this request, or null. Expired sessions are cleaned up as they are found. */
  function sessionUser(req) {
    const raw = parseCookies(req)[settings.cookieName];
    if (!raw) return null;
    const hash = sha256(raw);
    const row = one(
      `SELECT s.user_id AS userId, s.expires_at AS expiresAt, u.email AS email
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ?`,
      hash,
    );
    if (!row) return null;
    if (Date.parse(row.expiresAt) < Date.now()) {
      run('DELETE FROM sessions WHERE token_hash = ?', hash);
      return null;
    }
    run('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?', new Date().toISOString(), hash);
    return { id: row.userId, email: row.email };
  }

  /**
   * Whose stars are these? The account if signed in, otherwise the anonymous cookie.
   * `setCookie` is non-null when a fresh anonymous key had to be minted, so the caller can
   * return it — that keeps a visitor's stars stable even if they never sign in.
   */
  function ownerFor(req) {
    const user = sessionUser(req);
    if (user) return { ownerKey: user.id, user, setCookie: null };

    const provided = parseCookies(req)[settings.ownerCookieName];
    if (ANONYMOUS_OWNER_RE.test(String(provided ?? ''))) {
      return { ownerKey: provided, user: null, setCookie: null };
    }
    const fresh = `own_${randomBytes(8).toString('hex')}`;
    return {
      ownerKey: fresh,
      user: null,
      // Not HttpOnly: the client reads this too, and it authorises nothing but its own star list.
      setCookie: cookieString(settings.ownerCookieName, fresh, {
        maxAge: 365 * 24 * 3600,
        httpOnly: false,
      }),
    };
  }

  /**
   * Ask for a sign-in link. Rate limited per address, so one visitor cannot be used to flood a
   * mailbox, and the response is the same whether or not the address already has an account.
   */
  async function requestMagicLink({ email, ownerKey = null, ipHash = null }) {
    const address = normalizeEmail(email);
    if (!isEmail(address)) return { ok: false, reason: 'invalid-email' };

    const since = new Date(Date.now() - 60_000).toISOString();
    const recent = one(
      'SELECT COUNT(*) AS n FROM magic_links WHERE email = ? AND created_at > ?',
      address,
      since,
    );
    if ((recent?.n ?? 0) >= settings.requestPerEmailLimit) return { ok: false, reason: 'rate-limited' };

    const token = newToken();
    const now = Date.now();
    const expiresAt = new Date(now + settings.magicLinkTtlSeconds * 1000);
    run(
      `INSERT INTO magic_links (token_hash, email, owner_key, ip_hash, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      sha256(token),
      address,
      ANONYMOUS_OWNER_RE.test(String(ownerKey ?? '')) ? ownerKey : null,
      ipHash,
      new Date(now).toISOString(),
      expiresAt.toISOString(),
    );

    const link = `${config.publicOrigin}/api/auth/verify?token=${encodeURIComponent(token)}`;
    const message = signInEmail({
      origin: config.publicOrigin,
      link,
      ttlMinutes: Math.round(settings.magicLinkTtlSeconds / 60),
    });
    await mailer.send({ to: address, ...message });

    // The link is echoed back outside production only — otherwise it is in the e-mail (or the journal).
    return { ok: true, expiresAt: expiresAt.toISOString(), link: config.isProduction ? null : link };
  }

  /**
   * Move anonymous rows onto the account. `UPDATE OR IGNORE` + `DELETE` is how the UNIQUE
   * (owner_key, track_id) constraint de-duplicates: a star that exists on both sides keeps the
   * account's row, and the leftover anonymous row is dropped.
   */
  function claimAnonymous(ownerKey, userId) {
    if (!ownerKey || !ANONYMOUS_OWNER_RE.test(ownerKey) || ownerKey === userId) {
      return { favourites: 0, cart: 0 };
    }
    const favourites = run(
      'UPDATE OR IGNORE favourites SET owner_key = ? WHERE owner_key = ?',
      userId,
      ownerKey,
    ).changes;
    run('DELETE FROM favourites WHERE owner_key = ?', ownerKey);
    const cart = run(
      'UPDATE OR IGNORE cart_items SET owner_key = ? WHERE owner_key = ?',
      userId,
      ownerKey,
    ).changes;
    run('DELETE FROM cart_items WHERE owner_key = ?', ownerKey);
    return { favourites, cart };
  }

  /** Consume a sign-in link. Single use: a replayed link finds `used_at` set and is refused. */
  function verifyMagicLink(token) {
    if (!token) return { ok: false, reason: 'missing-token' };
    const hash = sha256(token);
    const row = one('SELECT * FROM magic_links WHERE token_hash = ?', hash);
    if (!row) return { ok: false, reason: 'unknown-token' };
    if (row.used_at) return { ok: false, reason: 'already-used' };
    if (Date.parse(row.expires_at) < Date.now()) return { ok: false, reason: 'expired' };

    const now = new Date().toISOString();
    run('UPDATE magic_links SET used_at = ? WHERE token_hash = ?', now, hash);

    let user = one('SELECT id, email FROM users WHERE email = ?', row.email);
    if (user) {
      run('UPDATE users SET last_seen_at = ? WHERE id = ?', now, user.id);
    } else {
      user = { id: newUserId(), email: row.email };
      run(
        'INSERT INTO users (id, email, created_at, last_seen_at) VALUES (?, ?, ?, ?)',
        user.id,
        user.email,
        now,
        now,
      );
    }

    const claimed = claimAnonymous(row.owner_key, user.id);

    const sessionToken = newToken();
    run(
      'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
      sha256(sessionToken),
      user.id,
      now,
      new Date(Date.now() + settings.sessionTtlSeconds * 1000).toISOString(),
    );

    return { ok: true, user, sessionToken, claimed };
  }

  function signOut(req) {
    const raw = parseCookies(req)[settings.cookieName];
    if (raw) run('DELETE FROM sessions WHERE token_hash = ?', sha256(raw));
    return { ok: true };
  }

  /** Housekeeping: expired links and sessions are of no further use to anyone. */
  function cleanup() {
    const now = new Date().toISOString();
    return {
      links: run('DELETE FROM magic_links WHERE expires_at < ?', now).changes,
      sessions: run('DELETE FROM sessions WHERE expires_at < ?', now).changes,
    };
  }

  return {
    settings,
    mailer,
    sessionUser,
    ownerFor,
    requestMagicLink,
    verifyMagicLink,
    claimAnonymous,
    signOut,
    cleanup,
    sessionCookie: (token) =>
      cookieString(settings.cookieName, token, { maxAge: settings.sessionTtlSeconds }),
    clearSessionCookie: () => cookieString(settings.cookieName, '', { maxAge: 0 }),
  };
}

let instance = null;

export function getAccounts() {
  if (!instance) instance = createAccounts();
  return instance;
}
