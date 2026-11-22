# 2026-11-13 小队 V1 实现与本机验收

依据：ADR 0033 `squad-issue-ledger-and-drawer.zh-CN.md` 与关联架构聊天最新讨论。状态：源码实现及 macOS 本机验收完成，未正式打包发布。

> 最新补验：五项审查修复与 `squad_wait` 已完成，主工作区全量 **507/507** 通过。下方 480 条与冻结副本记录属于首次实现的历史证据，最新结果和源文件指纹见文末。

## 已实现

- 常备角色配置复用动态模型目录与推理强度，不向用户暴露 runtime ID。
- 网关单写者追加 `ledger.json`，同步物化 `ISSUE.md`；系统生成序号、时间，校验成员归属并从成员表填角色、引擎。身份信任边界为已授权的本地实例调用者，不提供多租户身份认证。
- `post` 幂等写账、点名单一接棒者；忙碌成员排队，默认三次自动接力后等待人工放行。持久化发送意图，对结果不确定的投递不自动重发。
- 对应回合已终止而未记账时提示人工代记，CLI 与原生回合均按准确 turn ID 取文本；代记不生成评审通过结论。
- 独立小队抽屉、上下文胶囊、36px 成员行、账本时间线、双主题、常备角色建队与快审、成员扶正。左侧不插入分组 DOM，只按活跃编组做 CSS 折叠。
- 汇总追加至主会话现有草稿，保留草稿；修复富文本 DIV/BR 扩展空行造成的插入确认误报。
- 结束小队保存 closed 历史、所有会话及账本；不调用 thread/archive。兼容 brief/report 自动记账，下线旧 P3 的四个 MCP 工具及旧工位/Wave 2 操作入口。
- 账本按响应字节预算分页；面板仅在打开且有运行成员时做 5 秒指定小队查询，事件驱动更新为主。

## 验证证据

共享工作区另一任务在测试期间更新了 `bridge/translate.mjs`，导致一轮生成物指纹失效。最终在冻结临时源码副本验证；下列交付源文件已逐字节核对与该副本一致。保留了其他任务已有改动。

- `node tools/typescript-task.mjs typecheck`：通过。
- `node tools/typescript-task.mjs build`：通过，96 个 TS 源、192 个生成物。
- `node tools/typescript-task.mjs test`：**480/480 通过，0 跳过**；最终测试耗时 51.6 秒，不含编译与额外浏览器复核。
- 包模块门禁：239 个模块、570 个相对导入通过。
- `node tools/typescript-task.mjs check` 与 `git diff --check`：通过。
- 冻结副本显式配置 `MYCODEX_TEST_RADAR_SCHEMA`，指向原有相邻雷达仓库 schema；无源码测试豁免。
- 实际已安装 Codex core 通过隔离 profile、本地合成 Responses 端点，与两个测试 CLI 引擎完成建队、派单、MCP/本地命令、新账本投递、准确回合代记、原生重连及删除清理；不使用真实账户在线推理。
- 序列化 Desktop 注入在隔离 Chrome 中零页面错误；验证角色建队、代记、主/子会话切换、草稿保留、结束保留历史、深浅主题与 200/320px 无横向溢出。
- 额外侧栏浏览器验收：仅样式折叠、原生导航、扶正恢复、React 式重挂载、读取失败恢复、关闭和销毁通过。

## 交付边界

未重启用户现有客户端或网关，未在用户真实活动窗口做上线交互验收；上述证据属于源码与本机隔离环境。未修改 VERSION 或原生补丁链，未运行六平台打包，未替换安装包，未提交或推送其他任务改动。

## 首次实现源文件 SHA-256（历史快照）

