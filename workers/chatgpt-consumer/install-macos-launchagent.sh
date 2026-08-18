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
CHROME_BIN="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
CDP_PORT="9222"
CDP_URL="http://127.0.0.1:$CDP_PORT"

if [[ ! -x "$CHROME_BIN" ]]; then
  CHROME_BIN="$HOME/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
fi

if [[ -z "$NODE_BIN" || -z "$NPM_BIN" ]]; then
  echo "Node.js and npm are required." >&2
  exit 1
fi

if [[ ! -x "$CHROME_BIN" ]]; then
  echo "Google Chrome is required for the one-time ChatGPT sign-in." >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required to validate the Supabase worker credential." >&2
  exit 1
fi

mkdir -p "$CONFIG_DIR" "$PROFILE_DIR" "$LOG_DIR" "$HOME/Library/LaunchAgents"
chmod 700 "$CONFIG_DIR" "$STATE_DIR" "$PROFILE_DIR" "$LOG_DIR"

cd "$REPO_ROOT"
"$NPM_BIN" install
cd "$SCRIPT_DIR"
"$NPM_BIN" install

SUPABASE_URL="https://ispfhvdelglwvixaspza.supabase.co"
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$ENV_FILE"
fi

normalize_supabase_key() {
  local key="$1"

  # Clipboard content can contain a trailing carriage return or surrounding
  # whitespace. Remove only surrounding whitespace; never print the key.
  key="${key//$'\r'/}"
  while [[ "$key" == [[:space:]]* ]]; do
    key="${key#?}"
  done
  while [[ "$key" == *[[:space:]] ]]; do
    key="${key%?}"
  done

  printf '%s' "$key"
}

validate_supabase_key() {
  local key
  local status

  key="$(normalize_supabase_key "$1")"
  [[ -n "$key" ]] || return 1

  # A publishable key can reach the API gateway but is intentionally not
  # privileged enough for this backend worker.
  if [[ "$key" == sb_publishable_* ]]; then
    return 1
  fi

  # Feed the API key to curl through stdin config so the secret is not placed
  # directly in the process argument list or printed to stdout/stderr.
  status="$({ printf 'header = "apikey: %s"\n' "$key"; } | \
    curl --config - -sS -o /dev/null -w '%{http_code}' "$SUPABASE_URL/rest/v1/" || true)"

  [[ "$status" == "200" ]]
}

if [[ "${RESET_SUPABASE_KEY:-0}" == "1" ]]; then
  unset SUPABASE_SECRET_KEY
fi

if [[ -n "${SUPABASE_SECRET_KEY:-}" ]]; then
  SUPABASE_SECRET_KEY="$(normalize_supabase_key "$SUPABASE_SECRET_KEY")"
fi

if [[ -n "${SUPABASE_SECRET_KEY:-}" ]] && ! validate_supabase_key "$SUPABASE_SECRET_KEY"; then
  printf "Stored Supabase worker key is invalid for project superhuman; requesting a replacement.\n"
  unset SUPABASE_SECRET_KEY
fi

while [[ -z "${SUPABASE_SECRET_KEY:-}" ]]; do
  printf "Supabase elevated backend key for project superhuman: "
  IFS= read -r -s SUPABASE_SECRET_KEY
  printf "\n"

  SUPABASE_SECRET_KEY="$(normalize_supabase_key "$SUPABASE_SECRET_KEY")"

  if [[ -z "$SUPABASE_SECRET_KEY" ]]; then
    echo "A Supabase backend key is required." >&2
    unset SUPABASE_SECRET_KEY
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

printf "Supabase worker credential validated for project superhuman.\n"

umask 077
cat > "$ENV_FILE" <<EOF
SUPABASE_URL=$SUPABASE_URL
SUPABASE_SECRET_KEY=$SUPABASE_SECRET_KEY
CHATGPT_BROWSER_PROFILE_DIR=$PROFILE_DIR
CHATGPT_CHROME_BIN="$CHROME_BIN"
CHATGPT_CDP_PORT=$CDP_PORT
CHATGPT_CDP_URL=$CDP_URL
CHATGPT_HEADLESS=true
SUPERHUMAN_WORKER_ID=superhuman-mac-$(id -u)
EOF
chmod 600 "$ENV_FILE"
unset SUPABASE_SECRET_KEY

printf "\nOpening Google Chrome normally for one-time ChatGPT login...\n"
printf "This Chrome instance uses only the dedicated Superhuman profile:\n%s\n\n" "$PROFILE_DIR"
printf "Sign in to ChatGPT completely. When you can see the normal ChatGPT composer, return to this terminal and press Enter.\n"
printf "Do not close this dedicated Chrome window yet; the worker will verify the SAME live session.\n\n"

"$CHROME_BIN" \
  --remote-debugging-port="$CDP_PORT" \
  --remote-debugging-address=127.0.0.1 \
  --user-data-dir="$PROFILE_DIR" \
  --no-first-run \
  --no-default-browser-check \
  "https://chatgpt.com/" >/dev/null 2>&1 &

IFS= read -r

printf "Verifying the live ChatGPT session through Chrome CDP...\n\n"
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
printf "Keep the dedicated Chrome window open for this first run. If it is later closed/rebooted, the worker will relaunch the same profile headlessly.\n"
printf "Status: launchctl print gui/%s/%s\n" "$(id -u)" "$LABEL"
printf "Logs: %s\n" "$LOG_DIR"
printf "Worker env: %s (mode 600, outside repo)\n" "$ENV_FILE"
