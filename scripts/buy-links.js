#!/usr/bin/env node
/**
 * Anomalradio — buy links (CLI).
 *
 *   _data/buy-links.json  →  npm run buy-links  →  tracks.buy_url
 *
 * The pipeline lives in `server/buy-links.js` (so tests can drive it directly); this file is only
 * argument parsing and output.
 *
 *   node scripts/buy-links.js [--file <file>] [--db <file>] [--clear] [--list] [--dry-run]
 *                             [--set <trackId>=<url>]
 *
 * Nothing is written until the whole file validates, so one typo cannot half-apply a bulk edit.
 */

import path from 'node:path';
import process from 'node:process';
import { config } from '../server/config.js';

function usage() {
  console.log(
    'usage: node scripts/buy-links.js [--file <file>] [--db <file>] [--clear] [--list]\n' +
      '                               [--dry-run] [--set <trackId>=<url>]\n\n' +
      '  --file <file>   the id → url sidecar (default _data/buy-links.json)\n' +
      '  --db <file>     database to write into (default data/anomalradio.db)\n' +
      '  --clear         unset links no longer listed in the file\n' +
      '  --list          print the current links as JSON and exit (writes nothing)\n' +
      '  --dry-run       validate and report, but do not write\n' +
      '  --check         fetch every saved link and report the ones that are dead\n' +
      '  --set k=v       set a single link without touching the file',
  );
}

function parseArgs(argv) {
  const args = {
    file: config.checkout.buyLinksFile,
    db: config.dbPath,
    clear: false,
    list: false,
    dryRun: false,
    set: null,
    check: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--file') args.file = path.resolve(argv[++i]);
    else if (flag === '--db') args.db = path.resolve(argv[++i]);
    else if (flag === '--clear') args.clear = true;
    else if (flag === '--list') args.list = true;
    else if (flag === '--dry-run') args.dryRun = true;
    else if (flag === '--check') args.check = true;
    else if (flag === '--set') args.set = argv[++i];
    else if (flag === '--help' || flag === '-h') {
      usage();
      process.exit(0);
    } else {
      console.error(`unknown flag "${flag}"\n`);
      usage();
      process.exit(2);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

const { openDatabase } = await import('../server/db.js');
const {
  applyBuyLinks,
  checkBuyUrlReachable,
  currentBuyLinks,
  readBuyLinks,
  setBuyLink,
  unknownIds,
  validateBuyLinks,
} = await import('../server/buy-links.js');
const { storeLabel } = await import('../server/checkout.js');

openDatabase(args.db);

// `--list` is a read: no file needed, nothing written.
if (args.list) {
  process.stdout.write(`${JSON.stringify(currentBuyLinks(), null, 2)}\n`);
  process.exit(0);
}

// `--check` fetches every saved link. A dead buy button is easy to ship and embarrassing to find
// later — this is the check that would have caught an example URL being treated as a real store.
if (args.check) {
  const entries = Object.entries(currentBuyLinks());
  if (entries.length === 0) {
    console.log('no buy links saved yet — nothing to check.');
    process.exit(0);
  }
  let dead = 0;
  let unverified = 0;
  for (const [id, url] of entries) {
    const verdict = await checkBuyUrlReachable(url);
    if (verdict.reachable) {
      console.log(`✓ ${id}  ${url}  → ${verdict.status}`);
    } else if (verdict.reason === 'not-found') {
      dead += 1;
      console.log(`✗ ${id}  ${url}  → ${verdict.status}, not found`);
    } else {
      // A server-side check is refused by some hosts whether or not the page exists — Payhip answers
      // 403 even for its own homepage — so this is "could not tell", not "broken".
      unverified += 1;
      console.log(`? ${id}  ${url}  → ${verdict.status ?? verdict.error}, could not verify from here`);
    }
  }
  console.log(`
${entries.length} link(s) checked: ${dead} not found, ${unverified} unverifiable.`);
  process.exit(dead > 0 ? 1 : 0);
}

// `--set id=url` is a single edit; the file is not consulted.
if (args.set) {
  const separator = args.set.indexOf('=');
  if (separator < 1) {
    console.error('✗ --set expects <trackId>=<url>');
    process.exit(2);
  }
  const id = args.set.slice(0, separator);
  const raw = args.set.slice(separator + 1);
  const url = raw === '' || raw === 'none' ? null : raw;

  if (args.dryRun) {
    console.log(`would set ${id} → ${url ?? '(cleared)'}`);
    process.exit(0);
  }
  try {
    const ok = setBuyLink(id, url);
    console.log(ok ? `✓ ${id} → ${url ?? '(cleared)'}` : `✗ no track with id ${id}`);
    process.exit(ok ? 0 : 1);
  } catch (error) {
    console.error(`✗ ${error.message}`);
    process.exit(1);
  }
}

let map;
try {
  map = readBuyLinks(args.file);
} catch (error) {
  console.error(`✗ ${error.message}`);
  process.exit(1);
}

const ids = Object.keys(map);
if (ids.length === 0) {
  console.log(`no buy links in ${path.relative(process.cwd(), args.file)} — nothing is for sale yet.`);
  console.log('Add entries as { "trackId": "https://store.example/track" } and run this again.');
  process.exit(0);
}

const { ok, errors, links } = validateBuyLinks(map);
if (!ok) {
  console.error(`✗ ${errors.length} problem(s) in ${path.relative(process.cwd(), args.file)}:`);
  for (const error of errors) console.error(`    ${error}`);
  console.error('\nnothing was written.');
  process.exit(1);
}

const strays = unknownIds(links);
for (const id of strays) console.warn(`! ${id} is not in the catalogue — skipped`);

const applicable = Object.fromEntries(Object.entries(links).filter(([id]) => !strays.includes(id)));

if (args.dryRun) {
  console.log(`${Object.keys(applicable).length} link(s) valid — dry run, nothing written.`);
  for (const [id, url] of Object.entries(applicable)) console.log(`    ${id} → ${url}`);
  process.exit(0);
}

const { updated, cleared } = applyBuyLinks(applicable, { clear: args.clear });

console.log('Anomalradio — buy links');
console.log(`  file        ${path.relative(process.cwd(), args.file)}`);
console.log(`  database    ${path.relative(process.cwd(), args.db)}`);
console.log(`  applied     ${updated.length} link(s)`);
if (args.clear) console.log(`  cleared     ${cleared} link(s) no longer listed`);

// Group by store so the summary reads like a shop rather than a table of ids.
const byStore = new Map();
for (const url of Object.values(applicable)) {
  const store = storeLabel(url);
  byStore.set(store, (byStore.get(store) ?? 0) + 1);
}
for (const [store, count] of byStore) console.log(`  ${store.padEnd(11)} ${count} track(s)`);

console.log('\nRun `npm run build:static` to refresh the snapshot the static host serves.');
