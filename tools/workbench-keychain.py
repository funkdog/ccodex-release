#!/usr/bin/python3
"""User-operated, hidden input directly into the macOS login keychain.

Do not use security(1)'s getpass prompt: libc silently discards input after
128 characters. Python's termios-based getpass reads the complete line. The
credential goes to Security.framework as CFData, never argv, stdout or a file.
"""
import ctypes
import getpass
import re
import sys


def store(account):
    pointer = ctypes.c_void_p
    index = ctypes.c_long
    status_type = ctypes.c_int32
    security = ctypes.CDLL("/System/Library/Frameworks/Security.framework/Security")
    cf = ctypes.CDLL("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
    cf.CFStringCreateWithCString.argtypes = [pointer, ctypes.c_char_p, ctypes.c_uint32]
    cf.CFStringCreateWithCString.restype = pointer
    cf.CFDataCreate.argtypes = [pointer, pointer, index]
    cf.CFDataCreate.restype = pointer
    cf.CFDictionaryCreateMutable.argtypes = [pointer, index, pointer, pointer]
    cf.CFDictionaryCreateMutable.restype = pointer
    cf.CFDictionarySetValue.argtypes = [pointer, pointer, pointer]
    cf.CFDictionarySetValue.restype = None
    cf.CFArrayCreate.argtypes = [pointer, ctypes.POINTER(pointer), index, pointer]
    cf.CFArrayCreate.restype = pointer
    cf.CFRelease.argtypes = [pointer]
    cf.CFRelease.restype = None
    security.SecTrustedApplicationCreateFromPath.argtypes = [ctypes.c_char_p, ctypes.POINTER(pointer)]
    security.SecTrustedApplicationCreateFromPath.restype = status_type
    security.SecAccessCreate.argtypes = [pointer, pointer, ctypes.POINTER(pointer)]
    security.SecAccessCreate.restype = status_type
    security.SecItemUpdate.argtypes = [pointer, pointer]
    security.SecItemUpdate.restype = status_type
    security.SecItemAdd.argtypes = [pointer, pointer]
    security.SecItemAdd.restype = status_type
    owned = []
    buffer = None

    def retain(value):
        if not value:
            raise RuntimeError("Native allocation failed")
        owned.append(value)
        return value

    def text(value):
        return retain(cf.CFStringCreateWithCString(None, value.encode("utf-8"), 0x08000100))

    def constant(name):
        return pointer.in_dll(security, name).value

    def dictionary(entries):
        # All values are kept alive in `owned` through the synchronous native
        # calls. Null callbacks avoid transferring ownership of global keys.
        result = retain(cf.CFDictionaryCreateMutable(None, len(entries), None, None))
        for key, value in entries:
            cf.CFDictionarySetValue(result, constant(key), value)
        return result

    def checked(status):
        if status != 0:
            raise RuntimeError("Keychain status " + str(status))

    try:
        secret = getpass.getpass("运行密钥（隐藏输入，支持完整长密钥）：").strip()
        if not secret or len(secret) > 16384 or "*" in secret or any(char.isspace() for char in secret):
            print("未保存：请输入创建密钥时显示的完整原始值，不能使用遮罩文本。", file=sys.stderr)
            return 1
        raw = secret.encode("ascii")
        buffer = ctypes.create_string_buffer(raw)
        data = retain(cf.CFDataCreate(None, ctypes.cast(buffer, pointer), len(raw)))
        trusted = pointer()
        checked(security.SecTrustedApplicationCreateFromPath(b"/usr/bin/security", ctypes.byref(trusted)))
        retain(trusted.value)
        applications = retain(cf.CFArrayCreate(None, (pointer * 1)(trusted.value), 1, None))
        access = pointer()
        checked(security.SecAccessCreate(text("MyCodex 工作台自动连接"), applications, ctypes.byref(access)))
        retain(access.value)
        identity = [("kSecClass", constant("kSecClassGenericPassword")),
                    ("kSecAttrService", text("local.mycodex.workbench.tunnel")),
                    ("kSecAttrAccount", text(account))]
        attributes = [("kSecValueData", data), ("kSecAttrAccess", access.value)]
        result = security.SecItemUpdate(dictionary(identity), dictionary(attributes))
        if result == -25300:  # errSecItemNotFound
            result = security.SecItemAdd(dictionary(identity + attributes), None)
        checked(result)
        print("完整运行密钥已保存到本机钥匙串。")
        return 0
    finally:
        if buffer is not None:
            ctypes.memset(ctypes.addressof(buffer), 0, ctypes.sizeof(buffer))
        for value in reversed(owned):
            cf.CFRelease(value)


if __name__ == "__main__":
    result = 1
    try:
        if sys.platform != "darwin" or len(sys.argv) != 2 or not re.fullmatch(r"[a-z][a-z0-9-]{0,63}", sys.argv[1]):
            raise RuntimeError("Invalid invocation")
        if not sys.stdin.isatty() or not sys.stderr.isatty():
            raise RuntimeError("A user-owned terminal is required")
        result = store(sys.argv[1])
    except (KeyboardInterrupt, EOFError):
        print("已取消；没有输出密钥。", file=sys.stderr)
    except Exception:
        # Never include exception text: password values can appear in encoding
        # errors. The caller reports the failure without dumping any input.
        print("钥匙串保存未完成；没有输出密钥。", file=sys.stderr)
    sys.exit(result)
