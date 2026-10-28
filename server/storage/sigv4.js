/**
 * AWS Signature Version 4 (header and query-string signing).
 *
 * Hand-rolled on `node:crypto` so the S3 driver adds no dependency to a project whose whole point
 * is a small attack surface. The implementation is validated against the worked example in the
 * AWS documentation ("GET Object" with `Range: bytes=0-9`) in tests/sigv4.test.js.
 *
 * Two S3-specific details, both easy to get wrong:
 *   · the canonical URI is URI-encoded **once** (S3), not twice like other AWS services;
 *   · the payload hash must be the real body hash, `UNSIGNED-PAYLOAD`, or the streaming form —
 *     we always have a file on disk, so a real hash is simplest and strongest.
 */

import { createHash, createHmac } from 'node:crypto';

export const ALGORITHM = 'AWS4-HMAC-SHA256';

const sha256Hex = (value) => createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => createHmac('sha256', key).update(value).digest();

/** `2026-10-28T13:20:00.000Z` → `20261028T132000Z` */
export function amzDate(date = new Date()) {
  return date.toISOString().replace(/[-:]|\.\d{3}/g, '');
}

/** `2026-10-28T13:20:00.000Z` → `20261028` */
export function dateStamp(date = new Date()) {
  return date.toISOString().slice(0, 10).replace(/-/g, '');
}

/** SHA-256 of the request body, as hex — the `x-amz-content-sha256` value. */
export const payloadHash = (body) => sha256Hex(body ?? '');

function encodeRfc3986(value) {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** URI-encode a path once, segment by segment: `/tracks/a b.mp3` → `/tracks/a%20b.mp3`. */
export function encodePath(pathname) {
  return pathname.split('/').map(encodeRfc3986).join('/');
}

/** RFC 3986 query encoding, parameters sorted by name then value. */
export function canonicalQueryString(params = {}) {
  return Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => [encodeRfc3986(key), encodeRfc3986(String(value))])
    .sort(([aKey, aValue], [bKey, bValue]) =>
      aKey === bKey ? (aValue < bValue ? -1 : 1) : aKey < bKey ? -1 : 1,
    )
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}

/** Lower-cased, trimmed, sorted headers plus the matching `signedHeaders` list. */
export function canonicalHeaders(headers) {
  const entries = Object.entries(headers)
    .map(([name, value]) => [name.toLowerCase().trim(), String(value).trim().replace(/\s+/g, ' ')])
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return {
    signedHeaders: entries.map(([name]) => name).join(';'),
    canonical: `${entries.map(([name, value]) => `${name}:${value}`).join('\n')}\n`,
  };
}

/** The intermediate string that is actually signed. */
export function stringToSign({ amzDate: stamp, scope, canonicalRequest }) {
  return [ALGORITHM, stamp, scope, sha256Hex(canonicalRequest)].join('\n');
}

/** Derive the date/region/service scoped signing key. */
export function signingKey(secretAccessKey, stamp, region, service) {
  const kDate = hmac(`AWS4${secretAccessKey}`, stamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

/**
 * Sign a request with the Authorization header.
 * @returns {{ authorization: string, signature: string, canonicalRequest: string, stringToSign: string, amzDate: string, signedHeaders: string }}
 */
export function signRequest({
  method,
  path,
  query = {},
  headers,
  payload = '',
  contentSha256,
  accessKeyId,
  secretAccessKey,
  region,
  service = 's3',
  date = new Date(),
}) {
  const stamp = amzDate(date);
  const shortDate = dateStamp(date);
  const scope = `${shortDate}/${region}/${service}/aws4_request`;

  const withRequired = {
    ...headers,
    'x-amz-date': stamp,
    // `contentSha256` lets a caller stream a large body: hash the file first, then send it.
    'x-amz-content-sha256': contentSha256 ?? payloadHash(payload),
  };

  const { signedHeaders, canonical } = canonicalHeaders(withRequired);
  const canonicalRequest = [
    method.toUpperCase(),
    encodePath(path),
    canonicalQueryString(query),
    canonical,
    signedHeaders,
    withRequired['x-amz-content-sha256'],
  ].join('\n');

  const toSign = stringToSign({ amzDate: stamp, scope, canonicalRequest });
  const signature = createHmac('sha256', signingKey(secretAccessKey, shortDate, region, service))
    .update(toSign)
    .digest('hex');

  return {
    authorization:
      `${ALGORITHM} Credential=${accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    signature,
    canonicalRequest,
    stringToSign: toSign,
    amzDate: stamp,
    signedHeaders,
  };
}

/**
 * Presign a URL (query-string signing) — used only when the s3 driver is configured to redirect
 * instead of proxying. The signature is bound to the expiry.
 */
export function presignUrl({
  method = 'GET',
  url,
  accessKeyId,
  secretAccessKey,
  region,
  service = 's3',
  expiresSeconds = 60,
  extraQuery = {},
  date = new Date(),
}) {
  const target = new URL(url);
  const stamp = amzDate(date);
  const shortDate = dateStamp(date);
  const scope = `${shortDate}/${region}/${service}/aws4_request`;

  const query = {
    ...extraQuery,
    'X-Amz-Algorithm': ALGORITHM,
    'X-Amz-Credential': `${accessKeyId}/${scope}`,
    'X-Amz-Date': stamp,
    'X-Amz-Expires': String(expiresSeconds),
    'X-Amz-SignedHeaders': 'host',
  };

  const canonicalRequest = [
    method.toUpperCase(),
    encodePath(target.pathname),
    canonicalQueryString(query),
    `host:${target.host}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const toSign = stringToSign({ amzDate: stamp, scope, canonicalRequest });
  const signature = createHmac('sha256', signingKey(secretAccessKey, shortDate, region, service))
    .update(toSign)
    .digest('hex');

  target.search = `${canonicalQueryString(query)}&X-Amz-Signature=${signature}`;
  return target.toString();
}
