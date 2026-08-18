#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${SUPERHUMAN_ENV_FILE:-/etc/superhuman-ai/consumer-worker.env}"
DISPLAY_NUMBER="${SUPERHUMAN_DISPLAY_NUMBER:-99}"
DISPLAY=":$DISPLAY_NUMBER"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Worker env not found: $ENV_FILE" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

: "${CHATGPT_BROWSER_PROFILE_DIR:?CHATGPT_BROWSER_PROFILE_DIR missing}"
: "${CHATGPT_CHROME_BIN:?CHATGPT_CHROME_BIN missing}"
: "${CHATGPT_CDP_PORT:?CHATGPT_CDP_PORT missing}"

cleanup() {
  [[ -n "${CHROME_PID:-}" ]] && kill "$CHROME_PID" >/dev/null 2>&1 || true
  [[ -n "${XVFB_PID:-}" ]] && kill "$XVFB_PID" >/dev/null 2>&1 || true
  wait >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

mkdir -p "$CHATGPT_BROWSER_PROFILE_DIR"
chmod 700 "$CHATGPT_BROWSER_PROFILE_DIR"

Xvfb "$DISPLAY" -screen 0 1440x900x24 -nolisten tcp &
XVFB_PID=$!
sleep 1

DISPLAY="$DISPLAY" "$CHATGPT_CHROME_BIN" \
  --remote-debugging-port="$CHATGPT_CDP_PORT" \
  --remote-debugging-address=127.0.0.1 \
  --user-data-dir="$CHATGPT_BROWSER_PROFILE_DIR" \
  --no-first-run \
  --no-default-browser-check \
  --disable-background-networking=false \
  "https://chatgpt.com/" &
CHROME_PID=$!

wait "$CHROME_PID"
