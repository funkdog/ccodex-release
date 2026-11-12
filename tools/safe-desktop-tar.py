"""Validate a vendor data tar before writing only its private application payload."""
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import sys
import tarfile

MAX_MEMBERS = 50000
MAX_BYTES = 4 * 1024 * 1024 * 1024


def clean_name(name):
    if not isinstance(name, str) or not name or "\x00" in name or "\n" in name or "\r" in name:
        raise ValueError("Invalid archive member name")
    if "\\" in name or name.startswith("/") or ":" in name:
        raise ValueError("Absolute/ambiguous archive member name")
    parts = name.split("/")
    if ".." in parts:
        raise ValueError("Archive member traversal")
    return "/".join(part for part in parts if part not in ("", "."))


def inspect_payload(archive, app_prefix):
    prefix = clean_name(app_prefix).rstrip("/")
    members = archive.getmembers()
    if len(members) > MAX_MEMBERS:
        raise ValueError("Too many archive members")
    selected = []
    seen = set()
    total = 0
    links = set()
    for member in members:
        name = clean_name(member.name)
        if name != prefix and not name.startswith(prefix + "/"):
            continue
        relative = name[len(prefix):].lstrip("/")
        if not relative:
            if not member.isdir():
                raise ValueError("Application root is not a directory")
            continue
        folded = relative.casefold()
        if folded in seen:
            raise ValueError("Duplicate/case-colliding payload path")
        seen.add(folded)
        if not (member.isfile() or member.isdir() or member.issym() or member.islnk()):
            raise ValueError("Special archive payload entry")
        if member.sparse or any(key.startswith("GNU.sparse") for key in member.pax_headers):
            raise ValueError("Sparse archive payload entry")
        if member.size < 0 or member.size > MAX_BYTES:
            raise ValueError("Invalid archive member size")
        total += member.size
        if total > MAX_BYTES:
            raise ValueError("Archive payload is too large")
        target = None
        if member.issym():
            if not member.linkname or member.linkname.startswith("/") or "\\" in member.linkname:
                raise ValueError("Absolute/invalid payload symlink")
            # Lexically resolve the relative link, before any filesystem write.
            components = list(PurePosixPath(relative).parent.parts)
            for part in member.linkname.split("/"):
                if part in ("", "."):
                    continue
                if part == "..":
                    if not components:
                        raise ValueError("Payload symlink escaped application")
                    components.pop()
                elif ":" in part or "\x00" in part or "\n" in part or "\r" in part:
                    raise ValueError("Invalid payload symlink target")
                else:
                    components.append(part)
            target = "/".join(components)
            if not target:
                raise ValueError("Payload symlink targets broad application root")
            links.add(relative)
        elif member.islnk():
            link = clean_name(member.linkname)
            if not link.startswith(prefix + "/"):
                raise ValueError("Payload hardlink escaped application")
            target = link[len(prefix) + 1:]
        selected.append((member, relative, target))
    paths = {relative for _, relative, _ in selected}
    for member, relative, target in selected:
        parents = PurePosixPath(relative).parents
        if any(str(parent) in links for parent in parents):
            raise ValueError("Payload member traverses a symlink ancestor")
        if target is not None and target not in paths:
            raise ValueError("Payload link target is missing")
    by_path = {relative: (member, target) for member, relative, target in selected}
    for member, relative, target in selected:
        if not member.islnk():
            continue
        visited = {relative}
        current = target
        while True:
            if current in visited:
                raise ValueError("Cyclic payload hardlink")
            visited.add(current)
            linked, next_target = by_path[current]
            if linked.isfile():
                break
            if not linked.islnk():
                raise ValueError("Payload hardlink targets a non-regular entry")
            current = next_target
    # A relative link may point through another relative link. Resolve the
    # complete archive graph, not just each target's lexical spelling.
    symlinks = {relative: target for member, relative, target in selected if member.issym()}
    for link, target in symlinks.items():
        visited = {link}
        current = target
        for _ in range(len(symlinks) + 1):
            parts = current.split("/")
            replaced = False
            for count in range(1, len(parts) + 1):
                ancestor = "/".join(parts[:count])
                if ancestor in symlinks:
                    if ancestor in visited:
                        raise ValueError("Cyclic payload symlink")
                    visited.add(ancestor)
                    current = "/".join([symlinks[ancestor], *parts[count:]])
                    replaced = True
                    break
            if not replaced:
                break
        else:
            raise ValueError("Payload symlink graph is too deep")
        if current not in paths:
            raise ValueError("Payload symlink resolves outside the payload graph")
    if not selected:
        raise ValueError("Application payload is missing")
    return selected, total


def extract_payload(tar_path, destination, app_prefix):
    destination = Path(destination).absolute()
    if destination.exists() or destination.is_symlink():
        raise ValueError("Private payload destination must not exist")
    parent = destination.parent
    if not parent.is_dir() or parent.is_symlink():
        raise ValueError("Private extraction parent is missing/linked")
    if parent.resolve() != parent:
        raise ValueError("Private extraction parent contains a link")
    with tarfile.open(tar_path, mode="r:") as archive:
        selected, total = inspect_payload(archive, app_prefix)
        # Every member is validated before the first write.
        destination.mkdir(mode=0o700)
        for member, relative, _ in sorted(selected, key=lambda item: len(PurePosixPath(item[1]).parts)):
            if member.isdir():
                (destination / relative).mkdir(parents=True, exist_ok=True)
        for member, relative, _ in selected:
            if not member.isfile():
                continue
            output = destination / relative
            output.parent.mkdir(parents=True, exist_ok=True)
            source = archive.extractfile(member)
            if source is None:
                raise ValueError("Payload bytes are missing")
            with source, output.open("xb") as target:
                shutil.copyfileobj(source, target, length=1024 * 1024)
            if output.stat().st_size != member.size:
                raise ValueError("Payload byte count mismatch")
            output.chmod(member.mode & 0o777)  # Never copy owner/setuid/device privileges.
        pending = [(m, rel, target) for m, rel, target in selected if m.islnk()]
        while pending:
            remaining = []
            for member, relative, target in pending:
                source = destination / target
                if source.is_file() and not source.is_symlink():
                    output = destination / relative
                    output.parent.mkdir(parents=True, exist_ok=True)
                    with source.open("rb") as stream, output.open("xb") as sink:
                        shutil.copyfileobj(stream, sink, length=1024 * 1024)
                    output.chmod(member.mode & 0o777)
                else:
                    remaining.append((member, relative, target))
            if len(remaining) == len(pending):
                raise ValueError("Cyclic/non-regular payload hardlink")
            pending = remaining
        for member, relative, _ in selected:
            if member.issym():
                output = destination / relative
                output.parent.mkdir(parents=True, exist_ok=True)
                output.symlink_to(member.linkname)
        return {"members": len(selected), "bytes": total,
                "maintainerScriptsExecuted": False, "systemPathsWritten": False}


if __name__ == "__main__":
    try:
        if len(sys.argv) != 4:
            raise ValueError("Usage: safe-desktop-tar.py <uncompressed-tar> <private-destination> <app-prefix>")
        print(json.dumps(extract_payload(*sys.argv[1:])))
    except Exception as error:
        print("Private Desktop extraction refused: " + str(error), file=sys.stderr)
        sys.exit(1)
