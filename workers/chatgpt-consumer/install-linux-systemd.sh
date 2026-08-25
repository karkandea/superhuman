#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "This installer is for Linux VPS hosts only." >&2
  exit 1
fi

if [[ "${EUID}" -eq 0 ]]; then
  echo "Run this installer as the non-root user that owns the Superhuman checkout. It will use sudo only for OS packages/systemd." >&2
  exit 1
fi

if ! command -v sudo >/dev/null 2>&1; then
  echo "sudo is required." >&2
  exit 1
fi

if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemd is required." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CONFIG_DIR="$HOME/.config/superhuman"
STATE_DIR="$HOME/.superhuman"
PROFILE_DIR="$STATE_DIR/chatgpt-profile"
ENV_FILE="$CONFIG_DIR/consumer-worker.env"
CHROME_WRAPPER="$CONFIG_DIR/chrome-wrapper.sh"
SERVICE_NAME="superhuman-ai-worker.service"
SERVICE_FILE="/etc/systemd/system/$SERVICE_NAME"
SUPABASE_URL="https://ispfhvdelglwvixaspza.supabase.co"
CDP_PORT="9222"
CDP_URL="http://127.0.0.1:$CDP_PORT"

mkdir -p "$CONFIG_DIR" "$PROFILE_DIR" "$STATE_DIR/logs"
chmod 700 "$CONFIG_DIR" "$STATE_DIR" "$PROFILE_DIR" "$STATE_DIR/logs"

install_os_packages() {
  if ! command -v apt-get >/dev/null 2>&1; then
    echo "Automatic package install currently supports Debian/Ubuntu (apt-get)." >&2
    exit 1
  fi

  sudo apt-get update
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
    ca-certificates curl gnupg xvfb x11vnc novnc websockify
}

need_packages=0
for command_name in curl Xvfb x11vnc websockify; do
  command -v "$command_name" >/dev/null 2>&1 || need_packages=1
done
[[ -d /usr/share/novnc ]] || need_packages=1
if [[ "$need_packages" == "1" ]]; then
  install_os_packages
fi

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Node.js and npm are required on the VPS. Install Node.js 20+ for the Superhuman worker, then rerun this installer." >&2
  exit 1
fi

NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])")"
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  echo "Node.js 20+ is required; found $(node --version)." >&2
  exit 1
fi

CHROME_BIN="$(command -v google-chrome-stable || command -v google-chrome || true)"
if [[ -z "$CHROME_BIN" ]]; then
  if [[ "$(uname -m)" != "x86_64" ]]; then
    echo "Google Chrome auto-install is supported only on x86_64 VPS hosts." >&2
    exit 1
  fi
  tmp_deb="$(mktemp --suffix=.deb)"
  trap 'rm -f "$tmp_deb"' EXIT
  curl -fsSL "https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb" -o "$tmp_deb"
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y "$tmp_deb"
  rm -f "$tmp_deb"
  trap - EXIT
  CHROME_BIN="$(command -v google-chrome-stable || command -v google-chrome || true)"
fi

if [[ -z "$CHROME_BIN" ]]; then
  echo "Google Chrome could not be installed or located." >&2
  exit 1
fi

cat > "$CHROME_WRAPPER" <<EOF_CHROME
#!/usr/bin/env bash
exec "$CHROME_BIN" --disable-dev-shm-usage "\$@"
EOF_CHROME
chmod 700 "$CHROME_WRAPPER"
CHROME_BIN="$CHROME_WRAPPER"

cd "$REPO_ROOT"
npm install
cd "$SCRIPT_DIR"
npm install

normalize_key() {
  printf '%s' "$1" | tr -d '\r\n' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
}

validate_supabase_key() {
  local key="$1"
  local status

  [[ -n "$key" ]] || return 1
  [[ "$key" != sb_publishable_* ]] || return 2

  status="$({ printf 'header = "apikey: %s"\n' "$key"; } | \
    curl --config - -sS -o /dev/null -w '%{http_code}' "$SUPABASE_URL/rest/v1/" || true)"
  [[ "$status" == "200" ]]
}

