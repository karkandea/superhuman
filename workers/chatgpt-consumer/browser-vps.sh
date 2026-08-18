#!/usr/bin/env bash
set -euo pipefail

DISPLAY_NUMBER="${SUPERHUMAN_DISPLAY_NUMBER:-99}"
DISPLAY=":$DISPLAY_NUMBER"

# systemd injects the root-only EnvironmentFile before dropping privileges to
# superhuman-ai. Do not source /etc/superhuman-ai/consumer-worker.env here: the
# service account intentionally cannot read that secret file directly.
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

# Clear stale X server state from an interrupted login helper/service restart.
rm -f "/tmp/.X${DISPLAY_NUMBER}-lock" 2>/dev/null || true

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
