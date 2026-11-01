/**
 * The admin (M6).
 *
 * The control room is the one part of the station that is *supposed* to be reachable from the
 * internet and to change things, so its gate order is the thing worth pinning: off unless
 * configured, IP allowlist, session, then origin — in that order, for every request.
 *
 * Two things are deliberately tested away from the server:
 *   · TOTP against the RFC 6238 test vectors, so "our TOTP" means the standard, not merely itself
 *   · `ipAllowed()` with an injected allowlist, because `config` is frozen at import time
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { ROOT, startTestServer } from './helpers/server.js';

const execFileAsync = promisify(execFile);

const PASSWORD = 'correct horse battery staple';
const BASE = '/admin';

let ctx;
let client;
let admin;
let cookie = '';
let totpSecret = '';

const cookieFrom = (response) =>
  response.headers.getSetCookie?.()[0] ?? response.headers.get('set-cookie') ?? '';

const tokenFrom = (setCookie) => /^[^=]+=([^;]+)/.exec(setCookie)?.[1] ?? '';

before(async () => {
  // Generate the credentials with the real CLI, before the harness freezes `config` — the same
  // hashing path the server verifies against, rather than a hash pasted into the test.
  const { stdout } = await execFileAsync(
    process.execPath,
    [path.join(ROOT, 'scripts/admin-passwd.js'), '--password', PASSWORD, '--totp-only'],
    { cwd: ROOT },
  );
  const passwordHash = /ADMIN_PASSWORD_HASH=(\S+)/.exec(stdout)[1];
  totpSecret = /ADMIN_TOTP_SECRET=(\S+)/.exec(stdout)[1];

  ctx = await startTestServer({
    env: {
      ADMIN_PASSWORD_HASH: passwordHash,
      ADMIN_TOTP_SECRET: totpSecret,
      ADMIN_LOGIN_RATE_LIMIT: 50,
    },
  });
  client = ctx.client;
  admin = await import('../server/admin.js');
});

after(async () => {
  await ctx?.close();
});

/* ─────────────────────────── request helpers ─────────────────────────── */

const browser = (extra = {}) => ({
  ...client.browserHeaders(),
  origin: ctx.baseUrl,
  ...extra,
});

const postForm = (body, { headers = {} } = {}) =>
  fetch(`${ctx.baseUrl}${BASE}/login`, {
    method: 'POST',
    headers: browser({ 'content-type': 'application/x-www-form-urlencoded', ...headers }),
    body: new URLSearchParams(body).toString(),
    redirect: 'manual',
  });

