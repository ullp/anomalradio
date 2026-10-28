/**
 * Storage abstraction.
 *
 * Everything the app knows about audio lives behind this interface, so moving from the VPS disk to
 * a private bucket is one environment variable — no code change:
 *
 *   STORAGE_DRIVER=local   files under MEDIA_DIR (outside the web root)
 *   STORAGE_DRIVER=s3      any S3-compatible private bucket (R2 / B2 / Wasabi / MinIO / AWS)
 *
 * Keys are driver-agnostic (`tracks/<id>.mp3`) and are the *only* place the real location exists:
 * the API never sees them (see `sanitizeTrack`).
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { config } from '../config.js';
import { createLocalStorage } from './local.js';
import { createS3Storage } from './s3.js';

const CONTENT_TYPES = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
};

export function contentTypeForKey(key) {
  const extension = String(key).slice(String(key).lastIndexOf('.')).toLowerCase();
  return CONTENT_TYPES[extension] ?? 'application/octet-stream';
}

/** Streaming SHA-256 of a file — used for integrity and duplicate detection. */
export function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(filePath)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

let instance = null;

/**
 * The process-wide storage driver.
 * @param {{ driver?: string, storage?: object, overrides?: object }} options
 */
export function createStorage(options = {}) {
  const settings = { ...config.storage, ...options.storage };
  const driver = options.driver ?? settings.driver;

  if (driver === 'local') {
    return createLocalStorage({ directory: settings.directory, contentTypeForKey });
  }
  if (driver === 's3') {
    return createS3Storage({ ...settings, contentTypeForKey });
  }
  throw new Error(`unknown storage driver "${driver}" (expected local or s3)`);
}

export function getStorage() {
  instance ??= createStorage();
  return instance;
}

/** Test helper: forget the cached driver (used when a test swaps configuration). */
export function resetStorage() {
  instance = null;
}
