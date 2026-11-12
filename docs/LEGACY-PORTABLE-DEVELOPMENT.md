# Codex (Copilot)

The **native** Codex desktop app and Codex CLI, driven by **GitHub Copilot**.

The Codex package is not re-packed. This adds a second, self-contained profile whose model
provider is a local bridge to `api.githubcopilot.com`, plus a source-built Codex core with
the missing Context selection step and native terminal enhancements. The bundled patched
core is installed separately instead of replacing the official core. Stock `codex` and the stock
desktop entry continue using `~/.codex`; models without Copilot Context metadata behave
exactly as before.

| | Stock Codex | Codex (Copilot) |
|---|---|---|
| Desktop app | "ChatGPT" / Codex | **Codex (Copilot)** (same binary, same icon) |
| CLI command | `codex` | **`codex-copilot`** (alias `ccodex`) |
| `CODEX_HOME` | `~/.codex` | `~/.codex-copilot` |
| Sign-in | ChatGPT / OpenAI API key | **GitHub** |
| Models | OpenAI catalog | **every model enabled in your GitHub Copilot settings** |
| Model picker | OpenAI models | **all of them**, full names, real default/long context tiers and efforts |

Plugins, computer use, the browser and Chrome plugins, MCP servers, the Windows sandbox,
approvals, projects, scheduled tasks, skills and hooks all behave exactly as they do in
stock Codex — the profile is generated from your existing `~/.codex/config.toml`.

## Microsoft 365 / Work IQ

An optional shared enterprise connection is available through `ccodex workiq` and the
Desktop account panel. It uses Microsoft's hosted Work IQ MCP service with a separate,
explicit Microsoft sign-in; GitHub Copilot credentials do not grant M365 access.
Setup never opens a browser automatically, and the connection remains disabled until
enterprise data processing is acknowledged. The current secure credential cache is
Windows-only. See [WORKIQ.md](WORKIQ.md) for architecture, setup, verification and the
remaining gaps; this is not a claim of complete Microsoft 365 Copilot feature parity.

## Batch session history

CLI and Desktop use the same local, metadata-only management interface:

```text
ccodex history list --query project --limit 50 --json
ccodex history preview archive --id ccodex:FULL-UUID --id ccodex:ANOTHER-UUID --out plan.json
ccodex history apply --plan plan.json --confirm EXACT-PREVIEW-HASH
ccodex history ui --open
```

ccodex supports native archive, unarchive, rename and delete. GitHub Copilot supports
native listing and confirmed deletion; use `--product all` when both products are
installed. `--before`, `--after`, `--cwd` and `--archived` filter the list. Rename
previews accept `--name-template "{title} - {index}"`.

The Windows **Codex (Copilot) History** shortcut opens a separate loopback-only
management window with multi-selection, exact previews, progress and per-session
results. It does not replace the official Desktop sidebar or controls. Unix users
can launch the same UI with the command above or `tools/history/desktop.sh`.

Previews expire after ten minutes and never change history. Every apply attempt is
single-use; CLI results are retained beside the plan as `.applied`. Active, remote
and unknown-ownership sessions are protected, and changed metadata requires a new
preview. Plans bind their original profile even if copied histories reuse a UUID.
Current native cores cannot prove cross-process thread ownership, so
ccodex mutations require existing Codex CLI/Desktop clients to be closed. Native
parent deletion and archive can cascade: this interface refuses them until the affected
spawned children have first been explicitly processed and the parent has been previewed again.
No transcript, credential or stock `.codex` data is copied or exported.

## Copilot AI credits

`ccodex credits` shows the current authenticated account's exact reported AI-credit
usage; `ccodex credits --json` exposes the same bounded projection. Use
`ccodex credits --watch` for a one-line dynamic terminal gauge. Modern TTYs use
ANSI cursor control and colors; redirected output, `TERM=dumb` and unrecognized
legacy terminals use static ASCII. `--ascii`, `NO_COLOR` and `NO_UNICODE` are
respected. Cancellation restores the cursor without touching another line.
The Windows `ccodex` alias does not wrap credit/history commands or redirected
native output in terminal-reset escapes; JSON remains directly parseable.

The native `copilot-credits` status item and Desktop SVG ring share calculations,
one-decimal percentages, 75%/90% color thresholds, English captions, 15-second
account reads and 480-ms transitions, but not rendering code. Desktop respects
reduced-motion settings; native status uses terminal-theme ANSI colors.
Credits come only from explicit token-billing and `credits_used` metadata, not
estimated token costs or legacy request quotas. The current source is GitHub's
internal authenticated account API, not a promised public billing contract.
Missing, stale, expired and changed-account balances remain explicit.

