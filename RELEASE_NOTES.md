# Codex (Copilot) 1.2.36

## 1. 根因修复详解：彻底解决长会话与高强度推理（MAX）重连 / 断流问题

### 双层根因复盘
1. **第一层（早期自定义逻辑干扰原生行为）**：
   - 旧版桥接器包含自定义的“4 分钟思考检查点（Reasoning Checkpoint）”：当 `MAX` 推理超过 4 分钟且某个 `reasoning` 块结束时，主动中断上游响应、丢弃已缓冲的正文/工具调用/完成事件，并携带历史重新请求。
   - 在 `MAX` 深度推理下，每次被中断的尝试都会产生 50–100 个 `reasoning` 密文块（每个含约 19 KB `encrypted_content`），叠加 Codex 原生 `stream_max_retries = 5` 自动重连后，单次提问会产生 **8 次中断、9 次请求（耗时约 35 分钟）**，历史上下文从正常体量滚雪球膨胀至 **15–24 MB**。
2. **第二层（上游 HTTP `/responses` 网关 ~600 秒空闲断流）**：
   - 当上下文极大且开启 `MAX` 思考时，GitHub Copilot 上游 HTTP `/responses` 流在 ~600 秒（总计约 632 秒）处会被底层连接池/网关重置（`UND_ERR_SOCKET` / `stream disconnected before completion`）。

### 6 项核心 Bug 修复（100% 保持 Codex 与 Copilot 原生机制）
- **[修复 1] 移除自定义 4 分钟思考检查点重启**：`reasoning` 项结束绝不代表响应结束；保留同一条上游流直至收到真正的 `response.completed`，已发布的流式片段绝不在桥接器内重复回放。
- **[修复 2] 启用 Copilot 原生 `ws:/responses` WebSocket 传输**：对宣告支持 `ws:/responses` 的模型自动升级为原生 WebSocket（HTTP `101 Switching Protocols`），支持数十分钟的 `MAX` 深度思考与 22 MiB+ 超长历史传输而不会触发 HTTP 600 秒网关断流；仅在推理开始前的握手阶段失败时才回退 HTTP。
- **[修复 3] 按登录账户动态解析企业专属端点**：自动从当前登录的 GitHub Copilot 账户令牌解析 `endpoints.api`（如企业账户自动路由至 `https://api.enterprise.githubcopilot.com`），不再硬编码个人版端点。
- **[修复 4] 移除 HTTP 408 历史工具输出截断**：删除自定义按字节截断历史工具输出的逻辑，100% 交由 Codex 原生 `auto_compact_token_limit` 自动压缩（Compact）与 `context_length_exceeded` 恢复机制处理。
- **[修复 5] 保护原生窗口、压缩阈值与已选 Effort**：修复 `ccodex repair`、CLI 初始化和模型/Context 切换时意外清除 `model_context_window`、`model_auto_compact_token_limit`、`model_compact_prompt` 的问题；未显式指定新 Effort 时严格保留当前已选强度。
- **[修复 6] 禁止 400 参数静默降级与伪造零 Token**：当上游拒绝 `reasoning.effort`、`tools` 或 `max_output_tokens` 时，不再静默删减参数降级重试并谎报成功，而是只请求一次并向客户端原样返回真实错误详情；客户端取消请求时同步中止上游连接与退避计时器；缺少 `usage` 时保留未知状态而非伪造 `0` Token。

## 2. Ccodex 自定义增强能力全景说明（CLI & Desktop 全量验证）

- **模型、长上下文与计费透视增强**：
  - GitHub Copilot 全模型目录动态映射（原生 `/responses` WebSocket/SSE 与 `/chat/completions` 兼容适配）。
  - **Model / Context (`Default` vs `Long Context` 400K–1M+) / Effort (`none` ~ `max`) 三维独立控制**，CLI 与 Desktop 默认值互不串用。
  - **AI Credits 实时真实配额监控**：读取真实 `token_based_billing` / `credits_used` 数据，在 CLI（`ccodex credits --watch` 与状态栏）和 Desktop（左下角动态 SVG 圆环）同步展示。
  - **脱敏请求审计诊断**：`ccodex verify` / `ccodex inspect-request` 展示真实模型映射、端点、WebSocket 升级状态、生效 Context 窗口、Effort 路径及缓存命中率。
