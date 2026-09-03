#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo 'Run as root.' >&2
  exit 1
fi

REPO_DIR=${SUPERHUMAN_REPO_DIR:-/opt/superhuman}
RUNTIME_DIR=${SUPERHUMAN_WEB_RUNTIME_DIR:-/opt/superhuman-web}
BUILD_USER=${SUPERHUMAN_WEB_BUILD_USER:-superhuman-ai}
SERVICE_USER=${SUPERHUMAN_WEB_USER:-superhuman-web}
ENV_FILE=${SUPERHUMAN_WEB_ENV_FILE:-/etc/superhuman-web.env}
HEALTH_URL=${SUPERHUMAN_WEB_HEALTH_URL:-http://127.0.0.1:3000/api/health}
KEEP_RELEASES=${SUPERHUMAN_WEB_KEEP_RELEASES:-3}

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE. It must define NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

: "${NEXT_PUBLIC_SUPABASE_URL:?NEXT_PUBLIC_SUPABASE_URL is required}"
: "${NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:?NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is required}"

if [[ -n "$(sudo -u "$BUILD_USER" -H git -C "$REPO_DIR" status --porcelain)" ]]; then
  echo "Repo has local changes. Refusing deploy: $REPO_DIR" >&2
  sudo -u "$BUILD_USER" -H git -C "$REPO_DIR" status --short >&2
  exit 1
fi

sudo -u "$BUILD_USER" -H bash -lc "
set -euo pipefail
cd '$REPO_DIR'
git fetch origin main
git checkout main
git pull --ff-only origin main
npm ci
NEXT_PUBLIC_SUPABASE_URL='$NEXT_PUBLIC_SUPABASE_URL' \\
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY='$NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY' \\
npm run build
"

SHA=$(sudo -u "$BUILD_USER" -H git -C "$REPO_DIR" rev-parse HEAD)
RELEASE_DIR="$RUNTIME_DIR/releases/$SHA"
TMP_RELEASE="$RUNTIME_DIR/releases/.${SHA}.tmp"
PREVIOUS=$(readlink -f "$RUNTIME_DIR/current" 2>/dev/null || true)

rm -rf "$TMP_RELEASE"
mkdir -p "$TMP_RELEASE"
cp -a "$REPO_DIR/.next/standalone/." "$TMP_RELEASE/"
mkdir -p "$TMP_RELEASE/.next"
cp -a "$REPO_DIR/.next/static" "$TMP_RELEASE/.next/"
if [[ -d "$REPO_DIR/public" ]]; then
  cp -a "$REPO_DIR/public" "$TMP_RELEASE/public"
fi

# Server-only operator credentials are copied into the release runtime env, never into
# NEXT_PUBLIC_* build variables. When absent, the public player app still deploys normally,
# but /operator/inference remains unavailable until the server env is configured.
umask 077
{
  printf 'SUPERHUMAN_RELEASE_SHA=%s\n' "$SHA"
  printf 'SUPABASE_URL=%s\n' "${SUPABASE_URL:-$NEXT_PUBLIC_SUPABASE_URL}"
  printf 'SUPABASE_SECRET_KEY=%s\n' "${SUPABASE_SECRET_KEY:-${SUPABASE_SERVICE_ROLE_KEY:-}}"
  printf 'SUPERHUMAN_OPERATOR_TOKEN=%s\n' "${SUPERHUMAN_OPERATOR_TOKEN:-}"
} > "$TMP_RELEASE/.runtime.env"
chown -R "$SERVICE_USER:$SERVICE_USER" "$TMP_RELEASE"
chmod 0600 "$TMP_RELEASE/.runtime.env"

rm -rf "$RELEASE_DIR"
mv "$TMP_RELEASE" "$RELEASE_DIR"
ln -sfn "$RELEASE_DIR" "$RUNTIME_DIR/current.next"
mv -Tf "$RUNTIME_DIR/current.next" "$RUNTIME_DIR/current"

systemctl enable superhuman-web.service >/dev/null
systemctl restart superhuman-web.service

healthy=false
for _ in $(seq 1 30); do
  body=$(curl -fsS --max-time 2 "$HEALTH_URL" 2>/dev/null || true)
  if [[ "$body" == *'"status":"ok"'* && "$body" == *"\"release\":\"$SHA\""* ]]; then
    healthy=true
    break
  fi
  sleep 1
done

if [[ "$healthy" != true ]]; then
  echo "New release failed health check: $SHA" >&2
  journalctl -u superhuman-web.service -n 80 --no-pager >&2 || true
  if [[ -n "$PREVIOUS" && -d "$PREVIOUS" ]]; then
    echo "Rolling back to $PREVIOUS" >&2
    ln -sfn "$PREVIOUS" "$RUNTIME_DIR/current.next"
    mv -Tf "$RUNTIME_DIR/current.next" "$RUNTIME_DIR/current"
    systemctl restart superhuman-web.service
  else
    systemctl stop superhuman-web.service || true
  fi
  exit 1
fi

find "$RUNTIME_DIR/releases" -mindepth 1 -maxdepth 1 -type d ! -name '.*' -printf '%T@ %p\n' \
  | sort -nr \
  | awk -v keep="$KEEP_RELEASES" 'NR > keep { sub(/^[^ ]+ /, ""); print }' \
  | while IFS= read -r old_release; do
      [[ -n "$old_release" ]] || continue
      [[ "$old_release" == "$(readlink -f "$RUNTIME_DIR/current")" ]] && continue
      rm -rf "$old_release"
    done

printf 'release=%s\n' "$SHA"
printf 'health=%s\n' "$body"
printf 'service=%s\n' "$(systemctl is-active superhuman-web.service)"
printf '\nLogs:\n  journalctl -u superhuman-web.service -f\n  tail -f /var/log/nginx/superhuman.access.log\n  tail -f /var/log/nginx/superhuman.error.log\n'