Context appears inside the original Desktop model/Effort popover. Model names
do not include internal Context alias descriptions; Context choices reflect each
model's actual advertised capability. The native Effort slider remains mounted
and interactive, with English parameter names.

---

## Install

There is intentionally **no universal installer**. Download only the artifact matching the
operating system and CPU:

| System | Package |
|---|---|
| Windows on ARM | `codex-copilot-windows-arm64-<version>.zip` |
| Windows on Intel/AMD | `codex-copilot-windows-x64-<version>.zip` |
| macOS 13+ on Apple silicon | `codex-copilot-macos-arm64-<version>.pkg` or `.tar.gz` |
| macOS 13+ on Intel | `codex-copilot-macos-x64-<version>.pkg` or `.tar.gz` |
| Debian/Ubuntu on ARM64 | `codex-copilot-linux-arm64-<version>.deb` |
| Debian/Ubuntu on x64 | `codex-copilot-linux-x64-<version>.deb` |
| Fedora/RHEL/openSUSE | matching `linux-arm64` or `linux-x64` `.rpm` |
| Other Linux distributions | matching `linux-arm64` or `linux-x64` `.tar.gz` |

Every target archive contains one patched Codex core. Unix archives also carry one matching
Node runtime; Windows archives carry the matching `node-pty` prebuild and use the official
Desktop or system Node runtime. Installers reject an OS or architecture mismatch instead of
falling back to another target. The release in `VERSION` uses a pinned upstream
Codex core; its core version is recorded separately in each build manifest. A
wrapper release number does not overwrite Codex's own version identity.
Locally produced macOS tar archives are cross-built with the verified MacOSX 14.5 SDK,
declare macOS 13.0 as their minimum, and are statically validated as Mach-O for the
declared CPU. They are not executed on physical macOS here; the native macOS workflow
performs that validation and is the only path that emits `.pkg` installers.

### Windows

```powershell
.\install.ps1
```

For a guided double-click install, extract the zip and run `install.cmd`.

Requirements: Windows ARM64 or x64 and a GitHub account with Copilot access. Windows uses
separate `windows-arm64` and `windows-x64` packages; each archive contains only its matching
Codex core and node-pty module, and the installer rejects the wrong architecture. If the official Codex/ChatGPT
desktop package (`OpenAI.Codex`, Microsoft Store product `9PLM9XGG6VKS`) is missing, the
installer offers a path picker, an automatic `winget` installation, or official manual
instructions followed by a rescan. That package supplies a compatible Codex CLI and Node.js
runtime, so separate CLI installation is normally not required. An installed GitHub Copilot CLI supplies the
same tiered-pricing metadata used by its own **Context** picker; the bridge caches only
the resulting token limits, never credentials.

Before copying files, the guided installer renders one status panel for ChatGPT Desktop,
Codex CLI, and GitHub Copilot CLI. Every missing item offers the same three choices: provide an
exe/program/SDK path, let the installer attempt the official installation, or view official
manual instructions and rescan. After installation succeeds, the final `CODEX EVOLVED` panel
summarizes the model, Context, status, mouse input, transcript, isolated-profile and preserved
native capabilities compared with stock Codex CLI. Use
`CODEX_COPILOT_NONINTERACTIVE=1` for automation; `-NoPrerequisiteInstall` also disables external
installation attempts.

The installer:

1. copies the bridge and launchers to `%LOCALAPPDATA%\CodexCopilot`
2. builds `codex-copilot.ico` from the Codex package's own per-size logo assets, so the
   Start-menu and search icon is the same glyph Windows draws for the app, and compiles
   `codex-copilot-desktop.exe` with it
3. copies the matching official Code Mode and sandbox helpers into the enhanced installation
   and selects its separately built core; the official Desktop/CLI executables are not patched
4. generates `~/.codex-copilot\config.toml` from your existing Codex config
5. reuses a valid local Copilot credential or starts GitHub device login, then writes the model catalog
6. adds `codex-copilot` / `ccodex` to your user `PATH`
7. creates the Start-menu entries **Codex (Copilot)**, **Codex (Copilot) CLI**
   and **Codex (Copilot) History**
8. installs the `codex-copilot-manager` skill for GitHub Copilot CLI

Uninstall with `install.ps1 -Uninstall` (add `-Purge` to also delete `~/.codex-copilot`).

### macOS

Install the matching `.pkg`, or extract the matching `.tar.gz` and run:

```bash
./install.sh
```

The CLI and bridge include their own Node runtime. Enhanced Desktop runs a verified private
snapshot of the official app with its own profile and update selection, not the stock
`/Applications` bundle as a fallback. A signed candidate must be prepared and validated first.
Launch the selected private snapshot with
`codex-copilot desktop`. The tar installer creates user-local commands in `~/.local/bin`;
the `.pkg` creates system commands in `/usr/local/bin`. After a `.pkg` install, run
`codex-copilot setup` (first launch does this automatically); the tar installer starts the same
guided setup itself.

