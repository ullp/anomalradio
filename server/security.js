/**
 * Request gating (§7.2 and §7.4 of the offer).
 *
 * These are the checks that make the protection real rather than decorative:
 *   · a browser context is required before a token is minted (referer/origin allowlist);
 *   · CLI tools and stream rippers are refused by User-Agent;
 *   · token minting is rate limited per IP;
 *   · audio requests are rate limited per IP and capped in concurrency.
 *
 * Counters live in process memory: correct for a single instance, which is what M2 targets. Running
 * several Node instances behind nginx would make these caps per-instance — see README "Scaling".
 */

import { fingerprint } from './tokens.js';
import { config } from './config.js';

export function createSecurity(overrides = {}) {
  const settings = {
    blockedUserAgents: config.blockedUserAgents,
    allowedOrigins: config.allowedOrigins,
    sessionRateLimit: config.sessionRateLimit,
    audioRateLimit: config.audioRateLimit,
    maxStreamsPerIp: config.maxStreamsPerIp,
    ...overrides,
  };

  const rateBuckets = new Map();
  const activeStreams = new Map();

  /** Real client IP, honouring a proxy's X-Forwarded-For (nginx sits in front in production). */
  function clientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0) return forwarded.split(',')[0].trim();
    return req.socket.remoteAddress ?? 'unknown';
  }

  const ipHash = (req) => fingerprint(clientIp(req));
  const uaHash = (req) => fingerprint(req.headers['user-agent'] ?? '');

  /** Origin/Referer allowlist — this is what blocks hotlinking from other sites. */
  function originAllowed(req) {
    const value = req.headers.origin ?? req.headers.referer;
    if (!value) return false; // no browser context at all (curl, wget, scrapers)

    let hostname;
    try {
      hostname = new URL(value).hostname;
    } catch {
      return false;
    }
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return true;

    return settings.allowedOrigins.some((allowed) => {
      try {
        const pattern = new URL(allowed).hostname;
        const bare = pattern.replace(/^\*\./, '');
        return pattern.startsWith('*.')
          ? hostname === bare || hostname.endsWith(`.${bare}`)
          : hostname === pattern;
      } catch {
        return false;
      }
    });
  }

  /** Stream-ripper / bot User-Agent denylist. A missing UA counts as a bot. */
  function userAgentBlocked(req) {
    const userAgent = String(req.headers['user-agent'] ?? '').toLowerCase();
    if (!userAgent) return true;
    return settings.blockedUserAgents.some((fragment) => userAgent.includes(fragment));
  }

  /** Fixed-window per-minute limiter. */
  function rateLimited(key, limitPerMinute) {
    const now = Date.now();
    const bucket = rateBuckets.get(key);
    if (!bucket || bucket.resetAt < now) {
      rateBuckets.set(key, { count: 1, resetAt: now + 60_000 });
      return false;
    }
    bucket.count += 1;
    return bucket.count > limitPerMinute;
  }

  const sessionRateLimited = (req) => rateLimited(`session:${ipHash(req)}`, settings.sessionRateLimit);
  const audioRateLimited = (req) => rateLimited(`audio:${ipHash(req)}`, settings.audioRateLimit);

  /* ── per-IP concurrent streams ── */

  function streamSlotAvailable(req) {
    return (activeStreams.get(ipHash(req)) ?? 0) < settings.maxStreamsPerIp;
  }

  /**
   * Take a slot. Call this *before* any await: checking and acquiring separately lets parallel
   * requests all pass the check and overshoot the cap.
   * @returns {() => void} release
   */
  function acquireStream(req) {
    const key = ipHash(req);
    activeStreams.set(key, (activeStreams.get(key) ?? 0) + 1);
    return () => activeStreams.set(key, Math.max(0, (activeStreams.get(key) ?? 1) - 1));
  }

  const activeStreamCount = (req) => activeStreams.get(ipHash(req)) ?? 0;

  return {
    clientIp,
    ipHash,
    uaHash,
    originAllowed,
    userAgentBlocked,
    rateLimited,
    sessionRateLimited,
    audioRateLimited,
    streamSlotAvailable,
    acquireStream,
    activeStreamCount,
    limits: settings,
  };
}
