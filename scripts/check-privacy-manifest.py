"""Refuse a privacy manifest that is not a property list with the expected keys and types."""

import plistlib
import sys

path = sys.argv[1]
try:
    with open(path, "rb") as file:
        manifest = plistlib.load(file)
except (OSError, plistlib.InvalidFileException, ValueError) as error:
    raise SystemExit(f"Unreadable privacy manifest {path}: {error}")
expected = {
    "NSPrivacyTracking": bool,
    "NSPrivacyTrackingDomains": list,
    "NSPrivacyCollectedDataTypes": list,
    "NSPrivacyAccessedAPITypes": list,
}
if not isinstance(manifest, dict):
    raise SystemExit(f"{path}: the privacy manifest must be a dictionary")
problems = [f"unexpected key {key}" for key in manifest if key not in expected]
problems += [
    f"{key} must be a {kind.__name__}"
    for key, kind in expected.items()
    if not isinstance(manifest.get(key), kind)
]
for entry in manifest.get("NSPrivacyAccessedAPITypes") or []:
    if not isinstance(entry, dict) or not isinstance(entry.get("NSPrivacyAccessedAPIType"), str) or not entry.get("NSPrivacyAccessedAPITypeReasons"):
        problems.append("each accessed API needs a type and its reasons")
for entry in manifest.get("NSPrivacyCollectedDataTypes") or []:
    if not isinstance(entry, dict) or not isinstance(entry.get("NSPrivacyCollectedDataType"), str):
        problems.append("each collected data type needs NSPrivacyCollectedDataType")
if problems:
    raise SystemExit(f"{path}: " + "; ".join(sorted(set(problems))))
