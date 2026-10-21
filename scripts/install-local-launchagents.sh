#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TOKEN="${MOBILE_TYPER_TOKEN:-}"
PORT="${PORT:-8787}"
LABEL="${CODEX_MINI_SERVICE_LABEL:-codex-mini.local}"

if [[ -z "$TOKEN" ]]; then
  TOKEN="$(/usr/bin/python3 - <<'PY'
import secrets
print(secrets.token_urlsafe(18))
PY
)"
fi

NODE="$(command -v node || true)"
if [[ -z "$NODE" ]]; then
  echo "Node.js is required. Install Node 18+ first." >&2
  exit 1
fi

AGENT_DIR="$HOME/Library/LaunchAgents"
mkdir -p "$AGENT_DIR" "$PROJECT_DIR/logs"
PLIST="$AGENT_DIR/$LABEL.plist"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>WorkingDirectory</key><string>$PROJECT_DIR</string>
  <key>EnvironmentVariables</key><dict>
    <key>MOBILE_TYPER_TOKEN</key><string>$TOKEN</string>
    <key>PORT</key><string>$PORT</string>
    <key>CODEX_MINI_APP_NAME</key><string>Codex Mini</string>
  </dict>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$PROJECT_DIR/server.js</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$PROJECT_DIR/logs/launchd.out.log</string>
  <key>StandardErrorPath</key><string>$PROJECT_DIR/logs/launchd.err.log</string>
</dict></plist>
PLIST

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/$LABEL"

echo "Installed and started Codex Mini local service."
echo "Local URL: http://localhost:$PORT/?token=$TOKEN"
