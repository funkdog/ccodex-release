#define WIN32_LEAN_AND_MEAN
#define UNICODE
#define _UNICODE
#include <winsock2.h>
#include <windows.h>
#include <iphlpapi.h>
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <wchar.h>

#pragma comment(lib, "iphlpapi.lib")
#pragma comment(lib, "user32.lib")

typedef LONG (WINAPI *QueryProcess)(HANDLE, ULONG, PVOID, ULONG, PULONG);
typedef struct { USHORT length; USHORT maximum; PWSTR buffer; } StringResult;

static void json_string(const wchar_t *value, size_t length) {
    putchar('"');
    for (size_t i = 0; i < length; i++) {
        unsigned int c = (unsigned int)value[i];
        if (c == '"' || c == '\\') { putchar('\\'); putchar((int)c); }
        else if (c < 32 || c > 126) printf("\\u%04x", c);
        else putchar((int)c);
    }
    putchar('"');
}

static int process_identity(DWORD pid, const wchar_t *expected) {
    HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!process) {
        if (GetLastError() == ERROR_INVALID_PARAMETER) { puts("null"); return 0; }
        return 1;
    }
    FILETIME creation, exit_time, kernel, user;
    DWORD exit_code = 0;
    wchar_t lifetime[80];
    if (!GetProcessTimes(process, &creation, &exit_time, &kernel, &user) ||
        !GetExitCodeProcess(process, &exit_code)) { CloseHandle(process); return 1; }
    uint64_t born = ((uint64_t)creation.dwHighDateTime << 32) | creation.dwLowDateTime;
    _snwprintf_s(lifetime, 80, _TRUNCATE, L"windows:%llu",
        (born / 10) * 10 + 504911232000000000ULL);
    if (exit_code != STILL_ACTIVE || (expected && wcscmp(lifetime, expected))) {
        CloseHandle(process); puts("null"); return 0;
    }
    wchar_t executable[32768];
    DWORD executable_length = 32768;
    if (!QueryFullProcessImageNameW(process, 0, executable, &executable_length)) {
        CloseHandle(process); return 1;
    }
    QueryProcess query = (QueryProcess)GetProcAddress(GetModuleHandleW(L"ntdll.dll"),
        "NtQueryInformationProcess");
    if (!query) { CloseHandle(process); return 1; }
    ULONG required = 0;
    query(process, 60, NULL, 0, &required);
    if (required < sizeof(StringResult) || required > 512 * 1024) {
        CloseHandle(process); return 1;
    }
    unsigned char *buffer = (unsigned char *)calloc(1, required);
    if (!buffer) { CloseHandle(process); return 1; }
    LONG status = query(process, 60, buffer, required, &required);
    StringResult *command = (StringResult *)buffer;
    uintptr_t base = (uintptr_t)buffer, text = (uintptr_t)command->buffer;
    if (status < 0 || (command->length & 1) || text < base ||
        text - base > required || command->length > required - (text - base)) {
        free(buffer); CloseHandle(process); return 1;
    }
    FILETIME after;
    if (!GetProcessTimes(process, &after, &exit_time, &kernel, &user) ||
        !GetExitCodeProcess(process, &exit_code) || exit_code != STILL_ACTIVE ||
        after.dwHighDateTime != creation.dwHighDateTime ||
        after.dwLowDateTime != creation.dwLowDateTime) {
        free(buffer); CloseHandle(process); puts("null"); return 0;
    }
    printf("{\"pid\":%lu,\"lifetime\":", pid);
    json_string(lifetime, wcslen(lifetime));
    printf(",\"executable\":");
    json_string(executable, executable_length);
    printf(",\"commandLine\":");
    json_string(command->buffer, command->length / sizeof(wchar_t));
    puts("}");
    free(buffer);
    CloseHandle(process);
    return 0;
}

static int endpoint_owner(DWORD port) {
    DWORD size = 0;
    DWORD status = GetExtendedTcpTable(NULL, &size, FALSE, AF_INET,
        TCP_TABLE_OWNER_PID_LISTENER, 0);
    if (status != ERROR_INSUFFICIENT_BUFFER || size > 16 * 1024 * 1024) return 1;
    PMIB_TCPTABLE_OWNER_PID table = (PMIB_TCPTABLE_OWNER_PID)malloc(size);
    if (!table) return 1;
    status = GetExtendedTcpTable(table, &size, FALSE, AF_INET,
        TCP_TABLE_OWNER_PID_LISTENER, 0);
    DWORD owner = 0;
    if (status == NO_ERROR) {
        for (DWORD i = 0; i < table->dwNumEntries; i++) {
            MIB_TCPROW_OWNER_PID row = table->table[i];
            DWORD local_port = ((row.dwLocalPort & 255) << 8) | ((row.dwLocalPort >> 8) & 255);
            if (row.dwLocalAddr != 0x0100007f || local_port != port) continue;
            if (owner && owner != row.dwOwningPid) { free(table); return 1; }
            owner = row.dwOwningPid;
        }
    }
    free(table);
    if (status != NO_ERROR || !owner) return 1;
    printf("%lu\n", owner);
    return 0;
}

static int console_attached(DWORD pid) {
    HANDLE output = GetStdHandle(STD_OUTPUT_HANDLE);
    FreeConsole();
    BOOL attached = AttachConsole(pid);
    HWND window = attached ? GetConsoleWindow() : NULL;
    BOOL visible = window && IsWindowVisible(window);
    if (attached) FreeConsole();
    SetStdHandle(STD_OUTPUT_HANDLE, output);
    printf("{\"attached\":%s,\"windowVisible\":%s}\n",
        attached ? "true" : "false", visible ? "true" : "false");
    return 0;
}

int wmain(int argc, wchar_t **argv) {
    if (argc == 2 && !wcscmp(argv[1], L"notify")) {
        DWORD_PTR ignored = 0;
        SendMessageTimeoutW(HWND_BROADCAST, WM_SETTINGCHANGE, 0, (LPARAM)L"Environment",
            SMTO_ABORTIFHUNG, 2000, &ignored);
        return 0;
    }
    if (argc < 3) return 1;
    wchar_t *end = NULL;
    unsigned long number = wcstoul(argv[2], &end, 10);
    if (!number || !end || *end) return 1;
    if (!wcscmp(argv[1], L"process") && (argc == 3 || argc == 4)) {
        return process_identity((DWORD)number, argc == 4 ? argv[3] : NULL);
    }
    if (!wcscmp(argv[1], L"endpoint") && argc == 3 && number >= 1024 && number <= 65535) {
        return endpoint_owner((DWORD)number);
    }
    if (!wcscmp(argv[1], L"console") && argc == 3) return console_attached((DWORD)number);
    return 1;
}
