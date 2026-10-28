/**
 * Local storage driver — private files on this machine.
 *
 * The directory is deliberately *outside* the web root (`media/`, git-ignored), and every key is
 * resolved and re-checked against that root, so a crafted key can never walk out of it.
 */

import { createReadStream } from 'node:fs';
import { access, copyFile, mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

export function createLocalStorage({ directory, contentTypeForKey }) {
  const root = path.resolve(directory);

  /**
   * Resolve a key to an absolute path.
   * Keys we generate are always relative (`tracks/<id>.mp3`), so anything absolute or containing
   * `..` is refused loudly: silently rebasing such a key would hide a bug or an attack.
   */
  function resolveKey(key) {
    const value = String(key ?? '').trim();
    if (!value) throw new Error('storage key rejected: empty key');
    if (value.startsWith('/') || value.startsWith('\\')) {
      throw new Error(`storage key rejected: absolute paths are not allowed (${key})`);
    }
    if (value.split(/[\\/]+/).includes('..')) {
      throw new Error(`storage key rejected: escapes the media directory (${key})`);
    }
    const full = path.resolve(root, value);
    if (!full.startsWith(`${root}${path.sep}`)) {
      throw new Error(`storage key rejected: escapes the media directory (${key})`);
    }
    return full;
  }

  return {
    driver: 'local',

    describe: () => ({ driver: 'local', directory: root }),

    /** Copy a file in (never moves it: the import source stays untouched). */
    async put(key, sourcePath) {
      const target = resolveKey(key);
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(sourcePath, target);
      const info = await stat(target);
      return { key, size: info.size };
    },

    async exists(key) {
      const target = resolveKey(key); // illegal keys throw loudly rather than reading as "missing"
      try {
        await access(target);
        return true;
      } catch {
        return false;
      }
    },

    /** `null` when the object is missing, so callers can treat it as "not stored yet". */
    async stat(key) {
      const target = resolveKey(key);
      try {
        const info = await stat(target);
        return { size: info.size, contentType: contentTypeForKey(key), modifiedAt: info.mtime.toISOString() };
      } catch {
        return null;
      }
    },

    /** Node Readable, optionally a byte range — the same shape the HTTP layer pipes out. */
    async createReadStream(key, { start, end } = {}) {
      return createReadStream(resolveKey(key), {
        ...(Number.isInteger(start) ? { start } : {}),
        ...(Number.isInteger(end) ? { end } : {}),
      });
    },

    async delete(key) {
      await rm(resolveKey(key), { force: true });
    },
  };
}
