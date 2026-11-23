# MyCodex 0.2.0-rc.1 macOS 安装指南

`0.2.0-rc.1` 是 macOS Apple Silicon 候选版。平台包、SHA-256 和校验回执见 [发行页](https://github.com/funkdog/ccodex-release/releases/tag/mycodex-v0.2.0-rc.1)。

首次安装默认使用官方 Codex 的现有账号、Provider、模型设置与原生历史，同时启用 `mycodex` MCP、原生事件采集和右侧 `Squad Studio`。只需已登录的官方客户端和 Node.js 24。点击侧栏的小队入口可打开 Studio，查看成员、轮次、Git diff 和交付物。

外部模型按需接入 Claude Code、Antigravity ACP 1.4.4 或 GitHub Copilot。每个聊天保留自己的执行器，更换引擎时新建聊天。

## 安装

1. 本候选包适用 **macOS Apple Silicon（ARM64）**。先安装并登录官方客户端；安装 [Node.js 24 或更新版本](https://nodejs.org/)，确认终端中的 `node --version` 可运行。
2. 核对 Release 附件提供的 SHA-256，在下载目录运行 `shasum -a 256 -c mycodex-macos-arm64-0.2.0-rc.1.tar.gz.sha256`，通过后解压 `mycodex-macos-arm64-0.2.0-rc.1.tar.gz` 到长期保留的位置。
3. 在终端进入解压目录，运行 `./Install.command`。选择官方 `.app` 的完整路径；默认选项 **1：使用当前配置**，首次安装启用原生 Codex 与 Squad Studio，外部模型列表为空。
4. 运行 `./Diagnose.command`。当前聊天结束后正常退出官方客户端，再运行 `./Start.command`。客户端已经运行时不会强制结束任务或热替换当前会话。
5. 可选运行 `./Install-Launcher.command`，创建 `~/Applications/MyCodex Candidate.app`。构建图标需 Apple Command Line Tools（Swift / `xcrun`）；不用图标也能运行 `Start.command`。安装后保留解压文件夹的位置。

候选包在官方 ChatGPT `26.1117.41037` 上核验了应用与 CLI 摘要及原生接口。之前登记的版本仍按各自文件摘要匹配。官方更新后先运行诊断，兼容性以实际检查结果为准。

若 macOS 拦截下载内容，请在系统提供的安全界面核对来源后处理。本包不自动关闭系统保护。

## 接入自己的 CLI 与模型

**GitHub Copilot**：使用自己的 Copilot 账号，按 [专用接入指南](CODEX-COPILOT-SETUP.zh-CN.md) 完成独立登录、模型选择和启动。指南提供独立账号目录和带 Spine 的配置。

**原生 Codex**：在官方客户端已有的账号、Provider 和模型设置中配置即可。本向导不重写这些设置、不复制 Codex 凭据、不替换官方执行器。

**Claude Code**：按 [官方安装说明](https://code.claude.com/docs/en/setup) 安装并在终端运行自己的 `claude`，完成登录或已有服务配置，先确认 CLI 能回答短问题。然后运行 `Configure.command`：

1. 选 **2：添加自己的 CLI**，选择 Claude Code，为连接命名并填写自己 CLI 的命令或完整路径。路径字段不接受 `--model` 等命令参数。
2. 首次需要适配依赖时，向导会询问是否联网安装锁定的 Claude Agent SDK `0.3.312`。它调用你选择的 CLI，不捆绑另一个 CLI，也不复制维护者的账号。
3. 保存连接后，向导读取该 CLI 的**候选模型**。这只说明 CLI 认识该标识，不代表当前账号有权限或额度。
4. 选择一个模型编号，明确输入 `yes` 后才会发送一次短文本验证，可能消耗自己的额度。验证使用空临时工作目录，Claude 禁用工具、项目设置与会话持久化。只有收到正确结果，才把该模型加入菜单；失败不启用、不换用其他模型。
5. 正常重开后，在新聊天底部“引擎／模型”入口选择该 CLI 和已启用模型，点“应用切换”后发送。需要添加其他模型时再次运行 `Configure.command`，选 **3：为已有 CLI 添加并验证模型**，逐个选择。

认证、服务地址和模型权限仍由你的 CLI 管理，参考 [Claude 认证说明](https://code.claude.com/docs/en/authentication)。服务端 `/models` 列出的全部模型不会自动进入菜单；Claude 候选以 CLI 支持项及用户明确配置的模型为边界。已有连接不会因为重新运行向导被默默替换。

仅在终端临时 `export` 的配置不会自动传入 Dock 启动的进程。需要这些变量时，从同一终端运行 `Start.command`，或使用 CLI 自身支持的持久配置方式。账号、服务或 CLI 变化后，请重新验证所选模型；一次成功不保证后续额度或权限不变。不要把 Key 填入聊天、路径或反馈。

**Antigravity / Gemini 模型**：本候选可选择你已有、已完成个人 Google 授权的 **Antigravity ACP 1.4.4**。向导需要 ACP 服务可执行文件、配套 `localharness_external` 路径，以及包含 `antigravity-acp/settings.json`、`acp_token.json` 的账号根目录。认证文件需属于当前用户且为私有普通文件。使用自己的目录，不复制他人的令牌。模型同样需要逐个选择并通过短请求验证；该适配器真实桌面验收仍待完成。

普通 `gemini` / `agy` 命令不能替代此 ACP 协议。Gemini CLI 的个人 Google 登录服务已经变更，旧候选的 `Login-Gemini.command` 已移除，参见 [Google 官方迁移公告](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/)。本候选不提供通用 Gemini API Key / Vertex 接入。

## 会话内设置

新聊天创建前可以选择已配置且已验证的引擎与模型；创建后执行引擎和模型来源固定，只列出同一引擎支持切换的模型。要换引擎请新建聊天，不搬运整段历史。

在已有聊天底部打开“模型与引擎”，选择兼容模型后点“应用切换”；只有客户端确认后才更新当前模型。若切换失败，已提交的模型和历史保留，不自动重试。

原生 Codex 的“响应速度：标准／快速”沿用官方客户端对当前账号与模型开放的选项，选择后直接生效，无需点“应用切换”。第三方 CLI 不提供此原生速度控件；额度与可用性由自己的服务决定。

## 日常操作与数据

| 入口 | 用途 |
| --- | --- |
| `Install.command` / `Configure.command` | 原生优先配置、添加 CLI、选择并验证模型、停用连接或恢复原生配置 |
| `Diagnose.command` | 检查宿主、路径与候选目录，分别报告已启用的模型；不发送推理，不把目录成功称为认证或推理成功 |
| `Start.command` | 准备并打开当前官方客户端，不强制终止现有会话 |
| `Install-Launcher.command` | 可选创建独立图标，不覆盖原 MyCodex 图标 |

配置位于 `~/.mycodex/desktop-candidate/config.json`；网关与 CLI 聊天状态位于同目录的 `instances/adapters/`。配置目录权限为 `0700`，文件权限为 `0600`。从 RC.4 升级时会在这个新目录创建配置，使用新向导重新选择如需保留的外部连接。更新配置需明确确认并保留私有备份；模型验证记录只含模型标识、时间和结果，不含账号或 Key。已有未验证连接不会预填菜单，也不会因为缺少 SDK 阻止原生路径。

暂停增强：正常退出，从官方原图标打开。没有全局 shell 注入或登录项。删除入口或解压目录前先退出；不会自动删除认证、原生聊天或网关历史。不要向他人发送 `~/.mycodex`、`~/.claude`、`~/.codex` 或个人日志。

## 验收与发布边界

候选包随附 `MYCODEX-MANIFEST.json`，记录源码提交、载荷清单和每个文件的 SHA-256。平台包使用官方客户端自带的原生 Codex CLI，外部 SDK 在选择相应适配器后按需安装。发行页的 `RELEASE-0.2.0-RC1.json` 绑定归档、包内清单和源码记录。

带账号的真实桌面验证包括原生聊天、右侧 Squad Studio，以及选择外部模型、发送、权限确认、取消和重开续聊。实际范围见 [候选版验证记录](https://github.com/funkdog/ccodex-release/releases/tag/mycodex-v0.2.0-rc.1)。
