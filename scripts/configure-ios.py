"""Add the privacy manifest and background-work identifiers to the generated iOS project.

Usage: configure-ios.py <generated apple dir> <PrivacyInfo.xcprivacy>. Safe to run repeatedly.
"""

import hashlib
import json
import plistlib
import shutil
import subprocess
import sys
from pathlib import Path

apple = Path(sys.argv[1])
manifest = Path(sys.argv[2])
projects = list(apple.glob("*.xcodeproj/project.pbxproj"))
if len(projects) != 1:
    raise SystemExit(f"Expected one Xcode project in {apple}; run `tauri ios init` first")
project = projects[0]
data = json.loads(subprocess.check_output(["plutil", "-convert", "json", "-o", "-", str(project)]))
objects = data["objects"]
apps = [
    target
    for target in objects.values()
    if target.get("isa") == "PBXNativeTarget"
    and target.get("productType") == "com.apple.product-type.application"
]
if len(apps) != 1:
    raise SystemExit("Expected one iOS application target")
app = apps[0]
# The generated sources folder, `<crate>_iOS`, holds Info.plist; the manifest goes beside it.
folder = apple / (project.parent.stem + "_iOS")
if not (folder / "Info.plist").is_file():
    raise SystemExit(f"Missing {folder / 'Info.plist'}")

# Continued-processing requests use `<bundle id>.run.<unique id>`. The build setting expands to
# each distributor's bundle identifier.
info_path = folder / "Info.plist"
info = plistlib.loads(info_path.read_bytes())
permitted = info.get("BGTaskSchedulerPermittedIdentifiers", [])
pattern = "$(PRODUCT_BUNDLE_IDENTIFIER).run.*"
if pattern not in permitted:
    info["BGTaskSchedulerPermittedIdentifiers"] = [*permitted, pattern]
    info_path.write_bytes(plistlib.dumps(info, sort_keys=False))

shutil.copyfile(manifest, folder / "PrivacyInfo.xcprivacy")


def object_id(name: str) -> str:
    """Stable 24-digit IDs, so repeated runs find what they added."""
    return hashlib.sha1(("kinetik:" + name).encode()).hexdigest()[:24].upper()


reference = object_id("PrivacyInfo.xcprivacy:file")
build_file = object_id("PrivacyInfo.xcprivacy:resource")
if reference not in objects:
    objects[reference] = {
        "isa": "PBXFileReference",
        "lastKnownFileType": "text.xml",
        "path": "PrivacyInfo.xcprivacy",
        "sourceTree": "<group>",
    }
    groups = [
        o
        for o in objects.values()
        if o.get("isa") == "PBXGroup" and o.get("path") == folder.name
    ]
    if len(groups) != 1:
        raise SystemExit(f"Expected one {folder.name} group in the Xcode project")
    groups[0]["children"].append(reference)
if build_file not in objects:
    objects[build_file] = {"isa": "PBXBuildFile", "fileRef": reference}
    phases = [
        objects[phase]
        for phase in app["buildPhases"]
        if objects[phase].get("isa") == "PBXResourcesBuildPhase"
    ]
    if len(phases) != 1:
        raise SystemExit("Expected one resources phase in the iOS application target")
    phases[0]["files"].append(build_file)
project.write_bytes(plistlib.dumps(data, sort_keys=False))
print(f"Added the privacy manifest and background-work identifiers to {project.parent.name}")
