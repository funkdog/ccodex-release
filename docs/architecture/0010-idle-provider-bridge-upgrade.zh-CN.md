# Mac 启动：安全升级空闲的 Copilot API bridge

2026-10-30，本机启动修复。此前 [Desktop 版本兼容修复](0009-desktop-26.1023.51421.zh-CN.md) 解决了安装摘要与页面资源变化，但漏检了独立长期运行的 Copilot API bridge。用户从 MyCodex 启动时，`ensure.mjs` 因旧 bridge 的源码代次不同而拒绝；单独重开 ChatGPT 不会使该独立进程退出。

## 行为与边界

- `ensureBridge()` 默认行为不变：遇到旧代次仍拒绝替换。新增显式 `refreshIdle` / `--refresh-idle`，要求明确的 `CODEX_COPILOT_HOME` 和已支持的认证控制协议 1。
- MyCodex backend 在 `prepare` 启动阶段为配置中的 `codex-copilot` provider 使用该选项；`stage` 和只读检查不升级服务。复用现存网关时也要检查 API bridge，不能提前返回而跳过依赖。
- 升级复用已有 `control.mjs`，核对实例、端口运行记录和私有控制凭据。`expectedInstance` 绑定发现时的 PID、instanceId 和源码代次；目标变化后拒绝停止。服务端在拒绝新请求前，原子检查活跃请求、账号切换、目录刷新和其他后台任务。忙时返回错误，保留现有任务；没有强制终止或旧协议信号回退。
- 等待旧实例退出后，再由原 ensure 路径启动当前代码并核对代次。失败信息向启动器传递诊断正文，避免将完整 Node 命令和路径包在系统弹窗里。
- 不改变已有源码代次指纹范围，不新增服务或进程管理框架。升级策略仅用于明确配置的 provider bridge，不关闭或重启 ChatGPT，不改变原 profile 或默认 provider。

## 验证与本机处理

修复前回归已复现显式刷新仍被旧代次拦截、实例变化未被识别。修复后的 34 项相关测试全部通过，无跳过，包括：真实隔离 bridge 的忙时保留及空闲后替换、未启用刷新时仍拒绝替换、同代次复用、旧/未知控制协议拒绝、实例变化、认证与后台任务保护，以及固定 native core 的 provider 与历史恢复测试。严格 TypeScript 构建和 159 个 ESM / 362 个相对依赖检查通过。

本机旧 bridge PID 73079 已通过认证控制接口安全退出，新实例 PID 74333 代次匹配且账号已登录；GitHub 凭据文件摘要不变。没有调用真实模型推理。

已使用实际实例配置验证 backend 准备、网关启动与复用；通过实际 routed-stdio 以及原安装 CLI，在临时空 HOME/CODEX_HOME 中确认 `mycodex-copilot` 注册、默认 provider 保留、指定 Copilot provider 创建线程及元数据读取。原生空线程的 `includeTurns: true` 返回 core 的 `list_turns is not supported yet`，因此元数据探针改用不加载 turn 的读取；实际 turn 与冷恢复另由确定性 native 测试覆盖，不冒充真实模型续聊验收。

原有 CLI 会话文件、全局 `config.toml` 和当前 ChatGPT 生命周期均保持不变。当前窗口是普通启动的实例，用户此前选择稍后手动退出重开，该约定继续有效。需要用户用 ⌘Q 完全退出，再点击原有 MyCodex 图标，重新打开原会话，才算完成原窗口验收；不能把网关准备或隔离测试称为当前窗口已经恢复。

本轮没有修改 VERSION、native core 或其他会话的工作，没有运行 PowerShell、跨平台发行、提交或推送。验证摘要见 [本机证据](evidence/2026-10-30-idle-provider-bridge.json)。
