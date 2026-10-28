#!/usr/bin/env node
/**
 * Anomalradio — library import / scan.
 *
 * Reads every audio file under LIBRARY_SOURCE_DIR (default `_data/music`), probes it with
 * ffprobe and writes the metadata index to LIBRARY_INDEX (default `data/tracks.json`).
 *
 * Prototype stage (M1):
 *   - only metadata is produced; audio files stay exactly where they are
 *   - the dev server reads audio straight from the source folder (DEV ONLY, see scripts/serve.js)
 *
 * M2 extends this same script to:
 *   - copy audio into private storage (`media/tracks/<id>.mp3` or an S3/R2 bucket)
 *   - insert/update rows in SQLite instead of (in addition to) the JSON index
 *   - keep IDs stable in the database (today IDs derive from path + size)
 *
 * IDs are opaque and stable for a given file path + size:
 *   id = "ar_" + base62(sha256(relPath + "|" + sizeBytes))[0..10]
 * so re-running the scan never reshuffles the catalogue, and an original filename is
 * never used as a public identifier.
 *
 * Usage:
 *   node scripts/import-tracks.js [--source <dir>] [--out <file>] [--dry-run]
 */

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, stat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const execFileAsync = promisify(execFile);

const AUDIO_EXT = new Set(['.mp3', '.m4a', '.flac', '.wav', '.aac', '.ogg', '.opus']);
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/* ────────────────────────── args ────────────────────────── */

function parseArgs(argv) {
  const args = {
    source: process.env.LIBRARY_SOURCE_DIR ?? './_data/music',
    out: process.env.LIBRARY_INDEX ?? './data/tracks.json',
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--source') args.source = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--help' || a === '-h') {
      console.log('usage: node scripts/import-tracks.js [--source <dir>] [--out <file>] [--dry-run]');
      process.exit(0);
    } else {
      console.error(`unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

/* ────────────────────────── helpers ────────────────────────── */

function base62(buf, length) {
  let out = '';
  for (const byte of buf) {
    out += ALPHABET[byte % 62];
    if (out.length === length) break;
  }
  return out;
}

function trackId(relPath, sizeBytes) {
  const hash = createHash('sha256').update(`${relPath}|${sizeBytes}`).digest();
  return `ar_${base62(hash, 10)}`;
}

/** Recursively list audio files, sorted for deterministic output. */
async function listAudioFiles(dir) {
  const found = [];
  const walk = async (current) => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && AUDIO_EXT.has(path.extname(entry.name).toLowerCase())) found.push(full);
    }
  };
  await walk(dir);
  return found.sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

async function probe(file) {
  const { stdout } = await execFileAsync(
    'ffprobe',
    [
      '-v',
      'error',
      '-show_entries',
      'format=duration,bit_rate,size:format_tags=title,artist,album,album_artist,date,genre,TBPM,TKEY,composer,track,disc:stream=codec_name,sample_rate,channels,bit_rate',
      '-of',
      'json',
      file,
    ],
    { maxBuffer: 8 * 1024 * 1024 },
  );
  return JSON.parse(stdout);
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

function mmss(ms) {
  const totalSeconds = Math.round(ms / 1000);
  const mm = Math.floor(totalSeconds / 60);
  const ss = String(totalSeconds % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

/* ────────────────────────── main ────────────────────────── */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourceDir = path.resolve(args.source);
  const outFile = path.resolve(args.out);

  try {
    await stat(sourceDir);
  } catch {
    console.error(`✗ source directory not found: ${sourceDir}`);
    console.error('  Put your MP3s there (or pass --source <dir>) and run again.');
    process.exit(1);
  }

  const files = await listAudioFiles(sourceDir);
  if (files.length === 0) {
    console.error(`✗ no audio files found under ${sourceDir}`);
    process.exit(1);
  }

  console.log(`scanning ${files.length} file(s) under ${sourceDir}\n`);

  const tracks = [];
  let albumMeta = null;

  for (const file of files) {
    const relPath = path.relative(sourceDir, file).split(path.sep).join('/');
    const info = await stat(file);
    const json = await probe(file);
    const format = json.format ?? {};
    const tags = format.tags ?? {};
    const stream = (json.streams ?? [])[0] ?? {};

    const durationMs = Math.round((Number(format.duration) || 0) * 1000);

    const track = {
      id: trackId(relPath, info.size),
      title: tags.title ?? path.basename(file, path.extname(file)),
      artist: tags.artist ?? tags.album_artist ?? 'Unknown artist',
      album: tags.album ?? null,
      albumArtist: tags.album_artist ?? tags.artist ?? null,
      year: num(tags.date) ?? null,
      genre: tags.genre ?? null,
      composer: tags.composer ?? null,
      bpm: num(tags.TBPM),
      musicalKey: tags.TKEY ?? null,
      trackNumber: tags.track ? Number.parseInt(tags.track, 10) || null : null,
      disc: tags.disc ? Number.parseInt(tags.disc, 10) || null : null,
      durationMs,
      bitrate: num(format.bit_rate),
      sampleRate: num(stream.sample_rate),
      channels: num(stream.channels),
      sizeBytes: info.size,
      // public presentation / commerce fields (edited in /admin from M6)
      coverKey: null,
      priceCents: Number(process.env.DEFAULT_PRICE_CENTS ?? 199),
      currency: process.env.CURRENCY ?? 'EUR',
      buyUrl: null,
      tags: [],
      published: true,
      featured: false,
      plays: 0,
      stars: 0,
      addedAt: new Date().toISOString(),
      // ── server-side only: never exposed by any API (see sanitizeTrack in scripts/serve.js) ──
      sourceFile: relPath,
    };

    tracks.push(track);
    albumMeta ??= {
      album: track.album,
      artist: track.artist,
      year: track.year,
      genre: track.genre,
      composer: track.composer,
    };

    console.log(
      `  ${track.id}  ${mmss(durationMs).padStart(6)}  ${String(track.bpm ?? '--').padStart(3)} BPM  ` +
        `${track.artist} — ${track.title}`,
    );
  }

  const totalMs = tracks.reduce((sum, t) => sum + t.durationMs, 0);
  const payload = {
    generatedAt: new Date().toISOString(),
    generator: 'scripts/import-tracks.js',
    album: albumMeta,
    trackCount: tracks.length,
    totalDurationMs: totalMs,
    tracks,
  };

  if (args.dryRun) {
    console.log('\n--dry-run: nothing written');
    return;
  }

  await mkdir(path.dirname(outFile), { recursive: true });
  await writeFile(outFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(
    `\n✓ ${tracks.length} track(s) · ${mmss(totalMs)} total · written to ` +
      `${path.relative(process.cwd(), outFile)}`,
  );
}

main().catch((error) => {
  console.error('✗ import failed:', error.message);
  process.exit(1);
});
