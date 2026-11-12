#define WIN32_LEAN_AND_MEAN
#define UNICODE
#define _UNICODE
#include <windows.h>
#include <shlobj.h>
#include <stdio.h>
#include <string>
#include <vector>
#include "detours.h"

static std::wstring quote(const wchar_t *argument) {
    std::wstring result = L"\"";
    size_t slashes = 0;
    for (const wchar_t *next = argument; *next; ++next) {
        if (*next == L'\\') { ++slashes; continue; }
        result.append(slashes * (*next == L'"' ? 2 : 1) + (*next == L'"' ? 1 : 0), L'\\');
        result += *next;
        slashes = 0;
    }
    result.append(slashes * 2, L'\\');
    return result + L"\"";
}

static bool ownedTarget(const std::wstring &root, const std::wstring &target) {
    if (target.size() <= root.size() || _wcsnicmp(target.c_str(), root.c_str(), root.size()) ||
        target[root.size()] != L'\\') return false;
    const wchar_t *leaf = wcsrchr(target.c_str(), L'\\');
    if (!leaf || (_wcsicmp(leaf + 1, L"ChatGPT.exe") &&
        _wcsicmp(leaf + 1, L"codex.exe") && _wcsicmp(leaf + 1, L"codex-copilot-core.exe") &&
        _wcsicmp(leaf + 1, L"ccodex-release-native.exe"))) return false;
    DWORD attrs = GetFileAttributesW(target.c_str());
    if (attrs == INVALID_FILE_ATTRIBUTES || attrs & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) return false;
    std::wstring dll(target.c_str(), leaf - target.c_str() + 1);
    dll += L"ccodex-release-host.dll";
    attrs = GetFileAttributesW(dll.c_str());
    return attrs != INVALID_FILE_ATTRIBUTES && !(attrs & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT));
}

static BOOL WINAPI keepWrapper(DWORD event) {
    return event == CTRL_C_EVENT || event == CTRL_BREAK_EVENT;
}

int wmain(int argc, wchar_t **argv) {
    if (argc == 2 && !wcscmp(argv[1], L"--internal-probe")) {
        wchar_t active[4];
        PWSTR programs = nullptr;
        if (!GetEnvironmentVariableW(L"CCODEX_RELEASE_HOST_ACTIVE", active, ARRAYSIZE(active)) ||
            FAILED(SHGetKnownFolderPath(FOLDERID_ProgramFiles, KF_FLAG_DEFAULT_PATH, nullptr, &programs))) return 1;
        std::wstring value(programs);
        CoTaskMemFree(programs);
        for (size_t at = 0; (at = value.find(L'\\', at)) != std::wstring::npos; at += 2) value.insert(at, 1, L'\\');
        int bytes = WideCharToMultiByte(CP_UTF8, 0, value.c_str(), -1, nullptr, 0, nullptr, nullptr);
        std::vector<char> utf8(bytes);
        WideCharToMultiByte(CP_UTF8, 0, value.c_str(), -1, utf8.data(), bytes, nullptr, nullptr);
        printf("{\"adapterActive\":true,\"programFiles\":\"%s\"}\n", utf8.data());
        return 0;
    }
    wchar_t own[32768], full[32768];
    if (!GetModuleFileNameW(nullptr, own, ARRAYSIZE(own))) return 1;
    std::wstring root(own);
    root.resize(root.find_last_of(L'\\'));
    root.resize(root.find_last_of(L'\\'));
    if (GetFileAttributesW((root + L"\\release.json").c_str()) == INVALID_FILE_ATTRIBUTES) return 1;
    bool probe = argc == 2 && !wcscmp(argv[1], L"--probe");
    bool launch = argc > 2 && !wcscmp(argv[1], L"--launch");
    int first = launch ? 2 : 1;
    if (!probe && argc <= first) { fprintf(stderr, "Missing private native executable.\n"); return 1; }
    const wchar_t *requested = probe ? own : argv[first];
    if (!GetFullPathNameW(requested, ARRAYSIZE(full), full, nullptr)) return 1;
    std::wstring target(full);
    if (!ownedTarget(root, target)) { fprintf(stderr, "Native target is not owned by this release.\n"); return 1; }
    std::wstring command = quote(target.c_str());
    if (probe) command += L" --internal-probe";
    else for (int index = first + 1; index < argc; ++index) command += L" " + quote(argv[index]);
    if (command.size() >= 32767) { fprintf(stderr, "Native command line is too long.\n"); return 1; }
    STARTUPINFOW startup = {};
    startup.cb = sizeof(startup);
    startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
    startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
    startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
    if (launch) startup.dwFlags = 0;
    PROCESS_INFORMATION process = {};
    SetConsoleCtrlHandler(keepWrapper, TRUE);
    if (!DetourCreateProcessWithDllExW(target.c_str(), command.data(), nullptr, nullptr,
        !launch, 0, nullptr, nullptr, &startup, &process, "ccodex-release-host.dll", nullptr)) {
        fprintf(stderr, "Private native adapter failed (Windows error %lu). No global fallback was used.\n", GetLastError());
        return 1;
    }
    CloseHandle(process.hThread);
    if (launch) {
        printf("{\"pid\":%lu}\n", process.dwProcessId);
        CloseHandle(process.hProcess);
        return 0;
    }
    WaitForSingleObject(process.hProcess, INFINITE);
    DWORD code = 1;
    GetExitCodeProcess(process.hProcess, &code);
    CloseHandle(process.hProcess);
    return static_cast<int>(code);
}
