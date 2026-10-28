#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  deploy.sh — put the current main on the box and restart the station.
#
#  Idempotent: run it as often as you like (every deploy, every music import).
#
#    sudo /srv/anomalradio/deploy/bin/deploy.sh          # deploy current main
#    sudo /srv/anomalradio/deploy/bin/deploy.sh --tls    # also obtain the certificate
#
#  It refuses to run without a production environment file, and it never writes a
#  secret itself — SECRET is generated once at first boot (deploy/cloud-init.yaml)
#  and lives only in /etc/anomalradio/anomalradio.env.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

APP_DIR=/srv/anomalradio
ENV_FILE=/etc/anomalradio/anomalradio.env
STATE_DIR=/var/lib/anomalradio
INBOX=/srv/anomalradio-inbox
SERVICE=anomalradio
DOMAIN=anomalradio.com
BRANCH=main

step() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
die() {
  printf '\n✗ %s\n' "$*" >&2
  exit 1
}
as_app() { runuser -u anomalradio -- env HOME="$STATE_DIR" "$@"; }

TLS=0
for arg in "$@"; do
  case "$arg" in
    --tls) TLS=1 ;;
    -h | --help)
      sed -n '2,14p' "$0"
      exit 0
      ;;
    *) die "unknown argument: $arg" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "run as root: sudo $0"
[ -d "$APP_DIR/.git" ] || die "$APP_DIR is not a git checkout (see deploy/README.md)"
[ -f "$ENV_FILE" ] || die "$ENV_FILE is missing — copy deploy/env.production.example there and set SECRET"
[ -d "$STATE_DIR/data" ] || die "$STATE_DIR/data is missing — see deploy/cloud-init.yaml"

# ── 1. code ──────────────────────────────────────────────────────────────────
step "code"
as_app git -C "$APP_DIR" fetch --depth 1 origin "$BRANCH"
as_app git -C "$APP_DIR" reset --hard FETCH_HEAD
as_app git -C "$APP_DIR" log -1 --format='  %h %s'

# ── 2. dependencies ─────────────────────────────────────────────────────────
step "dependencies"
as_app npm --prefix "$APP_DIR" ci --omit=dev

# ── 3. music ────────────────────────────────────────────────────────────────
# Everything writable lives in the state directory, so the code tree can stay
# read-only to the service (ProtectSystem=strict in the unit).
step "music"
if find "$INBOX" -maxdepth 2 -name '*.mp3' -print -quit | grep -q .; then
  as_app bash -c "set -a; . '$ENV_FILE'; set +a; cd '$APP_DIR' && npm run import -- --publish"
else
  echo "  inbox is empty — scp mp3s to $INBOX and re-run to add them"
fi

# ── 4. systemd unit ─────────────────────────────────────────────────────────
step "systemd unit"
install -m 0644 "$APP_DIR/deploy/systemd/$SERVICE.service" "/etc/systemd/system/$SERVICE.service"
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null

# ── 5. nginx ────────────────────────────────────────────────────────────────
step "nginx"
if [ "$TLS" -eq 1 ]; then
  resolved="$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1 || true)"
  [ -n "$resolved" ] || die "$DOMAIN does not resolve yet — point its A record at this instance first"
  echo "  $DOMAIN resolves to $resolved"
  CERTBOT_EMAIL="${CERTBOT_EMAIL:-}" /usr/local/bin/anomalradio-cert
fi

# The TLS config cannot load before the certificate exists, so pick the config
# that matches reality rather than the one we wish we had.
if [ -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
  CONF="$APP_DIR/deploy/nginx/anomalradio.conf"
  echo "  certificate present → installing the TLS config"
else
  CONF="$APP_DIR/deploy/nginx/bootstrap.conf"
  echo "  no certificate yet → installing the bootstrap config (re-run with --tls to go live)"
fi
install -m 0644 "$CONF" /etc/nginx/sites-available/anomalradio
ln -sf ../sites-available/anomalradio /etc/nginx/sites-enabled/anomalradio
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

# ── 6. the station ──────────────────────────────────────────────────────────
step "the station"
systemctl restart "$SERVICE"
sleep 3
if ! systemctl is-active --quiet "$SERVICE"; then
  journalctl -u "$SERVICE" -n 40 --no-pager
  die "$SERVICE did not stay up"
fi

# ── 7. prove it ─────────────────────────────────────────────────────────────
step "health"
curl -fsS http://127.0.0.1:3000/healthz
echo
if [ -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
  curl -fsS -o /dev/null -w "  https://$DOMAIN/ → %{http_code}\n" "https://$DOMAIN/" ||
    echo "  https did not answer yet — DNS may still be propagating"
  curl -fsS -o /dev/null -w "  https://$DOMAIN/radio.pls → %{http_code}\n" "https://$DOMAIN/radio.pls" ||
    true
else
  curl -fsS -o /dev/null -w "  http://$DOMAIN/ → %{http_code} (bootstrap, no TLS yet)\n" "http://$DOMAIN/" ||
    echo "  http did not answer from outside yet — check the VCN security list and the host firewall"
fi

echo
journalctl -u "$SERVICE" -n 14 --no-pager