### Linux

The CLI packages require glibc 2.39 or newer, matching the 1.2.23 release baseline.
The package metadata declares this requirement rather than allowing installation on
an older, incompatible libc.

Install the matching Debian/Ubuntu or RPM package:

```bash
sudo apt install ./codex-copilot-linux-x64-<version>.deb
# or
sudo dnf install ./codex-copilot-linux-x64-<version>.rpm
codex-copilot setup
```

For other distributions, extract the matching `.tar.gz` and run `./install.sh`. Replace `x64`
with `arm64` on ARM systems. The tar installer uses `~/.local/share/codex-copilot` and
`~/.local/bin`, so it does not require root.

### Upgrade

Do **not** uninstall an older CodexCopilot release. Install the newer package for the same
OS and CPU over the existing installation. Windows uses `install.ps1`;
macOS/Linux tar packages use `install.sh`, while `.pkg`, `.deb`, and `.rpm` packages use the
normal system package upgrade command. The isolated profile, GitHub login, and
model/Context/effort defaults are preserved.

Enhanced Desktop has its own update backend:

```text
ccodex desktop update check
ccodex desktop update prepare
ccodex desktop update validate <candidate-version>
ccodex desktop update apply <private-validation.json>
```

The account panel exposes the same private workflow. Download metadata alone does
not prove the latest version; candidates are selected only after source-bound
native UI and extension validation. Apply failures preserve the current selection.
Stock Desktop and `codex` continue receiving their own official updates.
Direct enhanced CLI core upgrades still require a compatible, newly built package;
the unfinished upstream migration must not be replaced with an unpatched stock core.

Run the isolated installer and transfer-bundle smoke test with:

```powershell
powershell -ExecutionPolicy Bypass -File .\tests\Smoke-Test.ps1
```

---

## Use

Press <kbd>Win</kbd> and type **Codex (Copilot)** for the desktop app, or open a terminal:

```powershell
codex-copilot                       # interactive native TUI
codex-copilot exec "fix the build"  # non-interactive
codex-copilot -m claude-opus-5 …    # any Copilot model
ccodex                              # short alias
```

The enhanced core keeps Codex's interrupt conventions while adding prompt and output
selection. Ctrl+A selects the draft; typing, paste, Backspace or Delete replaces it.
Drag directly over output to select text, including across wheel scrolling. Ctrl+C
copies either selection, and right-click copies an output selection, without
interrupting the agent. With no selection, Ctrl+C retains native interrupt/quit behavior.
Ctrl+Z restores draft edits rather than rewinding the conversation.

Ctrl+V accepts text, clipboard bitmaps and copied file lists. Dropped images and
regular files receive individual filename labels, including duplicate filenames.
Those labels survive submission and history restoration. Images still use native
image input; other files retain their exact paths for the agent's file tools.
One drop accepts up to 128 regular files and 64 KiB of path text. Directories and
text that is not a complete file list remain editable text.

One rich transcript surface now owns both live and earlier output. The composer stays
at the bottom; output follows the agent unless the user scrolls away. The scrollbar
belongs to this same transcript and supports dragging. Press Down once to return to
the latest output. Selecting output holds a stable copy snapshot until the selection
is cleared or Down returns to live output.

On Windows, interactive `ccodex` stays attached directly to the caller's terminal.
The native core treats an empty bracketed-paste payload as an image clipboard event,
so Ctrl+V keeps working without a nested ConPTY that can randomly omit synchronized
redraw rows. The legacy smart-paste proxy remains packaged for migration diagnostics
but is not enabled by the launcher. The live regression repeatedly resizes and opens
the model picker, then enters `abcdef`, clicks between `c` and `d`, and requires the
native composer to render `abcXdef`.

Generated Copilot profiles use rich output and the alternate screen by default, so
the terminal's shell-scrollback bar cannot contradict the application's scrollbar.
Explicit raw-output and no-alternate-screen controls remain available. Setting
`CCODEX_MOUSE_CAPTURE=0` returns mouse input and scrollback to the terminal's legacy
inline mode. Shift+drag remains the terminal's native selection override where
supported. The launcher still clears stale mouse modes, and the Windows core keeps
control sequences out of the prompt.

Windows 下可直接拖选输出，并按住鼠标滚动扩展选区；Ctrl+C 或右键复制，不会误中断
Agent。输入栏始终固定底部，下键一次返回最新输出。应用内滚动条与会话内容使用相同位置，
不再通过切换历史页面才能恢复彩色。Ctrl+V 与拖入的多个附件均显示文件名标签，提交后保持一致。
需要终端自身管理鼠标时，可显式设置 `CCODEX_MOUSE_CAPTURE=0`。