```json
{
  "gateway/spine/squad-ledger.mts": "165e28a454ef73307670b3a3f8ba5dc1031970682be603d4e414b8d045ab77b8",
  "gateway/spine/squad-roles.mts": "1765a02dabe54376313efcd0741907b669872b56098e08f52db2b84871c17881",
  "gateway/spine/squad-lite.mts": "e5e23993369216464138107be9e417c1189bc840dd1547a39743d19bd8f80e3a",
  "gateway/spine/squad-service.mts": "eec5b475d77935d719419301ae7b5b3d66b7e90adf891b51865975ef7c38f24b",
  "gateway/spine/squad-commands.mts": "19f56e6e645ab28c2d916dba888a792e8333104cc1d2a1c3b368ab6a96d5d5fd",
  "gateway/spine/mcp-server.mts": "98ba7d1f7a61728ed5ae1345e648171299406610dadf67354b4ec2dc2e5b105a",
  "gateway/squad-native-peer.mts": "f6036408e9dbf165aabbdc5de0ba8f8bf76765e7054148df187fad4a012b06ca",
  "gateway/server.mts": "c2a8b6ff64478a68f4225d17d86bf51163767bc9ddf308dedb02a8dc9a508508",
  "bridge/diy/squad-panel.mts": "8c107ba96b91a7ee0b02ab5b53b33a7a24a88d2751d98b7fd0d75c503c4cba38",
  "bridge/diy/workbench.mts": "7f4e5a18e9c8e4247bb3bcdf58bdf76f76170cfeed67da2f1b7b0b0ed20ca8c2",
  "bridge/diy/drawer.mts": "c5b4648b91734b1604186cda95fac0f14e3fbac3d2932e42c1ddfbea259f1cfa",
  "bridge/diy/work-panel.mts": "90071853ff5e78a290630d74ff15d83b90c838a7ea213cb61f521ee5d5ad5c07",
  "bridge/desktop-spine-ui.mts": "34bbfab873d159650a865965c400889c68bd3530fb3ebc70392267d0dc47befd",
  "bridge/desktop-sessions.mjs": "9552acbb75d721efe7f23611367aa865a6cf2c8f9dad73a543c85e12b41a1290"
}
```

## 审查修复与 wait 补验

依据：最新 ADR 0033 §3.1、§3.4，以及架构会话列出的 P1/P2 审查清单。此次在当前主工作区验证，没有复用首次实现的冻结副本或测试结果；保全 0031/0032 等原有改动。

### 五项审查修复

1. **最新有效派发统一判定**：`squad-observation.mts` 的 `currentDelivery` 只取成员最新派发（包括 queued/failed），后续成员记账覆盖该义务；不再向前寻找旧 sent 派发。`missingReports`、代记、状态与等待复用该规则。CLI/原生代记都核实同一 turn ID 已终态，运行中或新派发未结束时拒绝代记。
2. **失败/中断诊断**：`SquadView.turnDiagnostics` 提供确切回合、状态和原因；原生读取也返回 bounded error.message。无助手文本的失败或中断允许诚实代记，标注回合失败/中断，交回 supervisor，不生成 approved。真实 CLI 后台 ask 失败已覆盖，面板显示审批原因。
3. **恢复后消警**：`SquadView.unresolvedDeliveries` 与当前成员状态排除已被更新派发/成员记录覆盖的失败；历史账本及投递记录保留。浏览器验证先显示失败、后重派并记账，再确认面板不残留历史失败告警。
4. **接棒权**：note 不改 ball；blocked + null 交回 supervisor；其他类型按显式 next 更新，null 清空。兼容旧接口行为与无自动归档原则保留。
5. **汇总格式**：没有文件或旧结果时，不生成“涉及文件”“兼容回报”空标题。

### wait 实现与端到端管道

- Gateway `diy/squad/wait` 以 work:read 注册并传入 context.signal；MCP `mycodex.squad_wait` 与 CLI `wait` 共用同一命令契约。校验 sinceSeq、最多 20 个 targetHandles、0..120000ms，默认 30000ms。
- 返回 settled / needs_human / timeout / idle，以及新增楼层、接棒权、跳数状态、成员状态和阻塞原因。人工阻塞优先结束；已存在的 sinceSeq 后结论立即命中。
- 等待 Promise、通知订阅与 1 秒复核在 `squad-wait.mts`；只把磁盘/CLI 快照放入短 serial 段。原生状态探针在锁外且支持 AbortSignal。真实 Worker 回合内 post 及完成通知可立即唤醒；慢原生读期间 post 仍畅通。
- MCP 等待使用独立可取消网关连接，取消单次 wait 不关闭其他 MCP 请求的共享连接；CLI 取消、进程终止、socket 断开均传导至网关该连接的 AbortSignal。断连后 activeTasks 归零，并验证 otherwise-idle 网关可 retireIfIdle。
- wait RPC 预算为 min(130000, max(15000, timeoutMs + 10000))；Desktop 两层请求预算上限 130000ms。额外修复原生 MCP 外层原有 20 秒预算，argv-local tool_timeout_sec 改为 140 秒；普通工具仍使用 15 秒传输预算，不写用户 config.toml。
- post/wait 工具描述均包含“三等三不等 + 动态脱手”，明确 needs_human 不循环等待、常规 1~2 个窗口后转后台。
- 大量新增条目按响应字节预算返回 nextSinceSeq/hasMoreEntries，阻塞列表超预算带 hasMoreBlockers；可用 ledger 补读完整历史，避免 256KiB 响应限制令等待失败。

### 本轮门禁与实际范围

