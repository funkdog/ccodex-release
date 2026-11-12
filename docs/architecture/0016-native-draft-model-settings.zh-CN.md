# 新建页第三方模型与推理设置

当前状态：原生草稿设置和宿主多目录上下文兼容已加载，用户已确认原窗口收到回复；后台核对 Antigravity/high、MyCodex cwd 和完成结果。此前的空列表修复未解决这次真实请求，见末节。

2026-10-31，用户在原生新建页选择 Antigravity 并调整推理强度，出现“无法更新模型设置”。本轮仅修复该设置路径和页面助手的身份探测超时；不扩展会话管理范围。

## 根因

当前宿主为 `26.1023.51421`。真实日志确认失败请求为 `config/batchWrite`，被 router 的第三方模型全局配置保护拒绝。静态核查原生新建页：模型菜单先保存草稿状态，随后通过管理器 `setDefaultModelConfig` 尝试写默认模型和推理；该接口不区分第三方 CLI 模型。

另查到页面助手因 `spawnSync /usr/sbin/lsof ETIMEDOUT` 退出。原先 watcher 只在 update 内捕获临时错误，每轮之前的身份检查处于捕获边界之外。

## 修复边界

- 在现有原生 manager 挂钩内接管本地新建草稿的第三方默认模型请求。页面适配器校验实际模型目录和推理档位，保存至现有草稿 controller，返回原生 UI 已支持的 `okOverridden`，让原菜单保持内存选择。没有写原生 config、创建线程或请求推理。
- 普通原生模型仍调用原方法；成功后清理本草稿的第三方选择。远程、已有聊天及非原生工作区页面不接管。卸载只恢复仍由本组件拥有的方法。
- 首次发送兼容原生草稿保留的显式第三方模型及推理，仍经过已有创建意图和路由。目录读取期间导航或更改草稿会拒绝过期设置，不能修改另一个聊天。
- router 的全局配置保护保持不变，混合批量写入仍整批拒绝。
- 身份探测放进 watcher 的重试边界；仅重试已知 `ps` / `lsof` 的 spawnSync 超时和既有临时连接错误。检查未通过时不运行 renderer 操作，真实身份变化、权限错误或未知命令错误仍停止。启动阶段也沿用此检查边界。
- 页面助手在实际安装脚本返回 active 后记录一次接入成功，区分进程存活与安装已确认。

## 验证与加载

新增三项回归均先复现失败，再通过修复。85 项相关会话、路由、CLI、审批和元数据回归全部通过；启动检查边界的小改动后再次运行 15 项原生会话测试通过。严格 TS 构建为 30 模块 / 60 输出；静态模块检查为 161 ESM / 373 相对 import。新旧两个宿主各 32 项独立浏览器检查通过，包括原生菜单入口、非法强度拒绝、首次发送参数、原生默认设置透传、导航竞争和序列化安装。浏览器 fixture 不连接生产窗口。

确认旧 helper 已退出后，仅启动新 helper 并更新其私有身份回执；ChatGPT PID 42126 和 gateway PID 42100 保持原生命周期。新 helper PID 73271 已回报“UI 会话控件已接入”。回执保留原整体 sourceGeneration，不冒充网关或客户端整体升级。周期性超时处理与新草稿控件均已加载；随后补充的启动探测边界已编译，供 helper 下次正常启动使用。

原生 config.toml 在热加载前后 SHA256 一致。没有重启应用或网关、改变用户权限、发送模型测试消息、修改已有聊天或官方应用文件。本轮未修改 VERSION/native core、未提交或发布。原窗口菜单是否不再报错且保持“高”已请求用户反馈，尚待确认。

结构化记录见 [验证记录](evidence/2026-10-31-native-draft-model-settings.json)。

## 首次发送的空工作区列表

用户随后反馈首次发送仍失败，原生日志确认 `thread/start` 被网关的 workspace 校验拒绝，发生在创建持久化聊天和调用 CLI 之前。此次错误与上一节的 config 写入拒绝是不同阶段；设置回显或浏览器检查通过不能替代真实首次发送。

