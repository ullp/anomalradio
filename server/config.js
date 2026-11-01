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

/**
 * Minimal .env loader — real environment variables always win.
 *
 * `ANOMALRADIO_NO_ENV_FILE=1` skips it entirely, and the test harness sets it. Without that, writing
 * a `.env` on your machine silently changes what the suite is testing: a local ADMIN_PASSWORD_HASH
 * made "the admin is off by default" fail, which is exactly the kind of local-only pass/fail that
 * makes a green CI run meaningless.
 */
function loadEnvFile() {
  if (process.env.ANOMALRADIO_NO_ENV_FILE === '1') return;
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
  /** State-changing endpoints (★, 🛒, ⇪) per minute per IP — generous, but not unlimited. */
  writeRateLimit: int(process.env.WRITE_RATE_LIMIT, 120),
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

  /** Absolute origin used in e-mails and share links (no trailing slash). */
  publicOrigin: text(process.env.PUBLIC_ORIGIN, 'http://localhost:3000').replace(/\/+$/, ''),

  /* ── accounts (M4): magic links, no passwords ── */
  accounts: {
    cookieName: text(process.env.SESSION_COOKIE, 'anomalradio_session'),
    /**
     * The anonymous favourites key. Not HttpOnly on purpose: the client reads it too, and it
     * authorises nothing but its owner's own star list.
     */
    ownerCookieName: text(process.env.OWNER_COOKIE, 'anomalradio_owner'),
    /** A sign-in link is single-use and short-lived: long enough to switch device, short enough to matter. */
    magicLinkTtlSeconds: int(process.env.MAGIC_LINK_TTL, 15 * 60),
    sessionTtlSeconds: int(process.env.SESSION_TTL, 60 * 24 * 3600),
    /** Sign-in requests per IP per minute — the one endpoint an anonymous visitor can make us send mail from. */
    requestRateLimit: int(process.env.MAGIC_LINK_RATE_LIMIT, 5),
    /** Per address, so one IP cannot be used to flood a mailbox either. */
    requestPerEmailLimit: int(process.env.MAGIC_LINK_EMAIL_LIMIT, 3),
  },

  /* ── mail: how a sign-in link leaves the building ── */
  mail: {
    /**
     * console — the link is printed to the journal (development, and a station with no provider yet)
     * http    — POST the message to a transactional API (Resend/Mailgun/Postmark-shaped)
     *
     * There is no SMTP driver on purpose: OCI blocks outbound port 25 on every tenancy, so SMTP
     * from the box would fail in a way that only shows up as "the e-mail never arrived".
     */
    driver: text(process.env.MAIL_DRIVER, 'console'),
    from: text(process.env.MAIL_FROM, 'Anomalradio <no-reply@anomalradio.com>'),
    apiUrl: text(process.env.MAIL_API_URL),
    apiKey: text(process.env.MAIL_API_KEY),
  },

  /* ── per-track preview (M4): a short, deliberately degraded excerpt ── */
  preview: {
    enabled: bool(process.env.PREVIEW_ENABLED, true),
    seconds: int(process.env.PREVIEW_SECONDS, 30),
    /** 96 kbps mono: ~360 KB, good enough to judge a track, useless as a copy of it. */
    bitrate: text(process.env.PREVIEW_BITRATE, '96k'),
    channels: int(process.env.PREVIEW_CHANNELS, 1),
    /** Where the excerpt starts, as a fraction of the track (skips the intro). */
    startRatio: float(process.env.PREVIEW_START_RATIO, 0.25),
    /** Audio previews are public by design (see offer §8.3), so they get their own limiter. */
    rateLimit: int(process.env.PREVIEW_RATE_LIMIT, 120),
  },

  /* ── checkout (M5): where a track's buy action resolves ── */
  checkout: {
    /**
     * external — hand the buyer off to a store we do not run (Payhip, Bandcamp, …). The default:
     *            no card data, no order record, and no VAT registration on our side.
     * stripe   — our own Checkout session plus download tokens. Cheapest per sale, but it makes us
     *            the merchant of record, so it must be opted into explicitly.
     * disabled — no buying at all (the UI says so rather than showing dead buttons).
     */
    driver: text(process.env.CHECKOUT_DRIVER, 'external'),
    /** Button label ("Buy on Payhip"). Empty = derive it from the URL's hostname. */
    storeName: text(process.env.CHECKOUT_STORE_NAME),
    /** Store-wide fallback for tracks with no individual link. Empty = "not for sale yet". */
    externalDefaultUrl: text(process.env.CHECKOUT_EXTERNAL_DEFAULT_URL),
    /** The `id → url` sidecar, written by `npm run buy-links`. */
    buyLinksFile: resolveFromRoot(process.env.BUY_LINKS_FILE, './_data/buy-links.json'),
    currency: text(process.env.CURRENCY, 'EUR'),
    defaultPriceCents: int(process.env.DEFAULT_PRICE_CENTS, 199),
    stripe: {
      secretKey: text(process.env.STRIPE_SECRET_KEY),
      webhookSecret: text(process.env.STRIPE_WEBHOOK_SECRET),
      /** How long a purchased download link stays valid, and how many times it may be used. */
      downloadTtlSeconds: int(process.env.DOWNLOAD_TTL, 72 * 3600),
      maxDownloads: int(process.env.MAX_DOWNLOADS, 3),
    },
  },

  /* ── admin (M6): the station's own control room ── */
  admin: {
    /** Where it lives. Changing this is tidiness, not security — the API is what is gated. */
    path: text(process.env.ADMIN_PATH, '/admin').replace(/\/+$/, ''),
    /** scrypt hash from `npm run admin:passwd`. **Empty means the admin is off entirely.** */
    passwordHash: text(process.env.ADMIN_PASSWORD_HASH),
    /** Optional RFC 6238 secret (base32). Empty = password only, no second factor. */
    totpSecret: text(process.env.ADMIN_TOTP_SECRET),
    /** Optional IP allowlist. Empty = any address. */
    ipAllowlist: list(process.env.ADMIN_IP_ALLOWLIST, []),
    sessionCookie: text(process.env.ADMIN_COOKIE, 'anomalradio_admin'),
    sessionTtlSeconds: int(process.env.ADMIN_SESSION_TTL, 8 * 3600),
    /** Sign-in attempts per IP per minute. */
    loginRateLimit: int(process.env.ADMIN_LOGIN_RATE_LIMIT, 8),
    /** Upload cap, per file. */
    maxUploadBytes: int(process.env.ADMIN_MAX_UPLOAD, 200 * 1024 * 1024),
  },

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
  /** The short public excerpt generated at import — never the master. */
  preview: (id, extension = 'mp3') => `previews/${id}.${extension}`,
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
  if (!['console', 'http', 'memory'].includes(config.mail.driver)) {
    throw new Error(`unknown MAIL_DRIVER "${config.mail.driver}" (expected console, memory or http)`);
  }
  if (config.mail.driver === 'http' && (!config.mail.apiUrl || !config.mail.apiKey)) {
    throw new Error('MAIL_DRIVER=http requires MAIL_API_URL and MAIL_API_KEY');
  }
  // The admin is off unless a usable hash is present, so a deployment cannot expose a control
  // panel by accident — and nothing has to be configured for the station to boot.
  if (
    config.admin.passwordHash &&
    !/^scrypt\$[0-9]+\$[0-9]+\$[0-9]+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/.test(config.admin.passwordHash)
  ) {
    throw new Error('ADMIN_PASSWORD_HASH is not a scrypt hash — generate one with `npm run admin:passwd`');
  }
  if (!config.admin.path.startsWith('/')) {
    throw new Error(`ADMIN_PATH must start with "/" (got "${config.admin.path}")`);
  }

  if (!['external', 'stripe', 'disabled'].includes(config.checkout.driver)) {
    throw new Error(
      `unknown CHECKOUT_DRIVER "${config.checkout.driver}" (expected external, stripe or disabled)`,
    );
  }
  // Stripe is the only mode that makes us the merchant of record, so it must be fully configured
  // before it can be switched on — a half-configured checkout would take money and deliver nothing.
  if (config.checkout.driver === 'stripe') {
    const missing = ['secretKey', 'webhookSecret'].filter((key) => !config.checkout.stripe[key]);
    if (missing.length > 0) {
      const names = missing.map((key) =>
        key === 'secretKey' ? 'STRIPE_SECRET_KEY' : 'STRIPE_WEBHOOK_SECRET',
      );
      throw new Error(`CHECKOUT_DRIVER=stripe requires: ${names.join(', ')}`);
    }
  }
  if (config.isProduction && !config.publicOrigin.startsWith('https://')) {
    // A sign-in link over http is a link anyone on the path can steal.
    throw new Error(`PUBLIC_ORIGIN must be https in production (got "${config.publicOrigin}")`);
  }
  return true;
}