- 修复前新增六个回归全部失败，确认触发点；修复后相关回归 **48/48** 通过。
- `node tools/typescript-task.mjs typecheck / build / test / check` 均通过。最终全量 **507/507 通过，0 失败，0 跳过**，测试耗时 **42.0 秒**（不含编译与定向补验）。
- 构建 99 个 TS 源、198 个生成物；包模块门禁验证 **242 个模块、577 个相对导入**；`git diff --check` 通过。
- MCP 与实际 CLI 子进程同时等待 **16000ms** 并正常返回 timeout，确认没有 15 秒提前截断。120 秒最大值为参数/配置预算边界验证，未实等 120 秒。
- 取消、回合内 post 唤醒、慢原生探针期间写入使用 <500ms 断言；原生状态变化按 1 秒复核。覆盖 sinceSeq 先 post 后 wait、审批/提问标记、跳数刹车、blocked、未决/失败投递、完成漏记账、真实后台审批失败、无文本中断、MCP notifications/cancelled、CLI AbortSignal 与进程终止、socket 断开释放 activeTasks。
- 隔离 Chrome 的真实序列化 UI 验证失败原因、诚实代记与重派恢复消警，并保留草稿、主题、200/320px 布局等断言；已安装原生 Codex core 的隔离 profile、本地合成端点联调也通过。
- 新增测试及辅助 profile/子进程由测试清理；本轮临时日志汇总至本记录后删除。未重启用户现有客户端/网关，未修改 VERSION/原生补丁链，未打包或发布。现有已运行进程的旧启动预算不会被源码修改自动替换，新进程使用更新后的托管参数。

### 本轮修改文件完整 SHA-256

这些是交付时整文件指纹，不表示文件中原有其他任务改动归本轮所有。

```json
{
  "gateway/spine/squad-observation.mts": "a1b75e2a53aaf526948b879759a5ec83fceb560c43c0b5b335933a8156003e6d",
  "gateway/spine/squad-wait.mts": "c227fc7309dfccaca8b3c2362dae67e72dcb510a2146c0c4f896fafe88048f3f",
  "gateway/spine/squad-wait-client.mts": "777555f9597f02c1dfb6ce3c29b3ddcf26b9c8efeb888ed314b88ffff53795ac",
  "gateway/spine/squad-service.mts": "b8740cda437eb478b1fad1cdef0ddae24d80b0e6b856ab72a8065ae23af8449c",
  "gateway/spine/squad-commands.mts": "2dc0a619795e08acebd585e136dfd466076d8f57f38fcab37bc35e6e1dd3e934",
  "gateway/spine/squad-cli.mts": "aaaa8eec53a151d6ad647342b6fa079eade9b699dbeee36b883a595df5609ae3",
  "gateway/spine/mcp-server.mts": "ec4448399b294052401354172ed4ec4dfd32ac589c0107d3f81e115514c2b7b9",
  "gateway/spine/native-config.mts": "a1f89c73a2a172c9ddeb1a85d6abc81f0023da9ac515517ad84d32e4ce50260f",
  "gateway/server.mts": "16ea27bdb2840468bca7ea3e9ab8656d0e2666654435a52df2c482090e101cfd",
  "gateway/host-threads.mts": "46ca4f3fbaa55cb36b83aa1a0568bb7d1eb08f5aa2c0687afbeb0f9fb8061416",
  "gateway/squad-native-peer.mts": "9689ca5d30a3e2eb2334a00d9a37a73ed1a50f18b08cdbdec908deca4c5512e3",
  "bridge/diy/squad-panel.mts": "85d96a319af9937b443ebd17f5818ea56795c0609157c2c54883608fc2bd80cc",
  "bridge/desktop-spine-ui.mts": "e4236ceb58f2e484d62a7aac0047df9692d186c379d9629aa11cef2a8cae227d",
  "bridge/desktop-gateway-ui.mts": "289497a5caa8f53900ceb0801077c4a5116b1c9369a80592a8a9a9b76bab2530",
  "tests/squad-wait-test.mjs": "b5650be59c0595a54b93dd878f6b27f69cdb07a5e47f879cd2ab019a95eddbfb",
  "tests/squad-flow-ui-test.mjs": "15aee376121af2bbbec64236188be2586f1185cddf1a47e1f08f08884b5d2d4b",
  "tests/squad-flow-fixture.mjs": "bad1bb5113d5bdbe703103645623896c3d960587fde8be24c2a09e53b2e0d0bd",
  "tests/squad-native-fixture.mjs": "c4f82a8dfe8c671237d631f1183aec322a011a89531b0a7cfe4aff0a8d17f1f4",
  "tools/typescript-task.mjs": "6a239f4324128061c43186c3653a427098a23ccb7aa4005101498edd3a7fb618"
}
```
