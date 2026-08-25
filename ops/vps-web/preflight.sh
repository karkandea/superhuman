#!/usr/bin/env bash
set -euo pipefail

REPO_DIR=${SUPERHUMAN_REPO_DIR:-/opt/superhuman}
DOMAIN=${SUPERHUMAN_WEB_DOMAIN:-superhuman.dualangka.com}

printf '=== SUPERHUMAN WEB VPS PREFLIGHT ===\n'
printf 'repo=%s\ndomain=%s\n\n' "$REPO_DIR" "$DOMAIN"

printf '%s\n' '--- memory ---'
free -h
printf '\n%s\n' '--- swap ---'
swapon --show || true

printf '\n%s\n' '--- node ---'
node --version
npm --version

printf '\n%s\n' '--- repo ---'
if [[ -d "$REPO_DIR/.git" ]]; then
  git -C "$REPO_DIR" status --short
  printf 'branch=' && git -C "$REPO_DIR" branch --show-current
  printf 'head=' && git -C "$REPO_DIR" rev-parse HEAD
else
  echo "missing repo: $REPO_DIR"
fi

printf '\n%s\n' '--- listeners 80/443/3000 ---'
ss -ltnp '( sport = :80 or sport = :443 or sport = :3000 )' || true

printf '\n%s\n' '--- web services ---'
for service in nginx apache2 caddy superhuman-web; do
  printf '%-18s %s\n' "$service" "$(systemctl is-active "$service" 2>/dev/null || true)"
done

printf '\n%s\n' '--- dns ---'
getent ahostsv4 "$DOMAIN" | awk '{print $1}' | sort -u || true

printf '\n%s\n' '--- existing nginx domain references ---'
if [[ -d /etc/nginx ]]; then
  grep -Rsn --exclude='*.log' -- "$DOMAIN" /etc/nginx 2>/dev/null || true
else
  echo 'nginx not installed'
fi

printf '\n%s\n' '--- local health ---'
curl -fsS --max-time 2 http://127.0.0.1:3000/api/health || echo 'frontend not listening locally yet'
printf '\n'
