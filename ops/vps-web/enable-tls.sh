#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo 'Run as root.' >&2
  exit 1
fi

DOMAIN=${SUPERHUMAN_WEB_DOMAIN:-superhuman.dualangka.com}
EXPECTED_IPV4=${SUPERHUMAN_WEB_EXPECTED_IPV4:-103.175.207.127}
CERTBOT_EMAIL=${CERTBOT_EMAIL:-}

resolved=$(getent ahostsv4 "$DOMAIN" | awk '{print $1}' | sort -u)
if ! grep -Fxq "$EXPECTED_IPV4" <<<"$resolved"; then
  echo "DNS is not pointing $DOMAIN to $EXPECTED_IPV4 yet." >&2
  echo "Current IPv4 resolution:" >&2
  printf '%s\n' "$resolved" >&2
  exit 1
fi

if ! curl -fsS --max-time 5 -H "Host: $DOMAIN" http://127.0.0.1/api/health | grep -q '"status":"ok"'; then
  echo 'Local Nginx -> Next.js health check failed. Refusing TLS cutover.' >&2
  exit 1
fi

if [[ -z "$CERTBOT_EMAIL" ]]; then
  echo 'Set CERTBOT_EMAIL before enabling TLS.' >&2
  exit 1
fi

if ! command -v certbot >/dev/null 2>&1; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y certbot python3-certbot-nginx
fi

certbot --nginx \
  --non-interactive \
  --agree-tos \
  --redirect \
  --email "$CERTBOT_EMAIL" \
  -d "$DOMAIN"

nginx -t
systemctl reload nginx
curl -fsS --max-time 10 "https://$DOMAIN/api/health"
printf '\nTLS enabled for %s\n' "$DOMAIN"
