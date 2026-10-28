/**
 * HTTP plumbing: responses, security headers, static files and range parsing.
 *
 * Deliberately small and dependency-free. The header set is the same one the prototype was verified
 * with (strict CSP, no framing, no sniffing, no inline anything).
 */

import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Content-Security-Policy': [
    "default-src 'self'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "style-src 'self'",
    "script-src 'self'",
    "connect-src 'self'",
    "font-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
};

export function sendJson(res, status, body, extraHeaders = {}) {
  const payload = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'Content-Type': MIME['.json'],
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex, nofollow',
    ...extraHeaders,
  });
  res.end(payload);
}

export function sendText(res, status, text, contentType = MIME['.txt']) {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

export function sendHtml(res, status, html, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': MIME['.html'],
    'Content-Length': Buffer.byteLength(html),
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
    ...extraHeaders,
  });
  res.end(html);
}

/**
 * Read a small JSON body. A larger one is refused rather than buffered, so an unauthenticated
 * endpoint cannot be used to make the process hold memory.
 */
export async function readJson(req, { limit = 16 * 1024 } = {}) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('body-too-large');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('invalid-json');
  }
}

/**
 * Parse a `Range` header.
 * @returns {{ start: number, end: number } | 'unsatisfiable' | null} `null` = no range requested
 */
export function parseRange(header, size) {
  if (!header || typeof header !== 'string') return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;

  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;

  if (Number.isNaN(start) || start > end || start >= size) return 'unsatisfiable';
  return { start, end };
}

/** Files that must never be served from the web root, whatever the path says. */
const NEVER_SERVE = /\.(mp3|m4a|flac|wav|aac|ogg|opus|db|sqlite|sqlite3)$/i;

/**
 * Serve a file from `publicDir`.
 * `transform` lets the caller rewrite HTML on the way out (used for per-track meta tags).
 * @returns {Promise<true|null>} `true` when the response was sent, `null` when the file is missing
 *   (so the caller can render a 404 instead of writing headers twice).
 */
export async function serveStatic(req, res, { publicDir, pathname, transform = null }) {
  let relative;
  try {
    relative = decodeURIComponent(pathname);
  } catch {
    sendText(res, 400, 'bad request');
    return true;
  }
  if (relative.includes('..') || relative.includes('\0')) {
    sendText(res, 404, 'not found');
    return true;
  }

  if (relative === '/') relative = '/index.html';
  if (relative.endsWith('/')) relative += 'index.html';

  const filePath = path.join(publicDir, relative);
  if (!filePath.startsWith(publicDir)) {
    sendText(res, 404, 'not found');
    return true;
  }
  if (NEVER_SERVE.test(filePath)) {
    sendText(res, 404, 'not found');
    return true;
  }

  let info;
  try {
    info = await stat(filePath);
  } catch {
    return null; // caller decides how to render a 404 page
  }
  if (!info.isFile()) return null;

  const extension = path.extname(filePath).toLowerCase();

  if (extension === '.html' && transform) {
    sendHtml(res, 200, transform(await readFile(filePath, 'utf8'), relative));
    return true;
  }

  res.writeHead(200, {
    'Content-Type': MIME[extension] ?? 'application/octet-stream',
    'Content-Length': info.size,
    // Prototype/dev: never cache, so edits show up immediately. M7 serves hashed assets instead.
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
  });
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }

  createReadStream(filePath)
    .on('error', () => res.destroy())
    .pipe(res);
  return true;
}

/** The styled 404 page, when it exists. */
export async function notFound(req, res, publicDir) {
  try {
    const page = await readFile(path.join(publicDir, '404.html'));
    return sendHtml(res, 404, page.toString('utf8'));
  } catch {
    return sendText(res, 404, 'not found');
  }
}
