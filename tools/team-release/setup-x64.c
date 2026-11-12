#define WIN32_LEAN_AND_MEAN
#define UNICODE
#define _UNICODE
#include <windows.h>
#include <bcrypt.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <wchar.h>
#include <shlobj.h>
#include <knownfolders.h>

#pragma comment(lib, "bcrypt.lib")
#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "uuid.lib")

#pragma pack(push, 1)
typedef struct {
    char magic[16];
    uint64_t zip_offset;
    uint64_t zip_length;
    unsigned char zip_sha256[32];
    uint64_t script_offset;
    uint64_t script_length;
    unsigned char script_sha256[32];
} Footer;
#pragma pack(pop)

static const char magic[16] = "CCODEX-SFX-V1";
static wchar_t failure[1024];
static int append(wchar_t *buffer, size_t capacity, const wchar_t *value);

static int remove_stage_tree(const wchar_t *directory) {
    DWORD attributes = GetFileAttributesW(directory);
    if (attributes == INVALID_FILE_ATTRIBUTES || (attributes & FILE_ATTRIBUTE_REPARSE_POINT)) return 0;
    size_t capacity = wcslen(directory) + 1024;
    wchar_t *child = (wchar_t *)calloc(capacity, sizeof(wchar_t));
    if (!child) return 0;
    swprintf_s(child, capacity, L"%ls\\*", directory);
    WIN32_FIND_DATAW entry;
    HANDLE search = FindFirstFileW(child, &entry);
    int success = search != INVALID_HANDLE_VALUE;
    if (success) {
        do {
            if (!wcscmp(entry.cFileName, L".") || !wcscmp(entry.cFileName, L"..")) continue;
            if (entry.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) { success = 0; break; }
            swprintf_s(child, capacity, L"%ls\\%ls", directory, entry.cFileName);
            if (entry.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
                if (!remove_stage_tree(child)) { success = 0; break; }
            } else {
                if (entry.dwFileAttributes & FILE_ATTRIBUTE_READONLY)
                    SetFileAttributesW(child, entry.dwFileAttributes & ~FILE_ATTRIBUTE_READONLY);
                if (!DeleteFileW(child)) { success = 0; break; }
            }
        } while (FindNextFileW(search, &entry));
        FindClose(search);
    }
    free(child);
    return success && RemoveDirectoryW(directory);
}

static int cleanup_stage(const wchar_t *stage, const wchar_t *temp) {
    wchar_t resolved[32768], base[32768], extended[32768];
    DWORD target_size = GetFullPathNameW(stage, 32768, resolved, NULL);
    DWORD base_size = GetFullPathNameW(temp, 32768, base, NULL);
    if (!target_size || target_size >= 32768 || !base_size || base_size >= 32768) return 0;
    if (base[base_size - 1] != L'\\' && !append(base, 32768, L"\\")) return 0;
    size_t prefix = wcslen(base);
    if (_wcsnicmp(resolved, base, prefix) || _wcsicmp(resolved, stage)) return 0;
    const wchar_t *name = resolved + prefix;
    const wchar_t *tag = L"ccodex-release-setup-";
    size_t tag_size = wcslen(tag);
    if (wcslen(name) != tag_size + 32 || wcsncmp(name, tag, tag_size)) return 0;
    for (size_t index = tag_size; name[index]; index++)
        if (!((name[index] >= L'0' && name[index] <= L'9') ||
              (name[index] >= L'a' && name[index] <= L'f'))) return 0;
    if (swprintf_s(extended, 32768, L"\\\\?\\%ls", resolved) < 0) return 0;
    ULONGLONG deadline = GetTickCount64() + 45000;
    do {
        if (remove_stage_tree(extended) ||
            GetFileAttributesW(extended) == INVALID_FILE_ATTRIBUTES &&
            GetLastError() == ERROR_FILE_NOT_FOUND) return 1;
        if (GetTickCount64() >= deadline) break;
        Sleep(750);
    } while (1);
    return 0;
}

static int fail(const wchar_t *message) {
    wcsncpy_s(failure, 1024, message, _TRUNCATE);
    return 0;
}

static int append(wchar_t *buffer, size_t capacity, const wchar_t *value) {
    return wcscat_s(buffer, capacity, value) == 0;
}