- **终端（CLI）增强体验**：
  - 增强原生 TUI：底部固定输入区（Docked Composer）、统一消息流展示、窄终端自适应状态栏（模型、请求状态、有效上下文窗口、Token 用量、缓存命中率、Compaction 次数、AI Credits）。
  - 终端交互增强：`Shift+Enter` 多行输入、智能粘贴（Smart Paste）、本地文件附件、鼠标直接拖选与右键复制、异常退出键盘模式自动恢复。
  - 交互式 `/model` 三步选择器（`Model → Context → Effort`）与 `/sessions` / `ccodex history` 本地批量会话管理。
- **独立 Desktop 增强工作台**：
  - 官方签名二进制字节级隔离快照（独立 `CODEX_ELECTRON_USER_DATA_PATH`、独立单实例锁、独立桥接端口，与原版 ChatGPT/Codex Desktop 并行运行互不干扰）。
  - 原生模型面板内嵌 **Model / Effort / Context** 三维并列控制栏，保留原生拖动滑块与动画。
  - 左下角 **GitHub Copilot 账户卡片与一键设备流切换账号**。
  - 左侧边栏“最近（Recent）”旁集成 **管理（Manage）** 批量会话管理抽屉（兼容中英文与空历史状态）。
- **企业级连接与热更新**：
  - **CLI ↔ Desktop 账户切换与模型启用/禁用实时双向热更新**：
    - 账户双向热同步：在 CLI（`ccodex account switch [login]`）或 Desktop 切换 GitHub 账户后，共享桥接器原子更新 `account-generation.json` 与 `catalog-generation.json`，运行中的 CLI（2 秒轮询线程）与 Desktop（自动重启本地 `app-server` 并刷新账户与模型视图）在数秒内无感完成热切换。
    - 上游模型 Enable / Disable 实时热更新：修复 `stabilizeCopilotModels` 24 小时缓存覆盖上游 `policy.state = "disabled"` 的问题，支持上游 GitHub Copilot Settings 变更或本地 `ccodex models enable|disable <model-id>` 后，运行中的 CLI 与 Desktop 模型选择器（`__codexCopilotModelControlsV1.setGroups`）原地实时热增删模型，无需重启窗口。
  - **Work IQ (Microsoft 365) 离线集成**：内置 `@azure/msal-node` 与 MCP 客户端，支持 `ccodex workiq`。
  - **仓库 Release 新版本热通知与一键升级**：CLI 启动横幅 + Desktop 右下角悬浮卡片（Toast）实时提醒新版本，支持 `ccodex release-update` 一键 SHA-256 校验安装。

## 3. 内置隔离工具全面升级（Copilot CLI 1.0.97 + Codex Desktop 26.1007.9446.0 / CLI 0.162.1）

