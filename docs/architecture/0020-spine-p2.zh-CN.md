# ADR 0020：MyCodex P2、图片正文投影与自有知识卡契约

日期：2026-11-02（Asia/Shanghai）。本轮依据 ADR 0017–0019 实施 P2 并加固 P1。用户随后明确“改变契约，不再采用之前的契约，改为 Mycodex 的”，因此知识卡改用本仓自有契约，不继续套用猫咖来源限定的 `knowledge-card-v2.schema.json`。此决定覆盖 ADR 0017 的“一源三出”及 ADR 0019 第 4.2 节中对旧知识卡 schema / writer 的引用；这些文档的旧描述保留为历史。本轮知识卡写入由 MyCodex 独立实现，不依赖旧 `journal.py` / `vault_writer.py`。雷达报告和官方 app-server 图片协议继续采用各自已有契约。

## 1. CLI / ACP 图片正文投影

- `gateway/media.mts` 在 SDK / ACP 边界识别多模态 image 块、data URL、资源中的 image MIME / blob，以及工具明确生成/查看的本地图片产物；不会把普通文件列表或任意图片路径当作产物。
- Antigravity、Gemini CLI、Copilot CLI、Claude Code 先剥离图片载荷、保留可读摘要，再上报结构化 `EngineImage`。底层会话和工具动作不重放、不转交给宿主 agent 推理。
- 图片复制到 `<home>/gateway/media/<threadId>/<itemId>.<ext>`，支持 PNG、JPEG、GIF、WebP，验证签名、格式声明与 10 MiB 上限，写入采用 `O_NOFOLLOW | O_EXCL` 和 `0o600`。线程最多 128 个媒体文件 / 256 MiB；不把 Base64 写入线程 JSON。
- 投影为标准 `imageGeneration`（`status: completed`、绝对 `savedPath`、编码后的 `file://` result），发送 `item/started` / `item/completed`，summary 白名单保留该类型。没有劫持宿主消息 DOM。
- 删除先保持原有 tombstone 与底层 CLI cleanup 边界，再清理本线程媒体；原项目图片不删除。聊天分支复制媒体到独立目录，删除源聊天不破坏分支图片。失败后的媒体保存不会发布半成品画廊条目。
- ACP 子进程读取帧上限单独提升到 16 MiB，容纳 10 MiB 图片的 Base64 封装；app-server / 网关 IPC 的 8 MiB 原边界保留。

已经被旧版截断的 Base64 历史无法凭空复原；本轮不自动重放工具生成历史图片。验收覆盖新条目持久化、summary 和重启恢复，不把隔离投影测试声称为当前原生窗口的画廊验收。

## 2. Spine 后台寿命与原生 Event Tap

`SpineRegistry.track()` 维护异步工作计数，后台刷新立即返回 job 标识，由网关持有实际任务。idle 同时检查 Spine、CLI 活跃轮次及维护任务；close 拒绝新工作并等待已有工作完成。无前台连接不等于后台任务可提前回收。

Router 的旁路钩子只复制受控生命周期摘要：线程 ID、标题 / 首条意图片段、cwd、真实模型/provider、轮次 ID、完成时间与状态。逐 token delta、工具内容和凭据字段不抄送，文本摘要做凭据脱敏。观察器抛错、超时、缓冲溢出不会改变原生响应，也不重试推理或工具操作。

前端旁路和原生轨迹通道共享已有私有 socket，但通过派生凭据区分可信连接角色。普通 UI/MCP 通道不能写原生轨迹；轨迹通道仅允许 initialize 和 `diy/trace/record`，不能操作聊天或插件。前端不负责持久化，轨迹写入网关独占的 `<home>/gateway/spine/trace/`。

覆盖从启用 Event Tap 后开始；没有追溯原生全量正文，也不把“未归档”“回复完成”当作任务完成。日报会显示实际覆盖与缺口。

## 3. 雷达、日报及 MyCodex 知识卡

### 雷达

`gateway/spine/radar.mts` 验证配置指向的既有 `report.schema.json`，支持 JSON 报告文件、只读加载命令或原雷达 archive CLI。报告读取和增量采集命令分别配置；现有 `radar.py` 是归档内核，并不自行采集。没有新增阅读 HTTP 服务或数据库，没有硬编码用户仓库路径。

本地反馈单独持久化于 Spine：每条记录一次 `-1/0/1`，主题权重来自明确反馈，可撤销，不修改原报告评分。展示评分由报告 1–5 级阅读优先级转换为 20–100，并叠加有界主题偏好；它是可解释的本地阅读排序，不声称模型计算过私人契合度。分页受 IPC 预算约束。

同步失败保留上次验证通过的报告快照，并明确标记 stale / sourceError。看过的高契合条目由人类面板显式确认，MCP 阅读不替用户标记已读。保存雷达卡直接写入 MyCodex 候选知识库，并保留雷达 ID 与原始链接。

### 日报与续接