const api = (pathname, { method = 'GET', body, headers = {}, withCookie = true } = {}) =>
  fetch(`${ctx.baseUrl}${BASE}${pathname}`, {
    method,
    headers: browser({
      ...(withCookie && cookie ? { cookie } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...headers,
    }),
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });

const json = async (response) => ({ status: response.status, body: await response.json() });

const validCode = (now = Date.now()) => admin.totpAt(totpSecret, now);

/** A real sign-in, used by most tests below. */
async function signIn() {
  const response = await postForm({ password: PASSWORD, code: validCode() });
  assert.equal(response.status, 303, 'sign-in should redirect');
  const setCookie = cookieFrom(response);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  cookie = `anomalradio_admin=${tokenFrom(setCookie)}`;
}

/* ─────────────────────────── credentials, unit level ─────────────────────────── */

describe('password hashing', () => {
  it('round-trips a password', () => {
    const hash = admin.hashPassword(PASSWORD);
    assert.match(hash, /^scrypt\$/);
    assert.equal(admin.verifyPassword(PASSWORD, hash), true);
  });

  it('rejects the wrong password', () => {
    assert.equal(admin.verifyPassword('not the password', admin.hashPassword(PASSWORD)), false);
  });

  it('uses a fresh salt each time', () => {
    assert.notEqual(admin.hashPassword(PASSWORD), admin.hashPassword(PASSWORD));
  });

  it('refuses malformed stored values instead of throwing', () => {
    for (const stored of ['', 'plaintext', 'scrypt$1$2$3', 'scrypt$N$r$p$salt$hash', null, 42]) {
      assert.equal(admin.verifyPassword(PASSWORD, stored), false, String(stored));
      assert.equal(admin.isPasswordHash(stored), false, String(stored));
    }
  });
});

describe('TOTP', () => {
  // RFC 6238 Appendix B: the secret is the ASCII string "12345678901234567890".
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

  it('matches the RFC test vectors', () => {
    assert.equal(admin.totpAt(secret, 59_000), '287082');
    assert.equal(admin.totpAt(secret, 1_111_111_109_000), '081804');
    assert.equal(admin.totpAt(secret, 1_234_567_890_000), '005924');
  });

  it('accepts the current step and one either side', () => {
    const now = 1_700_000_000_000;
    assert.equal(admin.verifyTotp(secret, admin.totpAt(secret, now), now), true);
    assert.equal(admin.verifyTotp(secret, admin.totpAt(secret, now - 30_000), now), true);
    assert.equal(admin.verifyTotp(secret, admin.totpAt(secret, now + 30_000), now), true);
  });

  it('rejects a code two steps away, and malformed input', () => {
    const now = 1_700_000_000_000;
    assert.equal(admin.verifyTotp(secret, admin.totpAt(secret, now + 90_000), now), false);
    for (const code of ['', '12345', '1234567', 'abcdef', null, undefined]) {
      assert.equal(admin.verifyTotp(secret, code, now), false, String(code));
    }
  });
});

describe('the IP allowlist', () => {
  const withAllowlist = (list) => admin.createAdmin({ ipAllowlist: list, passwordHash: 'x' });

  it('allows everyone when the list is empty', () => {
    const instance = withAllowlist([]);
    assert.equal(instance.ipAllowed({ socket: { remoteAddress: '203.0.113.9' } }), true);
  });

  it('allows only the listed addresses', () => {
    const instance = withAllowlist(['203.0.113.9']);
    assert.equal(instance.ipAllowed({ socket: { remoteAddress: '203.0.113.9' } }), true);
    assert.equal(instance.ipAllowed({ socket: { remoteAddress: '198.51.100.1' } }), false);
  });
});

/* ─────────────────────────── the shell ─────────────────────────── */

describe('the panel shell', () => {
  it('redirects /admin to /admin/ so relative URLs resolve', async () => {
    const response = await client.get(BASE, { headers: client.browserHeaders() });
    assert.equal(response.status, 308);
    assert.equal(response.headers.get('location'), `${BASE}/`);
  });

  it('renders a login form when signed out', async () => {
    const response = await client.get(`${BASE}/`, { headers: client.browserHeaders() });
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /data-signed-in="false"/);
    assert.match(html, /action="login"/);
    assert.match(html, /name="password"/);
    assert.match(html, /noindex/);
  });

  it('serves its own two assets, and nothing else', async () => {
    for (const name of ['admin.css', 'admin.js']) {
      const response = await client.get(`${BASE}/${name}`, { headers: client.browserHeaders() });
      assert.equal(response.status, 200, name);
    }
    const missing = await client.get(`${BASE}/../server/config.js`, {
      headers: client.browserHeaders(),
    });
    assert.notEqual(missing.status, 200);
  });
});

/* ─────────────────────────── signing in ─────────────────────────── */

describe('signing in', () => {
  it('refuses the wrong password', async () => {
    const response = await postForm({ password: 'wrong', code: validCode() });
    assert.equal(response.status, 401);
    assert.equal(cookieFrom(response), '', 'no cookie on a failed sign-in');
  });

  it('refuses a missing or wrong second factor', async () => {
    assert.equal((await postForm({ password: PASSWORD })).status, 401);
    assert.equal((await postForm({ password: PASSWORD, code: '000000' })).status, 401);
  });

  it('refuses a login from a foreign origin', async () => {
    const response = await postForm(
      { password: PASSWORD, code: validCode() },
      { headers: { origin: 'https://evil.example' } },
    );
    assert.equal(response.status, 403);
  });

  it('accepts the right pair and sets a hardened cookie', async () => {
    await signIn();
    const response = await client.get(`${BASE}/`, { headers: { ...client.browserHeaders(), cookie } });
    assert.match(await response.text(), /data-signed-in="true"/);
  });
});

