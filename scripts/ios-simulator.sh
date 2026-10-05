#!/usr/bin/env bash
# Builds the app for the iOS Simulator, then installs and opens it on a booted iPhone
# (booting the first available one if none is running).
set -euo pipefail
cd "$(dirname "$0")/.."
scripts/prepare-ios-simulator.sh
npm run ios:build -- --debug --target aarch64-sim --no-sign
pick='import json,sys
devices=[d for r,v in json.load(sys.stdin)["devices"].items() if "iOS" in r for d in v if d["name"].startswith("iPhone")]
print(next((d["udid"] for d in devices if d["state"]=="Booted"), devices[0]["udid"] if devices else ""))'
device=$(xcrun simctl list devices available -j | python3 -c "$pick")
[ -n "$device" ] || { echo "No iPhone simulator found. Install the iOS platform in Xcode → Settings → Components." >&2; exit 1; }
xcrun simctl boot "$device" 2>/dev/null || true
xcrun simctl bootstatus "$device" -b >/dev/null
open -a Simulator
xcrun simctl install "$device" src-tauri/gen/apple/build/arm64-sim/Kinetik.app
xcrun simctl launch "$device" app.kinetik.oss
