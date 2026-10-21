#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

LOG_DIR="$PROJECT_DIR/logs"
mkdir -p "$LOG_DIR"
LOG_PATH="$LOG_DIR/$(date +%F_%H%M%S).log"
if [[ "${CODEX_MINI_DISABLE_LOG_TEE:-0}" != '1' ]]; then
  exec > >(tee -a "$LOG_PATH") 2>&1
fi
echo "Log file: $LOG_PATH"

if [[ -f "$PROJECT_DIR/desktop-env.local.sh" ]]; then
  source "$PROJECT_DIR/desktop-env.local.sh"
fi
DEFAULT_PUBLIC_BASE=''
REGISTRATION_KEY_PLACEHOLDER='__CODEX_MINI_RELAY_REGISTRATION_KEY__'
DEFAULT_REGISTRATION_KEY='__CODEX_MINI_RELAY_REGISTRATION_KEY__'

PUBLIC_BASE="${CODEX_MINI_RELAY_PUBLIC_BASE:-$DEFAULT_PUBLIC_BASE}"
PUBLIC_BASE="${PUBLIC_BASE%/}"
if [[ -z "$PUBLIC_BASE" ]]; then
  echo 'Set CODEX_MINI_RELAY_PUBLIC_BASE in desktop-env.local.sh; see desktop-env.example.sh.' >&2
  exit 1
fi
REGISTRATION_KEY="${CODEX_MINI_RELAY_REGISTRATION_KEY:-$DEFAULT_REGISTRATION_KEY}"
if [[ "$REGISTRATION_KEY" == "$REGISTRATION_KEY_PLACEHOLDER" ]]; then
  echo 'Set CODEX_MINI_RELAY_REGISTRATION_KEY in desktop-env.local.sh; see desktop-env.example.sh.' >&2
  exit 1
fi

if [[ -n "${CODEX_MINI_RELAY_URL:-}" ]]; then
  RELAY_URL="$CODEX_MINI_RELAY_URL"
else
  case "$PUBLIC_BASE" in
    https:*) RELAY_URL="wss:${PUBLIC_BASE#https:}/tunnel" ;;
    http:*) RELAY_URL="ws:${PUBLIC_BASE#http:}/tunnel" ;;
    *) echo "Unsupported relay URL: $PUBLIC_BASE" >&2; exit 1 ;;
  esac
fi

STATE_ROOT="${CODEX_MINI_STATE_DIR:-$HOME/Library/Application Support/CodexMini}"
DEVICE_CONFIG_PATH="$STATE_ROOT/relay-device.json"
RUNTIME_ROOT="$PROJECT_DIR/.runtime"
NODE_ROOT="$RUNTIME_ROOT/node"
NODE_EXE=''
NPM_CMD=''
CODEX_CLI_EXE=''
MANAGED_CODEX_PID=''

set_node_commands() {
  NODE_EXE="$1"
  NPM_CMD="$2"
  local node_dir
  node_dir="$(dirname "$NODE_EXE")"
  case ":$PATH:" in
    *":$node_dir:"*) ;;
    *) export PATH="$node_dir:$PATH" ;;
  esac
}

portable_node_arch() {
  case "$(uname -m)" in
    arm64) echo 'darwin-arm64' ;;
    x86_64) echo 'darwin-x64' ;;
    *) echo "Unsupported Mac CPU architecture: $(uname -m)" >&2; return 1 ;;
  esac
}

