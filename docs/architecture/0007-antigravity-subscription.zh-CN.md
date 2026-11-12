# ADR 0007：Antigravity 订阅账号 Agent

2026-10-29，用户明确没有独立 Gemini API key，选择先接 Antigravity 的 Google 订阅账号 Agent。[ADR 0006](0006-google-account-gemini.zh-CN.md) 的旧 Gemini CLI 拒绝及原生 Codex 纯模型接口实验保留为历史；两条实验入口没有启用。

**状态：源码、真实网关联调和私有实例配置完成，当前窗口尚未切换。** Google 订阅认证成功，实际目录提供 Gemini 4 Argon 与 Gemini 3.8 Flash，每个模型均提供 low / medium / high，当前目录默认 high。5 次真实 Agent turn 通过，84 项定向测试通过。现有 MyCodex 入口只读检查返回 `needs-quit`、`launchPerformed: false`；仍需用户协调退出当前 ChatGPT 后从原 MyCodex 图标重开，并完成原窗口验收。

用户随后明确选择“稍后我再重开”。当前客户端继续保留，不安排自动退出或重启；用户手动从 MyCodex 重开后再接续原窗口验收。

## 执行路径与界面

原生输入框 → 现有本机协议路由 → 现有共享 CLI 网关 → 官方 Antigravity ACP Agent → Google 订阅模型服务。

菜单使用 `Antigravity（Google 订阅）`，与 `Codex + Copilot` 及 `Copilot CLI` 区分。引擎 ID 为 `antigravity`，adapter 为 `antigravity-acp`；不是原生 Codex 直连模型，也不使用 Copilot 或独立 API key 额度。

复用现有草稿、项目、统一侧栏、会话存储和 CLI 底栏控件。模型与推理选项来自实际 session config，不把旧兼容目录的“模型 × 推理”组合项重复列成独立型号。每轮设置得到 ACP 确认后才发送消息；不可用模型或推理档位明确失败，不选择替代型号。

审批提供“逐次确认”和“拒绝授权”；运行中的每次权限请求读取最新会话策略。只可选择 runtime 提供的 `allow_once`，不选择永久授权，也不切换到 yolo。`interaction_*` 业务提问按实际选项交给用户回答，不把答案当成权限批准；这项形状由确定性测试覆盖，尚未作为原窗口真实提问验收。

Antigravity 使用自己的工具与权限规则，不模拟 Codex OS 沙箱。“拒绝授权”拒绝权限请求，不声称禁用 runtime 本来就无需询问的所有工具。普通文本和现有本地图片输入可用；其他附件继续沿用 CLI 接口的明确拒绝边界。

## 官方运行时、认证与生命周期

[官方 ACP 注册表](https://github.com/agentclientprotocol/registry/blob/main/antigravity-acp/agent.json)选择 `1.4.4`，macOS ARM64 归档来自 `dl.google.com`，已验证 SHA-256：`a3cf324046396380fcd8c055a4a4c83ac4ea74a38ea883ccbfce5ca1e9927ae9`。`agy_acp_server.par` 与同发行的 `localharness_external` 保持成对，放在本机缓存，不复制到源码或修改官方应用。

官方 [Google 账号登录配置](https://antigravity.google/docs/ide/extensions/zed)使用 `auth.type: oauth-personal`。本机采用独立 `GEMINI_HOME` 与 runtime 管理的私有文件凭据，不迁移默认 `.gemini` 内容，不写 API key。目录读取和执行只使用已保存的登录，不自动调用 `authenticate`。环境移除其他 Google/Gemini key、云凭据、旧路由变量及原生 provider 能力凭据，避免改变账号或计费路径。

运行时的 `initialize` 名称与版本必须匹配已核验契约。已有会话使用明确支持的 `session/resume`，不创建替代会话，也不把 `session/load` 的历史重播混入新回复。取消通过通知传递，并以关闭自有 ACP 进程组回收未响应的子进程；不会连接或结束用户已有的 Antigravity 窗口/进程。

本机同时配置了同一地址的 HTTP、HTTPS 和 SOCKS 系统代理。官方 runtime 的 Python websocket 默认选择 SOCKS，却缺少 `python-socks`；首次建会话因此失败。适配器仅在无显式代理环境设置时，将当前 macOS 已配置的 HTTPS 代理按 HTTP CONNECT 传给自有子进程。没有改系统代理、安装补丁依赖或直连绕过代理。显式代理环境设置保持优先。

## 已有证据与剩余验收

[结构化记录](evidence/2026-10-29-antigravity-subscription.json)包括：

- 真实官方 Agent：Flash 文本回复；完整关闭并重建网关、原生路由测试进程和 ACP 进程后，恢复同一 session ID，正确复述未在新提示中提供的随机 nonce；红图识别成功；Argon 独立回复成功；1 次精确文件 diff 的单次批准后，在临时工作区写入预期内容。
- 原生 Codex 测试进程只用于验证协议共存，其推理入口被观察并拦截，实际计数 0。没有向用户现有线程发送或重放消息。
- 84 项定向测试通过，无跳过；覆盖真实 ACP 子进程 fixture、按模型读取推理选项、恢复、图片、权限和业务答案区分、拒绝、取消、未知 runtime/模型，以及既有 Copilot、路由、启动和配置回归。
- 模块检查：149 个 ESM、321 个相对 import。测试使用临时 HOME、私有账户快照和工作区；临时凭据、网关状态和测试工作区已删除，自有 ACP / harness 后代已退出。

本机配置只追加 Antigravity，原 `copilot`、`codex-copilot` 条目与 `defaultEngine: copilot` 保留，并保存私有备份。没有替换活跃网关的连接配置、重载 UI helper、退出或重启当前客户端。下次用户协调退出后点击原 MyCodex，入口会等待旧网关退休、准备新代次并启用，无须重装图标。

剩余：原窗口新建菜单、推理与审批控件、发送及原侧栏恢复，以及再次协调重启后的 Antigravity 续聊。这些尚未由真实 CLI 探针或 fixture 代替验收。

本轮仍是 Mac 本机开发，`VERSION` 为 `1.2.36`。没有运行 PowerShell、Windows runner、六平台构建或发布新发行包。
