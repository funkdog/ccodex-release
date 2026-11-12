#define WIN32_LEAN_AND_MEAN
#define UNICODE
#define _UNICODE
#include <windows.h>
#include <node_api.h>
#include <string>
#include <vector>
#include <stdio.h>

using CanvasFileOpen = FILE *(__cdecl *)(const wchar_t *, const wchar_t *);
static CanvasFileOpen originalOpen = nullptr;
static std::wstring icuPath;
static HMODULE preparedModule = nullptr;

static FILE *__cdecl openCanvasResource(const wchar_t *file, const wchar_t *mode) {
    const wchar_t *leaf = file ? wcsrchr(file, L'\\') : nullptr;
    if (leaf && !_wcsicmp(leaf + 1, L"icudtl.dat") && mode && !wcscmp(mode, L"rb")) {
        return originalOpen(icuPath.c_str(), mode);
    }
    return originalOpen(file, mode);
}

static napi_value fail(napi_env env, const char *message) {
    napi_throw_error(env, "CCODEX_CANVAS_PATH", message);
    return nullptr;
}

static std::wstring modulePath(HMODULE module) {
    std::vector<wchar_t> buffer(32768);
    DWORD length = GetModuleFileNameW(module, buffer.data(), static_cast<DWORD>(buffer.size()));
    if (!length || length >= buffer.size()) return {};
    return std::wstring(buffer.data(), length);
}

static std::wstring extendedPath(const std::wstring &file) {
    if (file.compare(0, 4, L"\\\\?\\") == 0) return file;
    if (file.compare(0, 2, L"\\\\") == 0) return L"\\\\?\\UNC\\" + file.substr(2);
    return L"\\\\?\\" + file;
}

static bool regularFile(const std::wstring &file) {
    DWORD attributes = GetFileAttributesW(extendedPath(file).c_str());
    return attributes != INVALID_FILE_ATTRIBUTES &&
        !(attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT));
}

static napi_value prepare(napi_env env, napi_callback_info info) {
    size_t argc = 1, length = 0;
    napi_value args[1];
    if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok || argc != 1 ||
        napi_get_value_string_utf16(env, args[0], nullptr, 0, &length) != napi_ok ||
        !length || length >= 32767) {
        return fail(env, "Canvas binding path must be an absolute Windows filename.");
    }
    std::vector<char16_t> argument(length + 1);
    if (napi_get_value_string_utf16(env, args[0], argument.data(), argument.size(), &length) != napi_ok) {
        return fail(env, "Cannot read canvas binding path.");
    }
    std::wstring target(reinterpret_cast<const wchar_t *>(argument.data()), length);
    const size_t slash = target.find_last_of(L'\\');
    if (slash == std::wstring::npos || target.substr(slash + 1) != L"skia.win32-arm64-msvc.node") {
        return fail(env, "Unexpected canvas native binding.");
    }
    HMODULE own = nullptr;
    if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
        GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
        reinterpret_cast<LPCWSTR>(&prepare), &own)) {
        return fail(env, "Cannot identify the private canvas path adapter.");
    }
    std::wstring ownPath = extendedPath(modulePath(own));
    std::wstring directory = extendedPath(target.substr(0, slash));
    if (ownPath.empty() || _wcsicmp(ownPath.substr(0, ownPath.find_last_of(L'\\')).c_str(),
        directory.c_str())) {
        return fail(env, "Canvas adapter and binding must belong to the same private runtime directory.");
    }
    const std::wstring resource = directory + L"\\icudtl.dat";
    if (!regularFile(target) || !regularFile(resource)) {
        return fail(env, "The bundled canvas binding or its ICU data is missing.");
    }
    HMODULE module = LoadLibraryExW(extendedPath(target).c_str(), nullptr, LOAD_WITH_ALTERED_SEARCH_PATH);
    if (!module) return fail(env, "Cannot load the bundled ARM64 canvas library.");
    if (preparedModule) {
        if (preparedModule != module) return fail(env, "A different canvas runtime was already prepared.");
    } else {
        auto base = reinterpret_cast<BYTE *>(module);
        auto dos = reinterpret_cast<IMAGE_DOS_HEADER *>(base);
        if (dos->e_magic != IMAGE_DOS_SIGNATURE) return fail(env, "Invalid canvas image header.");
        auto nt = reinterpret_cast<IMAGE_NT_HEADERS64 *>(base + dos->e_lfanew);
        if (nt->Signature != IMAGE_NT_SIGNATURE || nt->OptionalHeader.Magic != IMAGE_NT_OPTIONAL_HDR64_MAGIC) {
            return fail(env, "Invalid ARM64 canvas image.");
        }
        const auto &imports = nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT];
        if (!imports.VirtualAddress) return fail(env, "Canvas imports are unavailable.");
        void **slot = nullptr;
        auto descriptor = reinterpret_cast<IMAGE_IMPORT_DESCRIPTOR *>(base + imports.VirtualAddress);
        for (; descriptor->Name && !slot; ++descriptor) {
            if (!descriptor->OriginalFirstThunk) continue;
            auto names = reinterpret_cast<IMAGE_THUNK_DATA64 *>(base + descriptor->OriginalFirstThunk);
            auto addresses = reinterpret_cast<IMAGE_THUNK_DATA64 *>(base + descriptor->FirstThunk);
            for (; names->u1.AddressOfData; ++names, ++addresses) {
                if (IMAGE_SNAP_BY_ORDINAL64(names->u1.Ordinal)) continue;
                auto name = reinterpret_cast<IMAGE_IMPORT_BY_NAME *>(base + names->u1.AddressOfData);
                if (!strcmp(reinterpret_cast<const char *>(name->Name), "_wfopen")) {
                    slot = reinterpret_cast<void **>(&addresses->u1.Function);
                    break;
                }
            }
        }
        if (!slot) return fail(env, "The pinned canvas library has no supported ICU file import.");
        DWORD protection = 0;
        if (!VirtualProtect(slot, sizeof(void *), PAGE_READWRITE, &protection)) {
            return fail(env, "Windows policy blocked the process-local canvas path adapter.");
        }
        // Change this library's import only. Preserve its CRT FILE ABI and every other file operation.
        originalOpen = reinterpret_cast<CanvasFileOpen>(*slot);
        icuPath = resource;
        InterlockedExchangePointer(slot, reinterpret_cast<void *>(&openCanvasResource));
        DWORD ignored = 0;
        if (!VirtualProtect(slot, sizeof(void *), protection, &ignored)) {
            return fail(env, "Cannot restore canvas import-page protection.");
        }
        preparedModule = module;
    }
    napi_value result;
    napi_get_boolean(env, true, &result);
    return result;
}

NAPI_MODULE_INIT() {
    napi_value function;
    if (napi_create_function(env, "prepare", NAPI_AUTO_LENGTH, prepare, nullptr, &function) != napi_ok ||
        napi_set_named_property(env, exports, "prepare", function) != napi_ok) return nullptr;
    return exports;
}
