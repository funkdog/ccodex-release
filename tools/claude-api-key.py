#!/usr/bin/env python3
"""User-operated hidden input; no secret in arguments, output or diagnostics."""
import getpass
import json
import os
import pathlib
import stat
import sys
import uuid


def store(home, settings):
    directory = pathlib.Path(home)
    info = directory.lstat()
    if not directory.is_absolute() or not stat.S_ISDIR(info.st_mode) or directory.is_symlink():
        raise ValueError()
    if os.name != "nt" and (info.st_uid != os.getuid() or info.st_mode & 0o077):
        raise ValueError()
    destination = directory / "credentials.json"
    if destination.exists() or destination.is_symlink():
        info = destination.lstat()
        if not stat.S_ISREG(info.st_mode) or destination.is_symlink():
            raise ValueError()
        if os.name != "nt" and (info.st_uid != os.getuid() or info.st_mode & 0o077):
            raise ValueError()
    secret = getpass.getpass("Claude API key（隐藏输入，不会回显）：").strip()
    if not 8 <= len(secret) <= 16384 or "*" in secret or any(not 33 <= ord(c) <= 126 for c in secret):
        raise ValueError()
    pending = directory / (".credentials-" + str(uuid.uuid4()) + ".pending")
    try:
        fd = os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as stream:
            json.dump(dict(settings, apiKey=secret), stream)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(pending, destination)
        if os.name != "nt":
            parent_fd = os.open(directory, os.O_RDONLY)
            try:
                os.fsync(parent_fd)
            finally:
                os.close(parent_fd)
    finally:
        if pending.exists():
            pending.unlink()
    print("API key 已保存到独立私有 profile；没有输出密钥。")


if __name__ == "__main__":
    try:
        if len(sys.argv) != 3 or not sys.stdin.isatty() or not sys.stderr.isatty():
            raise ValueError()
        store(sys.argv[1], json.loads(sys.argv[2]))
    except (Exception, KeyboardInterrupt):
        print("未完成保存；请在本机终端输入完整 API key。没有输出密钥。", file=sys.stderr)
        sys.exit(1)