install_portable_node() {
  mkdir -p "$RUNTIME_ROOT"
  local arch base_url sums_url sums tar_name expected_hash archive_path expanded_name expanded_path actual_hash
  arch="$(portable_node_arch)"
  base_url="${CODEX_MINI_NODE_BASE_URL:-https://nodejs.org/dist/latest-v24.x}"
  sums_url="$base_url/SHASUMS256.txt"

  echo ''
  echo 'Node.js was not found. Downloading portable Node.js into this folder...'
  echo "Architecture: $arch"

  sums="$(curl -fsSL "$sums_url")"
  expected_hash="$(printf '%s\n' "$sums" | awk -v arch="$arch" '$2 ~ ("^node-v[0-9]+\\.[0-9]+\\.[0-9]+-" arch "\\.tar\\.gz$") { print $1; exit }')"
  tar_name="$(printf '%s\n' "$sums" | awk -v arch="$arch" '$2 ~ ("^node-v[0-9]+\\.[0-9]+\\.[0-9]+-" arch "\\.tar\\.gz$") { print $2; exit }')"
  if [[ -z "$tar_name" || -z "$expected_hash" ]]; then
    echo "Could not find a Node.js macOS archive for $arch." >&2
    exit 1
  fi

  archive_path="$RUNTIME_ROOT/$tar_name"
  expanded_name="${tar_name%.tar.gz}"
  expanded_path="$RUNTIME_ROOT/$expanded_name"

  echo "Downloading $tar_name..."
  curl -fL "$base_url/$tar_name" -o "$archive_path"
  actual_hash="$(shasum -a 256 "$archive_path" | awk '{ print $1 }')"
  if [[ "$actual_hash" != "$expected_hash" ]]; then
    rm -f "$archive_path"
    echo 'Downloaded Node.js archive failed SHA256 verification.' >&2
    exit 1
  fi

  rm -rf "$expanded_path" "$NODE_ROOT"
  tar -xzf "$archive_path" -C "$RUNTIME_ROOT"
  mv "$expanded_path" "$NODE_ROOT"

  if [[ ! -x "$NODE_ROOT/bin/node" || ! -x "$NODE_ROOT/bin/npm" ]]; then
    echo 'Portable Node.js download did not contain node and npm.' >&2
    exit 1
  fi
  set_node_commands "$NODE_ROOT/bin/node" "$NODE_ROOT/bin/npm"
}

ensure_node_runtime() {
  if [[ -x "$NODE_ROOT/bin/node" && -x "$NODE_ROOT/bin/npm" ]]; then
    set_node_commands "$NODE_ROOT/bin/node" "$NODE_ROOT/bin/npm"
    return
  fi

  local system_node system_npm node_major
  system_node="$(command -v node || true)"
  system_npm="$(command -v npm || true)"
  if [[ -n "$system_node" && -n "$system_npm" ]]; then
    node_major="$("$system_node" -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || echo 0)"
    if [[ "$node_major" -ge 18 ]]; then
      set_node_commands "$system_node" "$system_npm"
      return
    fi
  fi

  install_portable_node
}

ensure_node_dependencies() {
  local missing=0 module
  for module in node_modules/ws node_modules/qrcode node_modules/qrcode-terminal; do
    if [[ ! -d "$PROJECT_DIR/$module" ]]; then
      missing=1
    fi
  done
  if [[ "$missing" -eq 0 ]]; then
    return
  fi

  echo ''
  echo 'Installing Node dependencies...'
  "$NPM_CMD" install --omit=dev
}

set_codex_cli_command() {
  CODEX_CLI_EXE="$1"
  local codex_dir
  codex_dir="$(dirname "$CODEX_CLI_EXE")"
  case ":$PATH:" in
    *":$codex_dir:"*) ;;
    *) export PATH="$codex_dir:$PATH" ;;
  esac
}

find_codex_cli() {
  if [[ -n "${CODEX_MINI_CODEX_CLI:-}" && -x "${CODEX_MINI_CODEX_CLI:-}" ]]; then
    set_codex_cli_command "$CODEX_MINI_CODEX_CLI"
    return 0
  fi

  local found=''
  found="$(command -v codex 2>/dev/null || true)"
  if [[ -n "$found" && -x "$found" ]]; then
    set_codex_cli_command "$found"
    return 0
  fi

  local candidate
  for candidate in \
    "$HOME/.codex/bin/codex" \
    "$HOME/.local/bin/codex" \
    "/opt/homebrew/bin/codex" \
    "/usr/local/bin/codex" \
    "/usr/bin/codex"; do
    if [[ -x "$candidate" ]]; then
      set_codex_cli_command "$candidate"
      return 0
    fi
  done
  return 1
}

install_codex_cli() {
  echo ''
  echo 'Codex CLI was not found. Installing official Codex CLI...'
  curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh
}

