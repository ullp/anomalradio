#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  verify-nginx.sh — load the deploy nginx configs into a real nginx and check
#  they still behave.
#
#  Why this exists: the configs in deploy/nginx/ are otherwise only checked by text
#  assertions in tests/deploy.test.js, and a regex cannot tell you that nginx itself
#  accepts the file. Running it in CI (ubuntu-latest, whose nginx 1.24 is the same
#  version Ubuntu 24.04 ships on the box) is how we know the deploy will not fail at
#  `nginx -t` with no shell to fix it. It already caught `http2 on;`, a directive
#  that requires nginx 1.25.1 and would have stopped nginx starting on the target.
#
#  Only four things are substituted, so what is tested stays the shipped file:
#    · listen ports      → high ports (this runs unprivileged, and CI has no 80/443)
#    · certificate paths → a throwaway self-signed certificate
#    · upstream port     → the stub in scripts/nginx-stub-upstream.mjs
#    · ACME webroot      → the scratch directory
#  Every location block, regex and directive is untouched.
#
#  Usage:  scripts/verify-nginx.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
CONFIGS=(deploy/nginx/anomalradio.conf deploy/nginx/bootstrap.conf)
FAILURES=0

if ! command -v nginx >/dev/null; then
  echo "nginx not found. Install it (apt-get install -y nginx) or run this in CI." >&2
  exit 2
fi
if ! command -v node >/dev/null; then
  echo "node not found (needed for the stub upstream and a free port)" >&2
  exit 2
fi

WORK=$(mktemp -d)
STUB_PID=""
cleanup() {
  nginx -s stop -p "$WORK" -c "$WORK/main.conf" 2>/dev/null || true
  [ -n "$STUB_PID" ] && kill "$STUB_PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() {
  printf '  \033[31m✗\033[0m %s\n' "$1"
  FAILURES=$((FAILURES + 1))
}
check() { # <description> <expected> <actual>
  if [ "$2" = "$3" ]; then pass "$1 ($3)"; else fail "$1 — expected $2, got $3"; fi
}

free_port() {
  node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'
}

echo "nginx: $(nginx -v 2>&1 | sed 's/^nginx version: //')"
HTTP_PORT=$(free_port)
TLS_PORT=$(free_port)
STUB_PORT=$(free_port)

# ── a throwaway certificate, so the TLS config has something to load ──
mkdir -p "$WORK/webroot"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -keyout "$WORK/privkey.pem" -out "$WORK/fullchain.pem" \
  -subj '/CN=anomalradio.com' -addext 'subjectAltName=DNS:anomalradio.com' >/dev/null 2>&1

# ── the stub upstream ──
node "$ROOT/scripts/nginx-stub-upstream.mjs" "$STUB_PORT" >"$WORK/stub.log" 2>&1 &
STUB_PID=$!
for _ in $(seq 1 50); do
  curl -sf -o /dev/null "http://127.0.0.1:$STUB_PORT/__ping" && break
  sleep 0.1
done
curl -sf -o /dev/null "http://127.0.0.1:$STUB_PORT/__ping" || {
  echo "stub upstream did not start" >&2
  cat "$WORK/stub.log" >&2
  exit 1
}

# ── the config under test, with only the four substitutions above ──
prepare() { # <config> <output>
  sed \
    -e "s|listen 443 ssl http2;|listen ${TLS_PORT} ssl http2;|" \
    -e "s|listen 443 ssl;|listen ${TLS_PORT} ssl;|" \
    -e "s|listen 80;|listen ${HTTP_PORT};|" \
    -e '/listen \[::\]/d' \
    -e "s|/etc/letsencrypt/live/anomalradio.com/fullchain.pem|${WORK}/fullchain.pem|" \
    -e "s|/etc/letsencrypt/live/anomalradio.com/privkey.pem|${WORK}/privkey.pem|" \
    -e "s|/etc/letsencrypt/live/anomalradio.com/chain.pem|${WORK}/fullchain.pem|" \
    -e "s|server 127.0.0.1:3000;|server 127.0.0.1:${STUB_PORT};|" \
    -e "s|root /var/www/html;|root ${WORK}/webroot;|" \
    "$1" >"$2"
}

# ── a main config that includes the site config, so nginx can be run unprivileged ──
write_main() { # <site.conf> <main.conf>
  cat >"$2" <<EOF
worker_processes 1;
error_log ${WORK}/error.log warn;
pid ${WORK}/nginx.pid;
events { worker_connections 128; }
http {
    access_log off;
    client_body_temp_path ${WORK}/body;
    proxy_temp_path ${WORK}/proxy;
    fastcgi_temp_path ${WORK}/fastcgi;
    uwsgi_temp_path ${WORK}/uwsgi;
    scgi_temp_path ${WORK}/scgi;
    include ${1};
}
EOF
}

