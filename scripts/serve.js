#!/usr/bin/env node
/**
 * Anomalradio — development server (CLI).
 *
 * `npm run dev` starts the M2 server: static site + API + token-gated audio, catalogue in SQLite,
 * audio in private storage. The server itself lives in `server/index.js`; this file is the CLI entry
 * point (banner + signal handling) and keeps `node scripts/serve.js` working as documented.
 */

import { banner, closeDatabase, startServer } from '../server/index.js';

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
