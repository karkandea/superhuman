#!/usr/bin/env bash
set -euo pipefail

if [[ "$EUID" -ne 0 ]]; then
  echo "Run this helper as root on the VPS." >&2
  exit 1
fi

SERVICE_USER="${SUPERHUMAN_SERVICE_USER:-superhuman-ai}"
SERVICE_NAME="superhuman-ai-worker.service"
REPO_DIR="${SUPERHUMAN_REPO_DIR:-/opt/superhuman}"
WORKER_DIR="$REPO_DIR/workers/chatgpt-consumer"
ENV_FILE="/etc/superhuman-ai/consumer-worker.env"
STATE_DIR="/var/lib/superhuman-ai"
LOG_DIR="$STATE_DIR/logs"
DISPLAY_NUMBER="${SUPERHUMAN_VNC_DISPLAY:-99}"
DISPLAY=":$DISPLAY_NUMBER"
VNC_PORT="${SUPERHUMAN_VNC_PORT:-5901}"
NOVNC_PORT="${SUPERHUMAN_NOVNC_PORT:-6080}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Worker env not found. Run bootstrap-vps-root.sh first." >&2
  exit 1
fi
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  echo "Service user $SERVICE_USER does not exist." >&2
  exit 1
fi

SERVICE_HOME="$(getent passwd "$SERVICE_USER" | cut -d: -f6)"
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

: "${CHATGPT_BROWSER_PROFILE_DIR:?CHATGPT_BROWSER_PROFILE_DIR missing}"
: "${CHATGPT_CHROME_BIN:?CHATGPT_CHROME_BIN missing}"
: "${CHATGPT_CDP_PORT:?CHATGPT_CDP_PORT missing}"
: "${CHATGPT_CDP_URL:?CHATGPT_CDP_URL missing}"

kill_runtime_processes() {
  pkill -u "$SERVICE_USER" -f -- "--user-data-dir=$CHATGPT_BROWSER_PROFILE_DIR" >/dev/null 2>&1 || true
  pkill -u "$SERVICE_USER" -f -- "Xvfb :$DISPLAY_NUMBER" >/dev/null 2>&1 || true
  pkill -u "$SERVICE_USER" -f -- "x11vnc.*$VNC_PORT" >/dev/null 2>&1 || true
  pkill -u "$SERVICE_USER" -f -- "websockify.*$NOVNC_PORT" >/dev/null 2>&1 || true
}

cleanup() {
  kill_runtime_processes
}
trap cleanup EXIT INT TERM

systemctl stop "$SERVICE_NAME" >/dev/null 2>&1 || true
kill_runtime_processes
sleep 1

mkdir -p "$LOG_DIR" "$CHATGPT_BROWSER_PROFILE_DIR"
chown -R "$SERVICE_USER:$SERVICE_USER" "$STATE_DIR"
chmod 700 "$STATE_DIR" "$LOG_DIR" "$CHATGPT_BROWSER_PROFILE_DIR"

runuser -u "$SERVICE_USER" -- env HOME="$SERVICE_HOME" bash -lc \
  "exec Xvfb '$DISPLAY' -screen 0 1440x900x24 -nolisten tcp >>'$LOG_DIR/xvfb.log' 2>&1" &
sleep 1
runuser -u "$SERVICE_USER" -- env HOME="$SERVICE_HOME" bash -lc \
  "exec x11vnc -display '$DISPLAY' -localhost -forever -shared -nopw -rfbport '$VNC_PORT' >>'$LOG_DIR/x11vnc.log' 2>&1" &
runuser -u "$SERVICE_USER" -- env HOME="$SERVICE_HOME" bash -lc \
  "exec websockify --web=/usr/share/novnc '127.0.0.1:$NOVNC_PORT' '127.0.0.1:$VNC_PORT' >>'$LOG_DIR/novnc.log' 2>&1" &
runuser -u "$SERVICE_USER" -- env HOME="$SERVICE_HOME" DISPLAY="$DISPLAY" bash -lc \
  "exec '$CHATGPT_CHROME_BIN' --remote-debugging-port='$CHATGPT_CDP_PORT' --remote-debugging-address=127.0.0.1 --user-data-dir='$CHATGPT_BROWSER_PROFILE_DIR' --no-first-run --no-default-browser-check 'https://chatgpt.com/' >>'$LOG_DIR/chrome-login.log' 2>&1" &

cat <<EOF_LOGIN

Dedicated Chrome is now running privately on the VPS.
noVNC is bound ONLY to VPS localhost; port $NOVNC_PORT is not exposed to the internet.

On your Mac, open a SECOND terminal and run:

  ssh -N -L $NOVNC_PORT:127.0.0.1:$NOVNC_PORT root@103.175.207.127

Then open this in your normal Mac browser:

  http://127.0.0.1:$NOVNC_PORT/vnc.html?autoconnect=1&resize=remote

Log into chatgpt.com inside that remote Chrome until the normal ChatGPT composer is visible.
Then return to THIS VPS terminal and press Enter.
EOF_LOGIN

IFS= read -r

echo "Verifying the live ChatGPT session through local CDP..."
runuser -u "$SERVICE_USER" -- env \
  HOME="$SERVICE_HOME" \
  CHATGPT_BROWSER_PROFILE_DIR="$CHATGPT_BROWSER_PROFILE_DIR" \
  CHATGPT_CHROME_BIN="$CHATGPT_CHROME_BIN" \
  CHATGPT_CDP_PORT="$CHATGPT_CDP_PORT" \
  CHATGPT_CDP_URL="$CHATGPT_CDP_URL" \
  CHATGPT_HEADLESS=false \
  bash -lc "cd '$WORKER_DIR' && npm run login"

echo "Visual session verified. Closing the temporary remote desktop..."
kill_runtime_processes
sleep 3

echo "Verifying the same saved ChatGPT profile headlessly..."
runuser -u "$SERVICE_USER" -- env \
  HOME="$SERVICE_HOME" \
  CHATGPT_BROWSER_PROFILE_DIR="$CHATGPT_BROWSER_PROFILE_DIR" \
  CHATGPT_CHROME_BIN="$CHATGPT_CHROME_BIN" \
  CHATGPT_CDP_PORT="$CHATGPT_CDP_PORT" \
  CHATGPT_CDP_URL="$CHATGPT_CDP_URL" \
  CHATGPT_HEADLESS=true \
  bash -lc "cd '$WORKER_DIR' && npm run login"

echo "Headless ChatGPT session verified. Starting persistent worker..."
systemctl enable --now "$SERVICE_NAME"
sleep 2
systemctl --no-pager --full status "$SERVICE_NAME" | sed -n '1,24p'

trap - EXIT INT TERM

cat <<EOF_DONE

Superhuman AI worker is now managed by systemd on the VPS.
It survives SSH disconnects and VPS reboots.

Status:
  systemctl status $SERVICE_NAME

Live logs:
  journalctl -u $SERVICE_NAME -f

Re-login after blocked_auth:
  bash $WORKER_DIR/login-vps-root.sh
EOF_DONE
