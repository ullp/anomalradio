/**
 * Deployment kit.
 *
 * These files decide whether the station is reachable *and* still protected in production, and they
 * are the easiest thing in the repository to get subtly wrong — a proxy that appends
 * `X-Forwarded-For` instead of overwriting it hands every client the ability to choose its own IP,
 * and a buffering proxy turns the endless mount back into a file you can save. Both are one word
 * apart from the correct configuration, so they are pinned here rather than trusted to review.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from './helpers/server.js';
import { createSecurity } from '../server/security.js';

const read = (relative) => readFile(path.join(ROOT, relative), 'utf8');

const [unit, nginxTls, nginxBootstrap, envTemplate, cloudInit, deployScript] = await Promise.all([
  read('deploy/systemd/anomalradio.service'),
  read('deploy/nginx/anomalradio.conf'),
  read('deploy/nginx/bootstrap.conf'),
  read('deploy/env.production.example'),
  read('deploy/cloud-init.yaml'),
  read('deploy/bin/deploy.sh'),
]);

const NGINX_CONFIGS = [
  ['deploy/nginx/anomalradio.conf', nginxTls],
  ['deploy/nginx/bootstrap.conf', nginxBootstrap],
];

/** The body of the first `{ … }` block whose opening follows `marker`. */
function block(text, marker) {
  const start = text.indexOf(marker);
  assert.notEqual(start, -1, `no block starting at ${JSON.stringify(marker)}`);
  const open = text.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === '{') depth += 1;
    else if (text[index] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(open, index + 1);
    }
  }
  throw new Error(`unbalanced braces after ${JSON.stringify(marker)}`);
}

const MOUNT_MARKER = 'location ~ ^/radio';

