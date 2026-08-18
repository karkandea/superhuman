#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "Linux is required." >&2
  exit 1
fi

if [[ "$EUID" -ne 0 ]]; then
  echo "Run this bootstrap as root on the VPS." >&2
  exit 1
fi

if ! command -v apt-get >/dev/null 2>&1; then
  echo "This bootstrap currently supports Debian/Ubuntu hosts." >&2
  exit 1
fi

SERVICE_USER="${SUPERHUMAN_SERVICE_USER:-superhuman-ai}"
WORKER_SERVICE="superhuman-ai-worker.service"
BROWSER_SERVICE="superhuman-chatgpt-browser.service"
REPO_URL="https://github.com/karkandea/superhuman.git"
REPO_DIR="${SUPERHUMAN_REPO_DIR:-/opt/superhuman}"
WORKER_DIR="$REPO_DIR/workers/chatgpt-consumer"
CONFIG_DIR="/etc/superhuman-ai"
ENV_FILE="$CONFIG_DIR/consumer-worker.env"
STATE_DIR="/var/lib/superhuman-ai"
PROFILE_DIR="$STATE_DIR/chatgpt-profile"
LOG_DIR="$STATE_DIR/logs"
CHROME_WRAPPER="/usr/local/bin/superhuman-chrome"
WORKER_SERVICE_FILE="/etc/systemd/system/$WORKER_SERVICE"
BROWSER_SERVICE_FILE="/etc/systemd/system/$BROWSER_SERVICE"
SUPABASE_URL="https://ispfhvdelglwvixaspza.supabase.co"
CDP_PORT="9222"
CDP_URL="http://127.0.0.1:$CDP_PORT"

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl gnupg git xvfb x11vnc novnc websockify

node_major=0
if command -v node >/dev/null 2>&1; then
  node_major="$(node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || echo 0)"
fi
if [[ "$node_major" -lt 20 ]]; then
  echo "Installing Node.js 22 runtime..."
  nodesource_setup="$(mktemp)"
  curl -fsSL https://deb.nodesource.com/setup_22.x -o "$nodesource_setup"
  bash "$nodesource_setup"
  rm -f "$nodesource_setup"
  apt-get install -y nodejs
fi

CHROME_REAL="$(command -v google-chrome-stable || command -v google-chrome || true)"
if [[ -z "$CHROME_REAL" ]]; then
  if [[ "$(uname -m)" != "x86_64" ]]; then
    echo "Automatic Google Chrome install requires x86_64." >&2
    exit 1
  fi
  chrome_deb="$(mktemp --suffix=.deb)"
  curl -fsSL https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -o "$chrome_deb"
  apt-get install -y "$chrome_deb"
  rm -f "$chrome_deb"
  CHROME_REAL="$(command -v google-chrome-stable || command -v google-chrome || true)"
fi

cat > "$CHROME_WRAPPER" <<EOF_CHROME
#!/usr/bin/env bash
exec "$CHROME_REAL" --disable-dev-shm-usage "\$@"
EOF_CHROME
chmod 755 "$CHROME_WRAPPER"

if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash "$SERVICE_USER"
fi
SERVICE_HOME="$(getent passwd "$SERVICE_USER" | cut -d: -f6)"

mkdir -p "$CONFIG_DIR" "$PROFILE_DIR" "$LOG_DIR"
chown -R "$SERVICE_USER:$SERVICE_USER" "$STATE_DIR"
chmod 700 "$STATE_DIR" "$PROFILE_DIR" "$LOG_DIR" "$CONFIG_DIR"

if [[ -d "$REPO_DIR/.git" ]]; then
  chown -R "$SERVICE_USER:$SERVICE_USER" "$REPO_DIR"
  runuser -u "$SERVICE_USER" -- env HOME="$SERVICE_HOME" git -C "$REPO_DIR" fetch --depth=1 origin main
  runuser -u "$SERVICE_USER" -- env HOME="$SERVICE_HOME" git -C "$REPO_DIR" reset --hard origin/main
else
  rm -rf "$REPO_DIR"
  install -d -o "$SERVICE_USER" -g "$SERVICE_USER" "$REPO_DIR"
  runuser -u "$SERVICE_USER" -- env HOME="$SERVICE_HOME" git clone --depth=1 --branch main "$REPO_URL" "$REPO_DIR"
fi

runuser -u "$SERVICE_USER" -- env HOME="$SERVICE_HOME" bash -lc "cd '$REPO_DIR' && npm install --package-lock=false --no-audit --no-fund"
runuser -u "$SERVICE_USER" -- env HOME="$SERVICE_HOME" bash -lc "cd '$WORKER_DIR' && npm install --package-lock=false --no-audit --no-fund"

