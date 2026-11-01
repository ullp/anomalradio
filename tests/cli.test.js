/**
 * The CLI entry point.
 *
 * Everything else drives the server in-process through the harness, which means a mistake in the
 * *startup path* — the banner, the signal handlers — is invisible to the entire suite. That happened:
 * `banner()` referenced a variable that existed only inside `createServer`, so `npm start` died with
 * "admin is not defined" while 317 tests passed and CI stayed green. So this boots the real thing as a
 * child process and talks to it over HTTP.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ROOT } from './helpers/server.js';

const PORT = 3399;

let scratch;
let child;
let output = '';

before(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), 'anomalradio-cli-'));
  child = spawn(process.execPath, [path.join(ROOT, 'scripts/serve.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      NODE_ENV: 'production',
      SECRET: 'a'.repeat(64),
      PUBLIC_ORIGIN: 'https://anomalradio.com',
      // Hermetic: a throwaway database and media directory, so this never touches the real ones.
      ANOMALRADIO_DB: path.join(scratch, 'cli.db'),
      MEDIA_DIR: path.join(scratch, 'media'),
      LIBRARY_INDEX: path.join(scratch, 'tracks.json'),
      ADMIN_PASSWORD_HASH: '',
    },
  });
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && !/ANOMALRADIO|could not start/.test(output)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
});

after(async () => {
  child?.kill('SIGTERM');
  await rm(scratch, { recursive: true, force: true });
});

describe('npm start', () => {
  it('boots and prints its banner instead of dying on startup', () => {
    assert.ok(!/could not start/.test(output), output);
    assert.match(output, /ANOMALRADIO/);
    assert.match(output, /admin\s+\/admin/);
  });

  it('answers /healthz', async () => {
    const response = await fetch(`http://127.0.0.1:${PORT}/healthz`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, 'ok');
  });

  it('serves the site', async () => {
    assert.equal((await fetch(`http://127.0.0.1:${PORT}/`)).status, 200);
  });

  it('leaves the admin off when it is not configured', async () => {
    const response = await fetch(`http://127.0.0.1:${PORT}/admin/`, { redirect: 'manual' });
    assert.equal(response.status, 404);
  });

  it('shuts down cleanly on SIGTERM', async () => {
    // If the station died during startup, `once('exit')` would never fire again and this would hang
    // rather than fail — which is exactly how the first version of this test behaved.
    if (child.exitCode !== null || child.signalCode !== null) {
      assert.fail(`the station had already exited (code ${child.exitCode}, signal ${child.signalCode})`);
    }
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    assert.equal(await exited, 0);
  });
});