repair_codex_cli_config() {
  local config_path="$HOME/.codex/config.toml"
  if [[ ! -f "$config_path" ]]; then
    return
  fi

  "$NODE_EXE" - "$config_path" <<'NODE'
const fs = require('fs');
const path = process.argv[2];
const original = fs.readFileSync(path, 'utf8');
const pattern = /^([ \t]*service_tier[ \t]*=[ \t]*["']default["'][^\r\n]*)(\r?\n|$)/gm;
let changed = false;
const next = original.replace(pattern, (match, line, newline) => {
  changed = true;
  return `# ${line} # disabled by Codex Relay: current Codex CLI expects fast or flex${newline}`;
});
if (!changed) process.exit(0);
const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
const backup = `${path}.codex-mini-backup-${stamp}`;
fs.copyFileSync(path, backup);
fs.writeFileSync(path, next);
console.log(`Updated Codex CLI config: commented invalid service_tier = "default"`);
console.log(`Backup: ${backup}`);
NODE
}

codex_cli_check_dir() {
  local root dir
  root="${CODEX_MINI_CODEX_TEST_ROOT:-$HOME/Documents/Codex}"
  dir="$root/codex-mini-cli"
  mkdir -p "$dir"
  printf '%s' "$dir"
}

codex_cli_test_session_id_file() {
  local check_dir="$1"
  printf '%s' "$check_dir/.codex-mini-cli-session-id"
}

read_codex_cli_test_session_id() {
  local check_dir="$1" id_file value
  id_file="$(codex_cli_test_session_id_file "$check_dir")"
  [[ -f "$id_file" ]] || return 0
  value="$(tr -d '[:space:]' < "$id_file" 2>/dev/null || true)"
  if [[ "$value" =~ ^([0-9a-fA-F]{8}-[0-9a-fA-F-]{27,}|thr_[a-zA-Z0-9_-]{3,})$ ]]; then
    printf '%s' "$value"
  fi
}

extract_codex_cli_thread_id() {
  "$NODE_EXE" -e '
const text = require("fs").readFileSync(0, "utf8");
const match = text.match(/\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|thr_[a-z0-9_-]{3,})\b/i);
if (match) process.stdout.write(match[1]);
' 2>/dev/null || true
}

save_codex_cli_test_session_id() {
  local check_dir="$1" thread_id="$2"
  [[ -n "$thread_id" ]] || return 0
  printf '%s\n' "$thread_id" > "$(codex_cli_test_session_id_file "$check_dir")"
}

cleanup_old_codex_cli_test_sessions() {
  local check_dir="$1" keep_thread_id="$2"
  [[ "${CODEX_MINI_CLEAN_OLD_CLI_TEST_SESSIONS:-1}" != '0' ]] || return 0
  [[ -n "$check_dir" && -n "$keep_thread_id" ]] || return 0
  "$NODE_EXE" - "$check_dir" "$keep_thread_id" <<'NODE' || true
const fs = require('fs');
const path = require('path');
const checkDir = path.resolve(process.argv[2]);
const keepThreadId = String(process.argv[3] || '');
const root = path.join(process.env.HOME || '', '.codex', 'sessions');
function walk(dir, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && full.endsWith('.jsonl')) out.push(full);
  }
  return out;
}
for (const file of walk(root)) {
  const threadId = path.basename(file, '.jsonl');
  if (threadId === keepThreadId) continue;
  let isTestSession = false;
  try {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).slice(0, 80);
    for (const line of lines) {
      if (!line.trim()) continue;
      let item = null;
      try { item = JSON.parse(line); } catch { continue; }
      const cwd = item && item.type === 'session_meta' && item.payload && item.payload.cwd;
      if (cwd) {
        isTestSession = path.resolve(String(cwd)) === checkDir;
        break;
      }
    }
  } catch {}
  if (isTestSession) {
    try { fs.unlinkSync(file); } catch {}
  }
}
NODE
}