static int regular_ancestry(const wchar_t *path) {
    wchar_t current[32768];
    if (!path[0] || path[1] != L':' || path[2] != L'\\' ||
        wcscpy_s(current, 32768, path)) return 0;
    size_t size = wcslen(current);
    while (size > 3 && current[size - 1] == L'\\') current[--size] = 0;
    for (;;) {
        DWORD attributes = GetFileAttributesW(current);
        if (attributes == INVALID_FILE_ATTRIBUTES ||
            !(attributes & FILE_ATTRIBUTE_DIRECTORY) ||
            (attributes & FILE_ATTRIBUTE_REPARSE_POINT)) return 0;
        if (size <= 3) return 1;
        wchar_t *separator = wcsrchr(current, L'\\');
        if (!separator) return 0;
        if (separator == current + 2) separator[1] = 0;
        else *separator = 0;
        size = wcslen(current);
    }
}

static int setup_temp(wchar_t *temp, size_t capacity) {
    DWORD size = GetTempPathW((DWORD)capacity, temp);
    if (!size || size >= capacity) return fail(L"Cannot locate a private temporary directory.");
    // Pinned native executables still need short paths even with long-path-aware
    // extraction. Resolve this per user, without changing machine-wide settings.
    if (size <= 80 && regular_ancestry(temp)) return 1;
    wchar_t previous[32768], candidate[32768], environment_local[32768];
    wcscpy_s(previous, 32768, temp);
    DWORD local_size = GetEnvironmentVariableW(L"LOCALAPPDATA", environment_local, 32768);
    int copied = 0;
    if (local_size && local_size < 74 && regular_ancestry(environment_local)) {
        copied = wcscpy_s(candidate, 32768, environment_local) == 0 &&
            append(candidate, 32768, L"\\Temp");
    } else {
        PWSTR local = NULL;
        HRESULT status = SHGetKnownFolderPath(&FOLDERID_LocalAppData, 0, NULL, &local);
        if (FAILED(status) || !local) return fail(L"Cannot resolve a safe per-user setup directory.");
        copied = regular_ancestry(local) &&
            wcscpy_s(candidate, 32768, local) == 0 &&
            append(candidate, 32768, L"\\Temp");
        CoTaskMemFree(local);
    }
    if (!copied || wcslen(candidate) >= 80) {
        return fail(L"The temporary path is too long or redirected. Select a shorter local TEMP directory and retry.");
    }
    DWORD attributes = GetFileAttributesW(candidate);
    if (attributes == INVALID_FILE_ATTRIBUTES) {
        DWORD error = GetLastError();
        if ((error != ERROR_FILE_NOT_FOUND && error != ERROR_PATH_NOT_FOUND) ||
            !CreateDirectoryW(candidate, NULL))
            return fail(L"Cannot create the per-user temporary directory; existing files were preserved.");
    }
    if (!regular_ancestry(candidate) || !append(candidate, 32768, L"\\"))
        return fail(L"The per-user temporary directory is redirected or not a regular directory.");
    wchar_t inherited[2];
    if (!GetEnvironmentVariableW(L"CCODEX_REAL_TEMP", inherited, 2))
        SetEnvironmentVariableW(L"CCODEX_REAL_TEMP", previous);
    if (!SetEnvironmentVariableW(L"TEMP", candidate) ||
        !SetEnvironmentVariableW(L"TMP", candidate) ||
        wcscpy_s(temp, capacity, candidate)) return fail(L"Cannot prepare the private setup environment.");
    return 1;
}

static int append_arg(wchar_t *buffer, size_t capacity, const wchar_t *argument) {
    size_t slashes = 0;
    if (buffer[0] && !append(buffer, capacity, L" ")) return 0;
    if (!append(buffer, capacity, L"\"")) return 0;
    for (const wchar_t *at = argument; *at; at++) {
        if (*at == L'\\') { slashes++; continue; }
        size_t count = *at == L'"' ? slashes * 2 + 1 : slashes;
        while (count--) if (!append(buffer, capacity, L"\\")) return 0;
        wchar_t part[2] = { *at, 0 };
        if (!append(buffer, capacity, part)) return 0;
        slashes = 0;
    }
    while (slashes--) if (!append(buffer, capacity, L"\\\\")) return 0;
    return append(buffer, capacity, L"\"");
}

