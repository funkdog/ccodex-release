# Claude Code CLI：自有 API key 接入与体验边界

2026-11-10。本轮补齐现有 `claude-code` 适配器的个人 API key 路径，复用原有网关、模型目录、会话存储与审批偏好；没有另写模型请求或工具循环。新建条目默认使用官方 Agent SDK 配套的 Claude Code，当前本机验证的 SDK 为 `0.3.312`，不替换全局 CLI。已有明确的 SDK 路径、`executable` 或私有 profile 会保留，账户检查使用相同配置；自定义 CLI 版本的组合需要另行验证。

## 配置入口

源码维护者先执行 `node tools/configure-claude.mjs prepare --config <本机配置> --instance <实例> --sdk-path <官方 SDK 的 sdk.mjs> --initial-approval auto`。这只准备实例目录中的 `configure-claude` 启动器，不输入密钥、不修改客户端引擎列表、不启动模型。

用户在自己的终端运行准备好的启动器：

```sh
"<实例目录>/configure-claude"
"<实例目录>/configure-claude" status
"<实例目录>/configure-claude" check
```

第一条通过本机隐藏输入收取完整 key，不经过聊天、命令参数或报告。`status` 只显示是否已配置及非密钥设置。`check` 会用该 key 发起一次最小真实推理，消耗 API 额度；它使用临时 profile，禁用工具，不读取当前项目。检查完成前不能将“已配置”或“模型菜单可见”说成账户已接通。

可选参数为 `--base-url <HTTPS 地址>` 和 `--model <明确的模型 ID>`。地址必须兼容 Anthropic Messages API；不自动转换 OpenAI 协议。凭据型 URL、查询参数和片段被拒绝；非 HTTPS 仅允许本地回环测试。轮换 key 时保留已有地址和模型，不因省略参数把 key 改送到官方默认地址。

密钥及服务配置原子保存在独立 profile 的 `credentials.json`，目录 `0700`、文件 `0600`，拒绝链接文件和不安全权限。这是本机私有文件存储，不宣称系统钥匙串或静态加密。公开实例配置只含 `cliHome`、`sdkPath` 和可选的首次审批模式，没有密钥。不要把 profile、第三方 SDK 或 CLI 二进制加入源码仓库。

首次配置成功后新增 `claude` 引擎，保留原默认引擎、其他引擎和会话。引擎拓扑改变需要在当前任务结束后正常退出并从 MyCodex 重开客户端；配置工具不会强制退出进程。已有 Claude profile 仅轮换 key 时，下一次 Claude 请求读取新值，不要求重启。首次审批模式可明确配置为 `auto`，此后用户保存的审批偏好优先。

## 必要接线及当前状态

| 链路 | 本轮状态 | 仍需的验收或适配 |
| --- | --- | --- |
| API key、可选地址、显式模型 | 已有隐藏输入、私有存储、状态与账户检查入口 | 尚无用户 key，未完成真实账户授权、额度及推理验收 |
| 认证来源与配置优先级 | 清除混用的 OAuth/云提供方变量，以私有临时 CLI 设置文件绑定 key 与地址；不把 key 放在 `--settings` 参数 JSON 中 | 真实组织受管配置仍须在目标环境验证 |
| 模型与推理强度 | 读取 Claude Code 原生目录及支持的 effort；优先使用解析后的规范模型 ID并去重；显式自定义模型标为用户配置 | 原生目录不证明 API 账户有模型权限；自定义端点需要真实推理 |
| 审批与提问 | 支持逐次确认、自动批准、拒绝及新会话偏好；保留业务提问与规则强制人工审批 | 当前客户端真实控件需宿主界面兼容验收 |
| 会话和工具 | 流式正文、工具开始/结果、取消、同 ID 冷恢复及切模型保留历史已通过真实 CLI 配合本地协议服务验证 | 还需用户实际服务的长响应、断流和额度错误验证 |
| 图片、其他附件 | 未向目录宣告图片输入支持，避免按钮存在却误报能力 | 需要原生消息块映射、尺寸限制及实际视觉模型验收 |
| 分叉、删除、上下文与用量 | 继续遵循现有网关的显式能力边界 | Claude 原生分叉边界、物理会话删除、上下文压缩及费用展示尚未接齐 |
| 升级与界面 | 复用已有版本检查、独立 SDK 路径、主进程创建和侧栏路由 | SDK/CLI 未来升级需重跑契约测试；当前 Desktop 安装文件指纹与已验证界面不一致，未绕过保护 |

## 本轮发现的兼容边界