run_codex_cli_execution_test() {
  local expected="$1" check_dir="$2" existing output status thread_id
  existing="$(read_codex_cli_test_session_id "$check_dir")"
  if [[ -n "$existing" ]]; then
    set +e
    output="$("$CODEX_CLI_EXE" --ask-for-approval never exec resume --json --skip-git-repo-check "$existing" "Reply with exactly: $expected" 2>&1)"
    status=$?
    set -e
    if [[ "$status" -eq 0 && "$output" == *"$expected"* ]]; then
      thread_id="$(printf '%s' "$output" | extract_codex_cli_thread_id)"
      [[ -n "$thread_id" ]] || thread_id="$existing"
      save_codex_cli_test_session_id "$check_dir" "$thread_id"
      cleanup_old_codex_cli_test_sessions "$check_dir" "$thread_id"
      printf '%s' "$output"
      return 0
    fi
    if [[ ! "$output" =~ [Nn]ot[[:space:]]found|missing|conversation[[:space:]]state|session ]]; then
      printf '%s' "$output"
      return "$status"
    fi
    rm -f "$(codex_cli_test_session_id_file "$check_dir")"
  fi

  set +e
  output="$("$CODEX_CLI_EXE" --ask-for-approval never exec --json --skip-git-repo-check --cd "$check_dir" "Reply with exactly: $expected" 2>&1)"
  status=$?
  set -e
  if [[ "$status" -eq 0 && "$output" == *"$expected"* ]]; then
    thread_id="$(printf '%s' "$output" | extract_codex_cli_thread_id)"
    save_codex_cli_test_session_id "$check_dir" "$thread_id"
    cleanup_old_codex_cli_test_sessions "$check_dir" "$thread_id"
  fi
  printf '%s' "$output"
  return "$status"
}

codex_cli_execution_failure_can_continue() {
  local text="$1"
  case "$text" in
    *'failed to refresh available models'*|*'timeout waiting for child process to exit'*|*'Model metadata for `'*'` not found'*|*'requires a newer version of Codex'*|*'failed to load models cache'*|*'supports_reasoning_summaries'*)
      return 0
      ;;
  esac
  return 1
}

warn_codex_cli_execution_degraded() {
  echo 'Codex CLI execution test is degraded by model metadata/version mismatch. Continuing because Codex App Server is available.'
  echo 'If sending from the phone fails later, upgrade the Codex app or CLI, then restart Codex Relay.'
}

ensure_codex_cli() {
  if [[ "${CODEX_MINI_REQUIRE_CODEX_CLI:-1}" == '0' ]]; then
    echo ''
    echo 'Skipping Codex CLI check because CODEX_MINI_REQUIRE_CODEX_CLI=0.'
    return
  fi

  if ! find_codex_cli; then
    install_codex_cli
    if ! find_codex_cli; then
      echo 'Codex CLI install finished, but the codex command was not found.' >&2
      echo 'Restart this Terminal window or set CODEX_MINI_CODEX_CLI to the full codex path.' >&2
      exit 1
    fi
  fi

  echo ''
  echo 'Checking Codex CLI...'
  repair_codex_cli_config
  "$CODEX_CLI_EXE" --version
  "$CODEX_CLI_EXE" app-server --help >/dev/null
  echo 'Codex App Server check passed.'

  if [[ "${CODEX_MINI_SKIP_CODEX_CLI_TEST:-0}" == '1' ]]; then
    echo 'Skipping Codex CLI execution test because CODEX_MINI_SKIP_CODEX_CLI_TEST=1.'
    return
  fi

  local expected='codex-mini-cli-ok' output status check_dir
  check_dir="$(codex_cli_check_dir)"
  set +e
  output="$(run_codex_cli_execution_test "$expected" "$check_dir")"
  status=$?
  set -e
  if [[ "$status" -ne 0 ]]; then
    echo "$output" >&2
    if [[ "$output" == *'service_tier'*'default'* ]]; then
      echo 'Codex CLI config is invalid. Codex Relay tried to repair service_tier = "default"; please check ~/.codex/config.toml and start again.' >&2
    elif codex_cli_execution_failure_can_continue "$output"; then
      warn_codex_cli_execution_degraded
      return
    else
      echo 'Codex CLI execution test failed. If the output mentions authentication, unlock this Mac and run `codex login`, then start Codex Relay again.' >&2
    fi
    exit 1
  fi
  if [[ "$output" != *"$expected"* ]]; then
    echo "$output" >&2
    if codex_cli_execution_failure_can_continue "$output"; then
      warn_codex_cli_execution_degraded
      return
    fi
    echo 'Codex CLI execution test did not return the expected response.' >&2
    exit 1
  fi
  echo 'Codex CLI execution test passed.'
}

