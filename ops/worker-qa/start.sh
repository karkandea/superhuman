#!/usr/bin/env bash
set -euo pipefail

# consumer-worker.env is the production worker environment. The QA systemd unit
# also loads it for shared Supabase/browser credentials, so force the runtime
# values that must never inherit production browser identity.
export SUPERHUMAN_CHATGPT_TRAFFIC_KIND=qa
export SUPERHUMAN_QA_WORKER_ID="${SUPERHUMAN_QA_WORKER_ID:-superhuman-vps-qa}"
export CHATGPT_BROWSER_PROFILE_DIR=/var/lib/superhuman-ai/chatgpt-qa-profile
export CHATGPT_CDP_PORT=9223
export CHATGPT_CDP_URL=http://127.0.0.1:9223
export CHATGPT_HEADLESS=false
export DISPLAY=:99

resolve_linux_chrome() {
  local candidate
  for candidate in \
    "${SUPERHUMAN_QA_CHROME_BIN:-}" \
    /usr/bin/google-chrome-stable \
    /usr/bin/google-chrome \
    /opt/google/chrome/chrome \
    /usr/bin/chromium \
    /usr/bin/chromium-browser \
    "${CHATGPT_CHROME_BIN:-}"; do
    if [[ -n "$candidate" && -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

if ! QA_CHROME_BIN="$(resolve_linux_chrome)"; then
  echo "[qa-runtime] blocked: no executable Linux Chrome/Chromium binary found" >&2
  exit 78
fi
export CHATGPT_CHROME_BIN="$QA_CHROME_BIN"

cd /opt/superhuman/workers/chatgpt-consumer

echo "[qa-runtime] profile=${CHATGPT_BROWSER_PROFILE_DIR} cdp=${CHATGPT_CDP_URL} trafficKind=${SUPERHUMAN_CHATGPT_TRAFFIC_KIND} chrome=${CHATGPT_CHROME_BIN}"
node reasoning-level-preflight-v3.mjs
exec node --import ./checkpoint-observer.mjs --import tsx ./qa-worker.mjs