static int copy_verified(HANDLE source, uint64_t offset, uint64_t length,
                         const unsigned char expected[32], const wchar_t *destination) {
    BCRYPT_ALG_HANDLE algorithm = NULL;
    BCRYPT_HASH_HANDLE hash = NULL;
    unsigned char result[32];
    unsigned char *object = NULL;
    unsigned char *buffer = NULL;
    DWORD object_size = 0, returned = 0;
    HANDLE output = INVALID_HANDLE_VALUE;
    int success = 0;
    LARGE_INTEGER position;
    position.QuadPart = offset;
    if (!SetFilePointerEx(source, position, NULL, FILE_BEGIN)) return fail(L"Cannot read setup payload.");
    if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, NULL, 0) != 0 ||
        BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH, (PUCHAR)&object_size,
                          sizeof(object_size), &returned, 0) != 0) {
        fail(L"Windows SHA-256 service is unavailable.");
        goto cleanup;
    }
    object = (unsigned char *)malloc(object_size);
    buffer = (unsigned char *)malloc(1024 * 1024);
    if (!object || !buffer) { fail(L"Not enough memory."); goto cleanup; }
    if (BCryptCreateHash(algorithm, &hash, object, object_size, NULL, 0, 0) != 0) {
        fail(L"Cannot initialize setup integrity verification.");
        goto cleanup;
    }
    output = CreateFileW(destination, GENERIC_WRITE, 0, NULL, CREATE_NEW,
                         FILE_ATTRIBUTE_NORMAL, NULL);
    if (output == INVALID_HANDLE_VALUE) { fail(L"Cannot create setup staging file."); goto cleanup; }
    while (length) {
        DWORD requested = length > 1024 * 1024 ? 1024 * 1024 : (DWORD)length;
        DWORD read = 0, written = 0;
        if (!ReadFile(source, buffer, requested, &read, NULL) || read != requested ||
            BCryptHashData(hash, buffer, read, 0) != 0 ||
            !WriteFile(output, buffer, read, &written, NULL) || written != read) {
            fail(L"Setup payload is truncated, unreadable, or the disk is full.");
            goto cleanup;
        }
        length -= read;
    }
    if (BCryptFinishHash(hash, result, sizeof(result), 0) != 0 ||
        memcmp(result, expected, sizeof(result)) != 0) {
        fail(L"SHA-256 verification failed. Obtain an unmodified release package.");
        goto cleanup;
    }
    success = 1;
cleanup:
    if (output != INVALID_HANDLE_VALUE) CloseHandle(output);
    if (hash) BCryptDestroyHash(hash);
    if (algorithm) BCryptCloseAlgorithmProvider(algorithm, 0);
    free(object);
    free(buffer);
    if (!success) DeleteFileW(destination);
    return success;
}

