# 新建页引擎选择与宿主 RPC 创建接通

日期：2026-11-02（Asia/Shanghai）。状态：源码、编译及隔离验证完成；当前工作窗口尚未加载本次修复，真实创建结果待用户验收。P3 未开始。

## 问题与证据边界

用户反馈选择非原生 CLI/模型后创建失败，界面回到 Codex Astra。当前官方宿主仍为 26.1027.51404 / 23880，精确 ASAR/CLI 合同没有放宽。工作客户端 PID 89188、网关 62175、helper 89252 均保留。

静态核对已签名安装包及 ADR 0022：当前宿主的新建和默认模型设置使用宿主 RPC client，不必经过 renderer 中原 Manager 的原型方法。旧 MyCodex 引擎选择器在新建页只修改自己的 controller，不能可靠修改这个实际创建入口的模型。原有模拟 Manager 的创建测试覆盖不到此路径。

新增独立 Chrome fixture 刻意让 renderer Manager 的 startConversation 抛错，模型创建只读取另一个宿主侧选择状态。旧运行产物选择 Copilot 后不会调用原生选择动作，等待该动作的检查超时；修复后这条检查通过。当前工作日志另有原生预热会话被消费的记录，但没有完整记录失败时的模型请求。因此能确认并修复这条可复现缺口，不能据此断言用户当次消息已被发送给原生模型，或网关接收 CLI 请求后又自动重试原生。

只读查询现有网关目录得到 Copilot CLI 14 项、Codex + Copilot 15 项、Antigravity 2 项，无目录警告；这不验证各服务商的推理额度。

## 选择状态的所有者

精确宿主合同为当前版本标记 host-rpc。宿主适配器使用已有的 committed-Fiber resolver，从原生模型入口读取原有 modelOptions / onSelectModel / reasoningEffort；新增字段及回调仍局限在宿主适配层，没有加入 DIY 组件的私有导出依赖。

MyCodex 新建页的引擎和推理选择现在调用原生窗口已有的 onSelectModel。原生动作负责更新窗口覆盖状态和清理预热会话，MyCodex 等待原生模型及推理回显后再确认自己的选择；原生菜单的选择也同步回 MyCodex 控件。已有 CLI 聊天继续使用既有 thread/settings/update，不改线程归属。

目录没有该模型、入口被禁用、原生拒绝、草稿导航变化和等待超时均明确失败，不自动重试、不代选原生模型。用户草稿不被写入或发送。退出组件恢复仍由它拥有的页面样式和方法。旧宿主保留原适配路径，没有增加泛用版本匹配。

本轮只改变模型及推理的草稿确认路径，没有把 CLI 审批策略写进原生 config，也未扩大执行权限。真实宿主首轮发送、审批策略和上下文仍须随原窗口验收，不将 fixture 的合成创建当作实际宿主 RPC 调用的验收。

## 内建 MCP 的禁用配置兼容

工作日志反复出现标题生成失败：`failed to load configuration: invalid transport in mcp_servers.mycodex`。安装包的元数据生成代码会将 MCP 表替换为 `{enabled:false}`；实际安装 CLI 在这种覆盖下仍验证 transport。隔离 profile 中用真实 CLI 重放嵌套表和点路径表两种形状，均复现同一错误。

仅在动态挂载内建 MCP 的 native-peer 发送边界，将 thread/start、thread/resume、thread/fork 中内建 mycodex 的精确 enabled-only 禁用表补成 `{command:"",enabled:false}`。这是该宿主自身使用的显式禁用 stdio 形状，不保留可执行命令、不重新启用服务。原配置、调用者对象、其他服务器和显式自定义 transport 保持。未启用内建 MCP 的进程不进行此转换，config 写请求也不转换。

真实 CLI 的隔离检查现在能在两种禁用形状下创建 ephemeral 会话，无模型 turn；内建 MCP 的初始发现也继续通过。没有写用户 config.toml。

## 验证与加载

- 严格 typecheck、build、完整 test:diy：249/249 通过，零失败、取消或跳过。59 个 TS 源码 / 118 个产物，192 个 ESM 模块 / 462 条相对导入。
- 新 Chrome fixture 覆盖三个引擎的新建页选择、推理更新、拒绝后保留已确认模型与草稿、恢复原生默认模型及 dispose；不连接官方客户端或用户 profile。
- 定向检查覆盖缺失入口、未知模型/推理、明确拒绝、导航变化与无确认超时，断言不重试。原安装包继续核对模型回调及既有 lifecycle 接缝。
- 源码安全审计及生成产物新鲜度结果见 [结构化证据](evidence/2026-11-02-host-rpc-draft-creation.json)。

编译只更新仓库生成产物，没有替换正在运行的网关、helper 或 app-server 前端。没有操作官方窗口、发送测试消息、修改工作聊天、更新 VERSION/native core、提交、推送或发布。共享 DEVELOPMENT 文档的哈希保持。

加载需要在用户保存现有任务后，再协调手动完整退出 ChatGPT 并从原 MyCodex 图标重开。此前 P2 重开授权不作为本次自动重启授权；本轮不主动退出任何工作进程。原窗口验收仍需确认所用选择入口及实际错误文字，并对专用测试聊天验证三类引擎的首次发送。
