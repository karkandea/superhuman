#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "Run as root" >&2
  exit 1
fi

REPO=/opt/superhuman
QA_WORKER_UNIT_SOURCE="$REPO/ops/worker-qa/superhuman-ai-qa-worker.service"
QA_WORKER_UNIT_TARGET=/etc/systemd/system/superhuman-ai-qa-worker.service
QA_BROWSER_UNIT_SOURCE="$REPO/ops/worker-qa/superhuman-chatgpt-qa-browser.service"
QA_BROWSER_UNIT_TARGET=/etc/systemd/system/superhuman-chatgpt-qa-browser.service
PROD_PROFILE=/var/lib/superhuman-ai/chatgpt-profile
QA_PROFILE=/var/lib/superhuman-ai/chatgpt-qa-profile
PROD_WORKER=superhuman-ai-worker.service
PROD_BROWSER=superhuman-chatgpt-browser.service
QA_WORKER=superhuman-ai-qa-worker.service
QA_BROWSER=superhuman-chatgpt-qa-browser.service
QA_CDP_URL=http://127.0.0.1:9223

for path in \
  "$REPO" \
  "$QA_WORKER_UNIT_SOURCE" \
  "$QA_BROWSER_UNIT_SOURCE" \
  /etc/superhuman-ai/consumer-worker.env \
  "$PROD_PROFILE"; do
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
  systemctl stop "$QA_BROWSER" 2>/dev/null || true
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

install -m 0644 "$QA_BROWSER_UNIT_SOURCE" "$QA_BROWSER_UNIT_TARGET"
install -m 0644 "$QA_WORKER_UNIT_SOURCE" "$QA_WORKER_UNIT_TARGET"
systemctl daemon-reload
systemctl enable "$QA_BROWSER"
systemctl enable "$QA_WORKER"

# Browser lifecycle is independent from the QA worker. Keep the worker stopped
# until the dedicated CDP endpoint is healthy so preflight never races browser
# startup or falls back to an unmanaged Chrome process.
systemctl stop "$QA_WORKER" 2>/dev/null || true
systemctl stop "$QA_BROWSER" 2>/dev/null || true
rm -f \
  "$QA_PROFILE/SingletonCookie" \
  "$QA_PROFILE/SingletonLock" \
  "$QA_PROFILE/SingletonSocket" \
  "$QA_PROFILE/DevToolsActivePort" 2>/dev/null || true
chown -R superhuman-ai:superhuman-ai "$QA_PROFILE"
chmod 700 "$QA_PROFILE"

systemctl start "$QA_BROWSER"

cdp_ready=0
for _ in $(seq 1 60); do
  if curl -fsS "$QA_CDP_URL/json/version" >/dev/null 2>&1; then
    cdp_ready=1
    break
  fi
  sleep 0.5
done

if [[ "$cdp_ready" -ne 1 ]]; then
  echo "QA browser failed to expose CDP at $QA_CDP_URL" >&2
  journalctl -u "$QA_BROWSER" --since '2 minutes ago' --no-pager | tail -n 80 >&2 || true
  exit 1
fi

systemctl restart "$QA_WORKER"
sleep 3

echo "=== QA browser ==="
systemctl is-active "$QA_BROWSER"
echo
echo "=== QA CDP ==="
curl -fsS "$QA_CDP_URL/json/version" | head -c 500
echo
echo
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
echo "=== QA browser startup log ==="
journalctl -u "$QA_BROWSER" --since '2 minutes ago' --no-pager | tail -n 50
echo
echo "=== QA worker startup log ==="
journalctl -u "$QA_WORKER" --since '2 minutes ago' --no-pager | tail -n 50