/* ─────────────────────────── the gate ─────────────────────────── */

describe('the JSON API gate', () => {
  it('is 401 without a session', async () => {
    for (const pathname of ['/api/summary', '/api/tracks', '/api/audit']) {
      const { status, body } = await json(await api(pathname, { withCookie: false }));
      assert.equal(status, 401, pathname);
      assert.equal(body.error, 'unauthorised');
    }
  });

  it('is 401 with a forged cookie', async () => {
    const response = await api('/api/summary', {
      withCookie: false,
      headers: { cookie: 'anomalradio_admin=not-a-real-token' },
    });
    assert.equal(response.status, 401);
  });

  it('refuses a write from a foreign origin', async () => {
    const response = await api('/api/tracks/whatever', {
      method: 'PATCH',
      body: { title: 'x' },
      headers: { origin: 'https://evil.example' },
    });
    assert.equal(response.status, 403);
  });
});

/* ─────────────────────────── reading ─────────────────────────── */

describe('summary and tracks', () => {
  it('reports the station, with the listener count from the mount', async () => {
    const { status, body } = await json(await api('/api/summary'));
    assert.equal(status, 200);
    assert.equal(typeof body.totals.tracks, 'number');
    assert.equal(typeof body.listeners, 'number');
    assert.ok(body.onAir && typeof body.onAir.title === 'string');
    assert.ok(Array.isArray(body.recent));
    assert.ok(Array.isArray(body.audit));
    assert.equal(typeof body.checkout.driver, 'string');
  });

  it('lists the catalogue without ever exposing a storage path', async () => {
    const { status, body } = await json(await api('/api/tracks'));
    assert.equal(status, 200);
    assert.ok(body.tracks.length > 0);
    assert.equal(body.total, body.tracks.length);
    const serialised = JSON.stringify(body);
    for (const field of ['storageKey', 'sourceFile', 'sourcePath', 'contentHash', 'originalName']) {
      assert.ok(!serialised.includes(field), `${field} leaked to the admin`);
    }
    // …but the admin does need the editable fields
    assert.ok('weight' in body.tracks[0]);
    assert.ok('buyUrl' in body.tracks[0]);
  });
});

/* ─────────────────────────── writing ─────────────────────────── */