machine_seed() {
  local computer_name host_name user_name platform_uuid
  computer_name="$(scutil --get ComputerName 2>/dev/null || true)"
  host_name="$(hostname 2>/dev/null || true)"
  user_name="$(id -un 2>/dev/null || true)"
  platform_uuid="$(ioreg -rd1 -c IOPlatformExpertDevice 2>/dev/null | awk -F '"' '/IOPlatformUUID/ { print $(NF - 1); exit }' || true)"
  printf '%s|%s|%s|%s' "$computer_name" "$host_name" "$user_name" "$platform_uuid"
}

create_device_config_json() {
  local seed
  seed="$(machine_seed)"
  "$NODE_EXE" - "$PUBLIC_BASE" "$RELAY_URL" "$seed" <<'NODE'
const crypto = require('crypto');
const os = require('os');

const [publicBase, relayUrl, seed] = process.argv.slice(2);
const token = bytes => crypto.randomBytes(bytes).toString('base64url');
const installId = token(16);
const host = (os.hostname() || 'mac')
  .replace(/[^a-zA-Z0-9._-]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 40) || 'mac';
const fingerprint = crypto
  .createHash('sha256')
  .update(`${seed}|${installId}`)
  .digest('hex')
  .slice(0, 12);

process.stdout.write(JSON.stringify({
  publicBase,
  relayUrl,
  deviceId: `codex-${host}-${fingerprint}`.toLowerCase(),
  name: `Codex ${host}`,
  relaySecret: token(32),
  passphrase: token(18),
  fingerprint,
  installId,
  createdAt: new Date().toISOString()
}, null, 2) + '\n');
NODE
}

register_device() {
  local config_json body register_url
  config_json="$1"

  echo ''
  echo 'First start on this Mac. A new relay device approval request will be sent.'
  printf 'Relay: %s\n' "$PUBLIC_BASE"
  printf 'Device: %s\n' "$(printf '%s' "$config_json" | "$NODE_EXE" -e "const fs=require('fs'); const d=JSON.parse(fs.readFileSync(0,'utf8')); process.stdout.write(d.deviceId);")"
  echo ''

  body="$(printf '%s' "$config_json" | CODEX_MINI_RELAY_REGISTRATION_KEY_VALUE="$REGISTRATION_KEY" "$NODE_EXE" -e "const fs=require('fs'); const d=JSON.parse(fs.readFileSync(0,'utf8')); process.stdout.write(JSON.stringify({ registrationKey: process.env.CODEX_MINI_RELAY_REGISTRATION_KEY_VALUE, deviceId: d.deviceId, name: d.name, relaySecret: d.relaySecret, passphrase: d.passphrase, fingerprint: d.fingerprint }));")"
  register_url="$PUBLIC_BASE/device/register"
  printf '%s' "$body" | curl -fsS -X POST "$register_url" -H 'content-type: application/json' --data-binary @- >/dev/null
  echo 'Device request submitted. Waiting for relay authorization.'
}

load_or_create_device_config() {
  if [[ -f "$DEVICE_CONFIG_PATH" ]]; then
    return
  fi

  mkdir -p "$STATE_ROOT"
  local config_json final_json
  config_json="$(create_device_config_json)"
  register_device "$config_json"
  final_json="$(printf '%s' "$config_json" | "$NODE_EXE" -e "const fs=require('fs'); const d=JSON.parse(fs.readFileSync(0,'utf8')); d.registeredAt = new Date().toISOString(); d.approvedAtFirstStart = false; process.stdout.write(JSON.stringify(d, null, 2) + '\n');")"
  printf '%s' "$final_json" > "$DEVICE_CONFIG_PATH"
}

json_value() {
  "$NODE_EXE" -e "const fs=require('fs'); const d=JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); const v=d[process.argv[2]]; process.stdout.write(v == null ? '' : String(v));" "$DEVICE_CONFIG_PATH" "$1"
}

