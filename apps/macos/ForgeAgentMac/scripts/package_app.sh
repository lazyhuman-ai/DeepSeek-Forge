#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT_ROOT="$(cd "$ROOT/../../.." && pwd)"
BIN_DIR="$(swift build -c release --package-path "$ROOT" --show-bin-path)"
BIN="$BIN_DIR/ForgeAgentMac"
POWER_HELPER="$BIN_DIR/ForgeAgentPowerHelper"
APP="$ROOT/dist/ForgeAgent.app"
RESOURCES="$APP/Contents/Resources"
CORE="$RESOURCES/ForgeAgentCore"
NODE_BIN="$(command -v node)"
NODE_REAL="$(python3 - <<'PY' "$NODE_BIN"
import os, sys
print(os.path.realpath(sys.argv[1]))
PY
)"

cd "$PROJECT_ROOT"
npm run product:build
swift build -c release --package-path "$ROOT"
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
  <string>dev.forgeagent.mac</string>
  <key>CFBundleName</key>
  <string>ForgeAgent</string>
  <key>CFBundleDisplayName</key>
  <string>ForgeAgent</string>
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
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key>
    <true/>
  </dict>
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLName</key>
      <string>ForgeAgent Pairing</string>
      <key>CFBundleURLSchemes</key>
      <array>
        <string>forgeagent</string>
      </array>
    </dict>
  </array>
</dict>
</plist>
PLIST

echo "$APP"
