# MyCodex Adapters：macOS 配置指南

版本 `0.1.0-rc.3`，当前是待真实桌面验收的预发布候选包，不应标为稳定版。下载与附件见 [RC.3 发布页](https://github.com/funkdog/ccodex-release/releases/tag/mycodex-adapters-v0.1.0-rc.3)。

在现有官方 ChatGPT/Codex 窗口使用自己的 CLI 和模型。默认仅使用原生 Codex，沿用官方已有的账号、Provider 与模型设置。无需配置外部 CLI，也无需向 MyCodex 填 API 地址或 Key。

外部连接按需添加：Claude Code，或既有 Antigravity ACP 1.4.4（Google 订阅）运行时。此版本只接入已适配的协议，不能将任意 CLI 当作通用聊天接口。每个聊天保留自己的执行器，换 CLI 时新建聊天。工作台、Squad、雷达、日报与跨引擎接续均未启用。

## 安装

1. 首版仅验证 **macOS Apple Silicon（ARM64）**。先安装并登录官方客户端；安装 [Node.js 24 或更新版本](https://nodejs.org/)，确认终端中的 `node --version` 可运行。
2. 核对 Release 附件提供的 SHA-256，将 `.tar.gz` 解压到长期保留的位置，如 `~/Applications/MyCodex-Adapters/`。不要运行 GitHub 自动生成的源码压缩包来代替平台包。
3. 在终端进入解压目录，运行 `./Install.command`。选择官方 `.app` 的完整路径；默认选项 **1：使用当前配置**，首次安装只启用原生 Codex，不下载外部 SDK，不填充第三方模型。
4. 运行 `./Diagnose.command`。当前聊天结束后正常退出官方客户端，再运行 `./Start.command`。客户端已经运行时不会强制结束任务或热替换当前会话。
5. 可选运行 `./Install-Launcher.command`，创建 `~/Applications/MyCodex Adapters.app`。构建图标需 Apple Command Line Tools（Swift / `xcrun`）；不用图标也能运行 `Start.command`。安装后保留解压文件夹的位置。

界面兼容性按官方客户端的精确版本与文件摘要检查。当前登记的 ARM64 版本包括 `26.1023.50603`、`26.1023.51421`、`26.1027.51404`、`26.1103.60933`、`26.1106.51428`；登记不代表每一版都已完成本候选的真实窗口验收。版本或文件不匹配会停止配置。官方更新后先重新诊断，不跳过检查。

若 macOS 拦截下载内容，请在系统提供的安全界面核对来源后处理。本包不自动关闭系统保护。

## 接入自己的 CLI 与模型

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

配置位于 `~/.mycodex/adapters/config.json`；网关与 CLI 聊天状态位于同目录的 `instances/adapters/`。配置目录权限 0700，文件 0600。更新配置需明确确认并保留私有备份；模型验证记录只含模型标识、时间和结果，不含账号或 Key。已有未验证连接不会预填菜单，也不会因为缺少 SDK 阻止原生路径。

暂停增强：正常退出，从官方原图标打开。没有全局 shell 注入或登录项。删除入口或解压目录前先退出；不会自动删除认证、原生聊天或网关历史。不要向他人发送 `~/.mycodex`、`~/.claude`、`~/.codex` 或个人日志。

## 验收与发布边界

每个拟发布的外部引擎都需在专用测试聊天完成：选模型、真实发送、批准一次精确临时文件写入、拒绝另一次写入、取消生成、正常重开后续聊。还需确认原生 Codex、既有侧栏和插件可用，停用后普通客户端正常。目录读取和设置时的一次短请求不能代替桌面验收。

维护者运行 `npm run test:adapters`，复用项目 TypeScript、协议、审批、恢复、浏览器和源码门禁。打包通过 `bash tools/Invoke-HeavyTask.sh node tools/package-adapters.mjs /完整路径/候选包.tar.gz`，包内包含已编译模块、文件摘要与候选状态，不含 Node、CLI、账号或依赖缓存。完整开发门禁仍为 `npm run test:diy`。

在真实验收完成之前，保留 `rc`、`published: false` 与 `liveDesktopAcceptance: pending`。本渠道不覆盖旧 `v1.2.36` 的完整平台发行包。
