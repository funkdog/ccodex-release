import importlib.util
import io
from pathlib import Path
import tempfile
import tarfile
import unittest

module_path = Path(__file__).resolve().parents[1] / "tools" / "safe-desktop-tar.py"
spec = importlib.util.spec_from_file_location("safe_desktop_tar", module_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class SafeDesktopTarTests(unittest.TestCase):
    def archive(self, entries):
        data = io.BytesIO()
        with tarfile.open(fileobj=data, mode="w") as output:
            for name, kind, content in entries:
                member = tarfile.TarInfo(name)
                if kind == "file":
                    content = content.encode()
                    member.size = len(content)
                    member.mode = 0o4755
                    output.addfile(member, io.BytesIO(content))
                else:
                    member.type = {"symlink": tarfile.SYMTYPE, "hardlink": tarfile.LNKTYPE,
                                   "fifo": tarfile.FIFOTYPE}[kind]
                    member.linkname = content
                    output.addfile(member)
        data.seek(0)
        return tarfile.open(fileobj=data, mode="r:")

    def test_regular_payload_and_safe_links_validate(self):
        with self.archive([
            ("usr/lib/chatgpt/ChatGPT", "file", "binary"),
            ("usr/lib/chatgpt/copy", "hardlink", "usr/lib/chatgpt/ChatGPT"),
            ("usr/lib/chatgpt/link", "symlink", "ChatGPT"),
            ("etc/system-policy", "file", "must not extract"),
        ]) as archive:
            selected, total = module.inspect_payload(archive, "usr/lib/chatgpt")
            self.assertEqual(len(selected), 3)
            self.assertEqual(total, 6)

    def test_unsafe_payloads_are_rejected_before_destination_creation(self):
        cases = [
            [("usr/lib/chatgpt/../../stock", "file", "bad")],
            [("usr/lib/chatgpt/fifo", "fifo", "")],
            [("usr/lib/chatgpt/link", "symlink", "/stock")],
            [("usr/lib/chatgpt/link", "symlink", "../../stock")],
            [("usr/lib/chatgpt/a", "hardlink", "usr/lib/chatgpt/b"),
             ("usr/lib/chatgpt/b", "hardlink", "usr/lib/chatgpt/a")],
            [("usr/lib/chatgpt/a", "symlink", "b"), ("usr/lib/chatgpt/b", "symlink", "a")],
            [("usr/lib/chatgpt/A", "file", "one"), ("usr/lib/chatgpt/a", "file", "two")],
            [("usr/lib/chatgpt/link", "symlink", "other"),
             ("usr/lib/chatgpt/link/child", "file", "bad"),
             ("usr/lib/chatgpt/other", "file", "target")],
        ]
        for entries in cases:
            with self.subTest(entries=entries), self.archive(entries) as archive:
                with self.assertRaises(ValueError):
                    module.inspect_payload(archive, "usr/lib/chatgpt")

    def test_extracts_only_private_regular_bytes_without_special_permissions(self):
        with tempfile.TemporaryDirectory(prefix="ccodex-tar-test-") as temporary:
            root = Path(temporary)
            archive_path = root / "data.tar"
            with self.archive([
                ("usr/lib/chatgpt/ChatGPT", "file", "binary"),
                ("etc/system-policy", "file", "system"),
            ]) as archive:
                archive_path.write_bytes(archive.fileobj.getvalue())
            destination = root / "app"
            result = module.extract_payload(archive_path, destination, "usr/lib/chatgpt")
            self.assertEqual((destination / "ChatGPT").read_text(), "binary")
            self.assertFalse((destination / "etc").exists())
            self.assertEqual((destination / "ChatGPT").stat().st_mode & 0o7000, 0)
            self.assertFalse(result["maintainerScriptsExecuted"])
            self.assertFalse(result["systemPathsWritten"])


if __name__ == "__main__":
    unittest.main()
