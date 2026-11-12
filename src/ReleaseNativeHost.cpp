#define WIN32_LEAN_AND_MEAN
#define UNICODE
#define _UNICODE
#include <windows.h>
#include <shlobj.h>
#include <wchar.h>
#include <string>
#include "detours.h"

static wchar_t releaseRoot[32768];
static HANDLE runtimeDirectory = INVALID_HANDLE_VALUE;
static HANDLE runtimeMetadata = INVALID_HANDLE_VALUE;
static HRESULT (WINAPI *realKnownFolder)(REFKNOWNFOLDERID, DWORD, HANDLE, PWSTR *) = SHGetKnownFolderPath;
static BOOL (WINAPI *realCreateProcess)(LPCWSTR, LPWSTR, LPSECURITY_ATTRIBUTES,
    LPSECURITY_ATTRIBUTES, BOOL, DWORD, LPVOID, LPCWSTR, LPSTARTUPINFOW,
    LPPROCESS_INFORMATION) = CreateProcessW;

static bool releaseFile(const wchar_t *base, const wchar_t *relative) {
    wchar_t file[32768];
    if (swprintf_s(file, L"%ls\\%ls", base, relative) < 0) return false;
    DWORD attrs = GetFileAttributesW(file);
    return attrs != INVALID_FILE_ATTRIBUTES &&
        !(attrs & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT));
}

static bool privateImage(const wchar_t *file, const wchar_t *name) {
    if (!file || !releaseRoot[0]) return false;
    size_t size = wcslen(releaseRoot);
    if (_wcsnicmp(file, releaseRoot, size) || file[size] != L'\\') return false;
    const wchar_t *leaf = wcsrchr(file, L'\\');
    return leaf && !_wcsicmp(leaf + 1, name);
}

static bool pinPrivateRuntime() {
    wchar_t profile[32768];
    DWORD length = GetEnvironmentVariableW(L"CODEX_COPILOT_HOME", profile, ARRAYSIZE(profile));
    if (!length || length >= ARRAYSIZE(profile) || !releaseFile(profile, L".ccodex-release-profile.json")) return false;
    std::wstring root(profile);
    if (root.compare(0, 4, L"\\\\?\\") != 0) {
        root = root.compare(0, 2, L"\\\\") == 0 ? L"\\\\?\\UNC\\" + root.substr(2) : L"\\\\?\\" + root;
    }
    root += L"\\host-profile\\.cache\\codex-runtimes\\codex-primary-runtime";
    DWORD attributes = GetFileAttributesW(root.c_str());
    if (attributes == INVALID_FILE_ATTRIBUTES || !(attributes & FILE_ATTRIBUTE_DIRECTORY) ||
        attributes & FILE_ATTRIBUTE_REPARSE_POINT || !releaseFile(root.c_str(), L"runtime.json")) return false;
    // The vendor updater promotes by renaming this directory. Two held handles
    // prevent promotion/version replacement without traversing files in DllMain.
    runtimeDirectory = CreateFileW(root.c_str(), FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, nullptr);
    if (runtimeDirectory == INVALID_HANDLE_VALUE) return false;
    runtimeMetadata = CreateFileW((root + L"\\runtime.json").c_str(), GENERIC_READ,
        FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (runtimeMetadata == INVALID_HANDLE_VALUE) {
        CloseHandle(runtimeDirectory);
        runtimeDirectory = INVALID_HANDLE_VALUE;
        return false;
    }
    SetEnvironmentVariableW(L"CCODEX_RELEASE_RUNTIME_PIN_ACTIVE", L"1");
    return true;
}

static HRESULT WINAPI privateKnownFolder(REFKNOWNFOLDERID id, DWORD flags,
    HANDLE token, PWSTR *result) {
    if (token || (!IsEqualGUID(id, FOLDERID_ProgramFiles) &&
        !IsEqualGUID(id, FOLDERID_ProgramFilesX86) &&
        !IsEqualGUID(id, FOLDERID_ProgramFilesX64))) {
        return realKnownFolder(id, flags, token, result);
    }
    if (!result) return E_INVALIDARG;
    size_t count = wcslen(releaseRoot) + wcslen(L"\\runtime") + 1;
    PWSTR value = static_cast<PWSTR>(CoTaskMemAlloc(count * sizeof(wchar_t)));
    if (!value) { *result = nullptr; return E_OUTOFMEMORY; }
    swprintf_s(value, count, L"%ls\\runtime", releaseRoot);
    *result = value;
    return S_OK;
}

static BOOL WINAPI privateCreateProcess(LPCWSTR application, LPWSTR command,
    LPSECURITY_ATTRIBUTES processAttributes, LPSECURITY_ATTRIBUTES threadAttributes,
    BOOL inheritHandles, DWORD flags, LPVOID environment, LPCWSTR directory,
    LPSTARTUPINFOW startup, LPPROCESS_INFORMATION process) {
    // Propagate only to the vendor core in this release, never to agent tools.
    if (privateImage(application, L"codex.exe")) {
        return DetourCreateProcessWithDllExW(application, command, processAttributes,
            threadAttributes, inheritHandles, flags, environment, directory, startup,
            process, "ccodex-release-host.dll", realCreateProcess);
    }
    return realCreateProcess(application, command, processAttributes, threadAttributes,
        inheritHandles, flags, environment, directory, startup, process);
}

extern "C" __declspec(dllexport) void WINAPI ReleaseHostEntry() {}

BOOL WINAPI DllMain(HINSTANCE module, DWORD reason, LPVOID) {
    if (DetourIsHelperProcess()) return TRUE;
    if (reason != DLL_PROCESS_ATTACH) return TRUE;
    DisableThreadLibraryCalls(module);
    if (!DetourRestoreAfterWith()) return FALSE;
    if (!GetModuleFileNameW(module, releaseRoot, ARRAYSIZE(releaseRoot))) return FALSE;
    wchar_t expanded[32768];
    if (GetLongPathNameW(releaseRoot, expanded, ARRAYSIZE(expanded))) {
        wcscpy_s(releaseRoot, expanded);
    }
    for (int depth = 0; depth < 16; ++depth) {
        wchar_t *slash = wcsrchr(releaseRoot, L'\\');
        if (!slash) return FALSE;
        *slash = L'\0';
        if (releaseFile(releaseRoot, L"release.json")) break;
    }
    if (!releaseFile(releaseRoot, L"release.json") ||
        !releaseFile(releaseRoot, L"runtime\\git\\cmd\\git.exe")) return FALSE;
    wchar_t image[32768];
    if (!GetModuleFileNameW(nullptr, image, ARRAYSIZE(image))) return FALSE;
    bool desktop = privateImage(image, L"ChatGPT.exe");
    bool core = privateImage(image, L"codex.exe") ||
        privateImage(image, L"codex-copilot-core.exe") ||
        privateImage(image, L"ccodex-release-native.exe");
    if (!desktop && !core) return FALSE;
    if (desktop && !pinPrivateRuntime()) return FALSE;
    if (DetourTransactionBegin() != NO_ERROR) return FALSE;
    DetourUpdateThread(GetCurrentThread());
    LONG error = desktop
        ? DetourAttach(&(PVOID &)realCreateProcess, privateCreateProcess)
        : DetourAttach(&(PVOID &)realKnownFolder, privateKnownFolder);
    if (error != NO_ERROR) { DetourTransactionAbort(); return FALSE; }
    if (DetourTransactionCommit() != NO_ERROR) return FALSE;
    SetEnvironmentVariableW(L"CCODEX_RELEASE_HOST_ACTIVE", L"1");
    return TRUE;
}