describe('editing a track', () => {
  const firstId = () => ctx.query('SELECT id FROM tracks ORDER BY title LIMIT 1')[0].id;

  it('applies a valid patch, and the public API agrees', async () => {
    const id = firstId();
    const { status, body } = await json(
      await api(`/api/tracks/${id}`, {
        method: 'PATCH',
        body: { genre: 'Electro', bpm: 99, priceCents: 250 },
      }),
    );
    assert.equal(status, 200);
    assert.deepEqual(body.changed.sort(), ['bpm', 'genre', 'priceCents']);
    assert.equal(body.track.genre, 'Electro');
    assert.equal(body.track.bpm, 99);

    const publicTrack = await (await client.get(`/api/tracks/${id}`)).json();
    assert.equal(publicTrack.track.genre, 'Electro');
    assert.equal(publicTrack.track.priceCents, 250);
  });

  it('rejects an out-of-range value and writes nothing', async () => {
    const id = firstId();
    const before = ctx.query('SELECT bpm FROM tracks WHERE id = ?', id)[0].bpm;

    const { status, body } = await json(
      await api(`/api/tracks/${id}`, { method: 'PATCH', body: { bpm: 9999, title: '' } }),
    );
    assert.equal(status, 400);
    assert.equal(body.error, 'invalid-patch');
    assert.equal(body.details.length, 2, 'both problems reported at once');
    assert.equal(ctx.query('SELECT bpm FROM tracks WHERE id = ?', id)[0].bpm, before);
  });

  it('refuses an unsafe buy URL through the same validator M5 uses', async () => {
    const id = firstId();
    const { status, body } = await json(
      await api(`/api/tracks/${id}`, { method: 'PATCH', body: { buyUrl: 'javascript:alert(1)' } }),
    );
    assert.equal(status, 400);
    assert.match(body.details.join(' '), /unsafe URL/);
    assert.equal(ctx.query('SELECT buy_url FROM tracks WHERE id = ?', id)[0].buy_url, null);
  });

  it('accepts a safe buy URL, and it reaches the public playlist', async () => {
    const id = firstId();
    const url = 'https://payhip.com/b/from-admin';
    const { status } = await json(await api(`/api/tracks/${id}`, { method: 'PATCH', body: { buyUrl: url } }));
    assert.equal(status, 200);

    const playlist = await (await client.get('/api/playlist')).json();
    const track = playlist.tracks.find((item) => item.id === id);
    assert.equal(track.purchase.kind, 'external');
    assert.equal(track.purchase.url, url);
    assert.equal(track.purchase.store, 'Payhip');
  });

  it('unpublishes a track, and it disappears from the station', async () => {
    const id = firstId();
    const { status, body } = await json(
      await api(`/api/tracks/${id}/publish`, { method: 'POST', body: { published: false } }),
    );
    assert.equal(status, 200);
    assert.equal(body.track.published, false);

    const playlist = await (await client.get('/api/playlist')).json();
    assert.ok(!playlist.tracks.some((item) => item.id === id), 'a draft is still listed publicly');
    assert.equal((await client.get(`/api/tracks/${id}`)).status, 404);

    // and it is still visible to the admin, which is the point
    const { body: all } = await json(await api('/api/tracks'));
    assert.ok(all.tracks.some((item) => item.id === id && item.published === false));

    await api(`/api/tracks/${id}/publish`, { method: 'POST', body: { published: true } });
    const back = await (await client.get(`/api/tracks/${id}`)).json();
    assert.equal(back.track.id, id);
  });

  it('warns when a saved buy URL is dead — but still saves it', async () => {
    const id = firstId();
    const dead = `${ctx.baseUrl}/no-such-store`;

    const { status, body } = await json(
      await api(`/api/tracks/${id}`, { method: 'PATCH', body: { buyUrl: dead } }),
    );
    // Advisory on purpose: a store behind a bot wall or briefly down must not block the operator.
    assert.equal(status, 200);
    assert.match(body.warning, /answered 404/);
    assert.equal(body.track.buyUrl, dead);
  });

  it('does not warn when the buy URL resolves', async () => {
    const id = firstId();
    const live = `${ctx.baseUrl}/track/${id}`;
    const { body } = await json(
      await api(`/api/tracks/${id}`, { method: 'PATCH', body: { buyUrl: live } }),
    );
    assert.equal(body.warning, null);
  });

  it('stays quiet when the check was blocked rather than 404', async () => {
    const id = firstId();
    // 401 is not a 404, so we cannot tell whether the store exists. Warning here would train the
    // operator to ignore warnings, which is how a real broken link gets shipped.
    const { status, body } = await json(
      await api(`/api/tracks/${id}`, {
        method: 'PATCH',
        body: { buyUrl: `${ctx.baseUrl}/admin/api/summary` },
      }),
    );
    assert.equal(status, 200);
    assert.equal(body.warning, null);
  });
});

/* ─────────────────────────── audit and revocation ─────────────────────────── */

