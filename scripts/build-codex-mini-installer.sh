#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="${APP_NAME:-Codex Mini}"
PKG_ID="${PKG_ID:-local.codex-mini.pkg}"
BUNDLE_ID="${BUNDLE_ID:-local.codex-mini.app}"
SERVICE_LABEL="${SERVICE_LABEL:-codex-mini.local}"
SUPPORT_DIR_NAME="${SUPPORT_DIR_NAME:-Codex Mini}"
SERVICE_PORT="${SERVICE_PORT:-8787}"
VERSION="$(/usr/bin/python3 - <<'PY' "$PROJECT_DIR/package.json"
import json, sys
print(json.load(open(sys.argv[1])).get('version','1.0.0'))
PY
)"
DIST_DIR="$PROJECT_DIR/dist"
BUILD_DIR="${BUILD_DIR:-$PROJECT_DIR/.build/codex-mini-installer}"
PAYLOAD_ROOT="$BUILD_DIR/payload"
APP_PATH="$PAYLOAD_ROOT/Applications/${APP_NAME}.app"
PKG_COMPONENT="$BUILD_DIR/${APP_NAME}.pkg"
FINAL_PKG="${FINAL_PKG:-$DIST_DIR/${APP_NAME} Installer.pkg}"
NODE_SOURCE="${NODE_SOURCE:-}"

rm -rf "$BUILD_DIR"
mkdir -p "$PAYLOAD_ROOT/Applications" "$DIST_DIR"

# Build the real SwiftUI app into the installer payload. The build script also
# refreshes the embedded service project and bundles Node, while excluding logs,
# tokens, Codex sessions, build output, and recursive macOS project data.
APP_PATH="$APP_PATH" \
DERIVED_DATA_PATH="$BUILD_DIR/DerivedData" \
NODE_SOURCE="$NODE_SOURCE" \
APP_NAME="$APP_NAME" \
BUNDLE_ID="$BUNDLE_ID" \
SERVICE_LABEL="$SERVICE_LABEL" \
SUPPORT_DIR_NAME="$SUPPORT_DIR_NAME" \
SERVICE_PORT="$SERVICE_PORT" \
"$PROJECT_DIR/scripts/build-codex-mini-app.sh"

/usr/bin/pkgbuild \
  --root "$PAYLOAD_ROOT" \
  --identifier "$PKG_ID" \
  --version "$VERSION" \
  --install-location / \
  "$PKG_COMPONENT" >/dev/null

/usr/bin/productbuild \
  --package "$PKG_COMPONENT" \
  "$FINAL_PKG" >/dev/null

/usr/sbin/pkgutil --check-signature "$FINAL_PKG" >/dev/null 2>&1 || true

printf 'Built %s\n' "$FINAL_PKG"
printf 'Payload app: %s\n' "$APP_PATH"
printf 'Embedded project: %s\n' "$APP_PATH/Contents/Resources/CodexMiniProject"
printf 'Embedded node: %s\n' "$APP_PATH/Contents/Resources/node/node"