ensure_device_runtime_fields() {
  "$NODE_EXE" - "$DEVICE_CONFIG_PATH" <<'NODE'
const crypto = require('crypto');
const fs = require('fs');
const path = process.argv[2];
const device = JSON.parse(fs.readFileSync(path, 'utf8'));
if (!device.localToken || typeof device.localToken !== 'string') {
  device.localToken = crypto.randomBytes(18).toString('base64url');
  fs.writeFileSync(path, JSON.stringify(device, null, 2) + '\n');
}
NODE
}

json_text_value() {
  "$NODE_EXE" -e "const d=JSON.parse(process.argv[1] || '{}'); const v=d[process.argv[2]]; process.stdout.write(v == null ? '' : String(v));" "$1" "$2"
}

get_relay_status() {
  local base_url="$1" token="$2"
  curl -fsS --max-time 5 -H "x-mobile-typer-token: $token" "$base_url/codex/relay-status"
}

tcp_port_open() {
  local host="$1" port="$2"
  "$NODE_EXE" - "$host" "$port" <<'NODE'
const net = require('net');
const host = process.argv[2];
const port = Number(process.argv[3]);
const socket = net.createConnection({ host, port });
let done = false;
const finish = code => {
  if (done) return;
  done = true;
  socket.destroy();
  process.exit(code);
};
socket.setTimeout(800);
socket.once('connect', () => finish(0));
socket.once('timeout', () => finish(1));
socket.once('error', () => finish(1));
NODE
}

start_codex_mini_process() {
  "$NODE_EXE" server.js &
  MANAGED_CODEX_PID="$!"
}

stop_codex_mini_process() {
  local pid="${1:-}"
  [[ -n "$pid" ]] || return 0
  kill "$pid" >/dev/null 2>&1 || return 0
  sleep 1
  if kill -0 "$pid" >/dev/null 2>&1; then
    kill -9 "$pid" >/dev/null 2>&1 || true
  fi
  wait "$pid" 2>/dev/null || true
  if [[ "${MANAGED_CODEX_PID:-}" == "$pid" ]]; then
    MANAGED_CODEX_PID=''
  fi
}

cleanup_macos_supervisor() {
  if [[ -n "${MANAGED_CODEX_PID:-}" ]]; then
    stop_codex_mini_process "$MANAGED_CODEX_PID"
  fi
}

wait_for_relay_status() {
  local base_url="$1" token="$2" timeout_seconds="$3" deadline status_json
  deadline=$(( $(date +%s) + timeout_seconds ))
  while [[ "$(date +%s)" -lt "$deadline" ]]; do
    if status_json="$(get_relay_status "$base_url" "$token" 2>/dev/null)"; then
      printf '%s' "$status_json"
      return 0
    fi
    sleep 1
  done
  return 1
}

