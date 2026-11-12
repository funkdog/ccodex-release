import copy
import json
import os
import struct
import sys
import zipfile

root, previous, output, changed_file = sys.argv[1:]
root = os.path.abspath(root)
if os.name == "nt" and not root.startswith("\\\\?\\"):
    root = "\\\\?\\" + root
with open(changed_file, encoding="utf-8") as stream:
    changed = set(json.load(stream))
with open(os.path.join(root, "release-files.json"), encoding="utf-8") as stream:
    current = {entry["path"]: entry for entry in json.load(stream)["files"]}
expected = set(current)
expected.update(["release.json", "release-files.json"])
with zipfile.ZipFile(previous, "r") as source:
    old = {entry["path"]: entry for entry in json.loads(
        source.read("release-files.json").decode("utf-8"))["files"]}
    # A refresh may have run more than once. The embedded inventory, not the
    # most recent edit list, determines whether compressed data can be reused.
    changed.update(name for name, entry in current.items()
                   if old.get(name) != entry)
    changed.update(["release.json", "release-files.json"])
    infos = sorted(source.infolist(), key=lambda item: item.header_offset)
    boundaries = [entry.header_offset for entry in infos[1:]] + [source.start_dir]
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED,
                         compresslevel=3, allowZip64=True, strict_timestamps=False) as target:
        for entry, end in zip(infos, boundaries):
            if entry.filename not in expected or entry.filename in changed:
                continue
            cloned = copy.copy(entry)
            target.fp.seek(target.start_dir)
            cloned.header_offset = target.fp.tell()
            source.fp.seek(entry.header_offset)
            remaining = end - entry.header_offset
            while remaining:
                chunk = source.fp.read(min(remaining, 1024 * 1024))
                if not chunk:
                    raise RuntimeError("Truncated input ZIP")
                target.fp.write(chunk)
                remaining -= len(chunk)
            target.filelist.append(cloned)
            target.NameToInfo[cloned.filename] = cloned
            target.start_dir = target.fp.tell()
            target._didModify = True
        for name in sorted(expected):
            if name not in target.NameToInfo:
                target.write(os.path.join(root, name.replace("/", os.sep)), name)
        if len(target.NameToInfo) != len(expected):
            raise RuntimeError("Repacked ZIP resource inventory differs")
print(f"Repacked complete archive: {len(expected)} resources, {os.path.getsize(output)} bytes", flush=True)
