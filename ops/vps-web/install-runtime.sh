#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo 'Run as root.' >&2
  exit 1
fi

REPO_DIR=${SUPERHUMAN_REPO_DIR:-/opt/superhuman}
RUNTIME_DIR=${SUPERHUMAN_WEB_RUNTIME_DIR:-/opt/superhuman-web}
SERVICE_USER=${SUPERHUMAN_WEB_USER:-superhuman-web}
NGINX_SITE=/etc/nginx/sites-available/superhuman-web.conf

if [[ ! -f "$REPO_DIR/ops/vps-web/superhuman-web.service" ]]; then
  echo "Missing runtime files under $REPO_DIR/ops/vps-web" >&2
  exit 1
fi

if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$RUNTIME_DIR" --create-home --shell /usr/sbin/nologin "$SERVICE_USER"
fi

mkdir -p "$RUNTIME_DIR/releases"
chown root:root "$RUNTIME_DIR" "$RUNTIME_DIR/releases"
chmod 0755 "$RUNTIME_DIR" "$RUNTIME_DIR/releases"

install -m 0644 "$REPO_DIR/ops/vps-web/superhuman-web.service" /etc/systemd/system/superhuman-web.service
systemctl daemon-reload

if ! command -v nginx >/dev/null 2>&1; then
  if ss -ltnp '( sport = :80 or sport = :443 )' | tail -n +2 | grep -q .; then
    echo 'Port 80/443 is already in use and nginx is not installed. Inspect preflight output before continuing.' >&2
    exit 1
  fi
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y nginx curl
fi

install -m 0644 "$REPO_DIR/ops/vps-web/nginx-superhuman.conf" "$NGINX_SITE"
ln -sfn "$NGINX_SITE" /etc/nginx/sites-enabled/superhuman-web.conf
nginx -t
systemctl enable nginx >/dev/null
if systemctl is-active --quiet nginx; then
  systemctl reload nginx
else
  systemctl start nginx
fi

if [[ -f "$RUNTIME_DIR/current/server.js" ]]; then
  systemctl enable --now superhuman-web.service
else
  systemctl disable superhuman-web.service >/dev/null 2>&1 || true
  echo 'Runtime installed. Frontend service will be enabled by the first successful deploy.'
fi

echo 'VPS web runtime installation complete.'
