# ADR 0003：复用原生新建和会话侧栏

当前状态：原窗口的新建、引擎选择、发送、统一侧栏和完整重启后续聊已验收通过。后续推理、审批和紧凑控件的当前行为见 [ADR 0004](0004-cli-session-controls.zh-CN.md)；新增 Codex + Copilot、图片与 Gemini 目录接入见 [ADR 0005](0005-codex-copilot-images.zh-CN.md)，该增量已载入当前窗口，原窗口交互仍待验收。本文保留实施过程；早期“待验收”“固定逐次确认”等描述是历史状态。

2026-10-29 用户确认先完成原生新建、引擎选择、发送、统一侧栏及重启恢复；本轮不重启当前客户端。实现沿用原仓库 `bridge/` 与 `gateway/` 的职责，不创建平行 MyCodex 包、HTTP 管理服务或独立会话 UI 框架。

## 已实现的链路

1. 在已验证原生 Codex 输入区内挂载引擎选择器。选择只改变内存草稿，不发送 RPC 建线程，不修改原生默认模型配置。
2. 用户首次发送时，原生 `startConversation` 接收带显式 CLI model 的默认 collaboration envelope；原生流程继续负责目录、项目、新建、首轮发送及页面导航。
3. 所选 CLI 的创建期间，利用该版本已有的 `getThreadPrewarmPolicy=disabled` 生命周期接口，避免消费原生 Codex 的缓存预热线程。结束后恢复原策略；远程、自动化及侧聊创建保持原流程。
4. 原生分发层仅规范化明确携带当前 CLI 创建意图的 `thread/start`，以及已知归属的 CLI `turn/start` / `turn/addUserMessage` / `thread/resume`。恢复线程时以持久化归属为准，不使用新草稿的选择。
5. 现有路由器合并本地原生与 CLI 的 `thread/list`；网关接受原生项目 ID 的元数据更新，使会话能进入相同项目的筛选结果。原生云端/远程通道不由这一层替代。
6. 重启后从网关文件恢复线程、项目归属、历史和 CLI session ID；页面通过历史/响应恢复所用引擎。网关无法读取模型目录时仍可读取历史。

默认 helper 改为加载原生输入区适配器，停止默认挂载旧浮窗。旧选择器源码作为独立验证与恢复组件保留；本轮没有新增删除和置顶功能。

## 职责与依赖

| 模块 | 职责 |
|---|---|
| `bridge/desktop-native-session.mjs` | 无 DOM 的草稿意图、归属记录和请求规范化；可注入的原生 manager/bus 生命周期挂钩 |
| `bridge/desktop-native-composer.mjs` | 小型引擎组件，以及版本固定的原生模块、路由、编辑器定位适配；组件仅依赖注入服务 |
| `bridge/desktop-gateway-ui.mjs` | 复用既有进程/端口核验与 CDP，绑定仅允许读取模型/CLI 历史的私有业务通道；等待异步挂载结果 |
| `gateway/protocol.mjs` | 项目归属持久化、空 disabled-plugin 列表兼容及原生元数据通知；引擎运行不依赖页面 |
| `gateway/router.mjs` / `state.mjs` | 继续承担原生透传、列表合并、归属与原子文件持久化，无新增存储系统 |

引擎目录在当前页面适配器中缓存；输入区重建时复用结果，用户点击刷新才重读。页面轮询仅在路由/线程/模型状态改变时渲染，避免每次轮询重建正在操作的下拉框。

## 原生契约与保护

这不是官方的 UI 扩展 API。绑定当前已校验的 Desktop `26.1023.50603`、ASAR/CLI 摘要和两个已加载 renderer 模块：

- `app-shared-2864d2ff2296.js` 的 `eLt` 导出是原生消息总线；`dispatchMessage`、`subscribe` 为观察到的接口。
- `app-initial-b539f0af92f3.js` 的 `VUn` 导出是原生 manager 类，其 `startConversation`、`requestClient.getThreadPrewarmPolicy` 为本次使用的生命周期接口。
- 当前 preload 的 `codexWindowType` 为 `electron`，不能把日志中的窗口 appearance `primary` 当成其取值。
- 草稿仅在已识别的本地路由且可见原生 workspace 控件和单个 editor 存在时开放 CLI 选择，普通 ChatGPT 输入框不开放；已有本地线程显示固定引擎。
- 普通新建请求的 `threadSource` 可以是 `user`；创建请求的显式 model 来自 collaboration 设置，不依赖 `thread/start` 中必然存在 client message ID。

只在当前 renderer 内挂钩两个已核验的对象方法，并为实际参与创建的 request client 暂时禁用预热。不替换 `electronBridge`、全局 MessagePort/平台原型或客户端文件；卸载时只恢复仍由本组件拥有的方法。版本或模块契约未知时不安装。

CLI 明确使用自己的默认推理设置和逐次权限确认，不模拟 Codex OS 沙箱。当前适配只接受普通文本新会话；不支持的附件、协作模式或 Codex 设置会明确拒绝。非空禁用插件列表和 Daybreak 启用也不伪装成功。

## 本轮验证及尚未证明的部分

