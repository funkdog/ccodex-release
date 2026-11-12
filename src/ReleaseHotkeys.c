#define WIN32_LEAN_AND_MEAN
#define UNICODE
#define _UNICODE
#include <windows.h>
#include <stdio.h>

int wmain(int argc, wchar_t **argv) {
    (void)argv;
    if (argc != 1) return 2;
    int comma = 0;
    fputs("{\"available\":[", stdout);
    for (UINT key = VK_F1; key <= VK_F24; key++) {
        if (!RegisterHotKey(NULL, 1, MOD_CONTROL | MOD_ALT | MOD_SHIFT | MOD_NOREPEAT, key)) continue;
        UnregisterHotKey(NULL, 1);
        printf("%s\"Control+Alt+Shift+F%u\"", comma ? "," : "", key - VK_F1 + 1);
        comma = 1;
    }
    fputs("]}\n", stdout);
    return 0;
}
