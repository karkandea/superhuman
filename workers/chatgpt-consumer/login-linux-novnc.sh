#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "This login helper is for Linux VPS hosts only." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$HOME/.config/superhuman/consumer-worker.env"
SERVICE_NAME="superhuman-ai-worker.service"
DISPLAY_NUMBER="${SUPERHUMAN_VNC_DISPLAY:-99}"
DISPLAY=":$DISPLAY_NUMBER"
VNC_PORT="${SUPERHUMAN_VNC_PORT:-5901}"
NOVNC_PORT="${SUPERHUMAN_NOVNC_PORT:-6080}"
XVFB_LOG="$HOME/.superhuman/logs/xvfb.log"
VNC_LOG="$HOME/.superhuman/logs/x11vnc.log"
NOVNC_LOG="$HOME/.superhuman/logs/novnc.log"
CHROME_LOG="$HOME/.superhuman/logs/chrome-login.log"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Worker env not found. Run install-linux-systemd.sh first." >&2
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
  for pid_var in CHROME_PID NOVNC_PID VNC_PID XVFB_PID; do
    pid="${!pid_var:-}"
    if [[ -n "$pid" ]]; then
      kill "$pid" >/dev/null 2>&1 || true
    fi
  done
}
trap cleanup EXIT INT TERM

sudo systemctl stop "$SERVICE_NAME" >/dev/null 2>&1 || true
pkill -u "$(id -u)" -f -- "--user-data-dir=$CHATGPT_BROWSER_PROFILE_DIR" >/dev/null 2>&1 || true
pkill -u "$(id -u)" -f -- "Xvfb :$DISPLAY_NUMBER" >/dev/null 2>&1 || true
pkill -u "$(id -u)" -f -- "x11vnc.*$VNC_PORT" >/dev/null 2>&1 || true
pkill -u "$(id -u)" -f -- "websockify.*$NOVNC_PORT" >/dev/null 2>&1 || true
sleep 1

mkdir -p "$HOME/.superhuman/logs" "$CHATGPT_BROWSER_PROFILE_DIR"
chmod 700 "$HOME/.superhuman" "$HOME/.superhuman/logs" "$CHATGPT_BROWSER_PROFILE_DIR"

Xvfb "$DISPLAY" -screen 0 1440x900x24 -nolisten tcp >"$XVFB_LOG" 2>&1 &
XVFB_PID=$!
sleep 1

x11vnc -display "$DISPLAY" -localhost -forever -shared -nopw -rfbport "$VNC_PORT" >"$VNC_LOG" 2>&1 &
VNC_PID=$!

NOVNC_WEB="/usr/share/novnc"
if [[ ! -d "$NOVNC_WEB" ]]; then
  echo "noVNC web assets not found at $NOVNC_WEB" >&2
  exit 1
fi
websockify --web="$NOVNC_WEB" "127.0.0.1:$NOVNC_PORT" "127.0.0.1:$VNC_PORT" >"$NOVNC_LOG" 2>&1 &
NOVNC_PID=$!

DISPLAY="$DISPLAY" "$CHATGPT_CHROME_BIN" \
  --remote-debugging-port="$CHATGPT_CDP_PORT" \
  --remote-debugging-address=127.0.0.1 \
  --user-data-dir="$CHATGPT_BROWSER_PROFILE_DIR" \
  --no-first-run \
  --no-default-browser-check \
  "https://chatgpt.com/" >"$CHROME_LOG" 2>&1 &
CHROME_PID=$!

cat <<EOF_LOGIN

Dedicated Chrome is running on the VPS in a private virtual display.
Nothing is exposed publicly; noVNC listens only on 127.0.0.1:$NOVNC_PORT.

On your Mac, open a SECOND terminal and create an SSH tunnel to this SAME VPS:

  ssh -N -L $NOVNC_PORT:127.0.0.1:$NOVNC_PORT <your-vps-ssh-host>

Then open in your normal Mac browser:

  http://127.0.0.1:$NOVNC_PORT/vnc.html?autoconnect=1&resize=remote

Inside that noVNC screen, log into chatgpt.com normally. Do not paste ChatGPT credentials into SSH or this script.
When the normal ChatGPT composer is visible, return to THIS terminal and press Enter.
EOF_LOGIN

IFS= read -r

echo "Verifying the live ChatGPT session through local Chrome CDP..."
cd "$SCRIPT_DIR"
CHATGPT_HEADLESS=false npm run login

echo "ChatGPT session verified. Stopping the temporary VNC display..."
cleanup
trap - EXIT INT TERM
sleep 2

echo "Verifying that the saved profile also works headlessly..."
CHATGPT_HEADLESS=true npm run login

echo "Headless ChatGPT session verified. Starting the 24/7 systemd worker..."
sudo systemctl enable --now "$SERVICE_NAME"
sleep 2
sudo systemctl --no-pager --full status "$SERVICE_NAME" | sed -n '1,20p'

cat <<EOF_DONE

Superhuman VPS AI worker is installed and running 24/7 under systemd.

Status:
  sudo systemctl status $SERVICE_NAME

Live logs:
  sudo journalctl -u $SERVICE_NAME -f

If ChatGPT later becomes blocked_auth, rerun:
  bash $SCRIPT_DIR/login-linux-novnc.sh
EOF_DONE
