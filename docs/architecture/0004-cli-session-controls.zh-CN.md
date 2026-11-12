# ADR 0004：CLI 推理、审批与输入栏控件

2026-10-29，本轮修复当前 Mac 中的 Copilot 推理强度、逐次审批和重复输入栏控件。仍在原 `bridge/`、`gateway/` 职责内实现，没有增加 UI 框架、数据库、HTTP 服务或新的常驻管理进程。

后续的 [Codex + Copilot 与图片接入](0005-codex-copilot-images.zh-CN.md) 保留本页已验收的 CLI 路径；原生 provider 会话使用 Codex 自己的工具、沙箱、推理与审批控件，不套用 CLI 审批策略。

## 行为

- 新建草稿保留一个紧凑引擎入口；已有原生 Codex 会话不显示额外控件。
- CLI 会话在原生模型按钮所在的底栏显示模型、推理强度和审批策略；临时隐藏该会话的原生模型按钮，卸载或切回原生后恢复其原始样式。移除原有大下拉框、重复引擎说明及常驻状态文字。
- 推理档位来自已登录 CLI 的 `supportedReasoningEfforts`。网关确定默认档位；优先目录默认值，其次 `medium`，最后目录第一项。不支持推理覆盖的引擎仅保留 `none`。不虚构 `ultra` 等档位，也不再把 Copilot 一律写成 `none`。
- 新建和已有 CLI 会话都能修改推理强度；下一条消息生效。实际传入 SDK 的 `createSession` / `resumeSession` 配置，已有 CLI session ID 保持不变。
- 审批策略为“逐次确认”“读取自动”“自动批准”“拒绝授权”。“读取自动”只自动批准 SDK 标记为 `read` 的请求，其余仍询问；“拒绝授权”拒绝权限请求，不等同于 OS 沙箱。“自动批准”自动处理工具权限请求，不代答模型提出的业务问题。
- 策略按会话持久化，运行中变更从下一次权限请求起生效；已弹出的审批仍需处理。组织管理策略要求人工审批时继续询问，不因本地自动模式削弱它。
- CLI 工具权限只读取本会话的 `cliApprovalMode`。Desktop 原生 `approvalPolicy`（包括普通发送时附带的 `never`）独立保存，不覆盖 CLI 控件，也不因切换 CLI 策略被重写。旧会话即使已保存 `approvalPolicy: never` 仍按原有 CLI 模式执行；缺失模式时默认逐次确认，无需手动来回切换审批。

## 模块职责