# ── 1. nginx must accept every shipped config ──
echo
echo 'nginx -t (does nginx accept the file at all?)'
for config in "${CONFIGS[@]}"; do
  site="$WORK/$(basename "$config")"
  prepare "$ROOT/$config" "$site"
  write_main "$site" "$WORK/main.conf"
  if nginx -t -p "$WORK" -c "$WORK/main.conf" >"$WORK/t.log" 2>&1; then
    pass "$config loads"
  else
    fail "$config does NOT load:"
    sed 's/^/      /' "$WORK/t.log"
  fi
done

# ── 2. the critical directives must survive into the *effective* config ──
echo
echo 'nginx -T (what nginx actually parsed)'
prepare "$ROOT/deploy/nginx/anomalradio.conf" "$WORK/site.conf"
write_main "$WORK/site.conf" "$WORK/main.conf"
nginx -T -p "$WORK" -c "$WORK/main.conf" >"$WORK/effective.conf" 2>/dev/null || true

effective_has() { # <description> <regex>
  if grep -qE "$2" "$WORK/effective.conf"; then pass "$1"; else fail "$1"; fi
}
effective_has 'the mount is never buffered' 'proxy_buffering off;'
effective_has 'the mount is not request-buffered' 'proxy_request_buffering off;'
effective_has 'X-Forwarded-For is overwritten, not appended' 'proxy_set_header X-Forwarded-For \$remote_addr;'
effective_has 'a long read timeout for the endless stream' 'proxy_read_timeout 12h;'
if grep -qE 'proxy_add_x_forwarded_for' "$WORK/effective.conf"; then
  fail 'the effective config appends X-Forwarded-For'
else
  pass 'the effective config never appends X-Forwarded-For'
fi

# ── 3. live requests through the running proxy ──
echo
echo 'live requests through nginx'
prepare "$ROOT/deploy/nginx/anomalradio.conf" "$WORK/site.conf"
write_main "$WORK/site.conf" "$WORK/main.conf"
nginx -p "$WORK" -c "$WORK/main.conf"
for _ in $(seq 1 50); do
  curl -sk -o /dev/null "https://127.0.0.1:$TLS_PORT/__ping" && break
  sleep 0.1
done

code() { curl -sk -o /dev/null -w '%{http_code}' "$@"; }

# The one that matters most: send a lie and see what the app would have received.
spoofed=$(curl -sk -H 'X-Forwarded-For: 203.0.113.9' "https://127.0.0.1:$TLS_PORT/__forwarded" || true)
if [ "$spoofed" = '127.0.0.1' ]; then
  pass "a spoofed X-Forwarded-For is replaced (the app saw $spoofed)"
elif printf '%s' "$spoofed" | grep -q '203\.0\.113\.9'; then
  fail "the spoofed X-Forwarded-For reached the app ($spoofed) — the per-IP limits are bypassable"
else
  fail "unexpected X-Forwarded-For at the upstream: '$spoofed'"
fi

check 'private /media/ path is refused' 404 "$(code "https://127.0.0.1:$TLS_PORT/media/tracks/x.mp3")"
check 'private /server/ path is refused' 404 "$(code "https://127.0.0.1:$TLS_PORT/server/index.js")"
check 'private /deploy/ path is refused' 404 "$(code "https://127.0.0.1:$TLS_PORT/deploy/bin/deploy.sh")"
check 'a dotfile is refused' 404 "$(code "https://127.0.0.1:$TLS_PORT/.env")"
check 'the mount reaches the app' 200 "$(code "https://127.0.0.1:$TLS_PORT/radio-128.mp3?t=x")"
check 'the station file reaches the app' 200 "$(code "https://127.0.0.1:$TLS_PORT/radio.pls")"
check 'plain HTTP redirects to HTTPS' 301 \
  "$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: anomalradio.com' "http://127.0.0.1:$HTTP_PORT/")"

hsts=$(curl -sk -D - -o /dev/null "https://127.0.0.1:$TLS_PORT/" | tr -d '\r' | grep -i '^strict-transport-security:' || true)
if [ -n "$hsts" ]; then
  pass 'HSTS is sent'
else
  fail 'HSTS is missing from the response'
fi

# Proves `listen ... http2` actually took effect (the form that works on nginx 1.24).
if curl --help all 2>/dev/null | grep -q -- '--http2'; then
  version=$(curl -sk --http2 -o /dev/null -w '%{http_version}' "https://127.0.0.1:$TLS_PORT/" || true)
  check 'the TLS listener speaks HTTP/2' 2 "$version"
fi

nginx -s stop -p "$WORK" -c "$WORK/main.conf" 2>/dev/null || true

echo
if [ "$FAILURES" -eq 0 ]; then
  echo 'nginx config: all checks passed'
else
  echo "nginx config: $FAILURES check(s) FAILED"
  exit 1
fi