- 34 项相关测试分别通过，包括静态核对本机原生模块契约、原生 manager/message-bus 接缝、无持久化草稿、原生/远程/背景创建不受选项影响、项目列表、完整网关关闭重建后恢复同一 CLI session，以及卸载恢复。
- 独立浏览器 fixture 通过 12 项交互检查：内联挂载、选择、已有线程、原生新草稿/输入区重建、目录缓存、排除普通 ChatGPT、卸载、重新挂载恢复，以及生成后的异步脚本读取往返、幂等、卸载和无浏览器异常。生成脚本只将模块地址重定向到合成模块；没有加载厂商 renderer。见 [报告](evidence/2026-10-29-native-composer-ui.json)。
- 真实 Copilot `gpt-6-astra` 两轮通过；使用原始 native CLI 的临时 profile 创建真实项目后，确认项目筛选包含 CLI 线程。使用同一请求控制器验证首次发送与续聊，native peer 入口观察并拦截原生推理，实测为 0。见 [真实探针](evidence/2026-10-29-native-draft-copilot.json)。
- 模块解析检查：140 个 ESM、286 个相对 import。没有全仓测试或正式发行；VERSION 保持 `1.2.36`。

浏览器 fixture 不执行厂商 manager 实现；真实 CLI 探针也不运行原生 renderer。它们不能证明原窗口的所有回调、按钮位置、侧栏刷新和草稿恢复均已正确。尚需用户安排重启后，在原 ChatGPT 中完成原生新建、项目目录继承、发送、再打开，以及原生/云端会话和插件共存验收。工具不能直接观察当前客户端的界面，因此本轮没有用 CDP 做活体 UI 自动化。

本轮只读检查原运行实例；没有退出或重启 ChatGPT，也没有改用户的现有会话文件。现有 Dock MyCodex 会在下次允许的启动时自动准备这些源码，待旧网关退休后载入，无须重装启动入口。

## 2026-10-29 本机启动验收进展

用户随后授权重启原客户端。首次协调重启遇到 macOS 进程在 `ps` / `lsof` 两次观察之间退出的时序问题，恢复打开了普通客户端；修复后重新启动增强成功，入口检查返回 `activate-existing`，使用同一个官方应用和原 profile。进程检查仅把明确消失或 zombie 视为已退出，不把无法读取的存活进程放行；29 项进程、当前宿主和启动入口检查通过。

用户截图确认内联引擎控件出现，但反馈点击无法展开。独立网关读取成功返回 15 个 Copilot 模型；这是交互问题的证据，不能据此声称已定位全部界面原因。组件已增加本地事件边界和 `no-drag` 样式，保留浏览器默认行为，避免 Shadow DOM 事件被输入区当作外层 span 处理。加载中及目录错误现在持续显示。只重载拥有身份记录的 UI helper，应用和网关没有再次重启；helper 清理完成后显式退出，避免 CDP 关闭握手使其残留。

浏览器 fixture 改为真实点击和键盘输入，补测输入区焦点保留及 Enter 提交拦截，13 项检查通过。headless macOS Chrome 的平台下拉菜单无法通过箭头键驱动，因此关闭平台菜单后使用 select 的键盘文字匹配完成选择；这仍不能替代原窗口展开菜单的人工验收。另有 74 项相关会话、选择器及 CDP 检查通过，模块解析与依赖检查通过。

原窗口切换、首次发送、侧栏及再次重启后的恢复仍在联调，尚未宣布全部可用。当前模型目录无 Gemini；Claude Code 尚未登录。

### 原窗口发现的实际接入缺口

第一次下拉交互修复后，用户选择 Copilot 发送的“测试”会话实际仍是原生线程。网关没有对应记录，原生日志也证明创建和发送落在原生本地 app-server；没有把显示标识当作执行归属的证据。

静态检查确认当前 Desktop 使用 React Router 的内存路由，不能用 `window.location.pathname` 判断会话；首次发送时输入区也会暂时停用。适配器改为复用原仓库 `desktopPickerBinding` 的已提交 Fiber 解析器，只读取该输入区所在的路由上下文；保留 home → client draft 的选择，调用 manager 时不再要求输入区仍可编辑。已有线程在相同组件显示固定引擎。显式 CLI 选择但无法接入时会报错；普通原生、远程及背景创建继续原流程。

CLI 创建还设置 `skipAutoTitleGeneration`，并在该版本仅承担标题生成的 `onFirstTurnReady` 回调位置阻止原生标题推理，其余生命周期回调保留。会话标题来自首条消息预览，不为命名另发原生模型请求。对应测试覆盖保留 `onSettled` 和不调用标题回调。

用户随后确认新建 Copilot 成功，并提供了发送后仍显示 Copilot 的截图。网关与原生侧栏工具独立核对同一条 `MYCODEX_OK` 会话，真实 Copilot `gpt-6-astra` 完成两轮回复 `MYCODEX_OK`、`MYCODEX_RESUMED`，CLI session ID 已持久化；用户确认从原生侧栏重开并续聊成功。第一次误建的原生“测试”会话没有被迁移或重写。

再次完整退出并重启原 ChatGPT 及网关后，恢复检查确认同一 CLI session ID、两轮完成历史和列表项均保留，MyCodex 入口检查为 `activate-existing`。用户随后确认原侧栏能找回、历史和 Copilot 标识仍在，并在未提供答案的续聊中成功复述上一条 `MYCODEX_RESUMED`。本地持久化记录独立核对第三轮已完成、模型仍是 `copilot/gpt-6-astra`，CLI session ID 未变。本次原生新建、引擎选择、发送、统一侧栏和重启后找回及续聊验收通过。

最新独立浏览器 14 项检查通过，新增覆盖内存路由和临时不可编辑的首次发送；相关会话测试 5 项通过，模块检查为 140 个 ESM、288 个相对 import。记录见 [原窗口验收](evidence/2026-10-29-native-window-acceptance.json)。通过范围是当前固定版本原客户端中的 Copilot 普通文本会话；测试范围未扩展到其他 CLI、附件或项目迁移。