`gateway/engines/github-copilot.mjs` 负责把真实推理参数传入 SDK，并根据动态读取的会话审批策略回应权限请求。SDK 的模型目录和 `SessionConfigBase.reasoningEffort`、权限回调是本机核查依据；另对照了 [官方 SDK 更新记录](https://github.com/github/copilot-sdk/blob/main/CHANGELOG.md)。

`gateway/protocol.mjs` 负责目录转换、校验、按会话存储及 `thread/settings/update`。执行中的快照写入合并最新设置，避免保存回复或 CLI session ID 时覆盖用户刚修改的策略；当前轮推理强度使用提交时的快照。

`bridge/desktop-native-session.mjs` 负责草稿设置与明确归属的请求规范化。`desktop-cli-selector.mjs` 提供受限的设置业务函数；`desktop-gateway-ui.mjs` 的私有绑定增加 `updateSettings`，不开放任意 RPC。`desktop-native-composer.mjs` 只负责内存路由适配、底栏挂载、交互和样式。

## 本机升级和验证

仅在 CLI 网关空闲时更新网关，并保留同一配置下的私有连接能力，让现有 native stdio frontend 重连。冷启动默认仍轮换凭据；保留能力需要显式的 `preserveConnectionToken` 维护选项。没有重启 ChatGPT，也没有替换官方文件、profile 或用户会话。

- 47 项相关测试通过，覆盖策略自动/拒绝/读取分类、组织审批限制、创建和恢复时的参数、运行中策略更新、执行快照合并、重启持久化以及旧 frontend 凭据重连。
- 独立浏览器 fixture 18 项检查通过，覆盖紧凑底栏、现有线程设置保存、重新挂载恢复、原生按钮恢复、真实鼠标和键盘输入；不冒充原窗口自动化验收。见 [UI 报告](evidence/2026-10-29-cli-controls-ui.json)。
- 真实 Copilot `gpt-6-astra` 两轮通过：通过 CLI `session.model.getCurrent` 反查到创建时 `high`、恢复时 `low`；临时工作区 `apply_patch` 写入成功，1 次自动批准、0 次人工审批。探针另加精确文件保护，没有触发，原生推理入口观察计数为 0。第一次探针使用已移除的 create-file 工具名称而未触发工具，已改为当前 CLI 实际提供的 `apply_patch`；没有把该次失败当作审批成功。见 [真实 CLI 报告](evidence/2026-10-29-cli-controls-live.json)。
- 已热更新本机空闲网关与 UI helper，原 ChatGPT PID、CLI 会话 ID 和历史保留，入口检查为 `activate-existing`。见 [本机更新记录](evidence/2026-10-29-cli-controls-local-upgrade.json)。

用户已在原窗口确认紧凑布局正常，推理与审批设置可以选择并保持，并提供了 `Copilot · GPT-6.1 Sol / 推理 极高 / 自动批准` 的截图。该实际线程的网关记录独立核对为 `copilot/gpt-6.1-sol`、`xhigh`、`auto`。设置保存不等于旧审批失败操作已重试；当时线程已空闲，新策略下的后续工具执行需要用户在该线程继续工作。

这是本机源码热更新，不是新的多平台发行。`VERSION` 保持 `1.2.36`。Claude 等其他 CLI 的可配置推理及自动审批不在本轮通过范围内。

## 后续会话检查发现的历史接口问题

用原生 `read_thread` 检查用户指定的 CLI 会话时，初次读取报 `thread/items/list returned item for unexpected turn`。根因是网关返回了整个线程的条目，没有按请求中的 `turnId` 过滤，且没有应用原生分页方向。

对照本机固定 native CLI 生成的 JSON Schema，已补齐按轮过滤、turn 默认倒序、item 默认正序、显式方向、字符串续页和仅限指定轮次的排他 item anchor；`itemsView` 支持 `notLoaded`、`summary`、`full`。15 项相关协议/传输测试通过，并再次仅更新空闲网关，ChatGPT 未重启。相同原生 `read_thread` 请求重试后成功读取该会话两轮记录；没有发送或重放任何会话消息。

## 2026-11-10：原生审批字段误拒绝 CLI 工具

Desktop 首轮普通发送携带 `approvalPolicy: never` 后，网关曾将它优先解释成 CLI 拒绝授权，覆盖已保存的 `cliApprovalMode: ask`，造成 Antigravity 搜索与终端、Copilot 文件与终端工具在弹窗前被拒绝。修复删除了这两处原生字段的否决逻辑，并使 CLI 设置更新只修改 CLI 策略。旧会话无需切换控件即可沿用保存的模式，缺失模式时仍默认逐次确认。

63 项相关回归通过（约 1.8 秒），包含两种真实适配器的旧状态恢复、重复 `never` 信封、单次允许/拒绝、自动模式、显式拒绝、重启及 Copilot 组织审批限制。隔离 profile 的真实 Copilot `gpt-6.1-sol` 与 Antigravity `gemini-4-argon` 均在 `ask` + `never` 下完成 `pwd` 和联网搜索；探针只单次批准指定只读操作，临时 profile 已移除。

本机空闲网关已通过现有退休/重连接口加载修复，保留私有连接能力，未退出 ChatGPT。原会话仍保存 `ask` + `never`，历史和 CLI session ID 保留。首次原会话验收未完成：`send_message_to_thread` 返回 `Provide bounded text or image input`，CUA 不允许操作 Codex 自身界面，未绕过界面限制。

用户随后在原会话重试时出现一次工具调用前的 `Internal error`。原会话持久状态的隔离副本成功完成冷恢复、原模型/强度设置及一轮回复；该通用错误未取得底层原因，不能认定为审批冲突，也不能仅凭它要求丢弃历史。之后按用户原先授权，通过既有网关 IPC 在同一原会话完成受限续聊验收：`pwd` 与指定的 `search_web` 均真实执行成功，本轮状态为 `completed`、错误为 `null`。只对这两项检查给予单次许可，原 `ask` + `never`、CLI session ID、历史及 ChatGPT 进程保留，客户端没有重启。这验证了原会话能够继续；原生界面本身未做自动化验收，先前 `Internal error` 的具体根因仍未证实。

完整开发门禁为 320 项、314 通过、6 失败（约 13.6 秒）；修复前源码的隔离对照也复现全部失败：2 项当前宿主指纹不匹配，4 项 MCP 工具清单未包含已有 `show_work_card`。模块检查另通过 211 个模块、493 条相对导入。`Publish-Release.ps1` 的规定入口因本机缺少 `pwsh` 无法启动，且没有 `dist` 历史发行清单和发布准入文件。本次是已加载的本机源码修复，不是已验证的多平台发行；`VERSION` 保持 `1.2.36`。见[本次验证记录](evidence/2026-11-10-cli-approval-conflict.json)。

## 2026-11-10：新会话继承 CLI 审批偏好

新版宿主的主进程 RPC 创建不经过渲染层 `Manager.startConversation`；草稿中的 CLI 审批选择原先只保存在控制器内存，没有写到主进程能读取的默认值。网关新建逻辑同时硬编码回落到 `ask`，使已有会话的自动批准不能成为新会话偏好。当前适配文件尚未进入 Git 历史，不能仅凭现有源码确定是哪次提交引入了变化，或否定用户此前使用正常的经历。

网关现在将明确选择的审批模式按引擎 ID 和适配器保存在私有 `gateway/cli-approval-defaults.json`。更改会话审批控件会保存同引擎的新会话偏好；在空白草稿中选择模式则经专用 `gateway/approval/default/set` 写入，不再依赖渲染层创建钩子。模型目录返回实际默认值，草稿控件据此显示；选择原生 Codex 或原生 provider 不进入这套 CLI 默认值。

新建请求未明确指定模式时读取持久偏好；明确的创建参数可覆盖本会话，但不反向修改默认值。普通发送中的缓存模式不再修改已提交设置，修改现有会话仍通过专用设置接口。其他已有会话保留各自的拒绝、读取自动或逐次确认选择。适配器被替换或不支持保存的模式时回落到逐次确认，不从历史会话反推自动授权。

本机已在网关空闲后加载修复，保留原连接能力且未重启客户端；根据用户本轮明确要求，Copilot CLI 与 Antigravity 的新会话默认值均已保存为 `auto`。主进程创建路径的浏览器 fixture 覆盖了默认值展示和草稿选择持久化；原窗口草稿控件本身仍缺少当前安装文件指纹的验收，不能将 fixture 记为真实界面验收。完整开发门禁为 325 项、319 通过、6 项此前已复现的失败；模块检查通过 212 个模块和 495 条相对导入。发布入口仍受缺少 PowerShell、历史发行产物和准入证据阻塞，没有生成新安装器。详细结果见[验证记录](evidence/2026-11-10-cli-approval-defaults.json)。
