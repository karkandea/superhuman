#!/usr/bin/env bash
set -euo pipefail

# consumer-worker.env is the production worker environment. The QA systemd unit
# also loads it for shared Supabase credentials, so force the runtime values
# that must never inherit production browser identity.
export SUPERHUMAN_CHATGPT_TRAFFIC_KIND=qa
export SUPERHUMAN_QA_WORKER_ID="${SUPERHUMAN_QA_WORKER_ID:-superhuman-vps-qa}"
export CHATGPT_BROWSER_PROFILE_DIR=/var/lib/superhuman-ai/chatgpt-qa-profile
export CHATGPT_CDP_PORT=9223
export CHATGPT_CDP_URL=http://127.0.0.1:9223
export CHATGPT_REQUIRE_EXISTING_CDP=true
export CHATGPT_HEADLESS=false
export DISPLAY=:100

cd /opt/superhuman/workers/chatgpt-consumer

echo "[qa-runtime] profile=${CHATGPT_BROWSER_PROFILE_DIR} cdp=${CHATGPT_CDP_URL} trafficKind=${SUPERHUMAN_CHATGPT_TRAFFIC_KIND} display=${DISPLAY} browser=dedicated-service"

# The QA browser is owned by superhuman-chatgpt-qa-browser.service. Never spawn
# another Chrome from the worker process: wait for the dedicated CDP endpoint
# and fail closed if the browser service is not ready.
cdp_ready=0
for _ in $(seq 1 60); do
  if curl -fsS "${CHATGPT_CDP_URL}/json/version" >/dev/null 2>&1; then
    cdp_ready=1
    break
  fi
  sleep 0.5
done

if [[ "$cdp_ready" -ne 1 ]]; then
  echo "[qa-runtime] blocked: dedicated QA Chrome CDP did not become ready at ${CHATGPT_CDP_URL}" >&2
  exit 78
fi

echo "[qa-runtime] cdp=ready endpoint=${CHATGPT_CDP_URL}"
node reasoning-level-preflight-v3.mjs
exec node --import ./checkpoint-observer.mjs --import tsx ./qa-worker.mjs
