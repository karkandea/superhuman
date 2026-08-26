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

cd /opt/superhuman/workers/chatgpt-consumer

echo "[qa-runtime] profile=${CHATGPT_BROWSER_PROFILE_DIR} cdp=${CHATGPT_CDP_URL} trafficKind=${SUPERHUMAN_CHATGPT_TRAFFIC_KIND}"
node reasoning-level-preflight-v3.mjs
exec node --import ./checkpoint-observer.mjs --import tsx ./qa-worker.mjs
