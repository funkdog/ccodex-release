# ADR 0006：Google 账号 Gemini 试接与原生 Codex 桥接

后续状态：用户已明确没有独立 API key，选择先接 Antigravity 订阅 Agent。官方运行时已完成真实调用、图片、工具审批及冷恢复验证，本机配置已追加，尚待协调重开后的原窗口验收，见 [ADR 0007](0007-antigravity-subscription.zh-CN.md)。下文保留旧入口拒绝与未启用实验的原始范围。

2026-10-29，Mac 本机开发。用户要求接入自己的 Google 账号，并同时尝试 Gemini CLI Agent 与原生 Codex Agent 调用 Gemini。此账号与 Copilot 的 Gemini 目录、额度分开。

**当前状态：Google OAuth 已成功；真实模型接入未完成。** 用户已完成浏览器授权并明确反馈完成。固定官方 `@google/gemini-cli` / `@google/gemini-cli-core` `0.66.0` 在授权后的 Code Assist 初始化阶段返回：

> This client is no longer supported for Gemini Code Assist for individuals.

服务要求迁移到 Antigravity。没有取得可用模型目录，没有执行真实 Gemini 推理。此前把 Gemini CLI 个人账号登录推荐为当前可用路径的判断已被服务结果和官方公告纠正。

## 官方接口边界

- [Google 官方停用公告](https://github.com/google-gemini/gemini-cli/discussions/28017)确认：2026-06-18 起，Google AI Pro、Ultra 和免费个人账号不再由 Gemini CLI 提供服务；企业 Code Assist 与 API key 路径不受该次停用影响。
- [Antigravity 登录文档](https://antigravity.google/docs/install)提供个人 Google 账号登录；[迁移文档](https://antigravity.google/docs/cli/gcli-migration/)描述官方替代入口。不能据此把 Antigravity Agent 说成纯模型 API。
- [Antigravity SDK 文档](https://antigravity.google/docs/sdk/overview)的程序化接入使用 Gemini API key 或 Google Cloud / Vertex 身份。当前未核实到可把个人订阅直接用于原生 Codex 纯模型调用的官方接口。独立 Gemini API key 与个人 Google AI 订阅不是同一额度或计费路径。

接续需要用户确认：有独立 Gemini API key 时，优先完成原生 Codex 的真实模型直连；没有时，可改接官方 Antigravity Agent。尚未替用户选择额外计费方式，也没有把 CLI Agent 串联调用冒充原生 Codex 直连。

## 已完成但未启用的源码实验

沿用现有 `bridge/`、`gateway/`，不改 native core，不新增独立管理服务或数据库。

| 路径 | 已实现的隔离行为 | 真实缺口 |
|---|---|---|
| `gemini-cli` | 官方 ACP 的目录、文本/图片、session ID、冷恢复、逐次批准/拒绝和取消；加载时不把历史重播为新回复 | 所选个人账号的旧官方入口已停用；不能宣称可用 |
| `codex-gemini` | 原生 Codex 线程、沙箱/权限和历史；loopback Responses 适配 Google 内容/工具接口，持久化不透明工具签名 | Google 个人账号的纯模型入口被拒绝，API key 分支尚未实现或配置 |

`gateway/google-model-worker.mjs` 仅调用官方 CLI Core 的 content generator，没有运行 GeminiClient 的 Agent 循环、注册/执行 Gemini 工具或调用 ACP session/prompt。它使用独立私有登录目录；后台目录刷新不弹登录，也不继承 API key 去改变身份或计费。

原生 provider 的 HTTP 端口归现有共享网关进程管理，仅接受私有能力认证的请求，没有浏览器 CORS 或管理界面。provider 请求计入网关活跃状态，客户端断开传递取消。模型切换不允许跨原生 provider 或 CLI 线程；模型/provider 偏好不写全局 Codex 配置。

Google 的函数签名在向原生客户端公布工具调用前写入私有文件；冷恢复缺失或模型不匹配时明确失败。原生图片只接收有效本地内嵌图片，不下载远程图片；推理手动覆盖、opaque response 引用和远程 compaction 当前明确拒绝。

## 证据与当前现场

- 78 项定向测试通过，未跳过；覆盖现有 Copilot、路由、启动与配置，以及新增 Google 两条实验路径。不是全仓测试或发行验证。
- 固定本机原生 Codex 实际启动于临时 HOME/CODEX_HOME，连接确定性 Google 模型桩，传递图片、执行 Codex 自己的 `exec_command` 写入临时工作区，再完整重建 native 与 provider，恢复同一历史和工具签名后完成下一轮。上游是模型桩，不是 Google 账号实测。
- ACP 子进程 fixture 验证图片、身份恢复、历史重播隔离、只批准一次、拒绝及取消；不冒充真实 Gemini CLI 调用。
- 模块检查通过：146 个 ESM、309 个相对 import。探针进程已退出，所拥有的测试临时目录均清理。
- 当前 ChatGPT 生命周期保留，实例仍只配置 `copilot` 与 `codex-copilot`；没有启用实验 Google 引擎，没有热换网关/UI helper 或重启客户端。旧 Copilot 会话和用户既有 `.gemini` 文件未迁移或改写。
- Google 登录凭据仅保存在本机私有目录，不进入仓库。官方依赖在本机缓存，不复制到源码。`VERSION` 保持 `1.2.36`，没有运行 PowerShell、Windows runner、六平台构建或发布新包。

结构化范围见[试接记录](evidence/2026-10-29-google-account-gemini.json)。此项仍待可用账号接口及原窗口验收，不将 OAuth 成功、模型桩通过或未启用的源码称为接入完成。
