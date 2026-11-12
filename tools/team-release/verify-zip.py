import hashlib
import json
import sys
import zipfile

archive, root = sys.argv[1:]
with open(root + "/release.json", encoding="utf-8") as stream:
    expected_metadata = json.load(stream)
with open(root + "/release-files.json", "rb") as stream:
    expected_inventory = stream.read()
with zipfile.ZipFile(archive, "r") as bundle:
    metadata = json.loads(bundle.read("release.json"))
    inventory_bytes = bundle.read("release-files.json")
    if metadata != expected_metadata or inventory_bytes != expected_inventory:
        raise RuntimeError("ZIP metadata does not match the frozen release resources")
    if hashlib.sha256(inventory_bytes).hexdigest() != metadata["fileManifestSha256"]:
        raise RuntimeError("ZIP inventory checksum differs")
    files = json.loads(inventory_bytes)["files"]
    expected = {entry["path"] for entry in files} | {"release.json", "release-files.json"}
    names = bundle.namelist()
    if len(names) != len(expected) or set(names) != expected:
        raise RuntimeError("ZIP contains missing, extra or duplicate resources")
    total = 0
    for index, entry in enumerate(files, 1):
        info = bundle.getinfo(entry["path"])
        if info.file_size != entry["size"]:
            raise RuntimeError("ZIP resource size differs: " + entry["path"])
        digest = hashlib.sha256()
        with bundle.open(info) as source:
            while True:
                chunk = source.read(1024 * 1024)
                if not chunk:
                    break
                digest.update(chunk)
                total += len(chunk)
        if digest.hexdigest() != entry["sha256"]:
            raise RuntimeError("ZIP resource checksum differs: " + entry["path"])
        if index % 8000 == 0 or index == len(files):
            print(f"ZIP integrity: {index}/{len(files)} resources checked.", flush=True)
    print(json.dumps({"passed": True, "releaseId": metadata["releaseId"],
                      "checkedFiles": len(files), "checkedBytes": total,
                      "fileManifestSha256": metadata["fileManifestSha256"]}), flush=True)
