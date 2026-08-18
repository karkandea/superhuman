#!/bin/bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This installer is for macOS only." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CONFIG_DIR="$HOME/.config/superhuman"
STATE_DIR="$HOME/.superhuman"
PROFILE_DIR="$STATE_DIR/chatgpt-profile"
LOG_DIR="$STATE_DIR/logs"
ENV_FILE="$CONFIG_DIR/consumer-worker.env"
PLIST="$HOME/Library/LaunchAgents/com.dualangka.superhuman-ai-worker.plist"
LABEL="com.dualangka.superhuman-ai-worker"
NODE_BIN="$(command -v node || true)"
NPM_BIN="$(command -v npm || true)"

if [[ -z "$NODE_BIN" || -z "$NPM_BIN" ]]; then
  echo "Node.js and npm are required." >&2
  exit 1
fi

mkdir -p "$CONFIG_DIR" "$PROFILE_DIR" "$LOG_DIR" "$HOME/Library/LaunchAgents"
chmod 700 "$CONFIG_DIR" "$STATE_DIR" "$PROFILE_DIR" "$LOG_DIR"

cd "$REPO_ROOT"
"$NPM_BIN" install
cd "$SCRIPT_DIR"
"$NPM_BIN" install
"$NPM_BIN" run install-browser

SUPABASE_URL="https://ispfhvdelglwvixaspza.supabase.co"
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$ENV_FILE"
fi

if [[ -z "${SUPABASE_SECRET_KEY:-}" ]]; then
  printf "Supabase secret/service-role key for project superhuman: "
  IFS= read -r -s SUPABASE_SECRET_KEY
  printf "\n"
fi

if [[ -z "$SUPABASE_SECRET_KEY" ]]; then
  echo "A Supabase secret/service-role key is required." >&2
  exit 1
fi

umask 077
cat > "$ENV_FILE" <<EOF
SUPABASE_URL=$SUPABASE_URL
SUPABASE_SECRET_KEY=$SUPABASE_SECRET_KEY
CHATGPT_BROWSER_PROFILE_DIR=$PROFILE_DIR
CHATGPT_HEADLESS=true
AI_WORKER_ID=superhuman-mac-$(id -u)
EOF
chmod 600 "$ENV_FILE"
unset SUPABASE_SECRET_KEY

printf "\nOpening the dedicated ChatGPT browser profile for one-time login...\n"
printf "Complete ChatGPT login in that browser. The setup exits automatically when the composer is detected.\n\n"
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
CHATGPT_HEADLESS=false "$NPM_BIN" run login

NODE_DIR="$(dirname "$NODE_BIN")"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-lc</string>
    <string>set -a; source '$ENV_FILE'; set +a; exec '$NPM_BIN' start</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$SCRIPT_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$NODE_DIR:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/consumer-worker.out.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/consumer-worker.err.log</string>
</dict>
</plist>
EOF

chmod 600 "$PLIST"
launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/$LABEL"

printf "\nSuperhuman AI worker installed and started.\n"
printf "Status: launchctl print gui/%s/%s\n" "$(id -u)" "$LABEL"
printf "Logs: %s\n" "$LOG_DIR"
printf "Worker env: %s (mode 600, outside repo)\n" "$ENV_FILE"
