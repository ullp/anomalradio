/**
 * Server-rendered metadata.
 *
 * Share links are the reason this exists: a link posted to X/WhatsApp/Telegram has to unfurl with the
 * real track title, or the ⇪ button is pointless. The pages stay static files, but the `<head>` is
 * rewritten on the way out — which is what these tests check.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers/server.js';

let ctx;
let client;

before(async () => {
  ctx = await startTestServer();
  client = ctx.client;
});

after(async () => {
  await ctx?.close();
});

/** Count how many times a tag appears — duplicated og tags confuse crawlers. */
const count = (html, pattern) => (html.match(pattern) ?? []).length;
const metaContent = (html, property) =>
  new RegExp(`<meta property="${property}" content="([^"]*)"`).exec(html)?.[1] ?? null;

describe('server-rendered metadata', () => {
  it('gives the landing page exactly one set of tags', async () => {
    const { text } = await client.raw('/');
    assert.equal(count(text, /<title>/g), 1, 'one <title> only');
    assert.equal(count(text, /property="og:title"/g), 1);
    assert.equal(count(text, /name="description"/g), 1);
    assert.equal(count(text, /rel="canonical"/g), 1);
    assert.match(text, /<title>Anomalradio\.com — own music only, 24\/7<\/title>/);
    assert.equal(metaContent(text, 'og:type'), 'website');
    assert.match(metaContent(text, 'og:image'), /^https?:\/\/.+\/assets\/img\/og-default\.jpg$/);
  });

  it('unfurls a track permalink with that track’s own title and structured data', async () => {
    const track = ctx.track;
    const { response, text } = await client.raw(`/track/${track.id}`);
    assert.equal(response.status, 200);

    assert.match(text, new RegExp(`<title>${escapeRegExp(track.title)} — ${escapeRegExp(track.artist)}`));
    assert.equal(metaContent(text, 'og:type'), 'music.song');
    assert.match(metaContent(text, 'og:title'), new RegExp(escapeRegExp(track.title)));
    assert.match(metaContent(text, 'og:description'), new RegExp(escapeRegExp(track.artist)));
    assert.equal(metaContent(text, 'og:url'), `${client.baseUrl}/track/${track.id}`);
    assert.match(text, new RegExp(`<link rel="canonical" href="${client.baseUrl}/track/${track.id}"`));

    const jsonLd = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(text)?.[1];
    assert.ok(jsonLd, 'structured data must be present');
    const data = JSON.parse(jsonLd);
    assert.equal(data['@type'], 'MusicRecording');
    assert.equal(data.name, track.title);
    assert.equal(data.byArtist.name, track.artist);
    assert.match(data.duration, /^PT\d+M\d+S$/);
    assert.equal(data.url, `${client.baseUrl}/track/${track.id}`);
  });

  it('renders the track page even for an unknown id, with an honest title', async () => {
    const { response, text } = await client.raw('/track/ar_doesnotexist');
    assert.equal(response.status, 200, 'the page still loads so the client can show the error');
    assert.match(text, /<title>Track not found/);
    assert.match(metaContent(text, 'og:title') ?? '', /Track not found/);
    assert.equal(count(text, /property="og:title"/g), 1);
  });

  it('gives the library and console their own metadata', async () => {
    const tracks = await client.raw('/tracks/');
    assert.match(tracks.text, /<title>Track library — Anomalradio\.com<\/title>/);

    const console_ = await client.raw('/player/');
    assert.match(console_.text, /<title>Radio console — Anomalradio\.com<\/title>/);
  });

  it('escapes HTML in metadata so a track name cannot inject markup', async () => {
    const { upsertTrack, run } = await import('../server/db.js');
    const id = 'ar_escapedXSS';
    upsertTrack({
      id,
      storageKey: `tracks/${id}.mp3`,
      title: 'Quotes " and </script><script>alert(1)</script>',
      artist: 'A & B',
      durationMs: 1000,
      sizeBytes: 10,
      published: true,
    });

    try {
      const { text } = await client.raw(`/track/${id}`);
      assert.ok(!text.includes('<script>alert(1)</script>'), 'no raw script tag from track metadata');
      assert.match(metaContent(text, 'og:title') ?? '', /&quot;|&lt;/, 'meta values are HTML-escaped');
      assert.match(metaContent(text, 'og:description') ?? '', /&amp;/);

      // The structured data must still be valid JSON, just inert.
      const jsonLd = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(text)?.[1];
      const parsed = JSON.parse(jsonLd);
      assert.equal(parsed.name, 'Quotes " and </script><script>alert(1)</script>');
      assert.ok(!jsonLd.includes('</script'), 'the JSON-LD payload cannot close its own block');
    } finally {
      run('DELETE FROM tracks WHERE id = ?', id);
    }
  });
});

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
