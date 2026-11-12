# Codex core patch

## 1.2.25 Follow-On Patches

The following patches apply, in order, after `codex-docked-composer.patch`:

1. `codex-build-consistency-v5.patch`: task-start test ownership corrections and
   workspace-only lockfile version normalization. It does not upgrade external dependencies.
2. `codex-file-attachments-v5.patch`: independent file/image labels, multi-path parsing,
   clipboard file lists, persisted display metadata and Windows key-record drop handling.
3. `codex-unified-transcript-v5.patch`: a single source-backed live/history viewport,
   matching draggable scrollbar, output drag selection/copy, one-Down following, resize
   cleanup and per-cell rendering caches.
4. `codex-copilot-status-v5.patch`: per-thread/account bridge status, latest native usage,
   cached-read amounts and persistent status alongside the queue hint.
5. `codex-context-picker-v2.patch`: makes `/model` a transactional
   `Model -> Context -> Effort` flow, removes the legacy fixed-size context menu,
   keeps Context independent from Fast mode, and hardens the related regression tests.

The package's bridge and generated profile supply the corresponding credential-free
status records and rich/full-screen defaults. Native input and model-visible content are
kept separate: display labels do not replace image payloads or file paths.

`tests/live-tui-layout-smoke.cjs` exercises native interaction with isolated profiles.
`tests/live-transcript-stream-smoke.cjs` uses a loopback SSE provider to verify streaming,
pause/follow, rich completion and runtime status. Neither sends paid model requests.
Clipboard fixture tests require an isolated window station and fail closed when Windows
refuses it; they must not fall back to overwriting the real desktop clipboard.

`codex-context-picker.patch` applies to OpenAI Codex source commit
`25af12f7e61572b0bc18ddb1008be543b91519b0`.

It adds the `Model -> Context -> Effort` TUI flow and maps the internal
`context-long` service tier to each model's `max_context_window`. It also adds
native prompt selection/mouse handling, Ctrl+Z edit undo, active-context token
amount with an unclamped percentage, cache status, successful compaction count,
and latest post-compaction usage. Prebuilt
Windows ARM64 and x64 results are shipped under `bin/runtimes/`.

`codex-responsive-tui-v4.patch` is applied after the context, rendering, and
interaction patches. It makes configured status fields wrap without loss on narrow
terminals and replaces wheel-triggered pager entry with embedded transcript scrollback
that keeps the live composer pinned to the bottom. It also handles empty bracketed-paste
payloads as native image clipboard events, allowing Windows launchers to avoid the nested
ConPTY layer that can randomly omit synchronized redraw rows.

`codex-windows-input-record.patch` is applied after the responsive patch. It backports Codex's Windows
console-mode guard so Crossterm always reads Win32 input records instead of raw VT
bytes, including after another console client changes the mode while the TUI is
running. This prevents arrow, control, focus, and SGR mouse sequences from becoming
literal prompt text.

`codex-windows-input-record.patch` 在响应式补丁后应用。它回移植 Codex 的 Windows
控制台模式保护，确保 Crossterm 始终读取 Win32 输入记录，而不是原始 VT
字节；即使其他控制台程序在 TUI 运行期间更改模式也会自动恢复。这样可避免方向键、
控制键、焦点事件和 SGR 鼠标序列被写成普通输入文本。

`codex-clipboard-terminal-selection-animation.patch` follows the Windows input-record patch. Ctrl+V now
routes real clipboard images first and falls back to clipboard text, local images use
Copilot-style filename labels while the model protocol still receives `[Image #N]`,
Mouse capture enables native composer clicks and drag selection by default
(`Shift`+drag retains terminal-owned transcript selection), and `FORCE_COLOR=3`
is treated as TrueColor so Max/Ultra effort ignition remains animated.

`codex-docked-composer.patch` is applied after the clipboard patch. It keeps the
composer and status line at the terminal bottom during normal rendering as well
as transcript scrolling, leaving unused rows between the transcript and composer.
Completed history still uses native terminal scrollback; ordinary frames retain
incremental rendering. The patch also covers the first single-row history insert
and includes native-layout snapshots and test-fixture isolation corrections.
`tests/live-tui-layout-smoke.cjs` verifies the native Windows core in a background
ConPTY with a disposable profile, without foreground input or clipboard mutation.

Adding this patch does not replace previously published archives or prebuilt
runtimes. Rebuild every target before creating a new set of release packages.

Context choices use Copilot CLI's size-only labels, and explicit Max
selection replays Codex's native effort ignition even when that tier was
already active. Composer selections copied with Ctrl+A then Ctrl+C no longer
add a transient history notification. A dark fallback keeps the effect
available when a nested ConPTY blocks the terminal palette probe.

The separate `codex-windows-popup-redraw.patch` is retained only as a historical
artifact and is not applied by the current release workflow; its old source seam
predates the pinned revision.

The TUI model catalog also watches CodexCopilot's catalog generation file.
When bridge publication changes the eligible model set, an already-running
ccodex session replaces its picker catalog without restarting.

The bridge removes `service_tier` before forwarding requests to GitHub Copilot,
so `context-long` is local Codex state rather than an unsupported upstream
parameter.
