#!/usr/bin/env node
/**
 * One-off asset helper: downloads the self-hosted web fonts used by the design.
 *
 * Why self-host instead of linking Google Fonts:
 *   - no third-party request on the critical path (faster first paint)
 *   - no data leak to a third party (GDPR-friendly, as stated in the offer §10.2)
 *   - the site keeps working if the CDN is unreachable
 *
 * All three families are SIL Open Font License 1.1 (free to self-host and redistribute):
 *   Orbitron       — headings / techno display (matches the wide squared logo letterforms)
 *   Inter          — UI and body text
 *   JetBrains Mono — IDs, timings, ticker data
 *
 * Only the `latin` subset of each weight is downloaded. Re-running is idempotent.
 *
 * Usage: node scripts/fetch-fonts.js
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT_DIR = path.join(ROOT, 'public/assets/fonts');

// A modern browser UA is required, otherwise Google serves legacy TTF instead of woff2.
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

const FAMILIES = [
  { family: 'Inter', axis: 'wght@400;500;600;700', slug: 'inter' },
  { family: 'Orbitron', axis: 'wght@500;700;900', slug: 'orbitron' },
  { family: 'JetBrains Mono', axis: 'wght@400;500', slug: 'jetbrains-mono' },
];

const CSS_URL = (family, axis) =>
  `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, '+')}:${axis}&display=swap`;

/** Split a Google Fonts stylesheet into @font-face blocks we care about (latin subset only). */
function parseFaces(css) {
  const faces = [];
  for (const block of css.split('@font-face').slice(1)) {
    const family = /font-family:\s*'([^']+)'/.exec(block)?.[1];
    const weight = /font-weight:\s*(\d+)/.exec(block)?.[1] ?? '400';
    const style = /font-style:\s*(\w+)/.exec(block)?.[1] ?? 'normal';
    const url = /src:\s*url\((https:\/\/[^)]+\.woff2)\)/.exec(block)?.[1];
    const unicodeRange = /unicode-range:\s*([^;]+);/.exec(block)?.[1] ?? '';
    if (!family || !url) continue;
    // `latin` is the subset that contains U+0000-00FF; skip cyrillic/greek/vietnamese/latin-ext.
    if (!unicodeRange.includes('U+0000-00FF')) continue;
    faces.push({ family, weight, style, url });
  }
  return faces;
}

async function download(url, file) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  await writeFile(file, buffer);
  return buffer.length;
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const manifest = [];

  for (const { family, axis, slug } of FAMILIES) {
    const res = await fetch(CSS_URL(family, axis), { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`${res.status} while fetching the CSS for ${family}`);
    const faces = parseFaces(await res.text());

    for (const face of faces) {
      const file = `${slug}-${face.weight}.woff2`;
      const bytes = await download(face.url, path.join(OUT_DIR, file));
      manifest.push({ family, weight: Number(face.weight), style: face.style, file, bytes });
      console.log(`  ✓ ${file.padEnd(26)} ${String(Math.round(bytes / 1024)).padStart(4)} KB`);
    }
  }

  await writeFile(
    path.join(OUT_DIR, 'manifest.json'),
    `${JSON.stringify({ fetchedAt: new Date().toISOString(), license: 'SIL Open Font License 1.1', faces: manifest }, null, 2)}\n`,
  );
  console.log(`\n✓ ${manifest.length} font file(s) written to public/assets/fonts/`);
}

main().catch((error) => {
  console.error('✗ font fetch failed:', error.message);
  console.error('  The site falls back to system fonts if these files are missing, so this is not fatal.');
  process.exit(1);
});
