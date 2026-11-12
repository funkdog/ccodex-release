# ADR 0018：Spine P1 实现与验收记录

本记录落实 ADR 0017 的 P1，P2–P4 未开始。新增运行模块为严格 `.mts`，相邻 `.mjs/.map` 由现有构建器生成。当前客户端与活跃会话没有被重启或操作，原 profile、`VERSION`、native core 补丁链与其他工作文档保留。

## 所有权与接口

- `gateway/spine/registry.mts` 由取得实例 socket 的网关创建，状态 schema 独立位于 `<home>/gateway/spine/schema.json`。没有另建数据库或 HTTP 管理服务，没有向 `StoredThread`、`protocol.mts` 添加 DIY 状态。
- P1 注册方法只有 `diy/spine/status` 与 `diy/logs/read`。请求先经过现有私有 socket 的 token/generation 认证和 initialize，能力取自服务端上下文；调用参数不能授权。未知方法、危险键、超深 JSON、非对象参数与超限载荷拒绝。CDP 仅主 frame 的默认 context 接受绑定，仍核对宿主 PID、寿命和端点；返回前再次核对，不重放操作。
- CDP 请求上限 32 KiB、响应上限 256 KiB，每 context 最多 8 个在途请求。`diy/*` 使用通用命名规则，具体开放能力由 Spine 注册表决定；插件无需逐个修改页面隧道白名单。
- `bridge/diy/drawer.mts` 是无运行 import 的纯 Shadow DOM 外壳，只消费注入的 `DiyServices`、`HostActions` 与 `DrawerSlot`。槽位取消、切换和卸载使用 AbortSignal，异步晚到的组件会卸载。宿主 selector、内存路由读取与文本插入位于 `desktop-spine-ui.mts`/宿主合同。
- `HostActions` 提供打开聊天、预填空草稿和追加当前输入框文本；操作不发送消息，遇到已有草稿拒绝覆盖。导航以已提交的内存路由确认，输入以原编辑器确认，不依赖 document URL，不直接替换编辑器 DOM 文本。

## 原文保真与压缩边界

L1 支持 ANSI、已知数值进度刷新、明确绿色测试 verdict、连续重复行和已知 lockfile diff 模板。检测到非零 exit、失败、断言或堆栈时禁用折叠，保留完整 L1 错误内容。未知模板保守保留。剥离 ANSI 也属于字节变化，因此所有有改动的输出都会保留原始字节；未改动但超过阈值的输出同样落盘。

L2 保存 `<home>/gateway/spillover/<sessionId>/<callId>.log` 与不可覆盖、原子发布的每调用完成元数据，包含字节数、SHA256 和 LF 行数。无共享 shim 写入目录索引。未完成的捕获不可回读，同尺寸改写也会被拒绝。空输出为零行；终止 LF 属于它结束的行，CR 原样保留。原文超限时明确返回完整回读指针，而不是截掉失败段落。`mycodex.read_log` 参数为 `id/startLine/endLine`，行号从 1 开始且两端包含；单次最多 10000 行、实际字节响应最多 32 KiB（即使调用者请求更大），返回 `complete/nextByteOffset`，按同一范围继续直到完整。无法无损解码的字节块使用 base64。长行扫描在固定块之间让出事件循环，避免阻塞活跃引擎的消息。

`prepareCommandShims` 只为显式选择的噪音命令生成 Unix 私有 PATH 垫片，绑定绝对原命令及独立 session ID。stdout/stderr 分开落盘并保留各自输出通道、参数、stdin、退出码和信号。TTY 走原命令。巨大原文先流式落盘，内存预算有限；捕获失败明确报错，不把部分日志声称为完整原文。P1 不自动垫片所有系统命令，不把 `git` 的机器可读子命令或 SDK 的协议输出当成日志。

覆盖范围有限：绝对路径调用、登录 shell 重建 PATH、内置命令和没有主动接入 compressor 的第三方 CLI 工具可绕过此钩子。原生会话的源头压缩只发生在该子进程实际使用垫片时，不能声称已拦截所有 Rust 工具输出。L1 的 `layer1` 保留全部失败文本；过大输出进入模型的摘要要求主动 MCP 回读。这是显式旁路，不是承诺所有错误均能在同一个有界摘要内呈现。

## 显式启用与加载

开发实例的 `gateway.spine` 可配置 `{ "mcp": true }`，可选 `shimDirectory` 是已准备的私有绝对目录。默认缺失时不新增 MCP 或抽屉，不变更现有启动配置。启用 MCP 时 `routed-stdio.mts` 给原生子进程追加 `-c mcp_servers.mycodex={...}`，不写用户 `config.toml`；`native-peer.mts` 的 PATH 变化只作用于它拥有的子进程。内建 MCP 仅通过原有私有 IPC 查询网关，不创建第二个状态写入者。stdio stdout 只输出标准 MCP JSON-RPC，诊断在 stderr。

本轮未把 `spine` 写入正在使用的实例配置，也未安装实际噪音命令垫片。编译产物存在并不等于当前进程已加载。真实原生窗口抽屉与 GPT 主动回读尚需未来协调加载后验收。

## 验证状态

2026-10-31 最终门禁：严格类型检查、构建与完整 `test:diy` 均成功，205 项通过、0 失败、0 跳过；172 个 ESM 模块与 398 条相对依赖通过检查。测试包括压缩字节保真、全绿模板、失败断言/堆栈、巨行/无效 UTF8 续读、路径/权限/重复 ID 边界、真实私有 IPC、MCP 初始化/工具/取消/子进程、独立 Chrome 直接导入 ESM 与序列化抽屉挂载/卸载。

当前安装的官方 CLI `0.165.0-alpha.1.2` 在隔离 profile 中通过 `routed-stdio` 实际发现了动态挂载的 `mycodex.read_log` 与 `mycodex.spine_status`；没有发送模型 turn，没有写用户 config，也没有调用用户聊天。实际安装的 OpenAI app 完整签名检查通过；保护启动的进程动作只在 fixture 中验证，未真实启动或重启当前客户端。

最终运行核对仍为客户端 PID 42126、网关 PID 85785、helper PID 85892；当前实例缺少 `gateway.spine` 开关，保持旧加载状态。这些 PID 仅是本次观测，不作为后续接续的有效事实。证据见 [P1 验证记录](evidence/2026-10-31-spine-p1.json)。

源码发布检查复用 `tools/check-source-publication.mjs` 导出的 `auditSourceFiles`，通过 `tools/check-spine-source.mjs` 审计 34 个明确的 P1 文件。共享仓库未 stage，原主命令要求已 stage 的正式候选，其完整发布门禁不能声称通过。本轮不提交、推送或发布。

此前启动兼容工作的两项草稿回归（`tests/desktop-shortcut-test.mjs` 末尾）在 P1 首次全量检查中仍为红灯。本轮补齐了 `desktop-protected-start.mts`，没有删除或跳过它们：仅接受 OpenAI 完整签名的原安装，启动时不依赖私有页面合同、不附加 helper，使用现有 `routed-stdio` 的明确离线连接保持 CLI 归属。原生 catalog 在网关不可用时可用；CLI 请求明确失败，不进入原生推理。原生已有 provider 聊天的服务不可用时也不会被替换成 OpenAI。检查已运行的客户端与最后一次启动前重查均保留，没有终止或重启路径。