The native model picker uses one terminal row per model with stable all-row
column widths. This prevents wrapped-row viewport drift through Windows ConPTY
and keeps consecutive model numbers visible while scrolling.

The generated profile enables Codex's native status line with the GitHub account,
per-thread request verification, model + effort, latest request input/output,
active context amount/window and an unclamped percentage, cumulative session usage,
session cache hit ratio and cached reads, successful compaction count, and the latest post-compaction active
amount/percentage. An over-window state therefore remains visible above 100%.
Unknown cache data uses `--`; other unavailable values are omitted. Request proof
is scoped to the current thread and account generation, and cannot be borrowed from
another session. No usage is estimated by the bridge. On narrow terminals the complete status
line wraps onto additional rows instead of dropping fields behind an ellipsis.

Inside the interactive TUI, `/context` opens a read-only context-usage report. It
shows the active model and context tier, active/window tokens and unclamped
percentage, provider-reported input/cache/output/reasoning counters, free space,
cumulative session usage, and successful compaction state. Categories that the
runtime did not report are omitted rather than estimated.

Extra sub-commands (everything else is forwarded to the real Codex CLI verbatim):

| Command | Purpose |
|---|---|
| `codex-copilot login` | GitHub device-flow sign-in |
| `codex-copilot logout` | forget the saved GitHub token |
| `codex-copilot status` | show the account, entitlement and autostart state |
| `codex-copilot account switch` | authenticate a different GitHub account and rebuild the catalog |
| `codex-copilot models` | list the Copilot models exposed to Codex |
| `codex-copilot use <model> [effort] [context]` | set shared defaults for model, reasoning and `default`/`long_context`; verify the active Desktop thread separately |
| `codex-copilot context [default\|long_context]` | show or change the current model's context tier |
| `codex-copilot catalog` | regenerate the Codex model catalog |
| `codex-copilot doctor` | validate installation, credentials, selected model and catalog |
| `ccodex showcase` | display the same shared enhancement guide as the installer, without starting the bridge or creating a profile |
| `codex-copilot verify` | show redacted proof of the latest effective upstream model/context/effort request |
| `codex-copilot export [zip]` | create a credential-free bundle for another machine |
| `codex-copilot autostart on\|off` | start the bridge automatically at login |
| `codex-copilot repair` | regenerate config **and** catalog |
| `codex-copilot update` | explain how to install a matching CodexCopilot release; never replace the patched core with stock Codex |
| `codex-copilot bridge status\|stop` | inspect or stop the exact local bridge PID |
| `codex-copilot desktop` | launch the desktop app |

### Updates and compatibility

CodexCopilot deliberately pins its patched core. Stock `codex update`, Microsoft Store
updates, and ChatGPT desktop updates remain independent, while `codex-copilot update`
refuses to self-update the package core into an unpatched stock binary. The generated
profile also disables stock-core update prompts.

On Windows, `ccodex` resolves `bin/core-current.txt` and uses the isolated
versioned patched core. The Desktop launcher instead lets the official app use
its own version-matched native core so its bundled runtime and plugin
registration keep working; it supplies the isolated Copilot profile and
renderer helper. A Store update therefore does not overwrite the ccodex CLI
core, but may change Desktop protocol or renderer hooks. Unknown hooks fail
closed and require a newly validated adapter. If ChatGPT Desktop is already
running, even without a visible window, the enhanced launcher refuses to
focus that stale instance as though its new profile and catalog had loaded.
Save drafts, choose **Quit** from the system tray, then launch it again; the
launcher does not terminate running sessions.

Release archives remain tied to their declared OS and CPU. They keep the behavior they
were built with, but do not acquire newer upstream Codex features automatically. New
archives check all source patches against the pinned upstream commit before building
Windows, Linux, and macOS ARM64/x64 targets, so an upstream conflict stops the release
instead of producing a partially patched binary.

### Sign-in

`ccodex account switch` starts the bridge-owned GitHub device flow. After validation,
the bridge atomically publishes the credential, catalog and account generation. ccodex uses
the new account immediately; Desktop restarts its local app-server and reloads so its native
profile, model picker and bottom model bar update together. OAuth tokens remain in the bridge
and never enter renderer state. GitHub verification opens in the system browser. The existing
Codex profile button opens an in-document, theme-aware GitHub Copilot account card with account,
credential source, model count and device-flow switching. It is attached to the native renderer
and does not create an external WinForms or always-on-top overlay.

