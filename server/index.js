/**
 * Anomalradio server (M2).
 *
 * One process: static site + API + protected audio streaming, with the catalogue in SQLite and the
 * audio in private storage (this machine's disk, or an S3-compatible bucket).
 *
 * The prototype's public API contract is unchanged, which is what the frontend and the whole test
 * suite were written against — see README "Testing".
 */

import { createServer as createHttpServer } from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { assertUsableConfig, config } from './config.js';
import { closeDatabase, openDatabase } from './db.js';
import { broadcastState, sanitizeTrack } from './library.js';
import { createRadio } from './radio.js';
import { createRouter } from './routes.js';
import { createSecurity } from './security.js';
import { createStorage } from './storage/index.js';
import { createTokenService } from './tokens.js';
import { createAccounts } from './accounts.js';

export function createServer(overrides = {}) {
  assertUsableConfig();

  const database = overrides.database ?? openDatabase();
  const storage = overrides.storage ?? createStorage();
  const tokens = overrides.tokens ?? createTokenService();
  const security = overrides.security ?? createSecurity();
  // The continuous mount. Started below; it only reads audio once a listener is connected.
  const radio = overrides.radio ?? createRadio({ storage });
  // Accounts (M4): magic links, sessions, and the owner key that ties stars to a caller.
  const accounts = overrides.accounts ?? createAccounts();
  const router = createRouter({ security, tokens, storage, radio, accounts });

  const server = createHttpServer((req, res) => {
    const origin = `http://${req.headers.host ?? `localhost:${config.port}`}`;
    Promise.resolve(router.handle(req, res, origin)).catch((error) => {
      console.error(`✗ ${req.method} ${req.url} → ${error.message}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end('{"error":"internal-error"}\n');
      } else {
        res.destroy();
      }
    });
  });

  server.on('close', () => {
    radio.stop();
    router.close();
  });

  return Object.assign(server, {
    anomalradio: { storage, tokens, security, router, radio, database, accounts },
  });
}

/** Start listening. `port: 0` asks the OS for a free port — what the tests use. */
export async function startServer({ port = config.port, host, ...overrides } = {}) {
  const server = createServer(overrides);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  server.anomalradio.radio.start();
  return server;
}

export function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

/** Startup banner for the CLI. */
export function banner(server) {
  const { port } = server.address();
  const state = broadcastState();
  const storage = server.anomalradio.storage.describe();
  const lines = [
    '',
    '  ANOMALRADIO · M3 (continuous stream)',
    '  ─────────────────────────────────────────────',
    `  local       http://localhost:${port}/`,
    `  storage     ${storage.driver}${storage.directory ? ` (${path.relative(config.root, storage.directory)})` : ''}`,
    `  database    ${path.relative(config.root, config.dbPath)}`,
    `  secret      ${config.secretIsGenerated ? 'generated for development' : 'from environment'}`,
    `  tokens      ${config.streamTokenTtlSeconds}s TTL · max ${config.maxRequestsPerToken} requests each`,
    `  clock       ×${config.timeScale}${config.timeScale === 1 ? ' (real time)' : ''}`,
    `  mount       ${config.mountPath} · ${config.streamBitrate} kbps nominal · ICY every ${config.icyMetaInterval} B`,
    `  station     /radio.pls and /radio.m3u for VLC/foobar`,
    `  accounts    magic links · mail via ${config.mail.driver}${config.mail.driver === 'console' ? ' (links go to this journal)' : ''}`,
  ];
  if (state) {
    lines.push(`  on air now  ${state.now.track.artist} — ${state.now.track.title}`);
    lines.push(`  next        ${state.next?.track.title ?? '—'}`);
    lines.push(`  listeners   ${server.anomalradio.radio.listenerCount()} connected right now`);
  } else {
    lines.push('  ⚠ no published tracks — run `npm run import --publish`');
  }
  lines.push('');
  console.log(lines.join('\n'));
}

/** Test surface: everything the suites reach into. */
export { config, sanitizeTrack, broadcastState, createSecurity, createTokenService, createRadio };
export { closeDatabase };
export { getMailer } from './mail.js';

/* ─────────────────────────── CLI entry point ─────────────────────────── */

const isMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.join(import.meta.dirname, 'index.js');

if (isMain) {
  try {
    const server = await startServer();
    banner(server);

    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.on(signal, () => {
        console.log('\n  shutting down');
        server.close(() => {
          closeDatabase();
          process.exit(0);
        });
      });
    }
  } catch (error) {
    console.error(`\n✗ could not start: ${error.message}\n`);
    process.exit(1);
  }
}
