#!/usr/bin/env bash
# Generates the Xcode project if needed and gives the unsigned simulator build an app identity,
# so Keychain access works. Simulator only: physical devices use a real provisioning profile.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -d src-tauri/gen/apple ] || npm run tauri -- ios init --ci
identity=src-tauri/gen/apple/simulator-identity
cat > "$identity.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>application-identifier</key><string>SIMULATOR.app.kinetik.oss</string>
  <key>keychain-access-groups</key><array><string>SIMULATOR.app.kinetik.oss</string></array>
</dict></plist>
PLIST
/usr/bin/derq query -f xml -i "$identity.plist" -o "$identity.der" --raw
python3 scripts/configure-ios-simulator.py src-tauri/gen/apple/kinetik.xcodeproj/project.pbxproj "$identity"
