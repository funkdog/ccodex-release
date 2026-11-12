import os
import sys
import time
import zipfile

source, output = sys.argv[1:]
source = os.path.abspath(source)
if os.name == "nt" and not source.startswith("\\\\?\\"):
    source = "\\\\?\\" + source
started = time.monotonic()
count = 0
mode = "a" if os.path.exists(output) and zipfile.is_zipfile(output) else "w"
with zipfile.ZipFile(output, mode, compression=zipfile.ZIP_DEFLATED,
                     compresslevel=3, allowZip64=True, strict_timestamps=False) as archive:
    existing = set(archive.namelist())
    for root, directories, files in os.walk(source):
        directories.sort()
        for name in sorted(files):
            full = os.path.join(root, name)
            relative = os.path.relpath(full, source).replace(os.sep, "/")
            if relative in existing:
                count += 1
                continue
            archive.write(full, relative)
            count += 1
            if count % 4000 == 0:
                print(f"ZIP: {count} resources packed; {time.monotonic() - started:.0f}s", flush=True)
print(f"Complete ZIP: {count} files; {os.path.getsize(output)} bytes; {time.monotonic() - started:.0f}s", flush=True)
