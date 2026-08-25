#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
WORKER_DIR="$ROOT/workers/chatgpt-consumer"
WORKER_ENV_FILE="$HOME/.config/superhuman/consumer-worker.env"

# Public Supabase client config is required while Next prerenders pages during the
# VPS verification build. These values are intentionally public/browser-safe.
# Prefer operator-provided values when present so key rotation does not require
# editing this script immediately.
BUILD_SUPABASE_URL="${NEXT_PUBLIC_SUPABASE_URL:-https://ispfhvdelglwvixaspza.supabase.co}"
BUILD_SUPABASE_PUBLISHABLE_KEY="${NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:-${NEXT_PUBLIC_SUPABASE_ANON_KEY:-sb_publishable_0BLLi-rB2gXk3f7WtEWPAg_qTlu7qd-}}"

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
echo "=== APP LINT ==="
npm run lint

echo
echo "=== NEXT PRODUCTION BUILD ==="
NEXT_PUBLIC_SUPABASE_URL="$BUILD_SUPABASE_URL" \
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="$BUILD_SUPABASE_PUBLISHABLE_KEY" \
npx next build

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
echo "=== WORKER RUNTIME ENV ==="
if [[ ! -f "$WORKER_ENV_FILE" ]]; then
  echo "Missing worker runtime env: $WORKER_ENV_FILE" >&2
  echo "Existing production worker runtime is not installed for this user." >&2
  exit 1
fi
# Load the existing dedicated browser/CDP configuration without printing secrets.
# The old production env may predate CHATGPT_REASONING_LEVEL; the new runtime
# defaults fail-closed to High, and the post-merge installer refresh persists it.
# shellcheck disable=SC1090
set -a
source "$WORKER_ENV_FILE"
set +a
export CHATGPT_REASONING_LEVEL="${CHATGPT_REASONING_LEVEL:-high}"
printf 'profile=%s\n' "${CHATGPT_BROWSER_PROFILE_DIR:-<missing>}"
printf 'cdp=%s\n' "${CHATGPT_CDP_URL:-<missing>}"
printf 'reasoning=%s\n' "$CHATGPT_REASONING_LEVEL"

if [[ "$CHATGPT_REASONING_LEVEL" != "high" ]]; then
  echo "Worker runtime explicitly requests '$CHATGPT_REASONING_LEVEL'; rollout requires high." >&2
  exit 1
fi

echo
echo "=== CHATGPT REASONING PREFLIGHT ==="
npm run preflight

echo
echo "=== RESULT ==="
echo "PASS: tests/lint/build/syntax completed and ChatGPT reasoning preflight verified."
echo "Next production evidence after service restart should include:"
echo "  [reasoning-preflight] verified required=high ..."
echo "  Superhuman ChatGPT consumer worker online as ..."
