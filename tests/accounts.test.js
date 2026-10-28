/**
 * Accounts (M4): magic links.
 *
 * The sign-in endpoint is the one place an anonymous visitor can make the server send mail and
 * create rows, so its properties are tested directly rather than inferred: the link is single-use,
 * it expires, it is rate limited per address, only its hash is ever stored — and signing in *keeps*
 * the stars someone collected before they had an account.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BROWSER_UA, startTestServer } from './helpers/server.js';

const EMAIL = 'fan@example.com';
const SESSION_COOKIE = 'anomalradio_session';

let ctx;
let client;
let outbox;
let tokenFor; // the last link's token, so a test can replay it

/** Each test signs in from its own address, so one test's rate limit cannot fail another. */
const fromIp = (n) => ({ 'x-forwarded-for': `198.51.100.${n}` });

before(async () => {
  // MAIL_DRIVER=memory: the message is kept, nothing is printed, and — importantly — `env` is
  // applied by the helper *before* the server modules are imported, which is what pins the scratch
  // database. Importing a server module up here would freeze the config on the real one.
  ctx = await startTestServer({ env: { MAIL_DRIVER: 'memory' } });
  client = ctx.client;
  outbox = () => ctx.serverModule.getMailer().outbox;
});

after(async () => {
  await ctx?.close();
});

const requestLink = (email = EMAIL, ip = 1) =>
  client.raw('/api/auth/magic-link', {
    method: 'POST',
    headers: { ...client.browserHeaders(), 'content-type': 'application/json', ...fromIp(ip) },
    body: JSON.stringify({ email }),
  });

const tokenFrom = (link) => new URL(link).searchParams.get('token');

const verify = (token) =>
  fetch(`${client.baseUrl}/api/auth/verify?token=${encodeURIComponent(token)}`, {
    headers: { 'user-agent': BROWSER_UA },
    redirect: 'manual',
  });

const cookieFrom = (response) =>
  response.headers.getSetCookie?.()[0] ?? response.headers.get('set-cookie');

const jarOf = (response) => `${SESSION_COOKIE}=${/^[^=]+=([^;]+)/.exec(cookieFrom(response))[1]}`;

describe('magic links', () => {
  it('sends a link and stores only its hash', async () => {
    const { response, body } = await requestLink('Fan@Example.COM ', 2);
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.sentTo, EMAIL, 'the address is normalised');
    assert.match(body.link, /\/api\/auth\/verify\?token=/);

    assert.equal(outbox().length, 1);
    assert.match(outbox()[0].text, /expires in \d+ minutes/);

    const token = tokenFrom(body.link);
    tokenFor = token;
    // The database is not a credential store: the token exists nowhere in it.
    const rows = ctx.query('SELECT token_hash, email FROM magic_links');
    assert.ok(rows.length > 0);
    for (const row of rows) {
      assert.notEqual(row.token_hash, token);
      assert.doesNotMatch(row.token_hash, new RegExp(token.slice(0, 12)));
    }
    assert.equal(rows.at(-1).email, EMAIL);
  });

  it('signs in with the link and sets a hardened session cookie', async () => {
    const response = await verify(tokenFor);
    assert.equal(response.status, 302);
    assert.match(response.headers.get('location'), /^\/favourites\/\?signed-in=1$/);

    const cookie = cookieFrom(response);
    assert.match(cookie, new RegExp(`^${SESSION_COOKIE}=`));
    assert.match(cookie, /HttpOnly/, 'the session cookie must not be readable by scripts');
    assert.match(cookie, /SameSite=Lax/);
    assert.match(cookie, /Path=\//);

    const { body } = await client.raw('/api/auth/session', { headers: { cookie: jarOf(response) } });
    assert.equal(body.signedIn, true);
    assert.equal(body.email, EMAIL);
  });

  it('refuses a replayed link', async () => {
    const response = await verify(tokenFor);
    assert.equal(response.status, 302);
    assert.match(response.headers.get('location'), /sign-in-failed=already-used/);
  });

  it('refuses an expired link', async () => {
    const { body } = await requestLink('expired@example.com', 3);
    const token = tokenFrom(body.link);
    ctx.query(
      'UPDATE magic_links SET expires_at = ? WHERE used_at IS NULL',
      '2020-01-01T00:00:00.000Z',
    );
    const response = await verify(token);
    assert.match(response.headers.get('location'), /sign-in-failed=expired/);
  });

  it('refuses a token that was never issued', async () => {
    const response = await verify('not-a-real-token');
    assert.match(response.headers.get('location'), /sign-in-failed=unknown-token/);
  });

  it('rate limits requests per address', async () => {
    const email = 'flood@example.com';
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { response } = await requestLink(email, 4);
      assert.equal(response.status, 200, `attempt ${attempt + 1} should be allowed`);
    }
    const { response, body } = await requestLink(email, 4);
    assert.equal(response.status, 429);
    assert.equal(body.error, 'rate-limited');
  });

  it('does not reveal whether an address already has an account', async () => {
    const known = await requestLink(EMAIL, 5); // this address signed in above
    const unknown = await requestLink('stranger@example.com', 5);
    assert.equal(known.response.status, unknown.response.status);
    assert.deepEqual(Object.keys(known.body).sort(), Object.keys(unknown.body).sort());
    assert.equal(known.body.sentTo, EMAIL);
    assert.equal(unknown.body.sentTo, 'stranger@example.com');
  });

  it('rejects an address that is not an address', async () => {
    const { response, body } = await requestLink('not-an-email', 6);
    assert.equal(response.status, 400);
    assert.equal(body.error, 'invalid-email');
  });

  it('revokes the session on sign-out', async () => {
    const { body } = await requestLink('leaver@example.com', 7);
    const response = await verify(tokenFrom(body.link));
    const jar = jarOf(response);

    const before = await client.raw('/api/auth/session', { headers: { cookie: jar } });
    assert.equal(before.body.signedIn, true);

    const out = await client.raw('/api/auth/logout', {
      method: 'POST',
      headers: { ...client.browserHeaders(), cookie: jar },
    });
    assert.equal(out.response.status, 200);
    assert.match(cookieFrom(out.response) ?? '', /Max-Age=0/);

    const after = await client.raw('/api/auth/session', { headers: { cookie: jar } });
    assert.equal(after.body.signedIn, false, 'the row is gone, so the old cookie is dead');
  });
});