watch_codex_mini_relay() {
  local base_url="$1" token="$2" expected_device_id="$3"
  local process_pid='' restart_delay=1 offline_since=0 last_state='' managed_process=1
  local local_failure_count=0 local_failure_since=0 local_port="${PORT:-8787}"
  local status_json='' status_ok=0 state='' now=0 local_failure_seconds=0 offline_seconds=0 device_id='' connected=''

  if status_json="$(get_relay_status "$base_url" "$token" 2>/dev/null)"; then
    device_id="$(json_text_value "$status_json" deviceId)"
    if [[ "$device_id" == "$expected_device_id" ]]; then
      echo ''
      printf 'Existing Codex Relay service is already running on http://127.0.0.1:%s.\n' "$local_port"
      echo 'Monitoring existing service. Restart this script if that old service stops responding.'
      managed_process=0
    fi
  fi
  if [[ "$managed_process" -eq 1 ]] && tcp_port_open 127.0.0.1 "$local_port"; then
    echo "Port $local_port is already in use, but it did not expose this device's relay status. Close the old Codex Relay window and run this script again." >&2
    exit 1
  fi

  while true; do
    local process_missing=0
    if [[ -z "$process_pid" ]]; then
      process_missing=1
    elif ! kill -0 "$process_pid" >/dev/null 2>&1; then
      process_missing=1
    fi
    if [[ "$managed_process" -eq 1 && "$process_missing" -eq 1 ]]; then
      if [[ -n "$process_pid" ]]; then
        echo "Codex Relay node process exited. Restarting..."
        sleep "$restart_delay"
        restart_delay=$(( restart_delay * 2 ))
        if [[ "$restart_delay" -gt 30 ]]; then restart_delay=30; fi
      fi
      start_codex_mini_process
      process_pid="$MANAGED_CODEX_PID"
      printf 'Supervisor started Codex Relay node process PID %s.\n' "$process_pid"
      wait_for_relay_status "$base_url" "$token" 20 >/dev/null || true
      offline_since=0
      local_failure_count=0
      local_failure_since=0
    fi

    status_json=''
    status_ok=0
    if status_json="$(get_relay_status "$base_url" "$token" 2>/dev/null)"; then
      status_ok=1
    fi
    now="$(date +%s)"

    if [[ "$status_ok" -eq 1 ]]; then
      connected="$(json_text_value "$status_json" connected)"
      if [[ "$connected" == 'true' ]]; then
        offline_since=0
        local_failure_count=0
        local_failure_since=0
        restart_delay=1
        if [[ "$last_state" != 'connected' ]]; then
          device_id="$(json_text_value "$status_json" deviceId)"
          printf 'Relay status: connected as %s.\n' "$device_id"
          last_state='connected'
        fi
        sleep 5
        continue
      fi
      local_failure_count=0
      local_failure_since=0
    else
      local_failure_count=$(( local_failure_count + 1 ))
      if [[ "$local_failure_since" -eq 0 ]]; then local_failure_since="$now"; fi
      local_failure_seconds=$(( now - local_failure_since ))
      if [[ "$local_failure_count" -lt 3 || "$local_failure_seconds" -lt 15 ]]; then
        sleep 5
        continue
      fi
    fi

    if [[ "$status_ok" -eq 1 ]]; then
      state="$(json_text_value "$status_json" state)"
      [[ -n "$state" ]] || state='offline'
    else
      state='local-unreachable'
    fi

    if [[ "$state" == 'codex-stopped' || "$state" == 'codex-checking' ]]; then
      offline_since=0
      if [[ "$last_state" != "$state" ]]; then
        if [[ "$state" == 'codex-stopped' ]]; then
          echo 'Relay access is paused because Codex is not running. Waiting for Codex to start...'
        else
          echo 'Checking Codex desktop before opening relay access...'
        fi
        last_state="$state"
      fi
      sleep 5
      continue
    fi

    if [[ "$offline_since" -eq 0 ]]; then
      if [[ "$status_ok" -eq 0 && "$local_failure_since" -ne 0 ]]; then
        offline_since="$local_failure_since"
      else
        offline_since="$now"
      fi
      printf 'Relay status: %s. Waiting for automatic recovery...\n' "$state"
      last_state="$state"
    elif [[ "$last_state" != "$state" ]]; then
      printf 'Relay status: %s.\n' "$state"
      last_state="$state"
    fi

    offline_seconds=$(( now - offline_since ))
    if [[ "$offline_seconds" -ge 60 ]]; then
      if [[ "$managed_process" -eq 1 ]]; then
        printf 'Relay has been unavailable for %ss. Restarting Codex Relay node process...\n' "$offline_seconds"
        stop_codex_mini_process "$process_pid"
        process_pid=''
        offline_since=0
      else
        echo 'Existing Codex Relay service is unhealthy and was not started by this supervisor. Close the old Codex Relay window, then run this script again.'
        sleep 10
      fi
    else
      printf 'Relay reconnecting... %ss elapsed.\n' "$offline_seconds"
      sleep 5
    fi
  done
}

ensure_helper_permissions_hint() {
  if [[ -f "$PROJECT_DIR/bin/codex-window-point" ]]; then
    chmod +x "$PROJECT_DIR/bin/codex-window-point" 2>/dev/null || true
  fi
  if ! command -v cliclick >/dev/null 2>&1 && [[ ! -x /opt/homebrew/bin/cliclick && ! -x /usr/local/bin/cliclick ]]; then
    echo ''
    echo 'Optional: install cliclick for more reliable mouse clicks: brew install cliclick'
  fi
}

