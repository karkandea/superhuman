#!/usr/bin/env bash
set -euo pipefail

cd /opt/superhuman/workers/chatgpt-consumer

node reasoning-level-preflight-v3.mjs
exec node --import ./checkpoint-observer.mjs --import tsx ./qa-worker.mjs