/* ─────────────────────── claiming what you already had ─────────────────────── */

describe('claiming anonymous stars', () => {
  const starAsAnonymous = async (ownerKey, trackId) => {
    const { body } = await client.raw('/api/favourites', {
      method: 'POST',
      headers: {
        ...client.browserHeaders(),
        'content-type': 'application/json',
        cookie: `anomalradio_owner=${ownerKey}`,
      },
      body: JSON.stringify({ trackId }),
    });
    return body;
  };

  const signIn = async (email, ownerKey, ip) => {
    // The owner key must travel with the *request* — that is how the claim knows what to move.
    const { body } = await client.raw('/api/auth/magic-link', {
      method: 'POST',
      headers: {
        ...client.browserHeaders(),
        'content-type': 'application/json',
        cookie: `anomalradio_owner=${ownerKey}`,
        ...fromIp(ip),
      },
      body: JSON.stringify({ email }),
    });
    const response = await fetch(
      `${client.baseUrl}/api/auth/verify?token=${encodeURIComponent(tokenFrom(body.link))}`,
      { headers: { 'user-agent': BROWSER_UA }, redirect: 'manual' },
    );
    return jarOf(response);
  };

  it('keeps the stars collected before signing in', async () => {
    const owner = 'own_claimtest0001';
    const trackId = ctx.library.tracks[0].id;
    const starred = await starAsAnonymous(owner, trackId);
    assert.equal(starred.starred, true);

    // The sign-in request carries the cookie, which is how the claim knows what to move.
    const { body } = await client.raw('/api/auth/magic-link', {
      method: 'POST',
      headers: {
        ...client.browserHeaders(),
        'content-type': 'application/json',
        cookie: `anomalradio_owner=${owner}`,
        ...fromIp(8),
      },
      body: JSON.stringify({ email: 'claim@example.com' }),
    });
    const response = await fetch(
      `${client.baseUrl}/api/auth/verify?token=${encodeURIComponent(tokenFrom(body.link))}`,
      { headers: { 'user-agent': BROWSER_UA }, redirect: 'manual' },
    );
    const jar = jarOf(response);

    const mine = await client.raw('/api/favourites', { headers: { cookie: jar } });
    assert.equal(mine.body.signedIn, true);
    assert.equal(mine.body.count, 1, 'the star survived signing in');
    assert.equal(mine.body.tracks[0].id, trackId);

    // …and it is no longer sitting under the anonymous key.
    const leftover = ctx.query('SELECT COUNT(*) AS n FROM favourites WHERE owner_key = ?', owner);
    assert.equal(leftover[0].n, 0);
  });

  it('does not duplicate a track starred on both sides', async () => {
    const owner = 'own_claimtest0002';
    const [first, second] = ctx.library.tracks;
    const jar = await signIn('merge@example.com', owner, 9);

    // The account stars one track…
    await client.raw('/api/favourites', {
      method: 'POST',
      headers: { ...client.browserHeaders(), 'content-type': 'application/json', cookie: jar },
      body: JSON.stringify({ trackId: first.id }),
    });
    // …and the anonymous cookie already had the same one plus another.
    await starAsAnonymous(owner, first.id);
    await starAsAnonymous(owner, second.id);

    // A second sign-in claims the anonymous rows again.
    const again = await signIn('merge@example.com', owner, 10);
    const mine = await client.raw('/api/favourites', { headers: { cookie: again } });

    assert.equal(mine.body.count, 2, 'both tracks, each once');
    const ids = mine.body.tracks.map((track) => track.id).sort();
    assert.deepEqual(ids, [first.id, second.id].sort());

    // The UNIQUE (owner_key, track_id) constraint did its job: no account ends up with the same
    // track twice, however many times the claim runs.
    const rows = ctx.query('SELECT owner_key, track_id FROM favourites WHERE owner_key LIKE ?', 'usr_%');
    const pairs = rows.map((row) => `${row.owner_key}/${row.track_id}`);
    assert.equal(new Set(pairs).size, pairs.length, 'no duplicate (owner, track) rows');
  });
});
