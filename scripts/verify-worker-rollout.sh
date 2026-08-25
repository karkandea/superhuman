#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
WORKER_DIR="$ROOT/workers/chatgpt-consumer"
USER_WORKER_ENV_FILE="$HOME/.config/superhuman/consumer-worker.env"
ROOT_MANAGED_ENV_FILE="/etc/superhuman-ai/consumer-worker.env"

# Public Supabase client config is required while Next prerenders pages during the
# VPS verification build. These values are intentionally public/browser-safe.
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
# The worker package intentionally has no package-lock.json today, so npm ci is
# invalid here. Match the production installer without dirtying the checkout.
npm install --package-lock=false --no-audit --no-fund

echo
echo "=== WORKER STATIC SYNTAX ==="
node --check reasoning-level-preflight.mjs
node --check browser-transport.mjs
node --check checkpoint-observer.mjs
node --check composer-verification.mjs
node --check worker-v2.mjs

echo
echo "=== WORKER RUNTIME ENV ==="
if [[ -r "$USER_WORKER_ENV_FILE" ]]; then
  # Developer/non-root install path.
  # shellcheck disable=SC1090
  set -a
  source "$USER_WORKER_ENV_FILE"
  set +a
  RUNTIME_SOURCE="$USER_WORKER_ENV_FILE"
elif [[ -e "$ROOT_MANAGED_ENV_FILE" ]]; then
  # Production VPS is root-managed. The service user intentionally cannot read
  # /etc/superhuman-ai/consumer-worker.env because it contains the Supabase
  # backend key. Preflight needs only the dedicated browser/CDP settings, whose
  # canonical paths are defined by bootstrap-vps-root.sh.
  export CHATGPT_BROWSER_PROFILE_DIR="${CHATGPT_BROWSER_PROFILE_DIR:-/var/lib/superhuman-ai/chatgpt-profile}"
  export CHATGPT_CHROME_BIN="${CHATGPT_CHROME_BIN:-/usr/local/bin/superhuman-chrome}"
  export CHATGPT_CDP_PORT="${CHATGPT_CDP_PORT:-9222}"
  export CHATGPT_CDP_URL="${CHATGPT_CDP_URL:-http://127.0.0.1:9222}"
  export CHATGPT_HEADLESS="${CHATGPT_HEADLESS:-false}"
  RUNTIME_SOURCE="$ROOT_MANAGED_ENV_FILE (root-managed; browser-only canonical values used)"
else
  echo "No installed worker runtime was found." >&2
  echo "Checked: $USER_WORKER_ENV_FILE and $ROOT_MANAGED_ENV_FILE" >&2
  exit 1
fi

export CHATGPT_REASONING_LEVEL="${CHATGPT_REASONING_LEVEL:-high}"
export CHATGPT_REASONING_PREFLIGHT_TIMEOUT_MS="${CHATGPT_REASONING_PREFLIGHT_TIMEOUT_MS:-45000}"
printf 'runtime=%s\n' "$RUNTIME_SOURCE"
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
