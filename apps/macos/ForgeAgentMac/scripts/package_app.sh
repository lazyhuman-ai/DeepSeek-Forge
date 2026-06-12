#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT_ROOT="$(cd "$ROOT/../../.." && pwd)"
BIN_DIR="$(swift build -c release --package-path "$ROOT" --show-bin-path)"
BIN="$BIN_DIR/ForgeAgentMac"
POWER_HELPER="$BIN_DIR/ForgeAgentPowerHelper"
APP="$ROOT/dist/DeepSeek-Forge.app"
LEGACY_APP="$ROOT/dist/ForgeAgent.app"
RESOURCES="$APP/Contents/Resources"
CORE="$RESOURCES/ForgeAgentCore"
NODE_BIN="$(command -v node)"
NODE_REAL="$(python3 - <<'PY' "$NODE_BIN"
import os, sys
print(os.path.realpath(sys.argv[1]))
PY
)"

LAUNCHD_LABEL="com.forgeagent.gateway"
LAUNCHD_DOMAIN="gui/$(id -u)"
LAUNCHD_PLIST="$HOME/Library/LaunchAgents/$LAUNCHD_LABEL.plist"
LAUNCHD_START="$HOME/Library/Application Support/ForgeAgent/launchd-start.sh"
DIST_SERVICE_WAS_LOADED=0
DIST_SERVICE_STOPPED=0

restore_dist_app_service() {
  if [[ "$DIST_SERVICE_STOPPED" != "1" ]] || [[ "$DIST_SERVICE_WAS_LOADED" != "1" ]]; then
    return
  fi
  if [[ -f "$LAUNCHD_START" ]] && grep -Fq "$LEGACY_APP/Contents/" "$LAUNCHD_START"; then
    echo "Not restoring legacy ForgeAgent launchd service; open DeepSeek-Forge.app to reinstall it." >&2
    return
  fi
  if [[ ! -f "$LAUNCHD_PLIST" ]]; then
    echo "DeepSeek-Forge launchd plist was removed while packaging; not restoring $LAUNCHD_LABEL" >&2
    return
  fi
  launchctl bootstrap "$LAUNCHD_DOMAIN" "$LAUNCHD_PLIST" >/dev/null 2>&1 || true
  launchctl kickstart -k "$LAUNCHD_DOMAIN/$LAUNCHD_LABEL" >/dev/null 2>&1 || true
}

stop_running_dist_app() {
  if [[ -f "$LAUNCHD_START" ]] && { grep -Fq "$APP/Contents/" "$LAUNCHD_START" || grep -Fq "$LEGACY_APP/Contents/" "$LAUNCHD_START"; }; then
    if launchctl print "$LAUNCHD_DOMAIN/$LAUNCHD_LABEL" >/dev/null 2>&1; then
      DIST_SERVICE_WAS_LOADED=1
    fi
    launchctl bootout "$LAUNCHD_DOMAIN/$LAUNCHD_LABEL" >/dev/null 2>&1 \
      || launchctl bootout "$LAUNCHD_DOMAIN" "$LAUNCHD_PLIST" >/dev/null 2>&1 \
      || true
    DIST_SERVICE_STOPPED=1
    trap restore_dist_app_service EXIT
  fi

  for _ in 1 2 3 4 5; do
    if ! pgrep -f "$APP/Contents/" >/dev/null 2>&1 && ! pgrep -f "$LEGACY_APP/Contents/" >/dev/null 2>&1; then
      return
    fi
    pkill -TERM -f "$APP/Contents/" || true
    pkill -TERM -f "$LEGACY_APP/Contents/" || true
    sleep 0.2
  done
  pkill -KILL -f "$APP/Contents/" || true
  pkill -KILL -f "$LEGACY_APP/Contents/" || true
}

cd "$PROJECT_ROOT"
npm run product:build
swift build -c release --package-path "$ROOT"
if [[ "${FORGEAGENT_PACKAGE_SKIP_SERVICE_MANAGEMENT:-0}" != "1" ]]; then
  stop_running_dist_app
fi
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$RESOURCES/node/bin" "$CORE"
cp "$BIN" "$APP/Contents/MacOS/ForgeAgentMac"
chmod +x "$APP/Contents/MacOS/ForgeAgentMac"
cp "$POWER_HELPER" "$RESOURCES/ForgeAgentPowerHelper"
chmod +x "$RESOURCES/ForgeAgentPowerHelper"
cp "$NODE_REAL" "$RESOURCES/node/bin/node"
chmod +x "$RESOURCES/node/bin/node"
cp "$ROOT/Assets/AppIcon.icns" "$RESOURCES/AppIcon.icns"
rsync -a --delete \
  --exclude '.forge*' \
  --exclude 'apps' \
  --exclude 'claude-code' \
  --exclude 'web/src' \
  --exclude 'web/node_modules' \
  "$PROJECT_ROOT/package.json" \
  "$PROJECT_ROOT/package-lock.json" \
  "$PROJECT_ROOT/tsconfig.json" \
  "$PROJECT_ROOT/src" \
  "$PROJECT_ROOT/web" \
  "$PROJECT_ROOT/node_modules" \
  "$CORE/"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>ForgeAgentMac</string>
  <key>CFBundleIdentifier</key>
  <string>dev.deepseekforge.mac</string>
  <key>CFBundleName</key>
  <string>DeepSeek-Forge</string>
  <key>CFBundleDisplayName</key>
  <string>DeepSeek-Forge</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>14.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSMicrophoneUsageDescription</key>
  <string>DeepSeek-Forge uses the microphone to turn your voice input into chat text on this Mac.</string>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key>
    <true/>
  </dict>
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLName</key>
      <string>DeepSeek-Forge Pairing</string>
      <key>CFBundleURLSchemes</key>
      <array>
        <string>forgeagent</string>
      </array>
    </dict>
  </array>
</dict>
</plist>
PLIST

# Remove the old app bundle path so Dock and LaunchServices cannot keep using
# the pre-rename app label.
rm -rf "$LEGACY_APP"
touch "$APP"

echo "$APP"