发现接入边界没有将 `runtimeWorkspaceRoots: []` 规范成未指定。空列表没有额外目录，却会触发旧网关“仅支持当前工作目录”的长度限制。真实日志没有保存根目录数组，不能从报错断言用户配置了多个目录。允许的项目列表工具确认 MyCodex 的主目录为本仓库。

修复只在 CLI 会话的 native envelope 中移除空数组，使旧网关继续使用已选 cwd。非空根目录原样保留，由网关继续验证；原生 OpenAI / native provider 请求及权限策略不变。没有为热更新绕过或放宽网关的多目录限制。

新增边界测试，以及将已有 manager → router → socket gateway → 首轮发送和冷恢复测试改成显式传空列表；两项均先复现失败，再通过。严格构建通过，70 项相关回归和当前宿主 32 项独立浏览器检查通过。期间一次编译因新增字段未声明失败，旧运行产物保留；补齐 NativeOptions 字段后重新构建及验证，没有把失败记录算成通过。

只重载身份严格核对的 UI helper，应用 PID 42126 和网关 PID 42100 保持；新 helper PID 76331 回报接入成功。该次也加载了上一节的启动探测改进。没有重发用户消息或修改会话记录。已请用户从返回后的新建页保持 Antigravity / 高并发送限定文本，原窗口发送结果仍待反馈。见 [空工作区验证](evidence/2026-10-31-native-empty-workspace.json)。

## 原窗口仍失败后的接收端修复

用户明确反馈工作区错误仍在。此前只在 renderer 消息总线规范化空列表，覆盖不到所有原生主进程创建路径；对应的合成 Manager 测试也不足以证明真实宿主发送路径已修复。前一节的“原窗口待反馈”现更新为验收失败，不能把页面脚本已加载当成接收端已更新。

新增直接通过 gateway IPC、完全不依赖页面挂钩的创建/恢复/发送测试，先复现同一错误。将空数组的语义兼容移到 `GatewayProtocol`：0 个根目录等同未指定，保留既定 cwd；多个、相对、无效根目录仍拒绝。server 对首次出现的创建请求形状记录有界 workspace 元数据，不记录输入、附件、账号或完整请求，以便定位实际宿主参数而不是继续推测。

80 项定向回归通过。核对所有 CLI 聊天空闲后，只替换旧 gateway 42100 为 81858，并保留原 socket capability、generation 和 home；原有前端按既有机制重新连接。随后启动 helper 81989，安装 active 已确认。官方 ChatGPT 仍为 PID 42126，没有重启。MyCodex 只读入口检查为 activate-existing，静态模块检查 161 / 373 通过。

额外以隔离临时账号目录、工作区和网关完成一次真实 Antigravity 调用：实际目录选择 `antigravity/gemini-4-argon`，推理 high、审批 deny，原始 IPC 的创建、恢复和发送均显式携带空根列表。收到 MYCODEX_OK，cwd 保持，临时凭据和运行数据已删除，没有调用原生 Codex 模型。此探针不是生产窗口验收；已再次请求用户反馈当前窗口的发送结果。见 [接收端修复](evidence/2026-10-31-gateway-workspace-repair.json) 和 [真实 CLI 结果](evidence/2026-10-31-native-empty-workspace-live.json)。

## 捕获实际双目录参数后的修正

用户再次反馈相同错误。新网关的有界日志捕获到实际 `thread/start`：cwd 为 MyCodex 仓库，runtimeWorkspaceRoots 同时包含 MyCodex 与 Ainvest-Terminal-Cloud。此前按空数组推断本次请求是误判；已有空列表兼容属于独立边界修复，不能证明这个双目录请求可用。

在完全访问模式下，这个字段是宿主目录上下文，不是 CLI 执行目录覆盖或 OS 沙箱。移除“必须至多一个根”的限制，继续校验全部条目为绝对路径，并按真实路径确认至少一个可用根包含已选 cwd。无关或已不存在的其他项目提示不改变 cwd；不把它们注册为额外 CLI 项目，不修改工具审批。真正改变已存 cwd、缺少包含 cwd 的根、相对或无效路径、其他权限档位仍拒绝。

