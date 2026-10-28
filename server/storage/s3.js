/**
 * S3 storage driver — private objects in any S3-compatible bucket.
 *
 * Two delivery modes, chosen with `S3_PROXY`:
 *   proxy (default) — the server streams the object through itself, so the bucket hostname never
 *                     reaches the browser and the existing token gate stays the single door for
 *                     audio;
 *   redirect        — the server answers 302 with a short-lived presigned URL: cheaper on app
 *                     bandwidth, but it exposes the bucket host to the client.
 *
 * Bodies are streamed with a precomputed SHA-256 (`contentSha256`): correct SigV4, and cheap
 * because the importer already hashes every file.
 */

import { createReadStream } from 'node:fs';
import { stat as statFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { hashFile } from './index.js';
import { payloadHash, presignUrl, signRequest } from './sigv4.js';

const EMPTY_SHA256 = payloadHash('');

export function createS3Storage({
  endpoint,
  region,
  bucket,
  accessKeyId,
  secretAccessKey,
  forcePathStyle = true,
  proxy = true,
  signedUrlTtlSeconds = 60,
  contentTypeForKey,
}) {
  const base = new URL(endpoint);
  const host = forcePathStyle ? base.host : `${bucket}.${base.host}`;
  const prefix = base.pathname.replace(/\/+$/, '');

  /** The *unencoded* path used for signing: SigV4 for S3 encodes the path exactly once. */
  const canonicalPath = (key) => (forcePathStyle ? `${prefix}/${bucket}/${key}` : `${prefix}/${key}`);
  const requestUrl = (key) =>
    `${base.protocol}//${host}${canonicalPath(key).split('/').map(encodeURIComponent).join('/')}`;

  /** Sign one request and return the headers it needs. */
  const sign = (method, key, { extraHeaders = {}, payload = '', contentSha256, query = {} } = {}) => {
    const signed = signRequest({
      method,
      path: canonicalPath(key),
      query,
      headers: { host, ...extraHeaders },
      payload,
      contentSha256,
      accessKeyId,
      secretAccessKey,
      region,
    });
    return {
      amzDate: signed.amzDate,
      authorization: signed.authorization,
      contentSha256: contentSha256 ?? payloadHash(payload),
      signature: signed.signature,
      signedHeaders: signed.signedHeaders,
    };
  };

  return {
    driver: 's3',

    describe: () => ({
      driver: 's3',
      endpoint: base.origin,
      bucket,
      region,
      mode: proxy ? 'proxy' : 'redirect',
    }),

    async put(key, sourcePath) {
      const info = await statFile(sourcePath);
      const contentSha256 = await hashFile(sourcePath);
      const contentType = contentTypeForKey(key);
      const signed = sign('PUT', key, {
        extraHeaders: { 'content-length': String(info.size), 'content-type': contentType },
        contentSha256,
      });

      const response = await fetch(requestUrl(key), {
        method: 'PUT',
        headers: {
          'content-type': contentType,
          'content-length': String(info.size),
          'x-amz-date': signed.amzDate,
          'x-amz-content-sha256': contentSha256,
          authorization: signed.authorization,
        },
        body: Readable.toWeb(createReadStream(sourcePath)),
        duplex: 'half',
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`s3 put failed (${response.status}): ${detail.slice(0, 200)}`);
      }
      await response.body?.cancel();
      return { key, size: info.size, contentSha256 };
    },

    async exists(key) {
      return (await this.stat(key)) !== null;
    },

    /** `null` when the object is missing. */
    async stat(key) {
      const signed = sign('HEAD', key, { payload: '' });
      const response = await fetch(requestUrl(key), {
        method: 'HEAD',
        headers: {
          'x-amz-date': signed.amzDate,
          'x-amz-content-sha256': EMPTY_SHA256,
          authorization: signed.authorization,
        },
      });

      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`s3 head failed (${response.status})`);

      return {
        size: Number(response.headers.get('content-length') ?? 0),
        contentType: response.headers.get('content-type') ?? contentTypeForKey(key),
        modifiedAt: response.headers.get('last-modified') ?? null,
      };
    },

    /** Node Readable for the whole object or a byte range — what the HTTP layer pipes out. */
    async createReadStream(key, { start, end } = {}) {
      const hasRange = Number.isInteger(start) || Number.isInteger(end);
      const range = hasRange
        ? `bytes=${Number.isInteger(start) ? start : 0}-${Number.isInteger(end) ? end : ''}`
        : null;
      const signed = sign('GET', key, { extraHeaders: range ? { range } : {}, payload: '' });

      const response = await fetch(requestUrl(key), {
        headers: {
          ...(range ? { range } : {}),
          'x-amz-date': signed.amzDate,
          'x-amz-content-sha256': EMPTY_SHA256,
          authorization: signed.authorization,
        },
      });

      if (!response.ok) throw new Error(`s3 get failed (${response.status})`);
      return Readable.fromWeb(response.body);
    },

    async delete(key) {
      const signed = sign('DELETE', key, { payload: '' });
      const response = await fetch(requestUrl(key), {
        method: 'DELETE',
        headers: {
          'x-amz-date': signed.amzDate,
          'x-amz-content-sha256': EMPTY_SHA256,
          authorization: signed.authorization,
        },
      });
      await response.body?.cancel();
      if (!response.ok && response.status !== 404) {
        throw new Error(`s3 delete failed (${response.status})`);
      }
    },

    /** Only meaningful in redirect mode; `null` when proxying through the app. */
    signedUrl(key, { ttlSeconds = signedUrlTtlSeconds, responseContentDisposition = 'inline' } = {}) {
      if (proxy) return null;
      return presignUrl({
        url: requestUrl(key),
        accessKeyId,
        secretAccessKey,
        region,
        expiresSeconds: ttlSeconds,
        extraQuery: { 'response-content-disposition': responseContentDisposition },
      });
    },
  };
}