Authentication is GitHub, never OpenAI. The bridge looks for a Copilot-entitled GitHub
token in this order:

1. `CODEX_COPILOT_GITHUB_TOKEN`
2. `~/.codex-copilot/github-auth.json` (written by `codex-copilot login`)
3. the tokens the GitHub Copilot app / CLI already stored in Windows Credential Manager
4. `GH_TOKEN` / `GITHUB_TOKEN`

Each candidate is validated against `api.githubcopilot.com` before use, so a stale token is
skipped automatically. `codex-copilot login` runs the standard GitHub OAuth **device flow**.
Credential Manager tokens are used in place; they are not copied into `github-auth.json`.
Set `CODEX_COPILOT_AUTH_MODE` to `credential-manager`, `saved`, or `environment` to restrict
automatic credential discovery.

### Account and machine migration

Switch accounts on the same machine:

```powershell
codex-copilot account switch
```

Create a bundle for a colleague or another machine:

```powershell
codex-copilot export .\codex-copilot-transfer.zip
```

The bundle contains the installer/runtime and preferred model name, but no OAuth token,
Credential Manager data, sessions, logs, databases, MCP secrets or live profile files.
The destination user extracts it, runs `install.ps1`, and authenticates independently.
See [MIGRATION.md](MIGRATION.md).
中文说明见 [MIGRATION.zh-CN.md](MIGRATION.zh-CN.md)。

### When the bridge starts

The bridge is started **on demand**: interactive `codex-copilot` / `ccodex` and the desktop
launcher run `ensure.mjs` first, which is a no-op if the bridge is already listening and otherwise
starts it detached in about three seconds. It discovers your Copilot entitlement by itself -
no configuration, and no need to start it manually.

If you would rather have it up from login (so the first launch never waits):

```powershell
codex-copilot autostart on     # adds a hidden Startup entry
codex-copilot autostart off    # removes it
codex-copilot status           # shows the current state
```

### What needs the desktop app

The CLI is fully standalone for normal work. Some **bundled plugins are hosted by the desktop
app**, not by the CLI: `computer-use` and the in-app `browser` talk to the Sky runtime over a
named pipe that the desktop app creates and records in `config.toml`, so they only work while
**Codex (Copilot)** is running. This is stock Codex behaviour - plain `codex` against `~/.codex`
behaves exactly the same way. Plugin installation, enablement, MCP servers, hooks, skills and
everything else are identical between the two profiles.

---

## Models

`codex-copilot models` lists everything your GitHub Copilot settings expose. Two transports
are used, chosen per model from the `supported_endpoints` GitHub advertises:

* **`responses (native)`** — GPT-5.x, GPT-5.x-Codex, Grok, MAI-Code. The Responses API
  request is forwarded to `api.githubcopilot.com/responses` unchanged, so reasoning
  summaries, encrypted reasoning, freeform `apply_patch`, code mode and parallel tool calls
  all work exactly as they do against OpenAI.
* **`chat (adapted)`** — Claude and Gemini. The bridge translates the Responses request to
  Chat Completions and streams the reply back as a Responses event stream, including
  streamed function calls and freeform tool calls (`apply_patch` text is re-normalised on
  the way back).

Codex fetches `/models?client_version=<version>` from the local bridge. The response uses
Codex's official `models.json` shape, with context limits, vision, reasoning levels,
parallel-tool support and `auto_review_model_override` merged from the live Copilot
catalog. Each model keeps one canonical slug: `context_window` is the default Copilot
prompt limit and `max_context_window` is the long-context limit.

### Nothing about the model list is hard-coded

Every interactive launch of `codex-copilot`, `ccodex` or **Codex (Copilot)** re-reads the entitlement of
the signed-in GitHub account before Codex starts, so the models offered are exactly the ones
enabled in your GitHub Copilot settings *at that moment*. Turn a newly released model on
there and it is simply there the next time you start Codex — its context window, its
reasoning-effort levels, its vision and parallel-tool-call support all come from what GitHub
advertises for it, and the transport (native Responses vs. adapted Chat Completions) is chosen
from its `supported_endpoints`. The bridge also reads Copilot CLI's normalized token-pricing
metadata to obtain the exact default and long-context prompt limits. A model you turn off
disappears the same way.

Three things keep it current:

| when | what happens |
|---|---|
| every CLI / desktop launch | `ensure.mjs` checks bridge health; Desktop also refreshes and validates its own catalog before opening |
| every 10 minutes | the bridge re-reads the account and rewrites both catalogs if models or policies change, repairing missing or damaged files |
| on demand | `codex-copilot catalog` |

