# 源码维护与发布

## 取得源码

```powershell
git clone https://github.com/funkdog/ccodex-release.git
cd ccodex-release
```

本仓库是增强逻辑的可维护源码，不是第三方可执行资源的镜像。
源码包含 Copilot/Work IQ 桥接、Desktop 适配、独立安装与卸载、原生辅助组件、完整原生补丁链、测试和安装器组装代码。
Desktop、Copilot、Node、Git、Python、文档运行时等离线二进制由各自的安装渠道提供。

公开下载见 [MyCodex Adapters RC.4](https://github.com/funkdog/ccodex-release/releases/tag/mycodex-adapters-v0.1.0-rc.4)（macOS ARM64）。旧多平台包的操作记录见 [v1.2.36 历史发行说明](RELEASE.zh-CN.md)。

## 本机开发版

已有开发版使用唯一公共命令 `ccodex-dev`：

```powershell
ccodex-dev source
ccodex-dev sync
```

`source` 显示当前安装绑定的源码目录；不下载、不执行脚本。
在该目录修改源码后，`sync` 同步启动器、桥接、工具和辅助模块，并重新编译小型 Desktop 启动器。
它保留原生核心、登录、配置及聊天，不会强制结束当前任务。
新 CLI 使用同步后的代码；正在运行的 Desktop 正常退出后重开。

`sync` 不推送 GitHub，不打包同事安装器，也不构建原生核心。
它要求已有正确归属的开发版和辅助原生运行时；不用于从一个干净 Git 克隆安装全部离线资源。

### 开发版长推理断连

先核对当前窗口实际使用的桥接端口、进程和 `runtime.sourceGeneration`，再查看该
profile 的 `bridge.log`、`request-audit.jsonl` 和 `request-status`。`bridge-port.txt`
只代表当前选择，不能证明旧窗口或旧会话已经切换到该实例。

原生 Responses 流保持同一条上游连接，直到上游终结事件、真实断连或用户取消。
`response.output_item.done` 只代表一个输出项结束，不代表整个响应完成；其后可能
紧接正文、工具调用及最终用量。原先的四分钟定时续接会提前取消这些输出，并将
历史及推理项再次发送，最多造成八次额外重启。该路径已经删除，而非仅默认关闭。
旧的 `CODEX_COPILOT_RESPONSES_CHECKPOINT_MS` 和
`CODEX_COPILOT_RESPONSES_MAX_CHECKPOINTS` 变量不再启用它。

若原生模型目录声明 `ws:/responses`，完整历史的流式请求优先使用该传输；
仅增加 `response.create` 外层类型并省略 HTTP 的 `stream`，保留原有请求头、
MAX、加密推理、工具及完整输入。握手尚未发送推理时失败，才可回落到原 HTTP
请求；已开始的推理不得偷偷改用 HTTP 重播。HTTP-only、非流式、显式后台请求
和依赖上一响应 ID 的续接仍保持原来的 HTTP 契约。新路径没有推理时长截止，
真实断流、服务端限制和参数错误仍明确交回原生核心。

区分上游 HTTP 断流、原生 SSE 空闲超时和诊断脚本自己的观察期限。
收到真实推理事件超过先前断流时间，只是传输对照证据；观察期限到达不等于
上游断连，更不能当作完成。必须另验完整终结事件及真实用量，不能借此宣布
原会话已恢复或安装包已发布。旧 CLI 的逻辑中断也可能保留静默读取器，直到
下一条真实上游事件；应与旧 HTTP 路径对照，而不是伪造模型事件强制关闭。

HTTP 408 仅代表传输超时，不代表上下文超限。重试必须保留原始历史和工具输出，
不得按字节截短，也不得提示用户丢弃会话。配置修复、CLI 初始化及模型/Context
切换保留原生 `model_context_window`、`model_auto_compact_token_limit`、
`compact_prompt`；上限校验及压缩由原生核心决定。未指定 Effort 时，在新模型
支持的情况下保留当前值，而不是静默重置为模型默认值。
两种协议的取消信号同时结束上游和重试等待。上游没有报告用量时保持 `null`，
不能用零 token 代替未知用量，也不能从原生输入计数中扣除缓存 token。
上游拒绝未知参数时，不得删除整个 `reasoning`、`tools`、输入或压缩字段再尝试，
也不得通过静默关闭原生能力把失败包装为成功。参数错误及其详情直接交回原生客户端。

保活只维持客户端连接，不取消上游、不续接推理、不改变模型、Effort 或输入历史。
上游输出发布后，真实流错误交回原生 Codex 处理；桥接不自行重播消息或工具调用，
也不伪造完成事件和用量。上下文超限仍通过原生压缩恢复。
审计的 `elapsedMs` 是整条逻辑请求的实际耗时，包括正常的无输出重试；
`reasoningCheckpoints` 固定为零。旧记录的 `usageScope = "final_upstream_response"`
仍只表示当时最后一个上游响应的用量，不是旧续接过程的汇总。

同步源码后，应等待对应实例的任务暂停或结束，再通过受控停止接口重载该端口。
保留登录、配置、聊天和原生核心；不要强制结束仍有任务的实例，或只重开窗口就
宣称修复已加载。健康信息中的 `responsesStreamContinuity = 1`、
`responsesReasoningCheckpoints = 0`、`responsesCheckpointMs = 0` 和源码指纹
可核验实际运行的修复。开发版同步会移除已废弃的定时续接模块。
`responsesTimeoutCompaction = 0` 和 `responsesAbortableRetries = 1` 可进一步
核验超时不改历史、重试等待可取消。现有内存回归直接执行生产代理和配置函数，
不创建测试 profile 或额外报告；它们不等同于付费长上下文压测或安装包发布。
`responsesCapabilityDowngrade = 0` 可核验未知参数不会触发静默能力降级。
`responsesUpstreamWebSocket = 1` 表示支持新传输；审计的 `upstreamTransport`、
`upstreamHandshakeHttpStatus` 和 `upstreamTransportFallback` 才说明该请求
实际走了什么路径。能力标记不能代替真实请求或发布准入证据。

源码上传使用正常 Git 流程：

```powershell
git status
git add .
node tools/check-source-publication.mjs
git commit -m "Describe the source change"
git push origin main
```

`.gitignore` 排除运行时、profile、凭据、会话、构建目录和历史备份。
提交前检查器拒绝凭据形状、本机用户绝对路径、编译产物及异常大文件；其输出不会回显命中的凭据。
不要使用 `git add -f` 绕过这些边界。GitHub 凭据由用户的 Git/GitHub CLI 管理，不嵌入源码。

## 原生核心

固定上游提交在 `CODEX-SOURCE-REVISION`；补丁顺序和预期结果树在 `NATIVE_PATCH_CHAIN.json`。
`patches/` 包含全部有序补丁；上游 Codex 保持在其官方仓库，避免重复上传整个历史。

```powershell
git clone --filter=blob:none --no-checkout https://github.com/openai/codex.git codex-source
$revision = node tools/read-source-revision.mjs
git -C codex-source fetch --depth 1 origin $revision
git -C codex-source checkout --detach $revision
node tools/apply-native-patches.mjs codex-source
```

应用脚本验证固定提交、干净工作树、补丁顺序及最终树指纹。
修改原生补丁必须更新补丁链，并重新编译和验证匹配架构及原生 companion 文件。
不能沿用旧 EXE，仅修改源码清单就宣称完成发布。

## 构建与验收

Windows 需要匹配架构的 Visual Studio C++ 工具、Windows SDK、C# 编译器、Rust 和固定版本 Node。
跨平台构建模板位于 `ci/build-platform-packages.yml`，保存为源码而未自动启用。
启用 GitHub Actions 前需审核平台资源、runner 与 workflow 权限，不会因为这次源码上传自动进行长时间构建。

功能开发、修复和重构默认完成源码修改与目标平台的本机验证；正式打包、安装器验收和发布仅在用户明确要求或任务范围已约定时执行。
Mac 本机开发使用 Node/TypeScript 与 `tools/Invoke-HeavyTask.sh`，无需 `pwsh`、Windows 构建工具、发行清单或六平台发包环境。
`npm run typecheck`、`build`、`test:diy`（或 `node tools/typescript-task.mjs` 对应命令）自动选择当前平台的调度器。

Desktop 小队界面使用新版原生分屏 Squad Studio 与内嵌里程碑卡。旧 MyCodex 抽屉、
旧面板、`⌘⇧M` 快捷键及其页面注入与通用 DIY 请求通道已删除。
侧栏状态徽标和子会话返回主会话导航共享侧栏已有的小队快照，不再挂载抽屉、挤压主界面或单独请求抽屉状态。
已有配置中的 `spine.ui.rightOffset` 仅保留读取兼容性，不会恢复旧界面；后端 MCP、Studio 与卡片接口保留。

重构建或完整测试经当前平台的仓库调度器执行。macOS/Linux 示例：

```sh
bash tools/Invoke-HeavyTask.sh node --test tests/source-publication-test.mjs
```

Windows 示例：

```powershell
& .\tools\Invoke-HeavyTask.ps1 'node --test .\tests\source-publication-test.mjs'
```

已有完整、冻结的离线 stage 才能运行 `tools/team-release/package-setup.mjs`。
安装器源码在同目录：ARM64/X64 原生 bootstrap、PowerShell 安全解压安装、ZIP 组装与逐资源验证。
完整固定资源 stage 还需自行合法取得第三方资源，生成并验证 `release.json` 与 `release-files.json`。
源码库不会偷偷读取维护者的 profile 来补全缺失二进制，也不承诺仅 `git clone` 即可生成完整离线包。

`package-setup.mjs` 使用 `--stage`、`--stub`、`--zip` 参数选择已冻结的资源；
调用时必须传 `--reuse-inventory`，避免依赖历史的一次性 stage 准备脚本。
见 [安装器源码说明](../tools/team-release/README.md)。

功能修改需要相关自动回归与目标平台的 CLI/GUI 交互验证。
正式发行还需匹配平台的安装器及真实运行验收；Windows EXE 的完整安装验证在 Windows release runner 上执行。
`tools/Publish-Release.ps1` 通过该 runner 的 `tools/Invoke-HeavyTask.ps1` 调用，不作为 Mac 本机开发的前置步骤。
模拟登录测试不能替代真实账户授权、付费推理或企业连接验证。
本机开发、源码和文档整理不自动重编已验证的安装器、不增加版本号，也不重启当前客户端。

## 当前发布与清理

当前 Release 只保留 ARM64 EXE、X64 EXE 和 `SHA256SUMS.txt`。
使用说明、开发说明与验收记录统一放在仓库，而非堆积为附件。
GitHub 自动源码归档是源码，不含完整离线运行时。

清理只移除确认归属的构建 stage、重复源码快照、测试日志和失效传输辅助文件。
保护当前源码与 Git 历史、最新安装包、本机开发版、当前 Release 和所有登录/聊天数据。
含凭据的旧测试数据不能作为“垃圾”自动删除或上传；必要时由用户另行决定。
历史跨平台便携版资料仅作参考，不代表当前 Windows Release 的入口及安装策略。

## Mac 本机 TypeScript 与 DIY 组件

网关、引擎适配器及 4 个会话 UI 模块现在以 `.mts` 为源码；构建生成原路径的 `.mjs`，运行时不需要 TS 编译器。开发安装、`typecheck` / `build` / `watch` / `test:diy` 命令、组件示例和陈旧产物保护见 [ADR 0008](architecture/0008-typescript-diy.zh-CN.md)。这些命令复用既有 heavy-task 调度器，不会自动重启当前客户端或触发六平台发行。
