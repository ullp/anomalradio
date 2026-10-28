/* ═══════════════════════════════════════════════════════════════════════
   ANOMALRADIO · cover.js — deterministic generated cover art.
   There is no cover art in the source files yet, so every track gets its own
   "anomaly signature": a seeded waveform fingerprint in the brand palette,
   derived from the track id. When real covers are uploaded (M6) `coverKey`
   is set and these are replaced automatically.
   ═══════════════════════════════════════════════════════════════════════ */

import { h } from './ui.js';

/** FNV-1a — small, fast, deterministic hash of the track id. */
function hash(value) {
  let out = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    out ^= value.charCodeAt(i);
    out = Math.imul(out, 0x01000193) >>> 0;
  }
  return out;
}

/** Seeded PRNG (mulberry32) so the same id always yields the same artwork. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Build a square SVG cover for a track: dark field, azure glow, mirrored
 * waveform fingerprint, track initial and a faint grid.
 */
export function coverArt(track, size = 420) {
  const seed = hash(track.id);
  const random = rng(seed);
  const bars = 42;
  const gap = 3;
  const barWidth = (size - 96 - (bars - 1) * gap) / bars;
  const mid = size / 2 + 14;

  let fingerprint = '';
  for (let i = 0; i < bars; i += 1) {
    const envelope = Math.sin((i / (bars - 1)) * Math.PI) ** 0.7;
    const magnitude = (0.16 + random() * 0.84) * envelope;
    const height = Math.max(6, magnitude * (size * 0.34));
    const x = 48 + i * (barWidth + gap);
    const opacity = (0.35 + magnitude * 0.65).toFixed(2);
    fingerprint +=
      `<rect x="${x.toFixed(1)}" y="${(mid - height).toFixed(1)}" width="${barWidth.toFixed(1)}" ` +
      `height="${height.toFixed(1)}" rx="${(barWidth / 2).toFixed(1)}" fill="#1b8ef5" opacity="${opacity}"/>`;
    fingerprint +=
      `<rect x="${x.toFixed(1)}" y="${mid.toFixed(1)}" width="${barWidth.toFixed(1)}" ` +
      `height="${(height * 0.55).toFixed(1)}" rx="${(barWidth / 2).toFixed(1)}" fill="#00e0ff" ` +
      `opacity="${(opacity * 0.6).toFixed(2)}"/>`;
  }

  const initial = (track.title ?? '?').trim().charAt(0).toUpperCase();
  const hueShift = (seed % 24) - 12; // slight azure variation per track, stays on-brand

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#0a1420"/>
    <stop offset="1" stop-color="#020407"/>
  </linearGradient>
  <radialGradient id="glow" cx="50%" cy="42%" r="62%">
    <stop offset="0" stop-color="hsl(${205 + hueShift} 90% 55%)" stop-opacity="0.30"/>
    <stop offset="1" stop-color="hsl(${205 + hueShift} 90% 55%)" stop-opacity="0"/>
  </radialGradient>
  <pattern id="grid" width="28" height="28" patternUnits="userSpaceOnUse">
    <path d="M28 0H0v28" fill="none" stroke="#ffffff" stroke-opacity="0.045" stroke-width="1"/>
  </pattern>
</defs>
<rect width="${size}" height="${size}" fill="url(#bg)"/>
<rect width="${size}" height="${size}" fill="url(#grid)"/>
<rect width="${size}" height="${size}" fill="url(#glow)"/>
<text x="${size / 2}" y="${size * 0.44}" text-anchor="middle" font-family="Orbitron, sans-serif"
      font-size="${size * 0.3}" font-weight="900" fill="#ffffff" fill-opacity="0.07">${initial}</text>
${fingerprint}
<rect x="0.5" y="0.5" width="${size - 1}" height="${size - 1}" fill="none" stroke="#ffffff" stroke-opacity="0.08"/>
</svg>`;

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** Ready-to-insert cover element. `size` controls the rendered box via CSS class. */
export function coverNode(track, sizeClass = '', { alt = '' } = {}) {
  const src = track.coverKey ? `/media/covers/${track.coverKey}` : coverArt(track);
  return h(
    'div',
    { class: `cover ${sizeClass}`.trim() },
    h('img', {
      src,
      alt: alt || `Cover art for ${track.title}`,
      loading: 'lazy',
      width: '420',
      height: '420',
    }),
  );
}

/**
 * A wide, low-height waveform strip (used on the track page).
 * Pure decoration, deterministic from the id.
 */
export function waveformStrip(track, width = 720, height = 90) {
  const random = rng(hash(track.id) ^ 0x9e3779b9);
  const bars = 96;
  const gap = 2;
  const barWidth = (width - 8 - (bars - 1) * gap) / bars;
  let body = '';
  for (let i = 0; i < bars; i += 1) {
    const envelope = Math.sin((i / (bars - 1)) * Math.PI) ** 0.6;
    const value = (0.2 + random() * 0.8) * envelope;
    const h1 = Math.max(2, value * height * 0.82);
    const h2 = Math.max(2, value * height * 0.5);
    body +=
      `<rect x="${(4 + i * (barWidth + gap)).toFixed(1)}" y="${((height - h1) / 2).toFixed(1)}" ` +
      `width="${barWidth.toFixed(1)}" height="${h1.toFixed(1)}" rx="1" fill="#1b8ef5" opacity="0.85"/>`;
    body +=
      `<rect x="${(4 + i * (barWidth + gap)).toFixed(1)}" y="${((height - h2) / 2).toFixed(1)}" ` +
      `width="${barWidth.toFixed(1)}" height="${h2.toFixed(1)}" rx="1" fill="#00e0ff" opacity="0.5"/>`;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">${body}</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