Models the account cannot drive are dropped rather than guessed at: a model must be a `chat`
model, must advertise an endpoint the bridge speaks, must be enabled in the picker, and must
not be blocked by policy. Unknown vendors, unknown model families and effort levels Codex does
not understand are all handled — a brand-new `claude-opus-6` advertising
`low/high/max/hyper` becomes a working entry with `low/high/max`, and one that advertises no
capabilities at all still gets a usable default.

The bridge publishes `models.json` for the CLI and `models-desktop.json` for the enhanced
Desktop, with one generation fingerprint. Publication invalidates stale model caches. Running
ccodex sessions watch the CLI catalog. A separate selection generation carries
management-CLI changes to active sessions; the Desktop helper reloads its renderer
only when there is no open menu, draft, running response or foreground focus.
The official Desktop app-server does not hot-reload `model_catalog_json`: an
explicit account switch restarts it, while passive catalog changes are logged
for a later Desktop restart rather than interrupting active work.

### The desktop model picker

The enhanced Desktop profile explicitly points `model_catalog_json` at
`models-desktop.json`. Underneath the UI, a tiered model retains **Standard**
and **Long** native presets with real, distinct prompt windows. The enhanced
picker groups them into one Model entry, alongside independent Effort and
Context window rows. A Context change uses the app's own current-thread model
callback to switch presets while keeping the displayed model and effort.
Selecting Standard also takes precedence over a stale `context-long` service
tier. The CLI lists only the base model and keeps its `Model → Context → Effort`
flow.

Showing the full catalog still needs a renderer-local configuration adjustment,
because the app decides what to offer from remote configuration:

```js
// how the app filters the model list (from its own bundle)
useHiddenModels ? availableModels.has(model) : !model.hidden
```

`availableModels` is a server-side allowlist of eight OpenAI slugs. Since you sign in with
GitHub rather than an OpenAI account, that service hands out its default, which naturally
contains only OpenAI's own models — and `claude-opus-5` is not in it, whatever the catalog
says. But `useHiddenModels` is a plain feature flag whose **built-in default in the app is
`false`**, and that branch shows every non-hidden model in the explicit Desktop catalog.

So when the launcher starts the app it also starts `bridge/desktop-patch.mjs`, which attaches
to that window over Chromium's local debugging endpoint and puts that one flag back to its
default. It also presents the three independent controls over the app's native
picker and delegates selections to the app's own thread-owned callback. The
rest of the remote configuration, other feature flags, authentication and
telemetry are untouched.

Worth being precise about what this does and does not change:

* Nothing is written to the app, its package, its data or the network. The flag is flipped in
  the memory of the process the launcher started and is gone when that process exits.
* The endpoint is opened only on the instance **this launcher** starts, on a random loopback
  port. Stock Codex, started from its own Start-menu entry, never sees it.
* An already-running Desktop process is rejected before bridge or profile changes, with
  process IDs and a tray-quit instruction. If the helper cannot attach to a fresh window,
  the app falls back to its built-in model list, where Context aliases may again
  appear as separate entries; check
  `~/.codex-copilot/desktop-patch.log` rather than treating that as a verified enhancement.
* Renderer discovery uses the current `app://` page and semantic catalog/context hooks rather
  than a fixed bundle filename. After a ChatGPT/Codex Desktop update or renderer navigation,
  the helper retries and reattaches; if those anchors disappear it records a timeout and leaves
  the updated stock renderer usable. Independent picker rows do not rely on
  the version-sensitive service-tier permission breakpoint; if the app's model
  callback shape changes, they fail closed to the native picker.
* Model controls read the committed React tree rather than the alternate tree
  retained by a DOM node. An open menu belongs to one conversation; navigation
  closes it, and delayed results from the old conversation cannot close,
  disable or focus the new conversation's controls. A native callback's return
  is not itself a successful selection: the displayed committed settings must
  acknowledge the change.

Two details about how models are presented:

* **Full names.** The picker shortens any label beginning with `GPT-`, so `GPT-5.4` would
  render as bare `5.4`. The generated catalog prefixes those display names with a zero-width
  space, which is invisible but keeps the complete Copilot name on screen.
* **Reasoning efforts.** Codex only offers the efforts listed in the `[desktop]`
  `enabled-reasoning-efforts` setting, which ships as `low`/`medium`/`high`/`xhigh`/`ultra`.
  Copilot models also advertise `max` (and some `none`/`minimal`), so the generated profile
  opts every level in — without that the picker silently drops them. Each model then shows
  exactly the levels GitHub advertises for it: `low/medium/high/xhigh/max` for Claude Opus 5,
  `minimal/low/medium/high` for Gemini 3.6 Flash, and so on. `codex-copilot repair` re-applies
  the setting.
