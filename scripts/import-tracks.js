#!/usr/bin/env node
/**
 * Anomalradio — library import (CLI).
 *
 *   drop MP3s in _data/music  →  npm run import  →  private storage + SQLite + JSON export
 *
 * The pipeline itself lives in `server/importer.js` (so tests can drive it directly); this file is
 * only argument parsing and output.
 *
 *   node scripts/import-tracks.js [--source <dir>] [--out <file>] [--db <file>]
 *                                 [--publish] [--publish-existing] [--normalise] [--metadata-only]
 *                                 [--dry-run] [--prune]
 */

import path from 'node:path';
import process from 'node:process';
import { config } from '../server/config.js';
import { importLibrary, mmss, orphans } from '../server/importer.js';

function parseArgs(argv) {
  const args = {
    source: config.librarySource,
    out: config.libraryExport,
    db: config.dbPath,
    publish: false,
    publishExisting: false,
    normalise: false,
    metadataOnly: false,
    dryRun: false,
    prune: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--source') args.source = path.resolve(argv[++i]);
    else if (flag === '--out') args.out = path.resolve(argv[++i]);
    else if (flag === '--db') args.db = path.resolve(argv[++i]);
    else if (flag === '--publish') args.publish = true;
    else if (flag === '--publish-existing') args.publishExisting = true;
    else if (flag === '--normalise') args.normalise = true;
    else if (flag === '--metadata-only') args.metadataOnly = true;
    else if (flag === '--dry-run') args.dryRun = true;
    else if (flag === '--prune') args.prune = true;
    else if (flag === '--help' || flag === '-h') {
      console.log(
        'usage: node scripts/import-tracks.js [--source <dir>] [--out <file>] [--db <file>] [--publish]\n' +
          '                                    [--publish-existing] [--normalise] [--metadata-only]\n' +
          '                                    [--dry-run] [--prune]',
      );
      process.exit(0);
    } else {
      console.error(`unknown argument: ${flag}`);
      process.exit(2);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

console.log('\n  Anomalradio import');

const result = await importLibrary({
  ...args,
  log: (line) => console.log(`  ${line}`),
}).catch((error) => {
  console.error(`\n✗ import failed: ${error.message}`);
  process.exit(1);
});

for (const track of result.tracks) {
  console.log(
    `  ${track.published ? '●' : '○'} ${track.id}  ${mmss(track.durationMs).padStart(6)}  ` +
      `${String(track.bpm ?? '--').padStart(3)} BPM  ${track.artist} — ${track.title}`,
  );
}

console.log(
  `\n  ✓ ${result.tracks.length} track(s) · ${mmss(result.totalDurationMs)} total · ` +
    `${result.stored} copied to storage · ${result.unchanged} already stored · ` +
    `${result.previews} preview(s) generated`,
);
console.log(`  export ${path.relative(process.cwd(), args.out)}`);
console.log('  ● published   ○ draft (use --publish, or the admin in M6)');

if (args.prune && !args.metadataOnly && !args.dryRun) {
  const missing = orphans(result.tracks.map((track) => track.id));
  if (missing.length > 0) {
    console.log(`\n  ⚠ ${missing.length} database row(s) no longer have a source file:`);
    for (const row of missing) console.log(`      ${row.id}  ${row.title}  (${row.source_path ?? '—'})`);
    console.log('    Nothing was deleted — re-add the file, or unpublish the row in the admin (M6).');
  }
}
console.log('');