根据捕获形状新增原始 IPC 双目录回归，先失败再修复。81 项定向回归、严格构建和模块检查通过。真实 Antigravity 在隔离的两个临时项目目录中完成创建、倒序根列表恢复、high/deny 下发送并回复 MYCODEX_OK，cwd 与策略保持，临时数据已删除。没有声称这个隔离调用是生产 UI 验收。

所有生产 CLI 聊天空闲时，将 gateway 81858 替换为 85785，保留 capability/generation/home；helper 85892 安装 active 已确认，官方客户端仍是 42126。原窗口是否成功已请求用户确认。见 [实际目录修正](evidence/2026-10-31-native-host-roots.json) 和 [双目录真实 CLI 验证](evidence/2026-10-31-native-host-roots-live.json)。

## 原窗口确认与双目录的配置来源

用户随后明确确认收到回复。只读核对两条已完成的 Antigravity 测试聊天，模型均为 gemini-4-argon、推理 high、cwd 均为本仓库，回复包含预期 MYCODEX_OK；其中一条策略 ask、另一条 auto。没有通过此次验收改写策略。

用户追问为什么只选择 MyCodex 却携带两个根目录。只读检查原生 `.codex-global-state.json` 的 local-projects，发现 MyCodex 项目 0a506a2c-780e-43c0-91f9-05670cfb9c46 的 rootPaths 本来就有本仓库和 Ainvest-Terminal-Cloud；Ainvest 项目 96019ccc-8a36-433f-a41b-10add8bf643a 也反向包含两者。selected-project 确实为 MyCodex。两个项目的 updatedAt 分别为上海时间 2026-10-31 19:40:13.977 和 19:40:09.079，早于本轮设置错误修复；时间不能证明具体操作者或写入组件。

这修正了此前“可能只是全局附带其他项目”的推断：目前已有直接证据表明项目自身配置交叉关联。网关兼容修复只消除发送拦截，未清理原生项目目录配置，也未改变工作目录。此次来源调查保持项目状态只读；若要恢复两个单根项目，应通过原生项目设置路径操作并另行验收，不在客户端运行期间直接改写全局 JSON。

## 用户授权的项目目录清理

用户随后要求清理。通过当前官方 CLI 的实验性 `project/read` / `project/update` 接口核对映射后的原生项目 ID，再只更新 `roots`，不删除或重建项目。MyCodex 原生项目现只保留本仓库，Ainvest-Terminal-Cloud 原生项目只保留其自身目录。修改前的两条原生记录、旧项目记录及会话归属快照备份于私有 maintenance 目录，权限为 0600，未纳入仓库。

更新响应及再次读取确认：项目 ID、名称、metadata、position、createdAt、recencyAt 保持；旧版 `thread-project-assignments`、`projectless-thread-ids`、selected-project 和新建项目选择快照保持。两个项目的原生数据库成员列表前后均为空；当前宿主尚未完成会话归属迁移，因此不能用该空列表声称已核对全部会话。客户端 PID 42126、gateway 85785、helper 85892 均未重启。

原生 CLI 更新后，当前宿主仍从内存及全局状态中的旧版 local-projects 读取文件夹，没有自动同步这份配置。静态核查确认原生“编辑项目”的 `editLocal` 路径会分别写入 app-server 和缓存；现有 app 工具没有对应文件夹编辑接口。因此请用户在两个项目的“编辑项目”中分别只保留各自主目录并保存，没有直接改写运行中的全局 JSON，也没有把数据库更新冒充当前窗口清理完成。

用户随后确认两个项目均已保存。2026-10-31 22:22（上海时间）再次只读核对：app-server 的 roots 与旧版 local-projects 的 rootPaths 均为各自主目录，项目 ID 和名称正确。对清理前快照逐项比较，既有 thread-project-assignments 没有变动，既有 projectless-thread-ids 均保留。通过生产 gateway 只读抽查两条仍存在的 Antigravity 聊天，cwd 仍为本仓库、reasoningEffort 为 high、cliApprovalMode 为 auto，历史轮次仍可读；没有发送测试消息。旧验收样本中的一条已被标记永久删除，不恢复它，也不把它算入本次抽查。官方客户端、网关及 helper PID 均保持，目录清理已闭环。这是项目设置清理，没有修改运行源码或发布版本。