* **Context tiers.** The patched CLI keeps `Model → Context → Effort`: its native
  core changes the effective window and compaction limit on final confirmation.
  The official Desktop core cannot enlarge its native window by setting
  `serviceTier=context-long` alone, so the independent Desktop Context row
  selects a distinct catalog preset for each window. An isolated official-core test
  measured `121600 → 243200 → 121600` on synthetic presets in one thread.
  This is not a live Copilot request or a substitute for checking the actual
  Desktop picker after an app update.

Models GitHub advertises without any `reasoning_effort` show no configurable effort. The
bridge never fabricates display-only levels or forwards an effort the model does not advertise;
the native picker applies that model's default behavior instead.

`codex-copilot use <model> [effort] [default|long_context]` stores the matching
Desktop preset as the profile default. The CLI launcher translates it back to
the base model and its Context tier, and overrides the Desktop catalog path
when starting the patched core. A running Desktop conversation retains its
own thread setting until you change Model or Context there or open a new
conversation.

---

## How it works

```
codex-copilot.cmd ─┐
                   ├─ ensure.mjs ── starts ──► bridge (127.0.0.1:22690)
Codex (Copilot).exe┘                                │
        │                                           │  GitHub token from
        │ CODEX_HOME=~/.codex-copilot               │  Credential Manager / device flow
        ▼                                           ▼
  Context-enabled Codex core / Desktop ──/responses──► api.githubcopilot.com
                                                  ├─ /responses      (native)
                                                  └─ /chat/completions (adapted)
```

* `bridge/server.mjs` — HTTP server exposing `/responses`, `/models`, `/catalog`, `/health`
* `bridge/auth.mjs` — GitHub token discovery, validation and device-flow login
* `bridge/catalog.mjs` — produces the canonical Codex `/models` response
* `bridge/catalog-store.mjs` — atomically publishes generations and invalidates stale Codex caches
* `bridge/copilot-cli-models.mjs` — imports Copilot CLI's default/long-context token limits
* `bridge/translate.mjs` — Responses ⇄ Chat Completions translation
* `bridge/ensure.mjs` — starts the bridge on demand
* `bridge/autostart.mjs` — optional login autostart entry
* `bridge/use-model.mjs` — switches the profile's default model
* `bridge/desktop-profile.mjs` — validates the Desktop catalog and normalizes its default Context before launch
* `bridge/desktop-patch.mjs` — enables local models, installs the independent model controls and attaches the account card
* `bridge/desktop-model-controls.mjs` — groups native Context aliases and uses the app's current-thread model callback
* `bin/runtimes/<arch>/codex-copilot-core.exe` — the package-specific native Codex core with the Context selection step
* `bin/codex-code-mode-host.exe` — copied from the matching official Codex build during install
* `CODEX-SOURCE-REVISION` — exact upstream commit the patch applies to
* `patches/codex-context-picker.patch` — reproducible Rust source diff for that core
* `tools/gen-config.mjs` — derives `~/.codex-copilot/config.toml` from `~/.codex/config.toml`
* `tools/build-icon.ps1` — builds the shortcut icon from the Codex package's own glyphs
* `src/CodexCopilotDesktop.cs` — the desktop launcher

### Four Windows details worth knowing

* **Packaged-app activation.** MSIX executables cannot be started with `CreateProcess`, and
  shell activation builds the child environment from the user's environment block rather
  than the launcher's. The launcher therefore publishes `CODEX_HOME` to `HKCU\Environment`,
  launches the app, and restores the previous value immediately afterwards. It creates no
  window, so the only taskbar button you see belongs to Codex itself.

  *How* it launches matters more than it looks. `IApplicationActivationManager::ActivateApplication`
  is the documented API and passes a command line, but the taskbar button it produces falls
  back to the **window's** icon — a dull, upscaled 48×48 bitmap — instead of the package icon.
  Launching through a shortcut to the app's AppsFolder entry (`shell:AppsFolder\<AUMID>`),
  which is what the Start menu does, makes Windows associate the window with the packaged app
  and draw the **package** icon, and it still delivers the command line. So the launcher writes
  that shortcut to `~/.codex-copilot/desktop-activate.lnk` and starts it; `ActivateApplication`
  remains as a fallback. The result is a taskbar button indistinguishable from stock Codex.
* **Icons.** The package ships one PNG per icon size (`Square44x44Logo.targetsize-N_altform-unplated`)
  as a white glyph on transparency, and Windows uses those files as they are for Start, search
  and the taskbar — which is why the app shows a plain glyph rather than a coloured tile.
  `tools/build-icon.ps1` copies each size into the shortcut's `.ico` verbatim; rescaling one
  large asset, or compositing it onto the manifest's tile colour, both produce something that
  does not match the app.