ensure_macos_automation_permissions() {
  echo ''
  echo 'Checking macOS automation permissions...'
  if /usr/bin/osascript >/dev/null 2>&1 <<'APPLESCRIPT'
tell application "System Events"
  set uiEnabled to UI elements enabled
  key code 53
end tell
APPLESCRIPT
  then
    echo 'macOS automation permission check passed.'
  else
    echo 'macOS automation permissions are missing or pending approval.'
    echo 'Codex Relay is requesting permissions and opening Privacy settings.'
    echo 'Please allow the app/terminal running this script under Accessibility, Automation, and Screen Recording if shown.'
    /usr/bin/osascript >/dev/null 2>&1 <<'APPLESCRIPT' || true
tell application "System Events"
  set uiEnabled to UI elements enabled
  key code 53
end tell
APPLESCRIPT
    /usr/bin/open 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility' >/dev/null 2>&1 || true
    /usr/bin/open 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation' >/dev/null 2>&1 || true
  fi

  if [[ -x "$PROJECT_DIR/bin/codex-window-point" ]]; then
    /usr/bin/open -b com.openai.codex >/dev/null 2>&1 || true
    sleep 2
    if "$PROJECT_DIR/bin/codex-window-point" >/dev/null 2>&1; then
      echo 'Codex window inspection permission check passed.'
    else
      echo 'Codex window inspection needs permission or Codex is still loading.'
      echo 'If macOS asks, allow Screen Recording for the app/terminal running this script.'
      /usr/bin/open 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture' >/dev/null 2>&1 || true
    fi
  fi
}

ensure_node_runtime
load_or_create_device_config
ensure_device_runtime_fields
ensure_node_dependencies
ensure_codex_cli
ensure_helper_permissions_hint
ensure_macos_automation_permissions

DEVICE_PUBLIC_BASE="$(json_value publicBase)"
DEVICE_RELAY_URL="$(json_value relayUrl)"
DEVICE_ID="$(json_value deviceId)"
DEVICE_SECRET="$(json_value relaySecret)"
DEVICE_PASSPHRASE="$(json_value passphrase)"
DEVICE_LOCAL_TOKEN="$(json_value localToken)"

export CODEX_MINI_RELAY_URL="$DEVICE_RELAY_URL"
export CODEX_MINI_RELAY_PUBLIC_BASE="$DEVICE_PUBLIC_BASE"
export CODEX_MINI_RELAY_DEVICE_ID="$DEVICE_ID"
export CODEX_MINI_RELAY_SECRET="$DEVICE_SECRET"
export CODEX_MINI_RELAY_PASSPHRASE="$DEVICE_PASSPHRASE"
export MOBILE_TYPER_TOKEN="$DEVICE_LOCAL_TOKEN"
export CODEX_MINI_QR_DIR="$PROJECT_DIR"
export CODEX_MINI_AUTO_KEEP_AWAKE="${CODEX_MINI_AUTO_KEEP_AWAKE:-1}"
export PORT="${PORT:-8787}"

echo ''
echo 'Starting Codex Relay desktop relay...'
printf 'Device ID: %s\n' "$DEVICE_ID"
printf 'Device config: %s\n' "$DEVICE_CONFIG_PATH"
echo 'Phone URL:'
printf '  %s/#k=%s\n' "$DEVICE_PUBLIC_BASE" "$("$NODE_EXE" -e "process.stdout.write(encodeURIComponent(process.argv[1]));" "$DEVICE_PASSPHRASE")"
echo ''
echo 'Keep this Terminal window open while using the phone client.'
echo 'Supervisor will restart the local relay automatically if it becomes unhealthy.'
echo 'Locked mode: Codex Relay will use Codex App Server for locked conversations.'
if [[ "$CODEX_MINI_AUTO_KEEP_AWAKE" != '0' ]]; then
  echo 'Keep-awake: Codex Relay will prevent idle sleep while this relay is running.'
  echo 'Lid boundary: MacBook lid-close still requires clamshell mode; ordinary sleep stops remote access.'
else
  echo 'Keep-awake: disabled by CODEX_MINI_AUTO_KEEP_AWAKE=0.'
fi
echo ''

trap cleanup_macos_supervisor EXIT
watch_codex_mini_relay "http://127.0.0.1:${PORT}" "$MOBILE_TYPER_TOKEN" "$DEVICE_ID"
