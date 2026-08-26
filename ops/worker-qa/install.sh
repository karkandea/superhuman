#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "Run as root" >&2
  exit 1
fi

REPO=/opt/superhuman
UNIT_SOURCE="$REPO/ops/worker-qa/superhuman-ai-qa-worker.service"
UNIT_TARGET=/etc/systemd/system/superhuman-ai-qa-worker.service
PROD_PROFILE=/var/lib/superhuman-ai/chatgpt-profile
QA_PROFILE=/var/lib/superhuman-ai/chatgpt-qa-profile
PROD_WORKER=superhuman-ai-worker.service
PROD_BROWSER=superhuman-chatgpt-browser.service
QA_WORKER=superhuman-ai-qa-worker.service

for path in "$REPO" "$UNIT_SOURCE" /etc/superhuman-ai/consumer-worker.env "$PROD_PROFILE"; do
  if [[ ! -e "$path" ]]; then
    echo "Missing required path: $path" >&2
    exit 1
  fi
done

if ! id superhuman-ai >/dev/null 2>&1; then
  echo "Missing superhuman-ai user" >&2
  exit 1
fi

bootstrap_profile=0
if [[ ! -d "$QA_PROFILE" || ! -f "$QA_PROFILE/Local State" ]]; then
  bootstrap_profile=1
fi

if [[ "$bootstrap_profile" -eq 1 ]]; then
  echo "=== Bootstrap isolated QA ChatGPT profile ==="
  echo "Pausing production worker/browser briefly for a consistent profile snapshot."

  systemctl stop "$QA_WORKER" 2>/dev/null || true
  systemctl stop "$PROD_WORKER"
  systemctl stop "$PROD_BROWSER"

  cleanup() {
    systemctl start "$PROD_BROWSER" || true
    sleep 2
    systemctl start "$PROD_WORKER" || true
  }
  trap cleanup EXIT

  rm -rf "$QA_PROFILE"
  mkdir -p "$QA_PROFILE"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete \
      --exclude='SingletonCookie' \
      --exclude='SingletonLock' \
      --exclude='SingletonSocket' \
      --exclude='DevToolsActivePort' \
      "$PROD_PROFILE/" "$QA_PROFILE/"
  else
    cp -a "$PROD_PROFILE/." "$QA_PROFILE/"
    rm -f \
      "$QA_PROFILE/SingletonCookie" \
      "$QA_PROFILE/SingletonLock" \
      "$QA_PROFILE/SingletonSocket" \
      "$QA_PROFILE/DevToolsActivePort"
  fi
  chown -R superhuman-ai:superhuman-ai "$QA_PROFILE"
  chmod 700 "$QA_PROFILE"

  systemctl start "$PROD_BROWSER"
  sleep 3
  systemctl start "$PROD_WORKER"
  trap - EXIT
fi

install -m 0644 "$UNIT_SOURCE" "$UNIT_TARGET"
systemctl daemon-reload
systemctl enable "$QA_WORKER"
systemctl restart "$QA_WORKER"

sleep 3

echo "=== QA worker ==="
systemctl is-active "$QA_WORKER"
echo
echo "=== Production worker ==="
systemctl is-active "$PROD_WORKER"
echo
echo "=== Production browser ==="
systemctl is-active "$PROD_BROWSER"
echo
echo "=== QA profile ==="
stat -c '%U:%G %a %n' "$QA_PROFILE"
echo
echo "=== QA startup log ==="
journalctl -u "$QA_WORKER" --since '2 minutes ago' --no-pager | tail -n 50