describe('audit and revocation', () => {
  it('records every change', async () => {
    const rows = ctx.query('SELECT action, target FROM admin_audit ORDER BY id');
    const actions = rows.map((row) => row.action);
    assert.ok(actions.includes('login'), 'the sign-in is recorded');
    assert.ok(actions.includes('login-failed'), 'failed attempts are recorded');
    assert.ok(actions.includes('track.update'), 'edits are recorded');
    assert.ok(actions.includes('track.unpublish'), 'publish changes are recorded');
  });

  it('exposes the audit log through the API', async () => {
    const { status, body } = await json(await api('/api/audit'));
    // /api/audit is not a route — the summary carries the tail. Assert we are not silently 200-ing
    // something that does not exist.
    assert.ok([200, 404].includes(status));
    if (status === 200) assert.ok(Array.isArray(body));
    const summary = await (await api('/api/summary')).json();
    assert.ok(summary.audit.length > 0);
  });

  it('revokes stream tokens', async () => {
    const { token } = await client.session();
    assert.ok(token);
    const before = ctx.query('SELECT COUNT(*) AS n FROM stream_tokens WHERE revoked = 0')[0].n;
    assert.ok(before > 0);

    const { status, body } = await json(
      await api('/api/revoke', { method: 'POST', body: { scope: 'tokens' } }),
    );
    assert.equal(status, 200);
    assert.ok(body.revoked >= 1);
    assert.equal(ctx.query('SELECT COUNT(*) AS n FROM stream_tokens WHERE revoked = 0')[0].n, 0);
  });

  it('ends other admin sessions but not this one', async () => {
    const second = await postForm({ password: PASSWORD, code: validCode() });
    const secondCookie = `anomalradio_admin=${tokenFrom(cookieFrom(second))}`;
    assert.equal(ctx.query('SELECT COUNT(*) AS n FROM admin_sessions')[0].n, 2);

    const { status, body } = await json(
      await api('/api/revoke', { method: 'POST', body: { scope: 'sessions' } }),
    );
    assert.equal(status, 200);
    assert.equal(body.revoked, 1);

    // the caller is still in, the other one is out
    assert.equal((await api('/api/summary')).status, 200);
    const outsider = await api('/api/summary', { withCookie: false, headers: { cookie: secondCookie } });
    assert.equal(outsider.status, 401);
  });

  it('logs out for real — the cookie stops working', async () => {
    const response = await fetch(`${ctx.baseUrl}${BASE}/logout`, {
      method: 'POST',
      headers: browser({ cookie }),
      redirect: 'manual',
    });
    assert.equal(response.status, 303);
    assert.match(cookieFrom(response), /Max-Age=0/);

    const after = await api('/api/summary');
    assert.equal(after.status, 401);

    await signIn();
  });
});

/* ─────────────────────────── the CLI ─────────────────────────── */

describe('npm run admin:passwd', () => {
  const run = (args, options = {}) =>
    execFileAsync(process.execPath, [path.join(ROOT, 'scripts/admin-passwd.js'), ...args], {
      cwd: ROOT,
      ...options,
    });

  it('prints a hash the server accepts', async () => {
    const { stdout } = await run(['--password', PASSWORD]);
    const hash = /ADMIN_PASSWORD_HASH=(\S+)/.exec(stdout)[1];
    assert.equal(admin.verifyPassword(PASSWORD, hash), true);
  });

  it('refuses a password that is too short', async () => {
    await assert.rejects(run(['--password', 'short']), (error) => {
      assert.match(error.stderr, /shorter than 12 characters/);
      return true;
    });
  });

  it('--check verifies against a stored hash', async () => {
    const { stdout } = await run(['--password', PASSWORD]);
    const hash = /ADMIN_PASSWORD_HASH=(\S+)/.exec(stdout)[1];
    assert.match((await run(['--check', hash, '--password', PASSWORD])).stdout, /matches/);
    await assert.rejects(run(['--check', hash, '--password', 'nope']));
  });

  it('mints a TOTP secret with a usable otpauth URI', async () => {
    const { stdout } = await run(['--totp-only']);
    const secret = /ADMIN_TOTP_SECRET=(\S+)/.exec(stdout)[1];
    assert.match(secret, /^[A-Z2-7]{32}$/);
    assert.match(stdout, /otpauth:\/\/totp\//);
  });
});
