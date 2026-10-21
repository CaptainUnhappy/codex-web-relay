#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="${APP_NAME:-Codex Mini}"
SCHEME_NAME="${SCHEME_NAME:-Codex Mini}"
APP_PATH="${APP_PATH:-/Applications/${APP_NAME}.app}"
BUNDLE_ID="${BUNDLE_ID:-local.codex-mini.app}"
SERVICE_LABEL="${SERVICE_LABEL:-codex-mini.local}"
SUPPORT_DIR_NAME="${SUPPORT_DIR_NAME:-Codex Mini}"
SERVICE_PORT="${SERVICE_PORT:-8787}"
VERSION="${VERSION:-$(/usr/bin/python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("version", "1.0.0"))' "$PROJECT_DIR/package.json")}"
BUILD_NUMBER="${BUILD_NUMBER:-${VERSION//./}}"
XCODE_DIR="$PROJECT_DIR/macos/CodexMini"
XCODE_PROJECT="$XCODE_DIR/CodexMini.xcodeproj"
DERIVED_DATA_PATH="${DERIVED_DATA_PATH:-$XCODE_DIR/DerivedData}"
RESOURCE_ROOT="$XCODE_DIR/CodexMini/Resources"
EMBEDDED_PROJECT_DIR="$RESOURCE_ROOT/CodexMiniProject"
EMBEDDED_NODE_DIR="$RESOURCE_ROOT/node"
BUILT_APP="$DERIVED_DATA_PATH/Build/Products/Release/${APP_NAME}.app"
NODE_SOURCE="${NODE_SOURCE:-}"

if [[ ! -d "$XCODE_PROJECT" ]]; then
  echo "Xcode project not found: $XCODE_PROJECT" >&2
  exit 1
fi

