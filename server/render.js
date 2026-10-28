/**
 * Server-rendered metadata.
 *
 * The pages themselves stay static files (one source of truth for markup, hydrated by the client
 * JS), but the `<head>` is rewritten on the way out. That is what makes a shared track link unfurl
 * into a real card on X / WhatsApp / Telegram / Slack, which is the whole point of the ⇪ button.
 */

const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * Serialise JSON for embedding in an HTML `<script>` block.
 * `JSON.stringify` escapes quotes but not `<`, so a track title containing `</script>` would end the
 * block and inject markup. Escaping those characters (and the JS line separators) keeps the JSON
 * valid while making the payload inert.
 */
export function safeJsonForHtml(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** ISO-8601 duration for JSON-LD (`PT16M17S`). */
export function isoDuration(ms) {
  const total = Math.round((ms ?? 0) / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `PT${minutes}M${seconds}S`;
}

/**
 * The meta block for a page.
 * `og:image` prefers a real cover once one exists (M6 uploads them); until then it is the brand card.
 */
export function metaFor({
  origin,
  title,
  description,
  pathname,
  image = '/assets/img/og-default.jpg',
  type = 'website',
  jsonLd = null,
}) {
  const url = `${origin}${pathname}`;
  const imageUrl = image.startsWith('http') ? image : `${origin}${image}`;

  return {
    title,
    url,
    tags: [
      `<title>${escapeHtml(title)}</title>`,
      `<meta name="description" content="${escapeHtml(description)}" />`,
      `<link rel="canonical" href="${escapeHtml(url)}" />`,
      `<meta property="og:type" content="${escapeHtml(type)}" />`,
      `<meta property="og:site_name" content="Anomalradio.com" />`,
      `<meta property="og:title" content="${escapeHtml(title)}" />`,
      `<meta property="og:description" content="${escapeHtml(description)}" />`,
      `<meta property="og:url" content="${escapeHtml(url)}" />`,
      `<meta property="og:image" content="${escapeHtml(imageUrl)}" />`,
      `<meta property="og:image:width" content="1200" />`,
      `<meta property="og:image:height" content="630" />`,
      `<meta name="twitter:card" content="summary_large_image" />`,
      `<meta name="twitter:title" content="${escapeHtml(title)}" />`,
      `<meta name="twitter:description" content="${escapeHtml(description)}" />`,
      `<meta name="twitter:image" content="${escapeHtml(imageUrl)}" />`,
      jsonLd ? `<script type="application/ld+json">${safeJsonForHtml(jsonLd)}</script>` : null,
    ].filter(Boolean),
  };
}

/** Metadata for a track permalink, including MusicRecording structured data. */
export function metaForTrack(track, { origin, pathname }) {
  const album = track.album ? ` from ${track.album}` : '';
  return metaFor({
    origin,
    pathname,
    type: 'music.song',
    title: `${track.title} — ${track.artist} · Anomalradio.com`,
    description:
      `${track.title} by ${track.artist}${album}. ` +
      `${Math.round(track.durationMs / 1000)}s of own-catalogue electronic music, streaming on Anomalradio.com.`,
    image: track.coverKey ? `/media/covers/${track.coverKey}` : '/assets/img/og-default.jpg',
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'MusicRecording',
      name: track.title,
      byArtist: { '@type': 'MusicGroup', name: track.artist },
      ...(track.album ? { inAlbum: { '@type': 'MusicAlbum', name: track.album } } : {}),
      duration: isoDuration(track.durationMs),
      genre: track.genre ?? undefined,
      url: `${origin}/track/${track.id}`,
    },
  });
}

/**
 * Replace the page's `<title>` and inject the meta block before `</head>`.
 * Anything the static file already declares for og:* / twitter:* / description is dropped first, so
 * there is exactly one of each.
 */
export function injectMeta(html, meta) {
  let output = html.replace(/<title>[\s\S]*?<\/title>/i, '');
  output = output.replace(
    /<meta\s+(?:name|property)="(?:description|og:[^"]*|twitter:[^"]*)"[^>]*>\s*/gi,
    '',
  );
  output = output.replace(/<link\s+rel="canonical"[^>]*>\s*/gi, '');
  output = output.replace(/<\/head>/i, `    ${meta.tags.join('\n    ')}\n  </head>`);
  return output;
}

/** Pages that get server-rendered tags, with their titles and descriptions. */
export const PAGE_META = {
  '/index.html': {
    title: 'Anomalradio.com — own music only, 24/7',
    description:
      'Anomalradio.com streams its own electronic catalogue around the clock. Live radio, a full track library, favourites, and protected playback — no downloads, no hotlinks.',
  },
  '/player/index.html': {
    title: 'Radio console — Anomalradio.com',
    description:
      'The Anomalradio console: live now-playing, the last 15 tracks on air, star, basket and share every track.',
  },
  '/tracks/index.html': {
    title: 'Track library — Anomalradio.com',
    description:
      'Every track in the Anomalradio catalogue: search, filter, play, star, add to basket or share.',
  },
  '/favourites/index.html': {
    title: 'Favourites — Anomalradio.com',
    description: 'The tracks you starred on Anomalradio, with play-all and M3U export.',
  },
  '/cart/index.html': {
    title: 'Basket — Anomalradio.com',
    description: 'Tracks you collected for purchase. Checkout arrives with the shop milestone.',
  },
  '/about/index.html': {
    title: 'About the station — Anomalradio.com',
    description:
      'How Anomalradio works: own music only, protected streaming, and an honest account of what can and cannot be prevented.',
  },
};
