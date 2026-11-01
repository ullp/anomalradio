/**
 * Buy links.
 *
 * `_data/buy-links.json` is the operator's source of truth for "where can this track be bought",
 * keyed by track id:
 *
 *   { "ar_Kt0j2bAUde": "https://dwp.payhip.com/b/come" }
 *
 * `npm run buy-links` validates the file and writes it into `tracks.buy_url`, which is what the
 * server actually reads at request time. The file stays the input — reviewable, diffable, hand
 * editable — and the database stays the runtime store. Same split as `_data/music` → `npm run
 * import`, and for the same reason: no file parsing on the hot path.
 *
 * Validation happens *before* any write, so a file with one bad URL changes nothing at all.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { isSafeBuyUrl } from './checkout.js';
import { all, run } from './db.js';

/** Read the sidecar. A missing file is not an error — it means "nothing is for sale yet". */
export function readBuyLinks(file = config.checkout.buyLinksFile) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }

  const parsed = JSON.parse(raw);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path.basename(file)} must be a JSON object of { "trackId": "https://…" }`);
  }
  return parsed;
}

/**
 * Validate the whole map. Never throws, so the CLI can print every problem at once instead of one
 * per run — and so a single typo cannot abort a bulk edit halfway through.
 */
export function validateBuyLinks(map) {
  const errors = [];
  const links = {};

  for (const [id, value] of Object.entries(map)) {
    if (typeof value !== 'string') {
      errors.push(`${id}: expected a string URL, got ${value === null ? 'null' : typeof value}`);
      continue;
    }
    if (!isSafeBuyUrl(value)) {
      errors.push(`${id}: "${value}" is not an allowed https URL`);
      continue;
    }
    links[id] = value;
  }

  return { ok: errors.length === 0, errors, links };
}

/** Ids in the map that are not in the catalogue. A warning, not a failure — the file may be ahead. */
export function unknownIds(links) {
  const known = new Set(all('SELECT id FROM tracks').map((row) => row.id));
  return Object.keys(links).filter((id) => !known.has(id));
}

/**
 * Write validated links into `tracks.buy_url`. Ids absent from the map are left alone; pass
 * `{ clear: true }` to unset links that are no longer listed (i.e. make the file authoritative).
 */
export function applyBuyLinks(links, { clear = false } = {}) {
  const now = new Date().toISOString();
  const updated = [];

  for (const [id, url] of Object.entries(links)) {
    const changes = run('UPDATE tracks SET buy_url = ?, updated_at = ? WHERE id = ?', url, now, id).changes;
    if (changes > 0) updated.push(id);
  }

  let cleared = 0;
  if (clear) {
    const ids = Object.keys(links);
    const placeholders = ids.map(() => '?').join(', ');
    cleared = run(
      ids.length
        ? `UPDATE tracks SET buy_url = NULL, updated_at = ? WHERE buy_url IS NOT NULL AND id NOT IN (${placeholders})`
        : 'UPDATE tracks SET buy_url = NULL, updated_at = ? WHERE buy_url IS NOT NULL',
      now,
      ...ids,
    ).changes;
  }

  return { updated, cleared };
}

/** Set one link. Refuses anything `isSafeBuyUrl()` rejects; `null` clears it. */
export function setBuyLink(trackId, url) {
  if (url !== null && !isSafeBuyUrl(url)) {
    throw new Error(`refusing to store an unsafe URL: ${String(url)}`);
  }
  const changes = run(
    'UPDATE tracks SET buy_url = ?, updated_at = ? WHERE id = ?',
    url,
    new Date().toISOString(),
    trackId,
  ).changes;
  return changes > 0;
}

/** Current links, for `--list` and for writing the sidecar back out. */
export function currentBuyLinks() {
  return Object.fromEntries(
    all('SELECT id, buy_url FROM tracks WHERE buy_url IS NOT NULL ORDER BY id').map((row) => [
      row.id,
      row.buy_url,
    ]),
  );
}

/** Write the sidecar back out, sorted, so `--list > file` produces a stable diff. */
export function writeBuyLinks(links, file = config.checkout.buyLinksFile) {
  const sorted = Object.fromEntries(Object.entries(links).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(file, `${JSON.stringify(sorted, null, 2)}\n`, 'utf8');
  return file;
}
