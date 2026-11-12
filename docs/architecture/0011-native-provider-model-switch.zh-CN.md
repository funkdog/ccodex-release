# 原窗口模型切换验收与模型标识往返

2026-10-30，用户反馈原“测试”会话仍显示模型不可用，随后反馈模型选项存在但选择后似乎未切换。该会话 ID 为 `01a18752-ad9d-7582-b6ea-75aad02dcfeb`，provider 为 `mycodex-copilot`。

## 实际失败与恢复

只读检查确认，失败轮次实际发送 `gpt-6-astra`，本机 Copilot API 目录没有这个 ID，bridge 因而返回 `model_not_found`。此前完成的轮次使用 `gpt-6.1-sol`。不能根据这个差异断言用户手动选择或客户端默认值覆盖中的哪一种导致了 Astra；增加不同全局默认模型的原生冷恢复测试后，单独重开/恢复仍能保持原 provider 模型。

09:29 的实际记录确认，用户后续选择 Sol 后，同一会话以 `gpt-6.1-sol` 访问 Copilot API，HTTP 200、一次尝试完成，回复“收到：MYCODEX_OK”。用户随后明确确认“回复正常，底部也显示 Sol”，并提供原窗口截图：显示切换到 `codex-copilot · GPT-6.1 Sol`，后续“测试”再次得到正常回复。至此原窗口已可继续工作，无需为了当前恢复再次重启。

## 另外发现并修复的协议遗漏

固定 native core 的 `thread/settings/update` 返回空对象，以 `thread/settings/updated` 通知回传完整设置。原适配器只转换顶层 `model` 和 thread/list 记录，漏掉通知中的 `threadSettings.model`、其 `collaborationMode.settings.model` 以及恢复响应的协作模式模型。目录采用 `mycodex/codex-copilot/...`，这些设置却仍返回原 API ID，模型回显和后续请求无法稳定往返。

`gateway/router.mts` 现在针对已确认的 native provider 同步转换这些字段，记录设置通知中的实际模型，保留权限、推理、开发者指令和其他字段，且不重复添加前缀。对于原生客户端可能同时携带的“顶层原 ID + 协作模式限定 ID”，还原为同一 provider 的原 ID 后再转交 native core；不同 native provider 的混合参数拒绝处理。普通 OpenAI/CLI 线程仍保留原路由。

该协议遗漏在隔离测试中独立复现，不能据此宣称已经证明它导致了最初 Astra 的选择。没有添加模型别名替换或将不可用 Astra 静默降级到 Sol。

## 验证与部署边界

- 修复前两项回归因原始模型 ID 泄漏到界面状态而失败，修复后 32 项定向测试通过，无跳过。
- 原生测试在临时 HOME/CODEX_HOME、假上游及固定安装 CLI 下，创建模型 A、执行、冷恢复、切换至 B、使用真实设置通知继续发送，再冷恢复确认 B；不修改真实会话或调用付费模型。
- 严格 TypeScript 构建通过；159 个 ESM、362 个相对依赖检查通过。
- 本轮没有直接操控客户端界面、发送或重放用户会话消息，没有重启当前客户端或原生 app-server。实际成功请求来自用户操作，读取会话和请求审计作为证据。
- 源码协议修复已编译，但当前长期运行的 routed-stdio 仍为本次启动加载的代码。修复随下次正常 MyCodex 启动加载；不能把用户已经完成的当前窗口恢复归因于尚未加载的补丁。

未改 VERSION、native core、全局配置、登录凭据或共享工作区中的其他改动，未提交、推送或发布。摘要见 [模型切换验证](evidence/2026-10-30-native-provider-model-switch.json)。

## 后续推理设置错误（09:40）

用户继续调整原生模型/推理控件时出现“无法更新模型设置”。Desktop 日志在 09:40:16 记录 `thread/settings/update` 返回 `-32602`，正文为 `An existing native thread cannot switch CLI engines; start a new thread.`；原“测试”及另一条 native Copilot 会话均出现同类记录。这是本机路由拒绝，不是 Copilot 上游返回推理强度不支持。日志没有原始请求参数，因此不能把导致拒绝的具体模型字符串当作已知事实。

启动回执仍为 PID 77530、09:18 的源码代次；上轮模型标识补丁未加载到该长期运行的 frontend。此次补测真实 native CLI 的界面请求形状：选择 provider 模型 B 后，单独发送 `thread/settings/update`（包含限定模型、`effort: xhigh`、`multiAgentMode: explicitRequestOnly`），等待实际设置通知，验证下一轮上游请求和冷恢复都保留 B/xhigh。普通原生与 CLI 路由继续隔离；另外明确拒绝“CLI 限定模型 + native provider 协作模式”的混合请求，避免放宽引擎边界来绕过报错。

扩展后的 32 项定向回归、严格构建及模块检查通过。当前客户端、会话、profile 和已加载 frontend 未重启或替换；仍需用户按此前约定正常退出并从 MyCodex 重开，再完成原窗口推理调整验收。此次仅确认源码/隔离流程，不能宣称当前窗口报错已消失。见 [推理设置补测记录](evidence/2026-10-30-native-provider-effort-update.json)。