1. 在真实 SDK 中，测试 key 也能读取原生模型目录。因此目录发现不等于认证或付费推理成功。
2. 项目 `.claude/settings.json` 的 `env` 可以覆盖启动环境中的认证值。仅注入环境变量不足以绑定用户选择的账户。本轮增加只含认证变量的私有 CLI 设置覆盖层，保留项目权限、hooks 和其他设置；覆盖文件在结束或取消时清理。
3. 本机 SDK 运行时通过 `decisionReasonType: rule` / `serverPolicyAskOnly` 表达强制询问，而类型文档还包含 `matchedAskRule`。适配器兼容这些已核查的形状，不用自动批准覆盖明确规则。

## 验证与交付限制

相关测试使用隔离 profile 和非真实 key。真实 Claude Code CLI 指向本地 Anthropic 协议服务，覆盖个人 key 不被项目 key 替换、工具执行、effort 传递、规范模型切换、原 ID 冷恢复、规则强制审批、取消及临时认证文件清理。这些检查证明接线行为，不能代替用户 API 账户验收。

本机仅准备了配置入口，未取得 key，尚未将 Claude 引擎写入正在使用的实例。现有客户端、其他登录和会话保留。发行入口仍缺少 PowerShell、历史 `dist` 产物与发布准入证据；没有发布新安装器。详细结果见 [验证记录](evidence/2026-11-10-claude-api.json)。

随后用户已在本机配置 key，期望配置中已登记 Claude，引擎尚未加载到原运行网关。真实联调发现当前有效地址仍为官方 `https://api.anthropic.com`，其模型接口返回 `401 authentication_error: invalid x-api-key`；未发现包裹引号或环境变量赋值文本误粘贴，也未找到与此 key 匹配的既有用户端点。此结果只证明该 key 未被当前官方端点接受，不能推断它在其他服务商处无效。继续联调需要明确该 key 对应的服务 Base URL，或由用户在本机更换有效官方 key，不在聊天中索取 key。

本轮同时修正账户检查和适配器丢弃原生错误正文的问题：保留可操作的认证详情，并遮掉已知密钥的原文、URI 编码及 JSON 转义形式；隐藏输入前会显示服务地址。17 项相关回归通过，完整门禁 334 项中 328 通过、6 项为此前已复现失败。现有活跃任务未中断，未重启客户端。见[真实认证检查记录](evidence/2026-11-10-claude-real-auth.json)。

## 用户服务端点联调与当前窗口加载

用户明确提供对应 HTTPS 服务地址后，保留原 key 并更新私有 profile。该服务的模型接口返回 200，Claude Code 最小真实推理检查通过。模型发现现在优先读取服务的只读 `/v1/models` 目录，使用 SDK 原生目录补充已知型号的 effort 能力；缺少能力声明的型号使用 CLI 默认值。服务不实现模型接口时保留原生目录，认证失败则明确报错，不用内置别名伪装成认证成功。

真实账户在隔离 profile 中经同一 AppServerRouter 和官方 native app-server 协议完成：14 个服务模型进入客户端目录、自动批准模式下实际执行 `Bash pwd`、重建网关和 CLI 进程后保留原生会话 ID 与上下文。审批弹窗为 0，原生 OpenAI 推理提交为 0；没有使用原用户项目做测试，也没有将临时测试聊天加入真实侧栏。

本机这次以显式的、受控的“只追加 CLI 引擎”方式加载 Claude，无需退出客户端。仅当旧引擎全部配置、默认引擎、工作台、原生 CLI 和 IPC 路由都不变时，才在网关空闲后保留旧 token 与传输 generation；新增 `configGeneration` 记录新的配置摘要。旧前端可以重连，既有会话文件逐字节保持不变。修改或删除旧引擎、更换默认引擎或工作台、新增原生 provider 均不走此路径；普通启动及冷启动仍遵循原有保护和凭据轮换规则。

当前运行网关已包含 Claude，14 个模型的默认审批均为 `auto`，原客户端进程保留。后台目录和真实 CLI 链路已经验收；当前宿主原窗口菜单点击仍未自动化验收，界面指纹保护没有被放宽。完整门禁 336 项中 330 通过，6 项为此前已复现失败；未发布新安装包。见[服务端点联调与加载记录](evidence/2026-11-10-claude-provider-live.json)。

参考：[官方 Agent SDK 概览](https://code.claude.com/docs/en/agent-sdk/overview)、[TypeScript 参考](https://code.claude.com/docs/en/agent-sdk/typescript)、[权限处理](https://code.claude.com/docs/en/agent-sdk/permissions)、[Claude Code 设置优先级](https://code.claude.com/docs/en/settings)。
