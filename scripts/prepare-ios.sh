#!/usr/bin/env bash
# Adds what every iOS build needs to the Xcode project that `tauri ios init` generates:
# the privacy manifest and the identifiers for work that continues in the background.
# Run it after every `tauri ios init`, before building, for simulator and device builds alike.
set -euo pipefail
cd "$(dirname "$0")/.."
# KINETIK_PRIVACY_MANIFEST replaces the bundled privacy manifest with a distributor's own.
python3 scripts/configure-ios.py src-tauri/gen/apple "${KINETIK_PRIVACY_MANIFEST:-src-tauri/ios/PrivacyInfo.xcprivacy}"
