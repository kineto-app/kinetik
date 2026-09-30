"""Embed the CI simulator identity without changing physical-device signing."""

import json
import plistlib
import shlex
import subprocess
import sys
from pathlib import Path

project = Path(sys.argv[1])
identity = Path(sys.argv[2]).resolve()
data = json.loads(subprocess.check_output(["plutil", "-convert", "json", "-o", "-", str(project)]))
objects = data["objects"]
configurations = {
    config
    for target in objects.values()
    if target.get("isa") == "PBXNativeTarget"
    and target.get("productType") == "com.apple.product-type.application"
    for config in objects[target["buildConfigurationList"]]["buildConfigurations"]
}
updated = 0
for config in configurations:
    item = objects[config]
    settings = item["buildSettings"]
    key = "OTHER_LDFLAGS[sdk=iphonesimulator*]"
    flags = settings.get(key, settings.get("OTHER_LDFLAGS", ["$(inherited)"]))
    flags = shlex.split(flags) if isinstance(flags, str) else list(flags)
    for section, suffix in [("__entitlements", ".plist"), ("__ents_der", ".der")]:
        path = identity.with_suffix(suffix)
        if not path.is_file():
            raise SystemExit(f"Missing simulator identity: {path}")
        flag = f"-Wl,-sectcreate,__TEXT,{section},{path}"
        if flag not in flags:
            flags.append(flag)
    settings[key] = flags
    updated += 1
if not updated:
    raise SystemExit("No Xcode build configurations found")
project.write_bytes(plistlib.dumps(data, sort_keys=False))
print(f"Configured simulator identity in {updated} Xcode build configurations")