* **Detached bridge.** `child_process.spawn` always requests handle inheritance on Windows,
  so a plain detached spawn would keep the launching shell's stdout pipe open for the life of
  the bridge. `ensure.mjs` starts it through `Start-Process` (ShellExecute) instead, which
  creates the process with `bInheritHandles = FALSE`.
* **Bridge and account isolation.** CodexCopilot owns port `22690`; ClaudeCopilot owns
  `22790`. Health checks verify the bridge identity, so a stale environment override cannot
  attach to or stop the other product. Once a CodexCopilot login is saved, `auto` mode pins
  that account instead of silently adopting whichever account Windows Credential Manager
  currently contains. A rejected token may recover only from an official credential for the
  same GitHub login, which is then saved into this isolated profile.
* **Large-request recovery.** A GitHub Copilot 408 is returned through the local
  `127.0.0.1:22690/responses` URL, so the displayed URL does not mean the local bridge
  originated it. The bridge retries transient 408/429/5xx and transport failures; after a
  408 it also truncates oversized historical tool outputs while preserving the current turn.
  Diagnostics record byte counts and timing, never request contents.
* **VPN and network changes.** The bridge monitors active interfaces, DNS servers and proxy
  environment. Connecting or disconnecting a VPN replaces Node's pooled upstream HTTP
  connections and invalidates cached account/model state before the next request. This does
  not bypass corporate routing or policy: an endpoint-policy 403 while the VPN is active must
  still be resolved by disconnecting, correcting the corporate allowlist/proxy, or contacting
  the network/GitHub administrator.
* **Remote MCP denial.** `developers.openai.com/mcp` can independently return a Vercel
  `mitigated: deny` 403 even while Copilot inference works. Profile generation disables only
  that MCP in `~/.codex-copilot` when this exact response is observed; stock Codex remains
  unchanged. Run `codex-copilot repair` after changing networks to probe it again, or set
  `CODEX_COPILOT_OPENAI_DOCS_MCP=enabled` to force-enable it.
* **Core isolation.** The patched CLI core remains under CodexCopilot's own
  `bin/cores` directory. New installations do not replace the official Codex
  CLI or Desktop executable. If an older installer left a stock-core backup,
  migration restores it only when that exact legacy target is idle and its
  checksum still matches the old patch record; ambiguous files are preserved
  for review rather than overwritten.

### Browser and Windows Computer Use

The official Browser plugin is not available in Codex CLI. A standalone
ccodex terminal session may expose its plugin configuration but cannot acquire
the Desktop browser authorization token; use an enhanced Desktop chat for
in-app Browser or the connected browser extension. Windows Computer Use uses
the active desktop and foreground pointer/keyboard. It cannot operate
independently of the user's input in that same Windows session. Use a separate
Windows VM for true foreground isolation; PowerShell 7 changes terminal shell
behavior, not this native input limitation. Test both capabilities with a real
page/app after each Desktop update.
---

## Configuration

Environment variables (all optional):

| Variable | Default | Meaning |
|---|---|---|
| `CODEX_COPILOT_HOME` | `~/.codex-copilot` | the Codex profile directory |
| `CODEX_COPILOT_BRIDGE_PORT` | `22690` | bridge port |
| `CODEX_COPILOT_GITHUB_TOKEN` | — | force a specific GitHub token |
| `CODEX_COPILOT_AUTH_MODE` | `auto` | credential sources: `auto`, `credential-manager`, `saved`, or `environment` |
| `CODEX_COPILOT_API_BASE` | `https://api.githubcopilot.com` | Copilot API endpoint |
| `CODEX_COPILOT_DEFAULT_MODEL` | live account default | optional model override written into the generated config |
| `CODEX_COPILOT_SOURCE_HOME` | `~/.codex` | stock Codex profile used to generate the Copilot profile |
| `CODEX_COPILOT_CATALOG_SYNC_MS` | `600000` | how often the model catalog is re-synced |
| `CODEX_COPILOT_CONTEXT_METADATA_TTL_MS` | `600000` | cache lifetime for Copilot CLI context-tier metadata |
| `CODEX_COPILOT_REQUEST_AUDIT_MAX_BYTES` | `2097152` | maximum redacted request-audit log size before compaction |
| `CODEX_COPILOT_AUTO_REVIEW_MODEL` | — | optional enabled Copilot model slug for `auto_review_model_override` |

Logs: `~/.codex-copilot/bridge.log`. Redacted request proof is kept in
`request-audit.jsonl` with a bounded size and `request-audit-latest.json`; neither
file contains prompts, tool payloads, image bytes or credentials.

Re-run `codex-copilot repair` after changing `~/.codex/config.toml` to pull the new settings
(plugins, MCP servers, sandbox policy, …) into the Copilot profile.