int wmain(int argc, wchar_t **argv) {
    wchar_t executable[32768], temp[32768], stage[32768], script[32768], archive[32768];
    wchar_t powershell[32768], command[32768];
    unsigned char random[16];
    Footer footer;
    LARGE_INTEGER size, position;
    HANDLE self = INVALID_HANDLE_VALUE;
    STARTUPINFOW startup = { sizeof(startup) };
    PROCESS_INFORMATION process = { 0 };
    DWORD exit_code = 1, read = 0;
    int result = 1, stage_created = 0, keep_extracted = 0;
    stage[0] = temp[0] = 0;
    for (int index = 1; index < argc; index++)
        if (!_wcsicmp(argv[index], L"--keep-extracted")) keep_extracted = 1;
    wprintf(L"CCodex Release Setup | Windows x64 | local ccodex + Desktop snapshot\n\n");
    if (!GetModuleFileNameW(NULL, executable, 32768)) { fail(L"Cannot locate setup executable."); goto done; }
    self = CreateFileW(executable, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, 0, NULL);
    if (self == INVALID_HANDLE_VALUE || !GetFileSizeEx(self, &size) ||
        size.QuadPart <= sizeof(footer)) { fail(L"Setup package is incomplete."); goto done; }
    position.QuadPart = size.QuadPart - sizeof(footer);
    if (!SetFilePointerEx(self, position, NULL, FILE_BEGIN) ||
        !ReadFile(self, &footer, sizeof(footer), &read, NULL) || read != sizeof(footer) ||
        memcmp(footer.magic, magic, sizeof(magic)) != 0 ||
        footer.script_length == 0 || footer.script_length > 512 * 1024 ||
        footer.zip_length == 0 || footer.zip_offset > (uint64_t)position.QuadPart ||
        footer.zip_length != (uint64_t)position.QuadPart - footer.zip_offset ||
        footer.script_offset > footer.zip_offset ||
        footer.script_length != footer.zip_offset - footer.script_offset) {
        fail(L"Setup footer is invalid or the package was truncated.");
        goto done;
    }
    if (!setup_temp(temp, 32768)) goto done;
    if (BCryptGenRandom(NULL, random, sizeof(random), BCRYPT_USE_SYSTEM_PREFERRED_RNG) != 0) {
        fail(L"Cannot allocate a private setup directory.");
        goto done;
    }
    if (!regular_ancestry(temp)) {
        fail(L"Setup does not follow a redirected temporary directory.");
        goto done;
    }
    wcscpy_s(stage, 32768, temp);
    append(stage, 32768, L"ccodex-release-setup-");
    for (int index = 0; index < 16; index++) {
        wchar_t byte[3];
        swprintf_s(byte, 3, L"%02x", random[index]);
        append(stage, 32768, byte);
    }
    if (!CreateDirectoryW(stage, NULL)) { fail(L"Cannot create private setup directory."); goto done; }
    stage_created = 1;
    swprintf_s(script, 32768, L"%ls\\bootstrap.ps1", stage);
    swprintf_s(archive, 32768, L"%ls\\payload.zip", stage);
    wprintf(L"Verifying and staging the complete release payload...\n");
    fflush(stdout);
    if (!copy_verified(self, footer.script_offset, footer.script_length, footer.script_sha256, script) ||
        !copy_verified(self, footer.zip_offset, footer.zip_length, footer.zip_sha256, archive)) goto done;
    CloseHandle(self);
    self = INVALID_HANDLE_VALUE;
    if (!GetSystemDirectoryW(powershell, 32768) ||
        !append(powershell, 32768, L"\\WindowsPowerShell\\v1.0\\powershell.exe")) {
        fail(L"Cannot find Windows PowerShell.");
        goto done;
    }
    command[0] = 0;
    append_arg(command, 32768, powershell);
    append(command, 32768, L" -NoLogo -NoProfile -ExecutionPolicy Bypass -File");
    append_arg(command, 32768, script);
    append(command, 32768, L" -StageRoot");
    append_arg(command, 32768, stage);
    for (int index = 1; index < argc; index++) {
        const wchar_t *option = NULL;
        int takes_value = 0;
        if (!_wcsicmp(argv[index], L"--extract-only")) { option = L"-ExtractOnly -Destination"; takes_value = 1; }
        else if (!_wcsicmp(argv[index], L"--install-root")) { option = L"-InstallRoot"; takes_value = 1; }
        else if (!_wcsicmp(argv[index], L"--profile")) { option = L"-Profile"; takes_value = 1; }
        else if (!_wcsicmp(argv[index], L"--silent")) option = L"-Silent";
        else if (!_wcsicmp(argv[index], L"--no-login")) option = L"-NoLogin";
        else if (!_wcsicmp(argv[index], L"--no-shortcuts")) option = L"-NoShortcuts";
        else if (!_wcsicmp(argv[index], L"--no-registration")) option = L"-NoRegistration";
        else if (!_wcsicmp(argv[index], L"--keep-extracted")) option = L"-KeepExtracted";
        else { fail(L"Unknown setup option."); goto done; }
        if (!append(command, 32768, L" ") || !append(command, 32768, option)) {
            fail(L"Setup arguments are too long."); goto done;
        }
        if (takes_value) {
            if (++index >= argc || !append_arg(command, 32768, argv[index])) {
                fail(L"A setup option requires a path."); goto done;
            }
        }
    }
    startup.dwFlags |= STARTF_USESTDHANDLES;
    startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
    startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
    startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
    if (!CreateProcessW(powershell, command, NULL, NULL, TRUE, 0, NULL, stage, &startup, &process)) {
        fail(L"Could not start the isolated release installer.");
        goto done;
    }
    WaitForSingleObject(process.hProcess, INFINITE);
    GetExitCodeProcess(process.hProcess, &exit_code);
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    result = (int)exit_code;
done:
    if (self != INVALID_HANDLE_VALUE) CloseHandle(self);
    if (stage_created && !keep_extracted && !cleanup_stage(stage, temp))
        fwprintf(stderr, L"\nTemporary resources were preserved for inspection: %ls\n", stage);
    if (failure[0]) {
        fwprintf(stderr, L"\nSetup failed: %ls\nNo stock Codex or Copilot installation was replaced.\n", failure);
    }
    return result;
}