if [[ -f "$ENV_FILE" && "${RESET_SUPABASE_KEY:-0}" != "1" ]]; then
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  if [[ -n "${SUPABASE_SECRET_KEY:-}" ]]; then
    SUPABASE_SECRET_KEY="$(normalize_key "$SUPABASE_SECRET_KEY")"
  fi
fi

if [[ "${RESET_SUPABASE_KEY:-0}" == "1" ]]; then
  unset SUPABASE_SECRET_KEY
fi

if [[ -n "${SUPABASE_SECRET_KEY:-}" ]]; then
  if ! validate_supabase_key "$SUPABASE_SECRET_KEY"; then
    echo "Stored Supabase worker key is invalid for project superhuman; requesting a replacement."
    unset SUPABASE_SECRET_KEY
  fi
fi

while [[ -z "${SUPABASE_SECRET_KEY:-}" ]]; do
  printf "Supabase elevated backend key for project superhuman: "
  IFS= read -r -s SUPABASE_SECRET_KEY
  printf "\n"
  SUPABASE_SECRET_KEY="$(normalize_key "$SUPABASE_SECRET_KEY")"

  if [[ -z "$SUPABASE_SECRET_KEY" ]]; then
    echo "A backend key is required." >&2
    continue
  fi

  if [[ "$SUPABASE_SECRET_KEY" == sb_publishable_* ]]; then
    echo "That is a publishable key, not a backend secret key." >&2
    unset SUPABASE_SECRET_KEY
    continue
  fi

  if ! validate_supabase_key "$SUPABASE_SECRET_KEY"; then
    echo "That key is not valid for project superhuman. Use a Secret key (sb_secret_...) or legacy service_role key from this project." >&2
    unset SUPABASE_SECRET_KEY
    continue
  fi
done

echo "Supabase worker credential validated for project superhuman."

umask 077
cat > "$ENV_FILE" <<EOF_ENV
SUPABASE_URL=$SUPABASE_URL
SUPABASE_SECRET_KEY=$SUPABASE_SECRET_KEY
CHATGPT_BROWSER_PROFILE_DIR=$PROFILE_DIR
CHATGPT_CHROME_BIN=$CHROME_BIN
CHATGPT_CDP_PORT=$CDP_PORT
CHATGPT_CDP_URL=$CDP_URL
CHATGPT_HEADLESS=true
CHATGPT_REASONING_LEVEL=high
CHATGPT_REASONING_PREFLIGHT_TIMEOUT_MS=45000
SUPERHUMAN_WORKER_ID=superhuman-vps-$(hostname -s)
EOF_ENV
chmod 600 "$ENV_FILE"
unset SUPABASE_SECRET_KEY

NPM_BIN="$(command -v npm)"
NODE_BIN="$(command -v node)"
NODE_DIR="$(dirname "$NODE_BIN")"
RUN_USER="$(id -un)"
RUN_GROUP="$(id -gn)"

sudo tee "$SERVICE_FILE" >/dev/null <<EOF_SERVICE
[Unit]
Description=Superhuman ChatGPT consumer AI worker
Wants=network-online.target
After=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=3

[Service]
Type=simple
User=$RUN_USER
Group=$RUN_GROUP
WorkingDirectory=$SCRIPT_DIR
EnvironmentFile=$ENV_FILE
Environment=PATH=$NODE_DIR:/usr/local/bin:/usr/bin:/bin
ExecStart=$NPM_BIN start
Restart=on-failure
RestartSec=5
RestartPreventExitStatus=78
TimeoutStopSec=20
KillMode=mixed
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full

[Install]
WantedBy=multi-user.target
EOF_SERVICE

sudo systemctl daemon-reload
sudo systemctl disable --now "$SERVICE_NAME" >/dev/null 2>&1 || true

cat <<EOF_DONE

VPS worker runtime installed, but intentionally NOT started before ChatGPT login.

Next, establish one-time ChatGPT login on this VPS:
  bash $SCRIPT_DIR/login-linux-novnc.sh

After login succeeds, that helper enables and starts:
  $SERVICE_NAME

Environment: $ENV_FILE (mode 600)
Browser profile: $PROFILE_DIR
Required ChatGPT reasoning level: high (startup blocks if selection cannot be verified)
EOF_DONE