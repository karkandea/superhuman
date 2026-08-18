#!/usr/bin/env bash
set -euo pipefail

if [[ "$EUID" -ne 0 ]]; then
  echo "Run this helper as root on the VPS." >&2
  exit 1
fi

SERVICE_USER="${SUPERHUMAN_SERVICE_USER:-superhuman-ai}"
WORKER_SERVICE="superhuman-ai-worker.service"
BROWSER_SERVICE="superhuman-chatgpt-browser.service"
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
: "${CHATGPT_CDP_PORT:?CHATGPT_CDP_PORT missing}"
: "${CHATGPT_CDP_URL:?CHATGPT_CDP_URL missing}"

stop_remote_desktop() {
  pkill -u "$SERVICE_USER" -f -- "x11vnc.*$VNC_PORT" >/dev/null 2>&1 || true
  pkill -u "$SERVICE_USER" -f -- "websockify.*$NOVNC_PORT" >/dev/null 2>&1 || true
}

cleanup() {
  stop_remote_desktop
}
trap cleanup EXIT INT TERM

systemctl stop "$WORKER_SERVICE" >/dev/null 2>&1 || true
systemctl enable --now "$BROWSER_SERVICE"
sleep 3

mkdir -p "$LOG_DIR"
chown -R "$SERVICE_USER:$SERVICE_USER" "$STATE_DIR"
chmod 700 "$STATE_DIR" "$LOG_DIR" "$CHATGPT_BROWSER_PROFILE_DIR"

stop_remote_desktop
runuser -u "$SERVICE_USER" -- env HOME="$SERVICE_HOME" bash -lc \
  "exec x11vnc -display '$DISPLAY' -localhost -forever -shared -nopw -rfbport '$VNC_PORT' >>'$LOG_DIR/x11vnc.log' 2>&1" &
runuser -u "$SERVICE_USER" -- env HOME="$SERVICE_HOME" bash -lc \
  "exec websockify --web=/usr/share/novnc '127.0.0.1:$NOVNC_PORT' '127.0.0.1:$VNC_PORT' >>'$LOG_DIR/novnc.log' 2>&1" &
sleep 1

cat <<EOF_LOGIN

Persistent Chrome is running on the VPS inside Xvfb.
noVNC is temporarily bound ONLY to VPS localhost; port $NOVNC_PORT is not exposed publicly.

On your Mac, open a SECOND terminal and run:

  ssh -N -L $NOVNC_PORT:127.0.0.1:$NOVNC_PORT root@103.175.207.127

Then open in your normal Mac browser:

  http://127.0.0.1:$NOVNC_PORT/vnc.html?autoconnect=1&resize=remote

Log into chatgpt.com inside that remote Chrome until the normal ChatGPT composer is visible.
Then return to THIS VPS terminal and press Enter.
EOF_LOGIN

IFS= read -r

echo "Verifying the persistent VPS ChatGPT session through local CDP..."
runuser -u "$SERVICE_USER" -- env \
  HOME="$SERVICE_HOME" \
  CHATGPT_BROWSER_PROFILE_DIR="$CHATGPT_BROWSER_PROFILE_DIR" \
  CHATGPT_CDP_PORT="$CHATGPT_CDP_PORT" \
  CHATGPT_CDP_URL="$CHATGPT_CDP_URL" \
  CHATGPT_HEADLESS=false \
  bash -lc "cd '$WORKER_DIR' && npm run login"

echo "ChatGPT session verified. Closing noVNC while keeping Chrome/Xvfb alive..."
stop_remote_desktop

echo "Starting persistent AI worker..."
systemctl enable --now "$WORKER_SERVICE"
sleep 2

systemctl --no-pager --full status "$BROWSER_SERVICE" | sed -n '1,18p'
systemctl --no-pager --full status "$WORKER_SERVICE" | sed -n '1,22p'

trap - EXIT INT TERM

cat <<EOF_DONE

Superhuman VPS AI runtime is active.
- Chrome remains headful inside private Xvfb 24/7.
- noVNC is OFF except during login/re-login.
- AI worker attaches to Chrome through localhost CDP.
- Both services restart automatically after crashes/reboots.

Status:
  systemctl status $BROWSER_SERVICE $WORKER_SERVICE

Logs:
  journalctl -u $BROWSER_SERVICE -u $WORKER_SERVICE -f

Re-login after blocked_auth:
  bash $WORKER_DIR/login-vps-root.sh
EOF_DONE
