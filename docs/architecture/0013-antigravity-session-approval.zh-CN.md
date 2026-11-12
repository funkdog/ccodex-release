# Antigravity 会话工具审批

2026-10-30，原窗口模型列表恢复后，用户询问为什么 Gemini 只有逐次授权。截图中的引擎为 `Antigravity（Google 订阅）`。根因是本地 `antigravity-acp` 适配器仅发布 `approvalModes: [ask, deny]`，普通权限请求始终进入人工 `approveOnce`；不是模型接口只支持这两种策略。

原生 Codex 的“完全访问”与外部 CLI 工具审批分属不同执行器。现有接口固定 Antigravity 的 session mode 为 default，使用 runtime 提供的请求选项回答权限。ACP v1 定义 `allow_once` 只授权本次操作，`allow_always` 会记住授权；业务交互不能因工具自动策略而代答。参考 [ACP v1 工具授权](https://agentclientprotocol.com/protocol/v1/tool-calls#requesting-permission)。

## 行为

复用现有会话策略存储、控件和实时读取接口，新增 `auto`，菜单因此提供“逐次确认 / 自动批准 / 拒绝授权”。不新增全局开关或独立组件。

- ask：每次普通工具授权询问用户。
- auto：自动选择该次请求提供的 allow_once，不选择 allow_always；runtime 仍在 default mode，不写永久白名单。
- deny：取消普通工具权限请求。

`interaction_*` 业务问题在所有模式下仍需用户作答，不能把选项默认为“同意”。请求被取消、只有永久授权选项、optionId 缺失/重复时不批准。每次工具请求读取最新的会话策略，因此切回 ask / deny 对后续请求生效。原生 Codex 权限策略和其他引擎保持各自所有权。

没有把既有会话默认改成 auto。仅扩展适配器的可选能力；需要用户显式选择。

## 验证及加载状态

新增回归先在旧实现上失败，确认缺少 auto 能力、auto 仍询问。修复后 53 项相关测试通过；覆盖真实 ACP fixture 子进程的连续单次批准、业务提问人工处理、实时策略/取消/异常选项，以及从网关设置 auto、执行、完整关闭并重建隔离网关、恢复同一 session 和 auto、切回 ask 再执行。

为让冷恢复测试正确模拟多会话 runtime，fixture 的持久记录从一个 session 改为按 ID 存储多个 session；模型发现用的临时 session 不得覆盖工作 session。生产 runtime 和账户文件未修改。

严格构建通过，159 个模块 / 363 个相对导入检查通过。本次没有付费模型调用，没有把任何真实会话改为自动批准；原窗口、网关仍保持活跃。当前共享网关在本次源码修改前加载，仍只提供 ask / deny。auto 源码已编译，随下次协调退出并从 MyCodex 正常启动加载，真实 Antigravity 自动批准仍需原窗口验收。没有通过仅修改页面菜单来伪装后端支持。

这部分更新 [ADR 0007](0007-antigravity-subscription.zh-CN.md) 当时“仅逐次确认/拒绝”的功能边界，不改变其历史验收记录。未修改 VERSION、native core 或官方客户端，未提交、推送或发布。
