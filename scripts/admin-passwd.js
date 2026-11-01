#!/usr/bin/env node
/**
 * Anomalradio — admin credentials (CLI).
 *
 *   npm run admin:passwd -- --password '…'        → ADMIN_PASSWORD_HASH=scrypt$…
 *   npm run admin:passwd -- --password '…' --totp → also mints a TOTP secret
 *   npm run admin:passwd -- --totp-only           → just a TOTP secret
 *   npm run admin:passwd -- --check '<hash>' --password '…'   → verify a hash
 *
 * The hashing lives in `server/admin.js`; this file is argument parsing and output, so the same
 * code path is what the server verifies against.
 *
 * Reading the password from `--password` puts it in your shell history. Prefer piping it:
 *   printf '%s' "$ADMIN_PW" | npm run admin:passwd -- --stdin
 */

import process from 'node:process';
import { generateTotpSecret, hashPassword, isPasswordHash, verifyPassword } from '../server/admin.js';

function usage() {
  console.log(
    [
      'usage: node scripts/admin-passwd.js [--password <pw> | --stdin] [--totp] [--totp-only]',
      '                               [--check <hash>] [--label <name>]',
      '',
      '  --password <pw>   the password to hash (visible in shell history — prefer --stdin)',
      '  --stdin           read the password from standard input',
      '  --totp            also mint a TOTP secret for an authenticator app',
      '  --totp-only       mint only a TOTP secret',
      '  --check <hash>    verify --password against an existing hash instead of generating one',
      '  --label <name>    the account name in the otpauth:// URI (default: anomalradio)',
    ].join('\n'),
  );
}

function parseArgs(argv) {
  const args = {
    password: null,
    stdin: false,
    totp: false,
    totpOnly: false,
    check: null,
    label: 'anomalradio',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--password') args.password = argv[++i];
    else if (flag === '--stdin') args.stdin = true;
    else if (flag === '--totp') args.totp = true;
    else if (flag === '--totp-only') args.totpOnly = true;
    else if (flag === '--check') args.check = argv[++i];
    else if (flag === '--label') args.label = argv[++i];
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

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks)
    .toString('utf8')
    .replace(/\r?\n$/, '');
}

const args = parseArgs(process.argv.slice(2));

if (args.stdin) args.password = await readStdin();

// ── verify mode ──
if (args.check) {
  if (!isPasswordHash(args.check)) {
    console.error('✗ that does not look like a scrypt hash produced by this tool');
    process.exit(1);
  }
  if (!args.password) {
    console.error('✗ --check needs --password (or --stdin) too');
    process.exit(2);
  }
  const ok = verifyPassword(args.password, args.check);
  console.log(ok ? '✓ matches' : '✗ does not match');
  process.exit(ok ? 0 : 1);
}

if (!args.password && !args.totpOnly) {
  console.error('✗ nothing to do — pass --password (or --stdin), or --totp-only\n');
  usage();
  process.exit(2);
}

console.log('Anomalradio — admin credentials');
console.log('─────────────────────────────────────────────');
console.log('Add these to .env on the server (never commit them):\n');

if (args.password) {
  if (args.password.length < 12) {
    console.error('✗ that password is shorter than 12 characters — the panel is internet-facing');
    process.exit(1);
  }
  console.log(`ADMIN_PASSWORD_HASH=${hashPassword(args.password)}`);
}

if (args.totp || args.totpOnly) {
  const secret = generateTotpSecret();
  console.log(`ADMIN_TOTP_SECRET=${secret}`);
  console.log('');
  console.log('Add it to an authenticator app by hand (time-based, 6 digits, SHA-1), or with:');
  console.log(
    `  otpauth://totp/${encodeURIComponent(args.label)}?secret=${secret}&issuer=${encodeURIComponent(args.label)}&algorithm=SHA1&digits=6&period=30`,
  );
}

console.log('');
console.log('Optional:');
console.log('  ADMIN_PATH=/admin            # where the panel lives');
console.log('  ADMIN_IP_ALLOWLIST=1.2.3.4   # comma separated; empty = any address');
console.log('');
console.log('Then restart the station. With no ADMIN_PASSWORD_HASH the panel answers 404.');
