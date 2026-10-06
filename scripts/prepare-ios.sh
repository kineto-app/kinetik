#!/usr/bin/env bash
# Adds what every iOS build needs to the Xcode project that `tauri ios init` generates:
# the privacy manifest and the identifiers for work that continues in the background.
# Run it right after `tauri ios init` and before any other change to the generated project or
# its Info.plist, for simulator and device builds alike. It regenerates the project with
# XcodeGen, which keeps Xcode's text format, and is safe to repeat.
# KINETIK_PRIVACY_MANIFEST ships a distributor's own privacy manifest instead.
set -euo pipefail
manifest=${KINETIK_PRIVACY_MANIFEST:-}
[ -z "$manifest" ] || manifest=$(cd "$(dirname "$manifest")" && pwd)/$(basename "$manifest")
cd "$(dirname "$0")/.."
manifest=${manifest:-src-tauri/ios/PrivacyInfo.xcprivacy}
apple=src-tauri/gen/apple
[ -f "$apple/project.yml" ] || { echo "Run \`tauri ios init\` first." >&2; exit 1; }
sources=$(ls -d "$apple"/*_iOS)
python3 scripts/check-privacy-manifest.py "$manifest"
cp "$manifest" "$sources/PrivacyInfo.xcprivacy"
# project.yml includes the sources folder, so the manifest becomes an app resource.
(cd "$apple" && xcodegen generate --spec project.yml --quiet)
# XcodeGen rewrites Info.plist, so this comes after it. Continued-processing requests use
# `<bundle id>.run.<unique id>`; the build setting expands to each distributor's identifier.
plutil -replace BGTaskSchedulerPermittedIdentifiers -json '["$(PRODUCT_BUNDLE_IDENTIFIER).run.*"]' \
  "$sources/Info.plist"
for project in "$apple"/*.xcodeproj/project.pbxproj; do
  [ "$(head -1 "$project")" = '// !$*UTF8*$!' ] || { echo "$project is not in Xcode's text format" >&2; exit 1; }
done
echo "Added the privacy manifest and background-work identifiers to the iOS project"