choose_node() {
  if [[ -n "$NODE_SOURCE" && -x "$NODE_SOURCE" ]]; then
    printf '%s\n' "$NODE_SOURCE"
    return 0
  fi
  if [[ -x "/Applications/${APP_NAME}.app/Contents/Resources/node/node" ]]; then
    printf '%s\n' "/Applications/${APP_NAME}.app/Contents/Resources/node/node"
    return 0
  fi
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  for candidate in "/opt/homebrew/bin/node" "/usr/local/bin/node" "/usr/bin/node"; do
    if [[ -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

NODE_BIN="$(choose_node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "Node runtime not found; set NODE_SOURCE=/path/to/node" >&2
  exit 1
fi

mkdir -p "$EMBEDDED_PROJECT_DIR" "$EMBEDDED_NODE_DIR"

# Keep the app-managed service payload current while avoiding recursive macOS
# project/build output and user/runtime-private data.
/usr/bin/rsync -a --delete --delete-excluded \
  --exclude '.git' \
  --exclude '.DS_Store' \
  --exclude '.gitattributes' \
  --exclude 'logs' \
  --exclude 'output' \
  --exclude 'dist' \
  --exclude '.build' \
  --exclude 'DerivedData' \
  --exclude 'node_modules' \
  --exclude 'tmp-*' \
  --exclude '*.log' \
  --exclude 'macos' \
  "$PROJECT_DIR/" "$EMBEDDED_PROJECT_DIR/"

if true; then
  # Public app payloads keep only runtime files needed by the installed app.
  rm -f \
    "$EMBEDDED_PROJECT_DIR/.gitattributes" \
    "$EMBEDDED_PROJECT_DIR/.gitignore" \
    "$EMBEDDED_PROJECT_DIR/AGENTS.md" \
    "$EMBEDDED_PROJECT_DIR/MEMORY.md" \
    "$EMBEDDED_PROJECT_DIR/TODO.md" \
    "$EMBEDDED_PROJECT_DIR/CODEMAP.md" \
    "$EMBEDDED_PROJECT_DIR/README.md" \
    "$EMBEDDED_PROJECT_DIR/CHANGELOG.md"
  rm -rf \
    "$EMBEDDED_PROJECT_DIR/logs" \
    "$EMBEDDED_PROJECT_DIR/output" \
    "$EMBEDDED_PROJECT_DIR/scripts"
else
  mkdir -p "$EMBEDDED_PROJECT_DIR/logs"
fi
chmod +x "$EMBEDDED_PROJECT_DIR/bin/codex-window-point" 2>/dev/null || true
if [[ -d "$EMBEDDED_PROJECT_DIR/scripts" ]]; then
  chmod +x "$EMBEDDED_PROJECT_DIR/scripts/"*.sh 2>/dev/null || true
fi

cp "$NODE_BIN" "$EMBEDDED_NODE_DIR/node"
chmod +x "$EMBEDDED_NODE_DIR/node"

XCODEBUILD=(/usr/bin/xcodebuild)
if [[ -d "/Applications/Xcode.app/Contents/Developer" ]]; then
  export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
fi

rm -rf "$BUILT_APP"

"${XCODEBUILD[@]}" \
  -quiet \
  -project "$XCODE_PROJECT" \
  -scheme "$SCHEME_NAME" \
  -configuration Release \
  -derivedDataPath "$DERIVED_DATA_PATH" \
  build \
  CODE_SIGNING_ALLOWED=NO \
  PRODUCT_NAME="$APP_NAME" \
  PRODUCT_BUNDLE_IDENTIFIER="$BUNDLE_ID" \
  MARKETING_VERSION="$VERSION" \
  CURRENT_PROJECT_VERSION="$BUILD_NUMBER" \
  INFOPLIST_KEY_CFBundleDisplayName="$APP_NAME" \
  INFOPLIST_KEY_CodexMiniServiceLabel="$SERVICE_LABEL" \
  INFOPLIST_KEY_CodexMiniSupportDirectoryName="$SUPPORT_DIR_NAME" \
  INFOPLIST_KEY_CodexMiniPort="$SERVICE_PORT" \

if [[ ! -d "$BUILT_APP" ]]; then
  echo "Built app not found: $BUILT_APP" >&2
  exit 1
fi

set_plist_string() {
  local plist="$1"
  local key="$2"
  local value="$3"
  /usr/libexec/PlistBuddy -c "Set :$key $value" "$plist" >/dev/null 2>&1 \
    || /usr/libexec/PlistBuddy -c "Add :$key string $value" "$plist" >/dev/null
}

INFO_PLIST="$BUILT_APP/Contents/Info.plist"
set_plist_string "$INFO_PLIST" "CFBundleDisplayName" "$APP_NAME"
set_plist_string "$INFO_PLIST" "CFBundleName" "$APP_NAME"
set_plist_string "$INFO_PLIST" "CFBundleIdentifier" "$BUNDLE_ID"
set_plist_string "$INFO_PLIST" "CFBundleShortVersionString" "$VERSION"
set_plist_string "$INFO_PLIST" "CFBundleVersion" "$BUILD_NUMBER"
set_plist_string "$INFO_PLIST" "CFBundleDevelopmentRegion" "zh_CN"
/usr/libexec/PlistBuddy -c "Set :CFBundleAllowMixedLocalizations true" "$INFO_PLIST" >/dev/null 2>&1 \
  || /usr/libexec/PlistBuddy -c "Add :CFBundleAllowMixedLocalizations bool true" "$INFO_PLIST" >/dev/null
/usr/libexec/PlistBuddy -c "Delete :CFBundleLocalizations" "$INFO_PLIST" >/dev/null 2>&1 || true
/usr/libexec/PlistBuddy -c "Add :CFBundleLocalizations array" "$INFO_PLIST" >/dev/null
/usr/libexec/PlistBuddy -c "Add :CFBundleLocalizations:0 string zh_CN" "$INFO_PLIST" >/dev/null
set_plist_string "$INFO_PLIST" "CodexMiniServiceLabel" "$SERVICE_LABEL"
set_plist_string "$INFO_PLIST" "CodexMiniSupportDirectoryName" "$SUPPORT_DIR_NAME"
set_plist_string "$INFO_PLIST" "CodexMiniPort" "$SERVICE_PORT"

rm -rf "$APP_PATH"
mkdir -p "$(dirname "$APP_PATH")"
/usr/bin/ditto "$BUILT_APP" "$APP_PATH"

# Ad-hoc signing is best-effort only. It avoids some local launch warnings but
# does not replace Developer ID signing/notarization for outside distribution.
/usr/bin/codesign --force --deep --sign - "$APP_PATH" >/dev/null 2>&1 || true

printf 'Built and installed %s\n' "$APP_PATH"
printf 'Embedded project: %s\n' "$APP_PATH/Contents/Resources/CodexMiniProject"
printf 'Embedded node: %s\n' "$APP_PATH/Contents/Resources/node/node"