/** Config with comments stripped: these assertions are about directives, not prose. */
const directives = (text) =>
  text
    .split('\n')
    .map((line) => line.replace(/\s*#.*$/, ''))
    .filter((line) => line.trim() !== '')
    .join('\n');

describe('systemd unit', () => {
  it('runs the station as an unprivileged user', () => {
    assert.match(unit, /^User=anomalradio$/m);
    assert.match(unit, /^Group=anomalradio$/m);
    assert.doesNotMatch(unit, /^User=root$/m);
  });

  it('starts the app from the code tree and reads config from outside it', () => {
    assert.match(unit, /^WorkingDirectory=\/srv\/anomalradio$/m);
    assert.match(unit, /^ExecStart=\/usr\/bin\/node scripts\/serve\.js$/m);
    assert.match(unit, /^EnvironmentFile=\/etc\/anomalradio\/anomalradio\.env$/m);
  });

  it('comes back after a crash, and waits for the network first', () => {
    assert.match(unit, /^Restart=always$/m);
    assert.match(unit, /^After=network-online\.target$/m);
    assert.match(unit, /^Wants=network-online\.target$/m);
  });

  it('is confined, and the code tree stays read-only', () => {
    assert.match(unit, /^NoNewPrivileges=true$/m);
    assert.match(unit, /^ProtectSystem=strict$/m);
    assert.match(unit, /^ProtectHome=true$/m);
    assert.match(unit, /^PrivateTmp=true$/m);
    assert.match(unit, /^RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX$/m);

    const writable = /^ReadWritePaths=(.+)$/m.exec(unit)[1].trim();
    assert.equal(writable, '/var/lib/anomalradio');
    // The app must never write next to its own code: a bad path there fills the
    // system volume or ends up serving private files.
    assert.doesNotMatch(writable, /\/srv\/anomalradio/);
  });

  it('caps the resources it may take from the box', () => {
    assert.match(unit, /^MemoryMax=\d+[MG]$/m);
    assert.match(unit, /^TasksMax=\d+$/m);
    assert.match(unit, /^LimitNOFILE=\d+$/m);
  });

  it('is enabled at boot', () => {
    assert.match(unit, /^WantedBy=multi-user\.target$/m);
  });
});

describe('nginx — the two load-bearing rules', () => {
  for (const [name, config] of NGINX_CONFIGS) {
    it(`${name}: overwrites X-Forwarded-For instead of appending`, () => {
      const lines = directives(config);
      assert.match(lines, /proxy_set_header X-Forwarded-For \$remote_addr;/);
      // Appending keeps the client's own value first, and the app takes the first
      // value — so this one word would let anyone forge their IP and walk around
      // the per-IP rate limit, the stream cap and token/IP binding.
      assert.doesNotMatch(lines, /\$proxy_add_x_forwarded_for/);
    });

    it(`${name}: never buffers the mount`, () => {
      const mount = block(config, MOUNT_MARKER);
      assert.match(mount, /proxy_buffering off;/);
      assert.match(mount, /proxy_request_buffering off;/);
      // A short read timeout would cut every listener off mid-track.
      assert.match(mount, /proxy_read_timeout 12h;/);
      assert.match(mount, /proxy_set_header Connection "";/);
    });

    it(`${name}: never lists a directory`, () => {
      assert.doesNotMatch(config, /autoindex\s+on/);
    });

    it(`${name}: keeps private paths unreachable`, () => {
      const deny = block(config, 'location ~ ^/(media|data|server|scripts|tests|_data|deploy)/');
      assert.match(deny, /return 404;/);
      assert.match(config, /location ~ \/\\\.\(\?!well-known\)/);
    });

    it(`${name}: is brace-balanced`, () => {
      const opens = (config.match(/\{/g) ?? []).length;
      const closes = (config.match(/\}/g) ?? []).length;
      assert.equal(opens, closes);
    });
  }

  it('the extension deny list must not swallow the mount', () => {
    // The mount ends in .mp3 on purpose (players sniff it) but it is a stream, not
    // a file. A blanket audio-extension deny would 404 the station itself.
    for (const [name, config] of NGINX_CONFIGS) {
      const deny = /location ~\* \\\.\(([^)]*)\)/.exec(config);
      assert.ok(deny, `${name} has no extension deny rule`);
      assert.doesNotMatch(deny[1], /mp3|m4a|flac|wav|aac|ogg|opus/, `${name} denies audio`);
    }
  });

  it('the TLS config serves HTTPS, redirects HTTP and pins HSTS', () => {
    // `listen ... http2`, not `http2 on;`: the target is Ubuntu 24.04, whose nginx is
    // 1.24, where `http2 on;` is an unknown directive and nginx refuses to start.
    assert.match(nginxTls, /listen 443 ssl http2;/);
    assert.doesNotMatch(directives(nginxTls), /^http2 on;$/m);
    assert.match(nginxTls, /ssl_certificate\s+\/etc\/letsencrypt\/live\/anomalradio\.com\/fullchain\.pem;/);
    assert.match(nginxTls, /ssl_certificate_key\s+\/etc\/letsencrypt\/live\/anomalradio\.com\/privkey\.pem;/);
    assert.match(nginxTls, /return 301 https:\/\/\$host\$request_uri;/);
    assert.match(nginxTls, /Strict-Transport-Security "max-age=31536000/);
    assert.match(nginxTls, /ssl_protocols\s+TLSv1\.2 TLSv1\.3;/);
  });

  it('the bootstrap config can answer an ACME challenge before any certificate exists', () => {
    // certbot has to reach the webroot over plain HTTP first — which is exactly
    // why the bootstrap config is not simply the TLS one.
    assert.match(nginxBootstrap, /location \^~ \/\.well-known\/acme-challenge\//);
    assert.match(nginxBootstrap, /root \/var\/www\/html;/);
    assert.doesNotMatch(nginxBootstrap, /listen 443/);
    assert.match(nginxTls, /location \^~ \/\.well-known\/acme-challenge\//);
  });
});

describe('environment template', () => {
  it('is production, and ships no secret', () => {
    assert.match(envTemplate, /^NODE_ENV=production$/m);
    assert.match(envTemplate, /^SECRET=$/m);
    assert.doesNotMatch(envTemplate, /^SECRET=\S+$/m);
  });

  it('keeps every writable path out of the code tree', () => {
    const value = (key) => new RegExp(`^${key}=(.+)$`, 'm').exec(envTemplate)[1].trim();
    for (const key of ['DATA_DIR', 'ANOMALRADIO_DB', 'LIBRARY_INDEX', 'MEDIA_DIR']) {
      assert.match(value(key), /^\/var\/lib\/anomalradio\//, `${key} must live in the state dir`);
    }
    // Music is collected outside the repository, so audio can never be committed.
    assert.equal(value('LIBRARY_SOURCE_DIR'), '/srv/anomalradio-inbox');
  });

  it('trusts the proxy, because nginx is in front', () => {
    assert.match(envTemplate, /^TRUST_PROXY=true$/m);
  });

  it('MOUNT_PATH agrees with the mount location in the nginx config', () => {
    // Two different files that must not drift apart: if the path moves, nginx
    // stops recognising the mount and starts buffering it — a download again.
    const mountPath = /^MOUNT_PATH=(.+)$/m.exec(envTemplate)[1].trim();
    const pattern = /location ~ (\S+)/.exec(nginxTls)[1];
    assert.ok(new RegExp(pattern).test(mountPath), `nginx matches ${pattern} but MOUNT_PATH is ${mountPath}`);
  });
});

describe('cloud-init (first boot on the free box)', () => {
  it('is a cloud-config', () => {
    assert.match(cloudInit, /^#cloud-config/);
  });

  it('keeps every runcmd step as a block scalar', () => {
    // YAML folds line breaks inside quoted flow scalars into spaces, which would
    // silently collapse a whole shell script into one line — comments and all.
    for (const line of cloudInit.split('\n')) {
      const opens = (line.match(/\[/g) ?? []).length;
      const closes = (line.match(/\]/g) ?? []).length;
      assert.equal(opens, closes, `unbalanced flow collection: ${line}`);
    }
    assert.ok((cloudInit.match(/^ {2}- \|$/gm) ?? []).length >= 6);
  });

  it('installs what the app and the import pipeline need', () => {
    for (const packageName of ['nginx', 'certbot', 'ffmpeg', 'git']) {
      assert.match(cloudInit, new RegExp(`^ {2}- ${packageName}`, 'm'));
    }
  });

  it('generates the secret on the machine, never in the repository', () => {
    assert.match(cloudInit, /openssl rand -hex 32/);
    assert.match(cloudInit, /install -m 0640 -o root -g anomalradio/);
    assert.doesNotMatch(cloudInit, /SECRET=[0-9a-f]{64}/);
  });

  it('opens 80 and 443 in the host firewall as well as the VCN', () => {
    // Oracle's Ubuntu images reject everything but SSH at the host level, so a
    // correct VCN security list on its own leaves the box unreachable.
    assert.match(cloudInit, /for port in 80 443/);
    assert.match(cloudInit, /iptables -I INPUT 6 -p tcp --dport "\$port" -m state --state NEW -j ACCEPT/);
    assert.match(cloudInit, /netfilter-persistent save/);
  });

  it('keeps the distro default user, so the uploaded SSH key still works', () => {
    // cloud-init creates the distro default user (ubuntu) only when it is listed,
    // and Oracle injects the SSH key you uploaded into that user. Omitting it
    // locks you out of a brand-new instance with no way back but the serial console.
    assert.match(cloudInit, /^ {2}- default$/m);
    // ...and the service account must use cloud-init's real key name, `homedir`.
    assert.match(cloudInit, /^ {4}homedir: \/var\/lib\/anomalradio$/m);
    assert.doesNotMatch(cloudInit, /^ {4}home: /m);
  });

  it('keeps runcmd POSIX, because it runs under /bin/sh (dash)', () => {
    // `set -o pipefail` is a bashism and is a *fatal* error in dash, which would
    // abort the whole step — and on Ubuntu /bin/sh is dash.
    const runcmd = cloudInit.slice(cloudInit.indexOf('\nruncmd:'));
    assert.match(runcmd, /^ {4}set -eu$/m);
    assert.doesNotMatch(runcmd, /pipefail|compgen/);
  });

  it('reloads nginx after a certificate renewal', () => {
    // certbot's --webroot path does not reload the server, so without this hook
    // nginx keeps serving the old certificate from memory and the site breaks
    // around day 90, even though every renewal reported success.
    assert.match(cloudInit, /\/etc\/letsencrypt\/renewal-hooks\/deploy\/reload-nginx/);
    assert.match(cloudInit, /nginx -t && systemctl reload nginx/);
  });
});

describe('deploy script', () => {
  it('is strict, and refuses to run as anyone but root', () => {
    assert.match(deployScript, /^set -euo pipefail$/m);
    assert.match(deployScript, /\[ "\$\(id -u\)" -eq 0 \]/);
  });

  it('never writes a secret', () => {
    assert.doesNotMatch(deployScript, /openssl rand/);
    assert.match(deployScript, /^ENV_FILE=\/etc\/anomalradio\/anomalradio\.env$/m);
  });

  it('runs app commands as the unprivileged user, with a writable HOME', () => {
    assert.match(deployScript, /runuser -u anomalradio -- env HOME="\$STATE_DIR"/);
    assert.match(deployScript, /as_app npm --prefix "\$APP_DIR" ci --omit=dev/);
    assert.doesNotMatch(deployScript, /^\s*npm ci/m);
  });

  it('validates nginx before reloading it', () => {
    assert.ok(deployScript.indexOf('nginx -t') < deployScript.indexOf('systemctl reload nginx'));
  });

  it('picks the config that matches reality', () => {
    assert.match(deployScript, /letsencrypt\/live\/\$DOMAIN\/fullchain\.pem/);
    assert.match(deployScript, /deploy\/nginx\/anomalradio\.conf/);
    assert.match(deployScript, /deploy\/nginx\/bootstrap\.conf/);
  });

  it('proves the station came back, and shows the journal when it did not', () => {
    assert.match(deployScript, /systemctl is-active --quiet "\$SERVICE"/);
    assert.match(deployScript, /journalctl -u "\$SERVICE"/);
    assert.match(deployScript, /curl -fsS http:\/\/127\.0\.0\.1:3000\/healthz/);
  });
});

describe('X-Forwarded-For trust (the proxy boundary)', () => {
  const request = (remoteAddress, forwarded) => ({
    headers: forwarded === undefined ? {} : { 'x-forwarded-for': forwarded },
    socket: { remoteAddress },
  });

  it('believes the header from a local proxy', () => {
    const security = createSecurity({ trustProxy: true });
    assert.equal(security.clientIp(request('127.0.0.1', '203.0.113.7')), '203.0.113.7');
    assert.equal(security.clientIp(request('::1', '203.0.113.7')), '203.0.113.7');
  });

  it('ignores the header from anywhere else', () => {
    // The header is attacker-controlled. A direct connection must not be able to
    // claim an IP: that would reset the rate limit, the stream cap and token/IP
    // binding at once, just by sending a different value each request.
    const security = createSecurity({ trustProxy: true });
    assert.equal(security.clientIp(request('198.51.100.4', '203.0.113.7')), '198.51.100.4');
    assert.equal(security.clientIp(request('198.51.100.4', '')), '198.51.100.4');
  });

  it('can be switched off entirely', () => {
    const security = createSecurity({ trustProxy: false });
    assert.equal(security.clientIp(request('127.0.0.1', '203.0.113.7')), '127.0.0.1');
  });

  it('takes the first value, which is why nginx must overwrite the header', () => {
    const security = createSecurity({ trustProxy: true });
    assert.equal(security.clientIp(request('127.0.0.1', '203.0.113.7, 10.0.0.1')), '203.0.113.7');
  });
});
