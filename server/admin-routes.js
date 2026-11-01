/**
 * Admin routes (M6) — the HTTP surface of the control room.
 *
 * Kept out of `routes.js` on purpose: that file is the public contract, and this one is the opposite
 * of public. The gate order is the same for every request, and it is the whole security story:
 *
 *   1. `enabled()`      — no ADMIN_PASSWORD_HASH means the area answers 404, as if it were not there
 *   2. `ipAllowed()`    — optional allowlist, checked before anything else can leak
 *   3. `signedIn()`     — for the JSON API; the shell itself is public so it can render a login form
 *   4. `originAllowed()`— for every state change, which is what makes CSRF a non-issue
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { all, one, rowToTrack, run } from './db.js';
import { MIME, sendJson, sendText } from './http.js';
import { broadcastState, publicTrack } from './library.js';
import { setBuyLink } from './buy-links.js';

/** The columns the admin may change, and how. Anything not listed is not editable. */
const EDITABLE = {
  title: { column: 'title', kind: 'text', max: 200, required: true },
  artist: { column: 'artist', kind: 'text', max: 200, required: true },
  album: { column: 'album', kind: 'text', max: 200 },
  albumArtist: { column: 'album_artist', kind: 'text', max: 200 },
  genre: { column: 'genre', kind: 'text', max: 80 },
  composer: { column: 'composer', kind: 'text', max: 200 },
  musicalKey: { column: 'musical_key', kind: 'text', max: 12 },
  year: { column: 'year', kind: 'int', min: 1900, max: 2100 },
  bpm: { column: 'bpm', kind: 'int', min: 20, max: 400 },
  priceCents: { column: 'price_cents', kind: 'int', min: 0, max: 1000000 },
  currency: { column: 'currency', kind: 'text', max: 3, upper: true },
  weight: { column: 'weight', kind: 'int', min: 1, max: 100 },
  featured: { column: 'featured', kind: 'bool' },
  published: { column: 'published', kind: 'bool' },
};

const escapeHtml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );

/**
 * Validate one field. Returns `{ ok }` plus either `value` or `error`, so the caller can report every
 * problem in a patch at once instead of failing on the first.
 */
function coerce(spec, raw) {
  if (spec.kind === 'bool') {
    if (raw === null) return { ok: true, value: null };
    if (typeof raw === 'boolean') return { ok: true, value: raw };
    const text = String(raw).toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(text)) return { ok: true, value: true };
    if (['0', 'false', 'no', 'off'].includes(text)) return { ok: true, value: false };
    return { ok: false, error: 'expected a boolean' };
  }

  if (spec.kind === 'int') {
    if (raw === null || raw === '') return { ok: true, value: null };
    const parsed = Number.parseInt(String(raw), 10);
    if (!Number.isFinite(parsed)) return { ok: false, error: 'expected a whole number' };
    if (spec.min !== undefined && parsed < spec.min) return { ok: false, error: `must be ≥ ${spec.min}` };
    if (spec.max !== undefined && parsed > spec.max) return { ok: false, error: `must be ≤ ${spec.max}` };
    return { ok: true, value: parsed };
  }

  // text — a required field is checked *before* the empty-to-null shortcut, otherwise blanking the
  // title would be accepted here and then fail the NOT NULL constraint inside SQLite.
  if (spec.required) {
    const required = String(raw ?? '').trim();
    if (required.length === 0) return { ok: false, error: 'is required' };
  }
  if (raw === null || raw === '') return { ok: true, value: null };

  let text = String(raw).trim();
  if (spec.upper) text = text.toUpperCase();
  if (spec.max && text.length > spec.max) return { ok: false, error: `must be ≤ ${spec.max} characters` };
  return { ok: true, value: text };
}

/** Read a small request body as JSON or as an HTML form, whichever arrived. */
async function readPayload(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('body-too-large');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  if (String(req.headers['content-type'] ?? '').includes('json')) return JSON.parse(raw);
  return Object.fromEntries(new URLSearchParams(raw));
}

