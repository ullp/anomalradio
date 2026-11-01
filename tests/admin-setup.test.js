/**
 * `npm run admin:setup`.
 *
 * The panel is off by default and answers 404 when it is off, which is the right answer to give a
 * stranger — but it meant switching it on was a manual edit of `.env`, easy to get subtly wrong.
 * This is the command that replaces that, so it gets tested like the rest of the surface.
 *
 * Every case writes to a temporary env file: this must never touch a real `.env`.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { ROOT } from './helpers/server.js';

const execFileAsync = promisify(execFile);

let scratch;

const run = (args) =>
  execFileAsync(process.execPath, [path.join(ROOT, 'scripts/admin-setup.js'), ...args], { cwd: ROOT });

const envPath = (name) => path.join(scratch, name);
const read = (name) => readFile(envPath(name), 'utf8');

before(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), 'anomalradio-setup-'));
});

after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe('npm run admin:setup', () => {
  it('seeds a missing env file from .env.example and prints a password', async () => {
    const { stdout } = await run(['--env', envPath('fresh.env')]);
    const password = /password\s+(\S+)/.exec(stdout)[1];
    assert.ok(password.length >= 12, password);

    const written = await read('fresh.env');
    assert.match(written, /^ADMIN_PASSWORD_HASH=scrypt\$/m, 'a real scrypt hash');
    // Seeded from the example, so the rest of the documented configuration comes along too.
    assert.match(written, /^STORAGE_DRIVER=local$/m);
    assert.match(written, /^CHECKOUT_DRIVER=external$/m);
  });

  it('writes a hash the server can verify against', async () => {
    const { stdout } = await run(['--env', envPath('usable.env'), '--password', 'a-known-good-password']);
    const hash = /^ADMIN_PASSWORD_HASH=(\S+)$/m.exec(await read('usable.env'))[1];

    const { verifyPassword } = await import('../server/admin.js');
    assert.equal(verifyPassword('a-known-good-password', hash), true);
    assert.equal(verifyPassword('something else', hash), false);
    assert.match(stdout, /a-known-good-password/);
  });

  it('refuses to replace a hash it did not create', async () => {
    await run(['--env', envPath('existing.env'), '--password', 'the-first-password']);
    const first = await read('existing.env');

    await assert.rejects(
      run(['--env', envPath('existing.env'), '--password', 'a-second-password']),
      (error) => {
        assert.match(error.stderr, /already has an ADMIN_PASSWORD_HASH/);
        return true;
      },
    );
    assert.equal(await read('existing.env'), first, 'the file was changed anyway');
  });

  it('replaces it with --force', async () => {
    await run(['--env', envPath('forced.env'), '--password', 'the-first-password']);
    await run(['--env', envPath('forced.env'), '--force', '--password', 'a-second-password']);

    const { verifyPassword } = await import('../server/admin.js');
    const hash = /^ADMIN_PASSWORD_HASH=(\S+)$/m.exec(await read('forced.env'))[1];
    assert.equal(verifyPassword('a-second-password', hash), true);
    assert.equal(verifyPassword('the-first-password', hash), false);
  });

  it('mints a second factor with --totp', async () => {
    const { stdout } = await run(['--env', envPath('totp.env'), '--totp']);
    const secret = /^ADMIN_TOTP_SECRET=(\S+)$/m.exec(await read('totp.env'))[1];
    assert.match(secret, /^[A-Z2-7]{32}$/);
    assert.match(stdout, /otpauth:\/\/totp\//);
  });

  it('leaves an existing unrelated setting alone', async () => {
    const file = envPath('keep.env');
    await writeFile(file, 'PORT=4321\nADMIN_PASSWORD_HASH=\nSECRET=keep-me\n', 'utf8');
    await run(['--env', file, '--password', 'a-known-good-password']);

    const written = await read('keep.env');
    assert.match(written, /^PORT=4321$/m);
    assert.match(written, /^SECRET=keep-me$/m);
    assert.match(written, /^ADMIN_PASSWORD_HASH=scrypt\$/m);
  });

  it('refuses a password that is too short', async () => {
    await assert.rejects(
      run(['--env', envPath('short.env'), '--password', 'short']),
      (error) => {
        assert.match(error.stderr, /shorter than 12 characters/);
        return true;
      },
    );
  });
});
