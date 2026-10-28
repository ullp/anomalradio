#!/usr/bin/env node
/**
 * Static snapshot builder.
 *
 * Produces a deployable copy of the site for a host that can only serve files (GitHub Pages today,
 * or the shared host at 81.2.196.19). It is a *preview*, and the site says so: the pages, the
 * catalogue and the per-track share cards are real, while playback needs the station server (the
 * token-gated stream, the database and private storage all live there).
 *
 * What it writes into `_site/`:
 *   · every file from `public/`
 *   · `data/playlist.json`    — the same shape as `GET /api/playlist`, so the client needs no
 *                               special casing beyond falling back to it
 *   · `track/<id>/index.html` — pre-rendered so a shared track link still unfurls correctly
 *   · the other pages with their meta tags injected, exactly as the server renders them
 *
 * The catalogue comes from the database when one is present, otherwise from the committed
 * `data/tracks.json` export — which is what makes the build work on CI, where no database exists.
 *
 * Usage: node scripts/build-static.js [--out _site] [--base-url https://anomalradio.com]
 */

import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { config } from '../server/config.js';
import { injectMeta, metaFor, metaForTrack, PAGE_META } from '../server/render.js';

function parseArgs(argv) {
  const args = { out: path.join(config.root, '_site'), baseUrl: 'https://anomalradio.com' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') args.out = path.resolve(argv[++i]);
    else if (argv[i] === '--base-url') args.baseUrl = argv[++i].replace(/\/$/, '');
    else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('usage: node scripts/build-static.js [--out _site] [--base-url https://anomalradio.com]');
      process.exit(0);
    } else {
      console.error(`unknown argument: ${argv[i]}`);
      process.exit(2);
    }
  }
  return args;
}

/**
 * The public catalogue, from whichever source exists.
 * The database wins when it is there (it is the record); the committed export is the fallback so
 * the build also runs on a machine — or CI — that has neither music nor database.
 */
async function loadCatalogue() {
  if (existsSync(config.dbPath)) {
    const [{ openDatabase }, { catalogue, sanitizeTrack }] = await Promise.all([
      import('../server/db.js'),
      import('../server/library.js'),
    ]);
    openDatabase();
    const data = catalogue();
    return {
      source: 'database',
      album: data.album,
      trackCount: data.trackCount,
      totalDurationMs: data.totalDurationMs,
      tracks: data.tracks.map(sanitizeTrack),
    };
  }

  const exported = JSON.parse(await readFile(config.libraryExport, 'utf8'));
  const tracks = (exported.tracks ?? [])
    .filter((track) => track.published !== false)
    .map(({ sourceFile: _sourceFile, ...track }) => track);

  return {
    source: 'export',
    album: exported.album ?? null,
    trackCount: tracks.length,
    totalDurationMs: tracks.reduce((sum, track) => sum + (track.durationMs ?? 0), 0),
    tracks,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const catalogue = await loadCatalogue();

  if (catalogue.tracks.length === 0) {
    console.error('✗ no published tracks to build from — run `npm run import` first');
    process.exit(1);
  }

  await rm(args.out, { recursive: true, force: true });
  await mkdir(args.out, { recursive: true });

  // 1. the site itself
  await cp(config.publicDir, args.out, { recursive: true });

  // 2. the catalogue, in the same shape the API returns
  await mkdir(path.join(args.out, 'data'), { recursive: true });
  await writeFile(
    path.join(args.out, 'data', 'playlist.json'),
    `${JSON.stringify(
      {
        dev: false,
        static: true,
        generatedAt: new Date().toISOString(),
        album: catalogue.album,
        trackCount: catalogue.trackCount,
        totalDurationMs: catalogue.totalDurationMs,
        tracks: catalogue.tracks,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  // 3. pages with their meta tags, exactly as the server renders them
  let pages = 0;
  for (const [relative, meta] of Object.entries(PAGE_META)) {
    const file = path.join(args.out, relative);
    if (!existsSync(file)) continue;
    const html = await readFile(file, 'utf8');
    await writeFile(
      file,
      injectMeta(
        html,
        metaFor({ origin: args.baseUrl, pathname: relative.replace(/index\.html$/, ''), ...meta }),
      ),
      'utf8',
    );
    pages += 1;
  }

  // 4. one real page per track, so shared links unfurl with that track's title
  for (const track of catalogue.tracks) {
    const directory = path.join(args.out, 'track', track.id);
    await mkdir(directory, { recursive: true });
    const html = await readFile(path.join(args.out, 'track', 'index.html'), 'utf8');
    await writeFile(
      path.join(directory, 'index.html'),
      injectMeta(html, metaForTrack(track, { origin: args.baseUrl, pathname: `/track/${track.id}` })),
      'utf8',
    );
  }

  console.log('\n  Anomalradio static snapshot');
  console.log('  ─────────────────────────────────────────────');
  console.log(`  output      ${path.relative(process.cwd(), args.out)}`);
  console.log(`  catalogue   ${catalogue.tracks.length} track(s) from the ${catalogue.source}`);
  console.log(`  base url    ${args.baseUrl}`);
  console.log(`  pages       ${pages} with meta tags, ${catalogue.tracks.length} track permalinks`);
  console.log('  playback    not available in a static build — the stream needs the station server\n');
}

main().catch((error) => {
  console.error(`\n✗ static build failed: ${error.message}\n`);
  process.exit(1);
});
