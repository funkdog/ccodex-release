#define WIN32_LEAN_AND_MEAN
#define UNICODE
#define _UNICODE
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <wchar.h>

static DWORD deletion_error;

static int validate_tree(const wchar_t *directory) {
    DWORD attributes = GetFileAttributesW(directory);
    if (attributes == INVALID_FILE_ATTRIBUTES || !(attributes & FILE_ATTRIBUTE_DIRECTORY) ||
        (attributes & FILE_ATTRIBUTE_REPARSE_POINT)) { deletion_error = ERROR_INVALID_PARAMETER; return 0; }
    size_t capacity = wcslen(directory) + 1024;
    wchar_t *child = (wchar_t *)calloc(capacity, sizeof(wchar_t));
    if (!child) { deletion_error = ERROR_NOT_ENOUGH_MEMORY; return 0; }
    swprintf_s(child, capacity, L"%ls\\*", directory);
    WIN32_FIND_DATAW entry;
    HANDLE search = FindFirstFileW(child, &entry);
    int success = search != INVALID_HANDLE_VALUE;
    if (!success) deletion_error = GetLastError();
    if (success) {
        do {
            if (!wcscmp(entry.cFileName, L".") || !wcscmp(entry.cFileName, L"..")) continue;
            if (entry.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) { deletion_error = ERROR_INVALID_PARAMETER; success = 0; break; }
            if (entry.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
                swprintf_s(child, capacity, L"%ls\\%ls", directory, entry.cFileName);
                if (!validate_tree(child)) { success = 0; break; }
            }
        } while (FindNextFileW(search, &entry));
        if (success && GetLastError() != ERROR_NO_MORE_FILES) success = 0;
        FindClose(search);
    }
    free(child);
    return success;
}

static int remove_tree(const wchar_t *directory) {
    DWORD attributes = GetFileAttributesW(directory);
    if (attributes == INVALID_FILE_ATTRIBUTES || !(attributes & FILE_ATTRIBUTE_DIRECTORY) ||
        (attributes & FILE_ATTRIBUTE_REPARSE_POINT)) { deletion_error = ERROR_INVALID_PARAMETER; return 0; }
    size_t capacity = wcslen(directory) + 1024;
    wchar_t *child = (wchar_t *)calloc(capacity, sizeof(wchar_t));
    if (!child) { deletion_error = ERROR_NOT_ENOUGH_MEMORY; return 0; }
    swprintf_s(child, capacity, L"%ls\\*", directory);
    WIN32_FIND_DATAW entry;
    HANDLE search = FindFirstFileW(child, &entry);
    int success = search != INVALID_HANDLE_VALUE;
    if (!success) deletion_error = GetLastError();
    if (success) {
        do {
            if (!wcscmp(entry.cFileName, L".") || !wcscmp(entry.cFileName, L"..")) continue;
            if (entry.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) { deletion_error = ERROR_INVALID_PARAMETER; success = 0; break; }
            swprintf_s(child, capacity, L"%ls\\%ls", directory, entry.cFileName);
            if (entry.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
                if (!remove_tree(child)) { success = 0; break; }
            } else {
                if (entry.dwFileAttributes & FILE_ATTRIBUTE_READONLY)
                    SetFileAttributesW(child, entry.dwFileAttributes & ~FILE_ATTRIBUTE_READONLY);
                if (!DeleteFileW(child)) { deletion_error = GetLastError(); success = 0; break; }
            }
        } while (FindNextFileW(search, &entry));
        if (success && GetLastError() != ERROR_NO_MORE_FILES) { deletion_error = GetLastError(); success = 0; }
        FindClose(search);
    }
    free(child);
    if (!success) return 0;
    if (!RemoveDirectoryW(directory)) { deletion_error = GetLastError(); return 0; }
    return 1;
}

int wmain(int argc, wchar_t **argv) {
    wchar_t target[32768], temp[32768], extended[32768];
    const wchar_t *prefix = L"ccodex-uninstall-";
    if (argc != 2) return 2;
    DWORD size = GetFullPathNameW(argv[1], 32768, target, NULL);
    DWORD base_size = GetTempPathW(32768, temp);
    if (!size || size >= 32768 || !base_size || base_size >= 32768) return 2;
    if (_wcsnicmp(target, temp, base_size)) return 2;
    const wchar_t *name = target + base_size;
    size_t prefix_size = wcslen(prefix);
    if (wcslen(name) != prefix_size + 32 || wcsncmp(name, prefix, prefix_size)) return 2;
    for (size_t index = prefix_size; name[index]; index++)
        if (!((name[index] >= L'0' && name[index] <= L'9') ||
              (name[index] >= L'a' && name[index] <= L'f'))) return 2;
    if (GetFileAttributesW(temp) & FILE_ATTRIBUTE_REPARSE_POINT) return 2;
    if (swprintf_s(extended, 32768, L"\\\\?\\%ls", target) < 0) return 2;
    if (!validate_tree(extended)) {
        fwprintf(stderr, L"Unsafe or unreadable temporary uninstall tree was preserved: %ls\n", target);
        return 2;
    }
    ULONGLONG deadline = GetTickCount64() + 45000;
    while (!remove_tree(extended)) {
        if ((deletion_error != ERROR_ACCESS_DENIED &&
             deletion_error != ERROR_SHARING_VIOLATION &&
             deletion_error != ERROR_LOCK_VIOLATION &&
             deletion_error != ERROR_DIR_NOT_EMPTY) || GetTickCount64() >= deadline) {
            fwprintf(stderr, L"Temporary uninstall files were preserved for inspection: %ls (Windows error %lu)\n",
                target, deletion_error);
            return 1;
        }
        Sleep(750);
    }
    return 0;
}