### GitHub Copilot CLI：`1.0.94-3` → `1.0.97`
- **官方发布说明**：[GitHub Copilot CLI Releases](https://github.com/github/copilot-cli/releases) ｜ [npm `@github/copilot@1.0.97`](https://www.npmjs.com/package/@github/copilot/v/1.0.97)
- **核心更新亮点**：
  - **企业代理流式稳定性**：修复在 TLS 拦截代理（如企业安全网关）下省略 `close_notify` 时流式响应无法正常结束的问题（[#26120](https://github.com/github/copilot-agent-runtime/pull/26120)）。
  - **长会话内存紧急保护**：长会话在 V8 发生堆内存溢出（OOM）前可绕过冷却时间触发紧急内存释放并保留压缩历史（[#19534](https://github.com/github/copilot-agent-runtime/pull/19534)）。
  - **AI Credits 精确统计**：在 `/usage` 中支持按 Token 计费会话（含 `--resume` 恢复会话）显示已消耗的 AI Credits（[#25755](https://github.com/github/copilot-agent-runtime/pull/25755)）。
  - **挂起会话恢复安全**：恢复挂起会话时明确报告被中断的工具调用，避免重复执行已取消的写操作（[#25267](https://github.com/github/copilot-agent-runtime/pull/25267)）。
  - **自定义 Agent 声明式 Hooks 与深层发现**：支持自定义 Agent 作用域的声明式 Hooks（[#25603](https://github.com/github/copilot-agent-runtime/pull/25603)），并支持发现仓库内超过 100 个或深层嵌套的自定义 Agent（[#25825](https://github.com/github/copilot-agent-runtime/pull/25825)）。
  - **终端内联图片默认开启**：在支持的终端中默认开启内联图片渲染（[#25328](https://github.com/github/copilot-agent-runtime/pull/25328)）。

### OpenAI Codex Desktop：`26.928.3736.0` → `26.1007.9446.0`（含 Codex CLI `0.162.1` / `0.162.0-alpha.17.2`）
- **官方发布说明**：[OpenAI Codex Releases (`rust-v0.162.1`)](https://github.com/openai/codex/releases/tag/rust-v0.162.1) ｜ [OpenAI Codex Changelog](https://github.com/openai/codex/releases)
- **核心更新亮点**：
  - **Desktop 独立快照升级至 `26.1007.9446.0`（应用内部版本 `26.1007.71326`）**：保留完整官方签名字节与独立 `CODEX_ELECTRON_USER_DATA_PATH` 隔离契约。
  - **内置插件与原生工具全量升级**：`browser`、`chrome`、`code-review`、`computer-use`、`unified-computer-use` 同步升级至 `26.1007.71326`，`codex-app-tools` 升级至 `0.1.6`，`visualize` 升级至 `1.0.49`。
  - **Responses WebSocket v2 与 App-Server 增强**：原生支持更稳定的 `/responses` WebSocket 流式协议、改进的线程生命周期管理、子代理协同以及更完善的沙盒命令执行器。

## 4. 四平台全量发行与功能对齐（Windows ARM64 / Windows X64 / macOS / Linux）

- 统一维护四个平台发行包：`Windows ARM64`、`Windows X64`、`macOS (ARM64 & X64)`、`Linux (ARM64 & X64)`。
- 四个平台均内置完整平台原生 `@github/copilot` `1.0.97`（含原生 SEA 二进制与 `copilot-sdk`）、`codex-package` (`0.162.1` 核心与 `codex-code-mode-host`/`rg`/`voice`/`zsh`)、Node `24.18.0`、Work IQ 离线依赖 (`runtime/workiq`，4,787 个文件) 以及 `profile-seed` 全套内置插件与技能（macOS / Linux 各含 13,477+ 个文件，压缩包 328–373 MiB；Windows 额外内嵌 2.33 GiB 官方 Desktop 解压镜像、1.23 GiB Python/文档工具链与 385 MiB MinGit，压缩包约 1.98 GiB）。

## 5. 仓库 Release 新版本热更新提醒与一键安装（CLI + Desktop）

- **CLI 热提醒与一键升级**：启动 `ccodex` 时后台静默检测企业仓库 `nifan_microsoft/ccodex-release` 的最新 Release；发现新版本时在终端顶部弹出醒目通知横幅，用户只需执行 `ccodex release-update`（或 `ccodex release-update --check`）即可自动下载当前平台安装包、校验 SHA-256 并完成原地升级（完整保留已有登录凭据与历史会话）。
- **Desktop 悬浮热通知卡片**：Desktop 右下角实时挂载新版本热提醒卡片（Toast），展示最新版本号与更新摘要，支持点击 **立即下载并安装更新** 一键触发后台 SHA-256 校验安装，或一键复制 `ccodex release-update` 命令。

# Codex (Copilot) 1.2.35

## Responses Upstream Transport Repair

- Models advertising `ws:/responses` use that transport for streaming full-history
  requests without reducing MAX, truncating history or changing authentication
  headers. Genuine frames continue through the native SSE/identity pipeline.
- Only a failed pre-inference handshake can fall back to HTTP. Active inference
  has no bridge duration deadline or silent HTTP replay; cancellation closes its
  socket and reader. Prior-response continuations and HTTP-only contracts remain
  on their original transport.
- Request audit identifies the transport, actual upgrade status, provider request
  IDs and handshake fallback. These source changes are not release-publication
  evidence or proof that an existing process has loaded the candidate.

## Responses Stream Continuity Repair

- Removed the timed reasoning-checkpoint restarts. A reasoning item ending is
  not a response ending; messages, tool calls and completion already buffered
  after that item must be read from the same upstream stream.
- Legacy checkpoint environment variables cannot reactivate this path.
  Keepalives, native context-overflow recovery, selected model, effort and input
  history remain unchanged. Published partial output is never replayed inside
  the bridge.
- Request audit records now measure total logical-request latency rather than
  reporting only the final upstream attempt's duration.
- Removed HTTP 408 history truncation. Transport retries retain the original
  input and never replace native compaction with a byte-based shortcut.
- Native window, compact threshold and compact prompt survive configuration
  repair and model/Context selection. Supported current effort is retained
  when no replacement effort was requested.
- Both protocols cancel upstream work and retry backoff together. A successful
  response without reported usage retains unknown usage, not fabricated zeros.
- Unsupported parameters no longer trigger retries with native capabilities
  removed. Original parameter errors and provider details remain visible.

## Same-Version Windows Desktop UI Repair

- The session-management entry also mounts beside an empty or localized Recent
  section when its native options button is absent. English and Chinese labels
  and later sidebar changes are supported.
- The native bottom trigger projects committed model and Effort instead of an
  intensity placeholder. Model labels wrap inside the existing popover while
  Context remains independent of the unchanged native effort slider.
- Windows private document-runtime promotion retries temporary sharing failures
  for at most 30 seconds, revalidates path boundaries and restores the previous
  runtime when activation fails. It never changes permissions or kills processes.
- The installation-only document diagnostic reserves 240 seconds for combined
  JavaScript rendering and its bounded 120-second Python child, instead of
  incorrectly timing the complete check at the same limit as the nested child.
  Stage diagnostics do not add work to normal CLI or Desktop startup.
- Work IQ documentation now contains only generic architecture, configuration,
  consent and synthetic-testing guidance. Real enterprise validation narratives
  are removed; integration behavior and authorization defaults are unchanged.
- Windows installer names, public version and existing Release tag stay fixed.
  See docs/validation/UI-VALIDATION.zh-CN.md for the replacement-byte evidence and
  its physical-x64 and real-authorization limitations.

## Native Panel, Credits and Terminal Input

- Context is part of the native model/Effort popover, beside its existing model
  header. Model labels contain only the model name; supported effort parameters
  use English labels while preserving the vendor's drag slider, animations and
  committed selection callbacks. Context options remain per-model metadata.
- Actual `token_based_billing`/`credits_used` account data supplies AI-credit
  usage. Request counts and token totals are never relabeled as credits.
  Calculation, percentage, color thresholds, captions, freshness, account
  generation and animation timing are shared; each surface owns its rendering.
- `ccodex credits --watch` uses one-line ANSI rendering only in a proven modern
  TTY, with static ASCII for redirected or legacy terminals. Cursor state is
  restored. Native `copilot-credits` status uses the same projected rules and
  terminal-theme ANSI colors. Desktop uses a real animated SVG ring.
- Account metadata is refreshed at most every 15 seconds. The display identifies
  stale or expired balances and does not promise fresher data than GitHub reports.
- Direct native Shift+Enter validation includes Windows key records and
  record-delivered CSI-u; neither submits the draft or leaks `[13;2u`.
  The test releases its owned PTY only after the native child exits.

## Batch History Interfaces

- Shared CLI list/filter/page, exact-ID previews and confirmed native operations
  are available through `ccodex history` and `copilot history`.
- A separate loopback-only Desktop manager provides multi-selection, date and
  directory filters, previews, progress and per-session results. It does not
  replace native Desktop controls or require a real account for metadata reads.
- Plans expire after ten minutes; every CLI apply attempt has an exclusive
  persistent receipt. Active/remote/unknown ownership and changed metadata are
  protected. Native parent deletion/archive cannot silently cascade to unselected
  spawned threads.
- The authoritative kit is shared with GitHub Copilot enhancements through a
  checked seven-file synchronization. Installers, wrappers, update fingerprints
  and release inventories include the complete kit.

## Responses Stream and Context Recovery

- Resuming complete caller-owned history after an account/profile identity-cache
  change no longer depends on a foreign opaque-ID mapping. The bridge can omit
  only its own display ID from a fully materialized item, retaining every other
  field. Bare references and corrupt/inaccessible records remain explicit
  failures; saved history and other accounts' mappings are never rewritten.
- Recognize Copilot's context-window HTTP 400 even when it uses the generic
  `invalid_request_body` code. Streaming clients receive a genuine failed
  Responses event with `context_length_exceeded`, so Codex marks the context
  full and can compact on the next turn instead of repeatedly sending it.
- A premature EOF or socket failure now ends with an explicit failure, not
  a bare close. Completed responses finish immediately at their terminal
  event. No completed event, usage, history summary or tool result is invented.
- Quiet streams receive bounded, backpressure-aware keepalive events.
  Bridge retries are limited to streams with no published provider events;
  Codex retains ownership of reconnection after partial output.
- The stream repair leaves Codex's compaction algorithm, selected
  model/effort/context, stored user history and stock configuration unchanged.
- The Chat Completions adapter now uses the same native context failure
  protocol, preserves provider error details and partial output, and cannot
  mislabel an SSE error or premature EOF as successful zero-token completion.
  Both transports share the same bounded SSE framing.
- Isolated native regressions cover both Desktop and the pinned CLI core:
  threshold-based automatic compaction, an unexpected context overflow,
  rejection of the first summary request, and recovery in the same thread.
  The existing native algorithm owns compaction; the bridge neither deletes
  stored history nor silently replays a failed user turn.
- The Windows deployment gate now binds its declared Unix-only skips to
  actual named passes on WSL, using the same coverage validator as release
  testing. Original platform counts are retained; unknown skips, incomplete
  results and stale native core provenance are still hard failures.
- Native safety-retry fixtures isolate unrelated app/plugin discovery in both
  their file and initial in-process config. Marketplace downloads cannot
  compete with the mocked turn deadlines; all existing five-second bounds,
  retry, draft, steer and goal-preservation assertions remain intact.

## Release Regression Compatibility

- Legacy renderer-fixture focus is retained across a pending menu rerender
  and restored only after its toolbar is enabled. Explicit outside focus
  and cross-conversation ownership remain authoritative.
- Unix launcher regressions now exercise the current private-snapshot
  delegation, port/profile resolution, argument forwarding and refusal
  to open stock Desktop when the private runtime is missing.
- Production still installs only the native Context extension; the legacy
  replacement UI is not reintroduced.

## Accurate, Redacted Credential Diagnostics

- `doctor` now distinguishes missing credentials, unreadable stores,
  authorization/entitlement rejection, rate limiting, upstream outages,
  network/TLS/timeouts, invalid JSON/schema and no eligible chat models.
  Provider/network failures no longer become a generic "no usable credential".
- Diagnostics contain only fixed source/category labels, numeric HTTP status
  codes and model/sample counts. Tokens, credential targets, response bodies,
  URLs and raw exception messages are excluded.
- Partial successful model samples remain usable. Authentication order and
  same-account recovery restrictions are unchanged; diagnostics do not
  authorize a different-account fallback.
- Successful `doctor` runs reuse their fresh validation result instead of
  fetching a second model batch or treating historical cache data as fresh.
  Cache-write failures remain separate from credential-validation failures.
- Isolated regressions cover error classification, secret redaction,
  mixed/partial samples, selected credential sources, account isolation,
  cache errors, exact temporary-profile cleanup and CLI recovery guidance.
  The native core, status line and Desktop model-control patch are unchanged.

# Codex (Copilot) 1.2.34

## Desktop Model Controls on Real Renderer Trees

- Fixed the actual reason the separate controls could remain absent after a
  Desktop restart: ordinary renderer ancestry exceeded the old 512-Fiber
  traversal limit before reaching the committed root. Ancestors are now
  queued once within a larger, still bounded budget; committed child links,
  conversation ownership and native permission checks remain authoritative.
- Regression fixtures now include deeply nested, alternating React buffers
  and the same three independent Model, Effort and Context window controls.
  Excessive/cyclic graphs still fail safely to the native picker.
- The model patch exposes its revision and committed binding separately.
  Repeated installation is idempotent, and disposable patches remove their
  own listeners, observer and styles. A legacy undisposable patch explicitly
  requires a renderer reload instead of installing competing callbacks.
- Detached windows no longer lose installed Model/Account controls while
  waiting for an absent optional service-tier bundle. Discovery is bounded
  separately, live sessions are retained, and actual transport/renderer
  errors still propagate. Diagnostics distinguish installation from binding.
- Native cores, their patch chain, and the CLI's progressive
  `Model → Context → Effort` flow are unchanged.

# Codex (Copilot) 1.2.33

## Desktop Model State and Conversation Ownership

- Independent Model, Effort and Context controls now resolve the committed
  React tree. A DOM element can retain an older Fiber across renders; neither
  stale props nor an uncommitted alternate may drive the selected value or
  native callback.
- An open menu and pending update belong to the conversation that opened
  them. Navigation dismisses the old menu, and a late result cannot steal
  focus, close a new conversation's menu or clear its pending state.
- Native disabled flags and callback failures remain authoritative. Because
  Desktop may return before its internal asynchronous update completes, the
  menu waits for committed settings to acknowledge a change and reports an
  unconfirmed selection after a bounded wait.
- The shared installer guide now explains the three independent Desktop
  controls, on-demand bridge startup on Windows as well as Unix, and the
  Windows foreground-input boundary. PowerShell 7 does not turn Windows
  Computer Use into background input.
- The native core and patch chain are unchanged. Real UI evidence collected
  separately includes the user-started Desktop Browser form receipt and a
  native Windows Notepad input/save check. These do not replace a fresh
  Desktop model-menu click after restart or missing native platform runners.

# Codex (Copilot) 1.2.32

## Independent Desktop Model Controls

- The enhanced Desktop model bar now opens three separate Model, Effort and
  Context window rows. The Model list shows each Copilot model once, without
  repeating Standard/Long names and token counts. The top bar is a short
  model-and-effort summary.
- The two native Context aliases remain underneath because the official
  Desktop core needs distinct catalog windows. Context changes call the
  Desktop app's own active-thread model updater, preserving the selected
  model and effort; model changes preserve Long when the new model supports it.
- Unknown renderer shapes fall back to the native picker. The CLI's existing
  `Model → Context → Effort` flow and running Desktop sessions are not modified.
  Isolated state/renderer tests and a local visual preview cover the new menu;
  a real Desktop click still requires reopening the enhanced app after the
  current user task finishes.

# Codex (Copilot) 1.2.31

## Shared On-Demand Showcase

- `ccodex showcase` and `codex-copilot showcase` now work from the packaged
  Windows and Unix launchers, not only from a machine-specific wrapper. They
  display the same validated `assets/installer-showcase.json` and optional
  trusted HTTPS update used by the installer.
- The command does not create a workspace or profile and does not start the
  bridge or native core. Windows reuses the installer PowerShell renderer;
  Unix reuses the installer renderer in a read-only showcase mode. Isolated
  command tests cover both platform launchers.
- The shared Windows UI module emits UTF-8 for redirected console output, so
  Chinese stage details and fallback warnings remain readable in install logs
  under both PowerShell 5.1 and 7.
- The isolated Work IQ slow-upstream test now gives its own native host up to
  60 seconds to exit after the completed call, while still requiring clean exit
  code zero. Its startup and late-tool assertions are unchanged.
- On this resource-constrained Windows release host, the complete package
  suite now runs one test file at a time. The six-job ceiling remains fixed;
  no test or native assertion is skipped. Legacy bridge shutdown tests retry
  transient safe refusals only after rechecking the identical idle PID,
  endpoint and unchanged runtime record.
- The shared HTTPS endpoint remains opt-in until a publisher configures a
  trusted location; the bundled snapshot is the offline fallback.

# Codex (Copilot) 1.2.30

## Narrow Context Status Verification

- The isolated native `/model` regression now resizes to a 48-column terminal
  after Model → Context → Effort selection. In both alternate-screen modes it
  checks that the wrapped status still shows the effective Context window
  exactly once and does not restore the obsolete Context-tier segment.
- The complete Windows release suite now runs two test files concurrently by
  default, below the machine's six-job ceiling. This reduces startup contention
  for isolated bridge, PowerShell and native-host probes; all package, Unix and
  native checks remain mandatory and are counted in the release report.
- Two safety regressions tolerate a transient fail-closed refusal only after
  rechecking the same idle bridge PID or the unchanged cache-lock bytes.
  Identity changes, missing evidence and repeated failures still fail the suite.
- This is a verification-only update; the native patch chain and model routing
  are unchanged. Browser form submission still requires an authorized Desktop
  conversation. Archive checks are not a substitute for missing native Linux
  x64 or macOS runtime checks.

# Codex (Copilot) 1.2.29

## Windows Desktop Launch Safety

- The enhanced launcher now refuses to report success when an existing
  ChatGPT/Codex Desktop process is still running, including tray-resident
  instances with no visible window. It checks before modifying its profile or
  bridge and again during activation, displays the observed process IDs, and
  asks the user to save drafts and choose Quit from the system tray. It never
  kills the existing process or interrupts its tasks.
- Stock `codex.exe` CLI processes without a Desktop executable identity do
  not count as an already-running Desktop. An activation fallback without an
  observed new process no longer reports success.
- This fixes a false-success path; it does not force-restart a user's active
  Desktop. The new catalog still needs a fresh official app-server process,
  and real Desktop picker/Browser interaction remains to be verified from
  an authorized Desktop conversation.

# Codex (Copilot) 1.2.28

## Desktop Context Presets

- The enhanced Desktop receives a separate explicit model catalog. Models with
  Copilot Long metadata expose adjacent Standard and Long presets with distinct
  native context windows; both route to the same authorized Copilot model. Old
  base slugs remain available for existing conversations but are hidden from
  new Desktop model choices.
- The patched CLI continues to use the original one-entry-per-model catalog
  and its `Model → Context → Effort` flow. Its launcher maps profile-level
  Desktop aliases back to the base model and actual CLI context tier.
- Desktop launch refreshes its catalog and reconciles a legacy
  `model + service_tier` default before opening the app. Explicit Standard
  routing is not fooled by an inherited `context-long` value. Damaged Desktop
  catalogs are repaired with a new generation.
- Isolated app-server tests with the official Desktop core and local mock
  provider observed `121600 → 243200 → 121600` effective tokens in one
  thread. An isolated patched-CLI test verified catalog separation and the
  Long-tier launch override. These do not claim a live Copilot HTTP request or
  an authorized Desktop UI click.

## Verification Boundary

- Browser remains a Desktop/Web capability, not a Codex CLI capability. A
  real webpage form still needs an authorized Desktop conversation; no token
  or credential is copied into the CLI. Windows Computer Use's foreground
  keyboard/pointer behavior is unchanged.
- The official Desktop app-server does not hot-reload its explicit catalog.
  Account switching restarts it; passive model-catalog changes are logged for
  a later Desktop restart instead of interrupting active work.
- Native Linux x64 and both macOS target cores still require same-platform
  runtime checks; local archive verification is not that evidence.

# Codex (Copilot) 1.2.27

## Side-by-Side Bridge Updates

- New CLI and enhanced Desktop launches resolve a validated, profile-owned
  `bridge-port.txt`. Explicit port overrides still take precedence; existing
  processes keep the endpoint they already use.
- When an older bridge has active requests, Windows setup starts the new code
  on a separate loopback port and then moves new sessions to it. In-flight
  requests remain on the old endpoint. Each port has its own runtime record
  and restricted random control credential.
- A current bridge can atomically refuse new work and drain only while idle.
  Legacy bridges without that control endpoint require repeated idle, process
  and source-identity checks before shutdown; their final race cannot be
  eliminated without upgrading the old server.

## Installation And Release Verification

- Windows validates the native core, ordered patch chain, package target and
  SHA-256 before copying files. An old busy bridge is never treated as a
  successful new generation merely because `/health` answered.
- Unix setup verifies GitHub Copilot entitlement before official Desktop and
  independent stock Codex CLI prerequisites, stages an exact target, checks its
  core and preserves the old installation for rollback on failure. Linux
  Desktop preview uses the official app separately; no unsupported Computer
  Use or Copilot Desktop overlay is claimed there.
- CI applies one native patch chain, records real target architecture, build
  hash and same-architecture runtime verification. Local publication runs the
  Unix-only installation tests inside isolated WSL as well as the Windows
  package/native suite; unexplained skipped tests fail the release gate.

## Remaining Boundaries

- The official Desktop core bundled with 26.924.2738 does not expose a
  writable current-thread `modelContextWindow` in its v2 app-server schema.
  `context-long` alone is not proof of an enlarged effective window. The
  independently verified CLI `/model` sequence remains available; Desktop
  current-thread Context needs separate end-to-end validation.
- Browser control must be verified from a Desktop-authorized chat; standalone
  CLI sessions do not inherit its browser token. Windows Computer Use still
  owns the active desktop, so use a separate VM for simultaneous independent
  pointer/keyboard work.
- A shared showcase HTTPS endpoint has not been configured for this machine.
  Packages contain the same offline JSON snapshot and accept an explicit,
  schema-checked HTTPS URL for subsequent display updates.

# Codex (Copilot) 1.2.26

## Status And Selection

- The generated status line now shows one Context item: active tokens over the
  effective window. For example, a 922K prompt tier with Codex's 95% effective
  limit displays approximately 876K, rather than duplicating the tier label.
- Profile repair preserves a newer `/model` selection instead of restoring an
  older shared snapshot. The `Model → Context → Effort` confirmation flow is
  unchanged and has an isolated native regression test.

## Installer And Release

- Windows and Unix installers render the same schema-checked, colorful feature
  guide. An explicitly configured `CODEX_COPILOT_SHOWCASE_URL` can supply new
  HTTPS JSON at installation time; without it, the bundled snapshot is used.
  Already published packages without this fetch mechanism cannot be updated
  retroactively.
- The default bridge policy is on-demand when ccodex or the enhanced Desktop
  starts. Existing explicit autostart settings remain under the user's control.
- Windows setup checks Copilot eligibility before Desktop and CLI resources,
  preserves running sessions, and keeps the official Codex binaries separate
  from the patched ccodex core. It does not claim successful authentication
  when the model catalog cannot be verified.
- Native source patches are declared once for both CI platforms. Local release
  publication uses isolated tests, a global heavy-build lock, ordered targets,
  archive checksums and source-byte verification. Unchanged native cores are
  marked as reused, not misrepresented as newly compiled.

## Known Verification Boundary

- On Windows, Computer Use requires an active Desktop-owned native connection
  and foreground input. PowerShell 7 does not remove that OS limitation.
- The browser plugin is a Desktop/Web capability. A standalone CLI session may
  lack the Desktop authorization token even when the Edge extension is installed;
  the browser interaction flow must be verified from a Desktop chat.
- Desktop 26.924 changed the built-in service-tier permission check. This
  release does not bypass it; the Copilot Desktop Context control needs a
  supported thread-setting integration before it can be claimed as repaired.

# Codex (Copilot) 1.2.25

## Model And Context Selection

- `/model` now follows a strict `Model → Context → Effort` flow for models with
  multiple context tiers. Copilot-sized labels such as `400K` and `1.1M` come from
  the active model catalog rather than fixed `64K / 128K / Full` choices.
- The model, context tier and reasoning effort are applied atomically after the final
  confirmation. Escaping either child picker leaves the current selection unchanged.
- Choosing the default context clears `context-long`; choosing the extended context
  sets it without requiring Fast mode. Current-thread settings and future-session
  defaults stay synchronized.

## Terminal Interaction

- One rich transcript surface renders startup, live output and completed messages.
  The composer remains pinned to the bottom. New output follows automatically unless
  the user scrolls away; one Down key returns to the latest output.
- The transcript's scrollbar reflects the same row position as the displayed content
  and can be dragged. Resizing and closing a history overlay clear stale terminal cells.
- Ordinary mouse dragging selects output, including across wheel/edge scrolling.
  Ctrl+C or right-click copies the selection without interrupting the agent. Existing
  composer selection, editing, undo, model controls and native interrupt shortcuts remain.
- Completed history is cached per cell. Live state, syntax-theme changes and terminal
  palette changes still refresh correctly, including the initial selected-model header.

## Attachments And Status

- Clipboard images and copied file lists use native attachment handling. Dropped files
  and images receive individual filename labels, including disambiguated duplicate names.
  Filename labels remain visible after submission and restoration; the model still gets
  canonical image inputs and exact file paths.
- Windows key-record drops are recognized even when paste aggregation is disabled.
  Ordinary typing and Enter behavior are not delayed or reinterpreted as a large paste.
- The status line adds the GitHub account, per-thread request verification, latest
  input/output usage and cached-read amounts. Existing model, effort, context and
  compaction fields remain native. Missing values are omitted or explicitly unavailable,
  never estimated.
- Queue hints no longer hide the configured status line while drafting during a turn.
  Request verification cannot be borrowed from another thread or account generation.

## Installation

- Generated Copilot profiles default to rich output and an alternate-screen transcript.
  Explicit raw-output and no-alternate-screen controls remain available.
- Windows, Linux and macOS setup shows the updated interaction and attachment examples.
  Stock Codex profiles and entry points remain separate.
- All builds use the declared upstream source revision and ordered patch chain. Candidate
  cores and packages carry checksums and source provenance; a version label is not a
  substitute for rebuilding the native core.