`gateway/spine/daily.mts` 只读聚合网关 ThreadStore、原生轨迹和配置仓库的当日 Git log / 分支 / 工作区变更条目。日界按配置时区计算，包含 DST 边界。团队 Markdown 不复制完整对话，不发送外部消息；标题与 Git 摘要做脱敏。UI 的早间续接、复制 Markdown、候选标题/标签微调与入库均走注入服务/HostActions。

默认生成可核对的活动和工作连续性候选，不虚构已掌握的机制、认知变化或任务完成。深度语义蒸馏可配置 `distillCommand`，输入为本轮活动证据，输出为 `{ "cards": [MycodexKnowledgeCard] }`；输出必须经过自有 schema 验证。没有默认调用额外模型或重跑历史工具。

### 自有知识卡契约

规范位于 `gateway/spine/schemas/mycodex-knowledge-card.schema.json`，严格类型位于 `knowledge-contracts.mts`。schemaVersion 为 1，字段包含稳定 `MC-日期-内容来源哈希` ID、revision、date、title、body、tags、真实 sources、候选/已审阅状态和创建/更新时间。来源直接采用：

- `mycodex://thread/<uuid>`：原生或 CLI 聊天，附实际 engine；
- `mycodex://radar/<itemHash>` 与 HTTP(S) 原始资料：雷达证据；
- `mycodex://git/<repoHash>/<commitHash>`：Git 证据。

不伪造猫咖引用，也不将此契约写入 StoredThread。默认 Markdown 与记录保存在 Spine 自有知识库；可配置现有 vault 的 `MyCodex/Knowledge` 子目录。修订文件原子、独占写入，重复内容幂等，变更创建新修订，原有人工编辑和其他库文件保留。保存仍是候选状态，不自动升格为已验证认知。

内建 MCP 新增 `mycodex.radar_list`、`mycodex.daily_digest`，与窗口使用同一后端。

## 4. UI / UX 与接入

`bridge/diy/` 保持纯 DOM/Shadow DOM、注入服务、无 Node / 无宿主混淆符号。抽屉实现共享 `--mc-*` light-dark 色板、右上角胶囊、未读高契合角标、槽位徽章、悬浮毛玻璃骨架、减少动画模式和快捷键。阴影使用可解析的“几何 + light-dark 颜色令牌”组合，避免将 `light-dark()` 错用于整段 box-shadow。

嵌套面板隔离键盘事件，因此 shell 的 Escape / ⌘⇧M 在外层 ShadowRoot 捕获；其余输入不会冒泡为原生发送。关闭精确归还原焦点。宽屏阶段避让由宿主适配层定位 main，窄屏/卸载只恢复本层拥有的样式。主题、挂载点、原生路由仍集中在宿主适配层，精确版本与 ASAR 检查保留。

接入示意（占位路径须由操作者替换，不是已启用的配置）：

```json
{
  "spine": {
    "mcp": true,
    "eventTap": true,
    "radar": {
      "schemaFile": "/path/to/radar/plugin/report.schema.json",
      "archive": { "executable": "/usr/bin/python3", "script": "/path/to/radar/plugin/radar.py", "dataHome": "/path/to/radar/data" },
      "refreshCommand": { "executable": "/usr/bin/python3", "args": ["/path/to/owned/incremental-collector.py"] }
    },
    "daily": { "repositories": ["/path/to/repository"], "timezone": "Asia/Shanghai" },
    "knowledge": { "vaultRoot": "/path/to/existing/vault" },
    "ui": { "rightOffset": 64 }
  }
}
```

## 5. 验收与运行边界

验证记录：[2026-11-02-spine-p2.json](evidence/2026-11-02-spine-p2.json)。严格 typecheck 和 build 通过（54 个源码、108 个生成产物）；完整 `test:diy` 最终通过 218/218，无失败或跳过。ESM 静态合同检查通过 187 个模块、439 条相对导入；生成产物新鲜度检查通过。源码审计复用 `tools/check-source-publication.mjs` 的 `auditSourceFiles`，针对本轮及 P1 基础的 69 个明确文件检查，通过且无发现；共享工作区没有暂存为发布候选。

最终门禁首次运行中，保护启动的隔离子进程测试出现一次 3 秒 RPC 超时（217/218）；随后该文件独立运行 4/4 通过，完整重跑 218/218 通过。没有为使测试通过而放宽生产超时或删除断言，超时原因尚未确认，原日志与复跑日志均列入证据。

当前只读核对：ChatGPT `26.1023.51421`（build `22530`）、原生 CLI `0.165.0-alpha.1.2`。客户端、网关和 helper 的原进程寿命保持，当前连接没有配置 Spine。本 Mac 工作区没有 `bin/core-current.txt` 或发行 manifest；本轮未运行发行流程。

本轮没有重启/打断当前窗口，没有测试性修改用户聊天，未修改 VERSION、native Rust、原 profile 或其他工作的 DEVELOPMENT 文档，没有提交、推送或发布。P2 配置未写入当前实例；源码与生成产物完成不等于已加载。真实窗口的图片展开、抽屉及真实数据源交互仍需未来协调加载后验收。P3/P4 未实施。
