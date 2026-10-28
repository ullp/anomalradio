/**
 * Configuration.
 *
 * Environment is read **at import time**, so overrides must be applied before importing this
 * module (that is what the test harness does). Everything is validated here rather than at each
 * use site, and production gets hard requirements instead of silent insecure defaults.
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';

export const ROOT = path.resolve(import.meta.dirname, '..');

/** Minimal .env loader — real environment variables always win. */
function loadEnvFile() {
  try {
    const raw = readFileSync(path.join(ROOT, '.env'), 'utf8');
    for (const line of raw.split('\n')) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (!match) continue;
      const [, key, value] = match;
      if (process.env[key] === undefined) process.env[key] = value.trim().replace(/^["']|["']$/g, '');
    }
  } catch {
    /* no .env — defaults apply */
  }
}

loadEnvFile();

const text = (value, fallback = '') => (value === undefined || value === '' ? fallback : String(value));
const int = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const float = (value, fallback) => {
  const parsed = Number.parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : fallback;
};
const bool = (value, fallback = false) => {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
};
const list = (value, fallback = []) =>
  text(value)
    ? String(value)
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    : fallback;

const resolveFromRoot = (value, fallback) => path.resolve(ROOT, text(value, fallback));

const environment = text(process.env.NODE_ENV, 'development');

/**
 * A development secret keeps local runs frictionless; production refuses to start without a real
 * one, because a guessable secret means anyone can mint their own stream tokens.
 */
function resolveSecret() {
  const provided = text(process.env.SECRET);
  if (provided.length >= 32) return { secret: provided, generated: false };
  if (environment === 'production') {
    throw new Error('SECRET must be at least 32 characters in production (see .env.example)');
  }
  return {
    secret: createHash('sha256').update(`anomalradio-dev-secret:${ROOT}`).digest('hex'),
    generated: true,
  };
}

const { secret, generated: secretIsGenerated } = resolveSecret();

export const config = {
  environment,
  isProduction: environment === 'production',
  root: ROOT,
  port: int(process.env.PORT, 3000),
  publicDir: path.join(ROOT, 'public'),
  dataDir: resolveFromRoot(process.env.DATA_DIR, './data'),
  dbPath: resolveFromRoot(process.env.ANOMALRADIO_DB ?? process.env.DB_PATH, './data/anomalradio.db'),

  /** Where you drop new music for `npm run import`. */
  librarySource: resolveFromRoot(process.env.LIBRARY_SOURCE_DIR, './_data/music'),
  /** Human-readable metadata export, written next to the database. */
  libraryExport: resolveFromRoot(process.env.LIBRARY_INDEX, './data/tracks.json'),

  /** Prototype only: speed of the simulated broadcast clock (1 = real time). */
  timeScale: float(process.env.DEMO_TIME_SCALE, 1) || 1,

  /* ── the continuous stream (M3) ── */
  mountPath: text(process.env.MOUNT_PATH, '/radio-128.mp3'),
  streamBitrate: int(process.env.STREAM_BITRATE, 128),
  /** Bytes of audio between ICY metadata blocks — what makes players show the track title. */
  icyMetaInterval: int(process.env.ICY_METAINT, 16384),
  /** A live listener holds one long connection, so its token outlives the per-track one. */
  radioTokenTtlSeconds: int(process.env.RADIO_TOKEN_TTL, 6 * 3600),
  /** A listener more than this far behind is dropped rather than buffered forever. */
  listenerBufferLimitBytes: int(process.env.LISTENER_BUFFER_LIMIT, 1024 * 1024),

  secret,
  secretIsGenerated,
  streamTokenTtlSeconds: int(process.env.STREAM_TOKEN_TTL, 120),
  /** A token may serve this many HTTP requests before it is refused — a ripper signal. */
  maxRequestsPerToken: int(process.env.MAX_REQUESTS_PER_TOKEN, 400),
  maxStreamsPerIp: int(process.env.MAX_STREAMS_PER_IP, 3),
  sessionRateLimit: int(process.env.SESSION_RATE_LIMIT, 60),
  audioRateLimit: int(process.env.AUDIO_RATE_LIMIT, 600),
  /**
   * Honour X-Forwarded-For — but only from a trusted proxy peer (loopback), because the header
   * is attacker-controlled. Set to false to ignore it entirely.
   */
  trustProxy: bool(process.env.TRUST_PROXY, true),

  blockedUserAgents: list(process.env.BLOCKED_USER_AGENTS, [
    'streamripper',
    'ffmpeg',
    'ffprobe',
    'wget',
    'curl',
    'python-requests',
    'yt-dlp',
    'aria2',
    'httrack',
    'idm',
  ]).map((ua) => ua.toLowerCase()),

  allowedOrigins: list(process.env.ALLOWED_ORIGINS, [
    'http://localhost:3000',
    'https://anomalradio.com',
    'https://*.anomalradio.com',
  ]),

  storage: {
    driver: text(process.env.STORAGE_DRIVER, 'local'),
    /** local driver: directory that holds the private masters (outside the web root). */
    directory: resolveFromRoot(process.env.MEDIA_DIR, './media'),
    /** s3 driver: any S3-compatible endpoint (R2, B2, Wasabi, MinIO, AWS). */
    endpoint: text(process.env.S3_ENDPOINT),
    region: text(process.env.S3_REGION, 'auto'),
    bucket: text(process.env.S3_BUCKET),
    accessKeyId: text(process.env.S3_ACCESS_KEY_ID),
    secretAccessKey: text(process.env.S3_SECRET_ACCESS_KEY),
    /** Buckets stay private; proxy mode keeps the bucket hostname out of the browser entirely. */
    proxy: bool(process.env.S3_PROXY, true),
    signedUrlTtlSeconds: int(process.env.S3_SIGNED_URL_TTL, 60),
    /** Path style is what MinIO and most self-hosted gateways expect. */
    forcePathStyle: bool(process.env.S3_FORCE_PATH_STYLE, true),
  },
};

/** Storage keys are driver-agnostic: `<folder>/<id>.<ext>`. */
export const storageKeys = {
  track: (id, extension = 'mp3') => `tracks/${id}.${extension}`,
  streamMaster: (id, extension = 'mp3') => `stream/${id}.${extension}`,
  cover: (id, extension = 'webp') => `covers/${id}.${extension}`,
};

/** Fail fast on configuration that would silently weaken the service. */
export function assertUsableConfig() {
  if (!['local', 's3'].includes(config.storage.driver)) {
    throw new Error(`unknown STORAGE_DRIVER "${config.storage.driver}" (expected local or s3)`);
  }
  if (config.storage.driver === 's3') {
    const missing = ['endpoint', 'bucket', 'accessKeyId', 'secretAccessKey'].filter(
      (key) => !config.storage[key],
    );
    if (missing.length > 0) {
      throw new Error(`STORAGE_DRIVER=s3 requires: ${missing.map((key) => `S3_${key}`).join(', ')}`);
    }
  }
  return true;
}