export function createAdminRouter({ admin, security, tokens = null, radio = null } = {}) {
  const base = config.admin.path;
  const publicAdmin = path.join(config.publicDir, 'admin');

  /** The shell: public, because it is how you reach the login form. Contains no data. */
  async function renderShell({ signedIn, error = null, notice = null }) {
    let html;
    try {
      html = await readFile(path.join(publicAdmin, 'index.html'), 'utf8');
    } catch {
      return null;
    }
    const banner = error
      ? `<p class="admin-banner admin-banner--error" role="alert">${escapeHtml(error)}</p>`
      : notice
        ? `<p class="admin-banner" role="status">${escapeHtml(notice)}</p>`
        : '';
    return html
      .replace('data-signed-in="false"', `data-signed-in="${signedIn ? 'true' : 'false'}"`)
      .replace('<!--ADMIN_BANNER-->', banner);
  }

  async function serveAsset(res, name) {
    const allowed = { 'admin.css': MIME['.css'], 'admin.js': MIME['.js'] };
    if (!(name in allowed)) return sendText(res, 404, 'not found');
    try {
      const body = await readFile(path.join(publicAdmin, name));
      res.writeHead(200, {
        'Content-Type': allowed[name],
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex, nofollow',
      });
      return res.end(body);
    } catch {
      return sendText(res, 404, 'not found');
    }
  }

  /** The dashboard's own numbers. Cheap enough to recompute on every load. */
  function summary() {
    const totals = one(`
      SELECT COUNT(*) AS tracks,
             SUM(CASE WHEN published = 1 THEN 1 ELSE 0 END) AS published,
             SUM(CASE WHEN published = 0 THEN 1 ELSE 0 END) AS drafts,
             COALESCE(SUM(plays), 0) AS plays,
             COALESCE(SUM(stars), 0) AS stars,
             COALESCE(SUM(shares), 0) AS shares,
             COALESCE(SUM(duration_ms), 0) AS durationMs,
             COALESCE(SUM(size_bytes), 0) AS bytes
        FROM tracks`);
    const listeners = radio ? radio.listenerCount() : 0;
    const state = broadcastState();
    const recent = all(`
      SELECT h.started_at AS startedAt, t.title, t.artist
        FROM play_history h JOIN tracks t ON t.id = h.track_id
       ORDER BY h.started_at DESC LIMIT 10`);
    return {
      totals: totals ?? {},
      listeners,
      onAir: state ? { title: state.now.track.title, artist: state.now.track.artist } : null,
      next: state?.next?.track?.title ?? null,
      recent,
      checkout: { driver: config.checkout.driver, storeName: config.checkout.storeName || null },
      audit: admin.recentAudit(15),
    };
  }

  async function handle(req, res, url) {
    // 1. off unless configured — and indistinguishable from a path that does not exist.
    if (!admin.enabled()) return sendText(res, 404, 'not found');
    // 2. optional allowlist, before anything can be revealed
    if (!admin.ipAllowed(req)) return sendText(res, 403, 'forbidden');

    const rest = url.pathname.slice(base.length);
    const method = req.method ?? 'GET';

    // The shell uses relative URLs (`admin.css`, `api/summary`), which only resolve correctly from a
    // path with a trailing slash — and `<base>` is unavailable, because the CSP sets base-uri 'none'.
    if (method === 'GET' && rest === '') {
      res.writeHead(308, { Location: `${base}/`, 'Cache-Control': 'no-store' });
      return res.end();
    }

    /* ── the shell and its two assets ── */
    if (method === 'GET' && rest === '/') {
      const html = await renderShell({
        signedIn: admin.signedIn(req),
        error: url.searchParams.get('error'),
        notice: url.searchParams.get('notice'),
      });
      if (!html) return sendText(res, 404, 'not found');
      res.writeHead(200, {
        'Content-Type': MIME['.html'],
        'Content-Length': Buffer.byteLength(html),
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex, nofollow, noarchive',
      });
      return res.end(html);
    }

    if (method === 'GET' && (rest === '/admin.css' || rest === '/admin.js')) {
      return serveAsset(res, rest.slice(1));
    }

    /* ── sign in / out: forms, so they work with JavaScript off ── */

    if (method === 'POST' && rest === '/login') {
      // A state change, so it gets the same origin check as everything else. Login CSRF is real:
      // it is how an attacker gets you browsing as *them*.
      if (!security.originAllowed(req)) return sendText(res, 403, 'forbidden');
      if (security.rateLimited(`admin-login:${security.ipHash(req)}`, admin.settings.loginRateLimit)) {
        return sendText(res, 429, 'too many attempts');
      }

      let payload;
      try {
        payload = await readPayload(req);
      } catch {
        return sendText(res, 400, 'bad request');
      }

      const result = admin.signIn({
        password: payload.password,
        code: payload.code,
        ip: admin.clientIp(req),
      });

      if (!result.ok) {
        admin.audit({ action: 'login-failed', target: result.reason, ip: admin.clientIp(req) });
        const html = await renderShell({
          signedIn: false,
          error:
            result.reason === 'bad-code'
              ? 'That code is not right (or the clock drifted).'
              : 'That password is not right.',
        });
        if (!html) return sendText(res, 401, 'unauthorised');
        res.writeHead(401, {
          'Content-Type': MIME['.html'],
          'Set-Cookie': result.cookie ?? '',
          'X-Robots-Tag': 'noindex, nofollow',
        });
        return res.end(html);
      }

      admin.audit({ action: 'login', target: null, ip: admin.clientIp(req) });
      res.writeHead(303, { Location: base, 'Set-Cookie': result.cookie, 'Cache-Control': 'no-store' });
      return res.end();
    }

    if (method === 'POST' && rest === '/logout') {
      if (!security.originAllowed(req)) return sendText(res, 403, 'forbidden');
      const { cookie, ended } = admin.signOut(req);
      if (ended) admin.audit({ action: 'logout', ip: admin.clientIp(req) });
      res.writeHead(303, { Location: base, 'Set-Cookie': cookie, 'Cache-Control': 'no-store' });
      return res.end();
    }

    /* ── the JSON API: signed in, always ── */

    if (!rest.startsWith('/api/')) return sendText(res, 404, 'not found');
    if (!admin.signedIn(req)) return sendJson(res, 401, { error: 'unauthorised' });

    const isWrite = method !== 'GET' && method !== 'HEAD';
    if (isWrite && !security.originAllowed(req)) {
      return sendJson(res, 403, { error: 'forbidden-origin' });
    }

    const [, , resource, param] = rest.split('/');

    if (method === 'GET' && resource === 'summary' && !param) {
      return sendJson(res, 200, summary());
    }

    if (method === 'GET' && resource === 'tracks' && !param) {
      // Drafts included — that is the point of the admin — but still never a storage path, because
      // this goes through the same `publicTrack()` the public API uses.
      const rows = all(`
        SELECT * FROM tracks
         ORDER BY published DESC,
                  COALESCE(album, '') COLLATE NOCASE,
                  COALESCE(disc, 0),
                  COALESCE(track_number, 0),
                  title COLLATE NOCASE`);
      const tracks = rows.map((row) => publicTrack(rowToTrack(row)));
      return sendJson(res, 200, {
        tracks,
        total: tracks.length,
        published: tracks.filter((track) => track.published).length,
      });
    }

    if (method === 'PATCH' && resource === 'tracks' && param) {
      return patchTrack(req, res, param);
    }

    if (method === 'POST' && resource === 'tracks' && param && url.pathname.endsWith('/publish')) {
      return publishTrack(req, res, param);
    }

    if (method === 'POST' && resource === 'revoke') {
      return revoke(req, res);
    }

    return sendJson(res, 404, { error: 'unknown-admin-endpoint' });
  }

  /** The stored row as the rest of the server sees it. */
  function currentTrack(id) {
    const row = one('SELECT * FROM tracks WHERE id = ?', id);
    return row ? rowToTrack(row) : null;
  }

  /**
   * Patch one track. Every field is validated before anything is written, so a patch with one bad
   * value changes nothing — and each field that actually changed gets its own audit row, which is
   * what makes the audit log readable later.
   */
  async function patchTrack(req, res, id) {
    const before = currentTrack(id);
    if (!before) return sendJson(res, 404, { error: 'track-not-found' });

    let payload;
    try {
      payload = await readPayload(req);
    } catch (error) {
      return sendJson(res, error.message === 'body-too-large' ? 413 : 400, { error: error.message });
    }

    const assignments = [];
    const params = [];
    const changed = [];
    const errors = [];

    for (const [field, spec] of Object.entries(EDITABLE)) {
      if (!(field in payload)) continue;
      const { ok, value, error } = coerce(spec, payload[field]);
      if (!ok) {
        errors.push(`${field} ${error}`);
        continue;
      }
      if (value === before[field]) continue;
      assignments.push(`${spec.column} = ?`);
      params.push(spec.kind === 'bool' ? (value ? 1 : 0) : value);
      changed.push(field);
    }

    // buyUrl goes through the M5 validator, so an unsafe link cannot be stored from here either.
    if ('buyUrl' in payload) {
      const raw = payload.buyUrl;
      const next = raw === null || raw === undefined || raw === '' ? null : String(raw).trim();
      if (next !== before.buyUrl) {
        try {
          setBuyLink(id, next);
          changed.push('buyUrl');
        } catch (error) {
          errors.push(`buyUrl: ${error.message}`);
        }
      }
    }

    if (errors.length > 0) return sendJson(res, 400, { error: 'invalid-patch', details: errors });

    if (assignments.length > 0) {
      run(
        `UPDATE tracks SET ${assignments.join(', ')}, updated_at = ? WHERE id = ?`,
        ...params,
        new Date().toISOString(),
        id,
      );
    }

    for (const field of changed) {
      admin.audit({ action: 'track.update', target: `${id}:${field}`, ip: admin.clientIp(req) });
    }

    return sendJson(res, 200, { track: publicTrack(currentTrack(id)), changed });
  }

  async function publishTrack(req, res, id) {
    const before = currentTrack(id);
    if (!before) return sendJson(res, 404, { error: 'track-not-found' });

    let payload;
    try {
      payload = await readPayload(req);
    } catch {
      return sendJson(res, 400, { error: 'bad-request' });
    }

    const next = coerce(EDITABLE.published, payload.published ?? true);
    if (!next.ok) return sendJson(res, 400, { error: 'invalid-published' });
    if (next.value === before.published) return sendJson(res, 200, { track: publicTrack(before) });

    run(
      'UPDATE tracks SET published = ?, updated_at = ? WHERE id = ?',
      next.value ? 1 : 0,
      new Date().toISOString(),
      id,
    );
    admin.audit({
      action: next.value ? 'track.publish' : 'track.unpublish',
      target: id,
      ip: admin.clientIp(req),
    });

    return sendJson(res, 200, { track: publicTrack(currentTrack(id)) });
  }

  /**
   * The panic buttons. `sessions` ends every admin session *except* this one — otherwise the button
   * would log you out of the panel you are standing in; `tokens` revokes every issued stream token.
   */
  async function revoke(req, res) {
    let payload;
    try {
      payload = await readPayload(req);
    } catch {
      return sendJson(res, 400, { error: 'bad-request' });
    }

    const scope = String(payload.scope ?? 'sessions');

    if (scope === 'sessions') {
      const current = admin.sessionFor(req);
      const ended = current
        ? run('DELETE FROM admin_sessions WHERE token_hash <> ?', current.tokenHash).changes
        : run('DELETE FROM admin_sessions').changes;
      admin.audit({ action: 'revoke.sessions', target: String(ended), ip: admin.clientIp(req) });
      return sendJson(res, 200, { scope, revoked: ended });
    }

    if (scope === 'tokens') {
      const revoked = run('UPDATE stream_tokens SET revoked = 1 WHERE revoked = 0').changes;
      admin.audit({ action: 'revoke.tokens', target: String(revoked), ip: admin.clientIp(req) });
      return sendJson(res, 200, { scope, revoked });
    }

    return sendJson(res, 400, { error: 'unknown-scope' });
  }

  return { handle, base, summary };
}
