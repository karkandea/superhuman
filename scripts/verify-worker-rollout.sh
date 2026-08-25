#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
WORKER_DIR="$ROOT/workers/chatgpt-consumer"

echo "=== SUPERHUMAN WORKER ROLLOUT VERIFY ==="
echo "repo=$ROOT"
echo "commit=$(git -C "$ROOT" rev-parse HEAD)"
echo "branch=$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)"
echo

echo "=== APP DEPENDENCIES ==="
cd "$ROOT"
npm ci --no-audit --no-fund

echo
echo "=== DOMAIN TESTS ==="
npm test

echo
echo "=== APP BUILD (lint + tests + Next build) ==="
npm run build

echo
echo "=== WORKER DEPENDENCIES ==="
cd "$WORKER_DIR"
npm ci --no-audit --no-fund

echo
echo "=== WORKER STATIC SYNTAX ==="
node --check reasoning-level-preflight.mjs
node --check browser-transport.mjs
node --check checkpoint-observer.mjs
node --check composer-verification.mjs
node --check worker-v2.mjs

echo
echo "=== CHATGPT REASONING PREFLIGHT ==="
npm run preflight

echo
echo "=== RESULT ==="
echo "PASS: tests/build/syntax completed and ChatGPT reasoning preflight verified."
echo "Next production evidence after service restart should include:"
echo "  [reasoning-preflight] verified required=high ..."
echo "  Superhuman ChatGPT consumer worker online as ..."
