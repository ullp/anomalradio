#!/usr/bin/env node
/**
 * Anomalradio — turn the admin on (CLI).
 *
 *   npm run admin:setup                 → generate a password, write .env, print it
 *   npm run admin:setup -- --totp       → also mint a second factor
 *   npm run admin:setup -- --force      → replace an existing hash
 *
 * Exists because the panel is off by default and answers 404 when it is off — deliberately, since
 * "there is no such path" is a better answer than "there is a panel here". The cost of that choice is
 * that switching it on was a manual edit of `.env`, which is exactly the kind of thing that is easy
 * to get subtly wrong. This does it in one step and says what it did.
 *
 * It never overwrites a hash it did not create unless you ask with `--force`, and it never touches a
 * `.env` outside the repository unless `--env` says so.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { ROOT } from '../server/config.js';
import { generateTotpSecret, hashPassword } from '../server/admin.js';

function usage() {
  console.log(
    [
      'usage: node scripts/admin-setup.js [--password <pw>] [--totp] [--force] [--env <file>]',
      '',
      '  --password <pw>   use this password instead of generating one',
      '  --totp            also mint a TOTP secret for an authenticator app',
      '  --force           replace an existing ADMIN_PASSWORD_HASH',
      '  --env <file>      which env file to write (default .env)',
    ].join('\n'),
  );
}

function parseArgs(argv) {
  const args = { password: null, totp: false, force: false, env: path.join(ROOT, '.env') };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--password') args.password = argv[++i];
    else if (flag === '--totp') args.totp = true;
    else if (flag === '--force') args.force = true;
    else if (flag === '--env') args.env = path.resolve(argv[++i]);
    else if (flag === '--help' || flag === '-h') {
      usage();
      process.exit(0);
    } else {
      console.error(`unknown flag "${flag}"\n`);
      usage();
      process.exit(2);
    }
  }
  return args;
}

/** A readable passphrase — this is a local development convenience, and it gets printed. */
const generatePassword = () => `anomalradio-${randomBytes(6).toString('hex')}`;

/** Replace a `KEY=` line in place, or append it. */
function setLine(text, key, value) {
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  if (pattern.test(text)) return text.replace(pattern, `${key}=${value}`);
  return `${text.replace(/\n?$/, '\n')}${key}=${value}\n`;
}

const args = parseArgs(process.argv.slice(2));

if (args.password !== null && args.password.length < 12) {
  console.error('✗ that password is shorter than 12 characters — the panel is internet-facing');
  process.exit(1);
}

// ── read or seed the env file ──
let text;
let seeded = false;
if (existsSync(args.env)) {
  text = readFileSync(args.env, 'utf8');
} else {
  const example = path.join(ROOT, '.env.example');
  if (!existsSync(example)) {
    console.error(`✗ ${args.env} does not exist and .env.example is missing, so there is nothing to copy`);
    process.exit(1);
  }
  text = readFileSync(example, 'utf8');
  seeded = true;
}

// ── refuse to clobber a hash somebody else set ──
const existing = /^ADMIN_PASSWORD_HASH=(.+)$/m.exec(text)?.[1]?.trim();
if (existing && !args.force) {
  console.error(`✗ ${path.relative(ROOT, args.env)} already has an ADMIN_PASSWORD_HASH.`);
  console.error('  Pass --force to replace it, or use `npm run admin:passwd -- --check <hash>` to test it.');
  process.exit(1);
}

// ── write it ──
const password = args.password ?? generatePassword();
const totpSecret = args.totp ? generateTotpSecret() : null;

text = setLine(text, 'ADMIN_PASSWORD_HASH', hashPassword(password));
if (totpSecret) text = setLine(text, 'ADMIN_TOTP_SECRET', totpSecret);
writeFileSync(args.env, text, 'utf8');

console.log('Anomalradio — admin enabled');
console.log('─────────────────────────────────────────────');
console.log(`  file      ${path.relative(ROOT, args.env)}${seeded ? ' (created from .env.example)' : ''}`);
console.log(`  password  ${password}`);
if (totpSecret) {
  console.log(`  totp      ${totpSecret}`);
  console.log(
    `  otpauth   otpauth://totp/anomalradio?secret=${totpSecret}&issuer=anomalradio&algorithm=SHA1&digits=6&period=30`,
  );
} else {
  console.log('  totp      not set — add one with `npm run admin:setup -- --force --totp`');
}
console.log('');
console.log('Restart the station, then open http://localhost:3000/admin/');
console.log('If the port is behind nginx, remember to allow the path through the firewall too.');