normalize_key() {
  printf '%s' "$1" | tr -d '\r\n' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
}

validate_supabase_key() {
  local key="$1"
  local status
  [[ -n "$key" ]] || return 1
  [[ "$key" != sb_publishable_* ]] || return 2
  status="$({ printf 'header = "apikey: %s"\n' "$key"; } | curl --config - -sS -o /dev/null -w '%{http_code}' "$SUPABASE_URL/rest/v1/" || true)"
  [[ "$status" == "200" ]]
}

SUPABASE_SECRET_KEY=""
if [[ -f "$ENV_FILE" && "${RESET_SUPABASE_KEY:-0}" != "1" ]]; then
  existing_key="$(awk -F= '$1 == "SUPABASE_SECRET_KEY" {sub(/^SUPABASE_SECRET_KEY=/, ""); print; exit}' "$ENV_FILE" || true)"
  existing_key="$(normalize_key "$existing_key")"
  if validate_supabase_key "$existing_key"; then
    SUPABASE_SECRET_KEY="$existing_key"
    echo "Stored Supabase worker credential is still valid."
  fi
fi

while [[ -z "$SUPABASE_SECRET_KEY" ]]; do
  printf "Supabase elevated backend key for project superhuman: "
  IFS= read -r -s SUPABASE_SECRET_KEY
  printf "\n"
  SUPABASE_SECRET_KEY="$(normalize_key "$SUPABASE_SECRET_KEY")"
  if [[ "$SUPABASE_SECRET_KEY" == sb_publishable_* ]]; then
    echo "That is a publishable key, not a backend secret key." >&2
    SUPABASE_SECRET_KEY=""
    continue
  fi
  if ! validate_supabase_key "$SUPABASE_SECRET_KEY"; then
    echo "That key is not valid for project superhuman. Use sb_secret_... or the legacy service_role key from this project." >&2
    SUPABASE_SECRET_KEY=""
    continue
  fi
done

echo "Supabase worker credential validated for project superhuman."

umask 077
cat > "$ENV_FILE" <<EOF_ENV
SUPABASE_URL=$SUPABASE_URL
SUPABASE_SECRET_KEY=$SUPABASE_SECRET_KEY
CHATGPT_BROWSER_PROFILE_DIR=$PROFILE_DIR
CHATGPT_CHROME_BIN=$CHROME_WRAPPER
CHATGPT_CDP_PORT=$CDP_PORT
CHATGPT_CDP_URL=$CDP_URL
CHATGPT_HEADLESS=false
SUPERHUMAN_WORKER_ID=superhuman-vps-$(hostname -s)
EOF_ENV
chmod 600 "$ENV_FILE"
unset SUPABASE_SECRET_KEY

NODE_BIN="$(command -v node)"
NPM_BIN="$(command -v npm)"
NODE_DIR="$(dirname "$NODE_BIN")"

cat > "$BROWSER_SERVICE_FILE" <<EOF_BROWSER
[Unit]
Description=Superhuman persistent ChatGPT browser
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$WORKER_DIR
EnvironmentFile=$ENV_FILE
Environment=HOME=$SERVICE_HOME
Environment=PATH=$NODE_DIR:/usr/local/bin:/usr/bin:/bin
ExecStart=/bin/bash $WORKER_DIR/browser-vps.sh
Restart=always
RestartSec=5
TimeoutStopSec=20
KillMode=mixed
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full

[Install]
WantedBy=multi-user.target
EOF_BROWSER

cat > "$WORKER_SERVICE_FILE" <<EOF_WORKER
[Unit]
Description=Superhuman ChatGPT consumer AI worker
Requires=$BROWSER_SERVICE
After=network-online.target $BROWSER_SERVICE

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$WORKER_DIR
EnvironmentFile=$ENV_FILE
Environment=HOME=$SERVICE_HOME
Environment=PATH=$NODE_DIR:/usr/local/bin:/usr/bin:/bin
ExecStart=$NPM_BIN start
Restart=always
RestartSec=5
TimeoutStopSec=20
KillMode=mixed
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full

[Install]
WantedBy=multi-user.target
EOF_WORKER

systemctl daemon-reload
systemctl disable --now "$WORKER_SERVICE" "$BROWSER_SERVICE" >/dev/null 2>&1 || true

cat <<EOF_READY

VPS runtime bootstrap complete.
- Service user: $SERVICE_USER
- Repo: $REPO_DIR
- Browser profile: $PROFILE_DIR
- Browser service: $BROWSER_SERVICE
- Worker service: $WORKER_SERVICE

Starting one-time private ChatGPT login setup now...
EOF_READY

exec bash "$WORKER_DIR/login-vps-root.sh"
