#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "Linux is required." >&2
  exit 1
fi

if [[ "$EUID" -ne 0 ]]; then
  echo "Run this upgrade as root on the VPS." >&2
  exit 1
fi

SERVICE_USER="${SUPERHUMAN_SERVICE_USER:-superhuman-ai}"
WORKER_SERVICE="superhuman-ai-worker.service"
BROWSER_SERVICE="superhuman-chatgpt-browser.service"
REPO_DIR="${SUPERHUMAN_REPO_DIR:-/opt/superhuman}"
WORKER_DIR="$REPO_DIR/workers/chatgpt-consumer"
ENV_FILE="/etc/superhuman-ai/consumer-worker.env"
DROPIN_DIR="/etc/systemd/system/$WORKER_SERVICE.d"
DROPIN_FILE="$DROPIN_DIR/reasoning-policy.conf"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Production worker env is missing: $ENV_FILE" >&2
  exit 1
fi
if [[ ! -d "$WORKER_DIR" ]]; then
  echo "Worker checkout is missing: $WORKER_DIR" >&2
  exit 1
fi
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  echo "Service user does not exist: $SERVICE_USER" >&2
  exit 1
fi

SERVICE_HOME="$(getent passwd "$SERVICE_USER" | cut -d: -f6)"

set_env_value() {
  local key="$1"
  local value="$2"
  local tmp
  tmp="$(mktemp)"
  awk -v key="$key" -v value="$value" '
    BEGIN { found = 0 }
    index($0, key "=") == 1 {
      if (!found) print key "=" value
      found = 1
      next
    }
    { print }
    END { if (!found) print key "=" value }
  ' "$ENV_FILE" > "$tmp"
  chown --reference="$ENV_FILE" "$tmp"
  chmod --reference="$ENV_FILE" "$tmp"
  mv "$tmp" "$ENV_FILE"
}

set_env_value CHATGPT_REASONING_LEVEL high
set_env_value CHATGPT_REASONING_PREFLIGHT_TIMEOUT_MS 45000

mkdir -p "$DROPIN_DIR"
cat > "$DROPIN_FILE" <<'EOF_DROPIN'
[Unit]
StartLimitIntervalSec=300
StartLimitBurst=3

[Service]
RestartPreventExitStatus=78
EOF_DROPIN
chmod 644 "$DROPIN_FILE"

# Load runtime values as root. Do not print or pass the Supabase backend key.
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

: "${CHATGPT_BROWSER_PROFILE_DIR:?CHATGPT_BROWSER_PROFILE_DIR missing}"
: "${CHATGPT_CDP_PORT:?CHATGPT_CDP_PORT missing}"
: "${CHATGPT_CDP_URL:?CHATGPT_CDP_URL missing}"
: "${CHATGPT_CHROME_BIN:?CHATGPT_CHROME_BIN missing}"

runuser -u "$SERVICE_USER" -- env HOME="$SERVICE_HOME" bash -lc \
  "cd '$WORKER_DIR' && npm install --package-lock=false --no-audit --no-fund"

systemctl daemon-reload
systemctl enable --now "$BROWSER_SERVICE"
sleep 2

echo "Verifying ChatGPT High on the existing dedicated browser profile..."
runuser -u "$SERVICE_USER" -- env \
  HOME="$SERVICE_HOME" \
  CHATGPT_BROWSER_PROFILE_DIR="$CHATGPT_BROWSER_PROFILE_DIR" \
  CHATGPT_CHROME_BIN="$CHATGPT_CHROME_BIN" \
  CHATGPT_CDP_PORT="$CHATGPT_CDP_PORT" \
  CHATGPT_CDP_URL="$CHATGPT_CDP_URL" \
  CHATGPT_HEADLESS="${CHATGPT_HEADLESS:-false}" \
  CHATGPT_REASONING_LEVEL=high \
  CHATGPT_REASONING_PREFLIGHT_TIMEOUT_MS=45000 \
  bash -lc "cd '$WORKER_DIR' && npm run preflight"

echo "High verified. Restarting production worker..."
systemctl enable "$WORKER_SERVICE" >/dev/null
systemctl restart "$WORKER_SERVICE"
sleep 3

if ! systemctl is-active --quiet "$WORKER_SERVICE"; then
  echo "Worker did not remain active after upgrade." >&2
  journalctl -u "$WORKER_SERVICE" --since "2 minutes ago" --no-pager | tail -80 >&2
  exit 1
fi

printf 'reasoning=%s\n' "$(awk -F= '$1 == "CHATGPT_REASONING_LEVEL" {print $2; exit}' "$ENV_FILE")"
printf 'worker=%s\n' "$(systemctl is-active "$WORKER_SERVICE")"
printf 'browser=%s\n' "$(systemctl is-active "$BROWSER_SERVICE")"

echo "Recent reasoning/worker evidence:"
journalctl -u "$WORKER_SERVICE" --since "2 minutes ago" --no-pager \
  | grep -E "reasoning-preflight|Superhuman ChatGPT consumer worker|consumer-output-repair" \
  | tail -30 || true

echo "VPS reasoning policy upgrade complete."
