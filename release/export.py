import json
import os
import sys
import zipfile

root, output, manifest = sys.argv[1:]
root = os.path.abspath(root)
if os.name == "nt" and not root.startswith("\\\\?\\"):
    root = "\\\\?\\" + root
with open(manifest, encoding="utf-8") as stream:
    files = json.load(stream)
with zipfile.ZipFile(output, "x", compression=zipfile.ZIP_DEFLATED,
                     compresslevel=3, allowZip64=True, strict_timestamps=False) as archive:
    for name in files:
        full = os.path.realpath(os.path.join(root, name))
        if os.path.commonpath([os.path.realpath(root), full]) != os.path.realpath(root):
            raise RuntimeError("Export file escaped the release directory")
        archive.write(full, name)
