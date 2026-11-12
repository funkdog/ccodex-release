# 宿主 RPC 路径的第三方草稿模型设置

2026-11-02。状态：源码、协议集成及实际路由入口的隔离验证通过；协调重启后，原窗口模型设置也已确认成功。此前页面侧验证通过不能代表该问题已解决。

## 真实失败与所有者

用户在第二次重启后仍报告“无法更新模型配置”。当前应用为 26.1027.51404，PID 54670；页面 helper 54734 存活，且已回报会话控件接入，三个引擎配置仍在。上次“等待懒初始化”的修复消除了一个页面启动缺口，不能解释或解决这次已接入后仍失败的设置路径。

原应用日志确认两次失败请求分别为 `mycodex/antigravity/gemini-4-argon` 的 high 和 medium，profile 均为 null。`config/batchWrite` 返回 -32602，错误为 `Third-party model preferences cannot be written into native Codex configuration`。

静态核对原应用的 `renderer-app-server-managers-8103218e001d.js`：渲染器从 `appServerManagers` 服务获得 RPC client，`forHost` 返回该 client；设置调用经 `Jh(...).setDefaultModelConfig(...)` 到宿主 manager，再发送 `config/batchWrite`。因此，渲染器里对 `Fmn.prototype` 的挂钩不是这条真实路径的必经点。两轮仅围绕页面挂钩的测试和修复没有覆盖实际执行边界；本次把兼容行为放到本地 app-server router。

## 最小协议兼容

只接管原生默认模型构造器的明确请求形状：

- `config/batchWrite`，且参数恰为 edits、filePath、expectedVersion、reloadUserConfig；filePath / expectedVersion 为 null，reloadUserConfig 为 true。
- 恰好两个 upsert edit，分别为 model 和同一前缀的 model_reasoning_effort。支持根设置和简单命名 profile；其他路径不猜测。
- 模型为 MyCodex 第三方模型，且模型与所选推理档位均经过真实目录验证。原生 Provider 直接读取自身目录，不依赖 CLI 网关来验证它的模型。

这些请求返回原生 UI 已支持的 `okOverridden`。UI 原有分支将选择保留在当前窗口，并把显式模型/推理带给后续聊天创建；router 不保存全局默认模型，不制造线程归属。

返回的文件路径和版本来自只读 `config/read` 的真实 user layer，版本保持不变，不伪造文件或修订号。overriddenMetadata 明确说明原生配置没有写入，并保留实际原生有效值。该响应是窗口内覆盖确认，不是持久化成功声明。

混合批量修改、指定文件、版本约束、未知额外字段、非法路径、未知模型和不支持的推理仍明确拒绝；不会把一批设置拆开部分执行。普通原生模型配置仍按原流程透传。请求形状不匹配时，错误中仅附字段名、edit 数量和布尔标志，不记录配置值、消息或凭据。没有放宽工具权限或审批策略。

## 验证

新增回归先复现实际同款 -32602；修复后验证根设置/profile 设置、原生配置不变、原生元数据真实性，以及后续显式模型/推理/审批的正确路由。失败边界覆盖混合写、持久化目标、未知形状/模型/档位、重复 edit 和缺失原生配置元数据。

实际安装的原生 CLI 0.166.0-alpha.5.1 加隔离 profile / 本地 Responses 模型桩，在完全不安装 renderer 挂钩的条件下确认第三方草稿设置、原生默认值和文件内容不变；后续原有图像、模型切换、冷恢复与分支等检查继续通过。原生 schema 的 ConfigWriteResponse 必填字段及 okOverridden 枚举也已核对。

通过正式启动 shim 新建隔离前端，连接当前网关的只读模型目录，重放日志中 Argon/high 与 Argon/medium 的设置形状：两者均在实际广告档位内，返回 okOverridden；真实原生路径指向隔离 profile，配置内容及默认模型保持，无模型推理或原生窗口操作，临时数据已清理。

完整回归、类型、构建、模块和源码检查见 [验证记录](evidence/2026-11-02-host-rpc-draft-settings.json)。初次编译的联合类型错误及定向验证暴露的 Provider 目录依赖已修正；前者保留旧产物，后者通过直接 Provider 目录读取解决，没有要求 Provider 依赖 CLI 网关。

## 加载与未完成验收

当前客户端、前端、网关和 helper 均未停止或替换，工作聊天未修改。原生配置及权限未改；VERSION、native core 和共享开发文档保持，没有提交或发布。

router 属于 app-server 前端的已加载模块，页面 helper 重载不能替换它。MyCodex 的只读入口检查会提示当前窗口仍运行旧代码。用户在合适时退出当前 ChatGPT，再点击原 MyCodex 图标；入口会按已有机制等待旧网关空闲退役并准备新版本，可能需要约一分钟。没有为了提前准备而覆盖运行中网关配置或中断任务。

重启后先只在新建页选择 Antigravity 并切换 high / medium，检查原生日志的 config/batchWrite 是否成功以及原生窗口是否保留选择，再做发送验收。Argon 的账户额度与设置兼容是独立问题，本轮没有消耗其模型额度。Computer Use 禁止自动操作 com.openai.codex，原窗口点选需要用户完成；未使用其他通道绕过这个限制。提示体验优化仍等待当前兼容验收。

## 重启后设置验收

用户于本日 12:32 通过原 MyCodex 入口重新加载。应用 PID 68483、网关 68440、页面 helper 68542，后端就绪。原应用日志在 12:34:59 记录 Argon/high 设置的 `config/batchWrite` 成功，errorCode 为 null。随后用户在原窗口完成“高 → 中 → 高”点选，并明确反馈“不再报错，选择能保留”。这完成本次模型配置错误的实际界面验收，不扩大为所有会话能力或 Argon 额度的验收。

后续已按既定顺序实施独立的原生状态提示，见 [ADR 0023](0023-native-compatibility-status.zh-CN.md)。当前窗口继续运行，未为加载提示监测而再次重启。
