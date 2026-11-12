# ADR 0025：P2 真实来源接入与启用准备

日期：2026-11-02（Asia/Shanghai）。继续完成 P2，用户要求进入 P3 前再次确认功能设计。本轮未进入 P3，没有启动新的研究/模型任务，没有重启工作客户端。

## 1. 雷达来源与刷新语义

现有 AI 前沿雷达归档含 2026-11-02 报告，9 条，采集截至 `2026-11-02T09:30:34+08:00`，覆盖 models / infra / agents。先通过已连接的雷达插件核对归档，再验证本地真实来源。原采集由既有 Codex 自动任务负责，`radar.py` 是归档内核，不是可直接执行的增量采集器；本轮没有修改既有自动任务或调用其聊天。

新增可配置的 `radar.archiveDatabase`，与 reportFile / loadCommand / archive 三种入口互斥。`gateway/spine/radar-archive.mts` 独占外部 SQLite 表布局假设，只消费 reports 的 id / report_date / revision / payload。使用 Node 内建 SQLite 的 readOnly 模式与 query_only，拒绝链接、缺失文件和超出预算的数据，不执行原归档 CLI 的建表、WAL 初始化或迁移。报告内容继续按原 `report.schema.json` 验证；没有新增数据库或管理 HTTP 服务，没有修改上游仓库。

无 `refreshCommand` 时，`diy/radar/refresh` 只同步当前来源，标明 `refreshMode: archive-sync`；配置了采集命令时才是 collector。UI 分别显示采集截止时间 collectedThrough 与本机读取时间 syncedAt。同步失败保留上次有效快照和截止时间，同时显示失败，不能把重新读取旧稿描述成完成了新采集。

真实数据验证复现了默认筛选缺口：本期条目最高为编辑优先级 4/5，换算 80 分，未达到 85 分阈值。首次默认高分视图在高分条目为零且有其他条目时切换到“全部”；人类明确选择高分筛选后不再自动切换。没有为填满视图而抬高原评分或捏造个人契合度。修复前独立 Chrome 检查失败，修复后通过。

## 2. 日报与知识卡

启用候选配置纳入三个已明确涉及的仓库：MyCodex、AI 前沿雷达与 personal-agent-skills。日报 Git 查询加入 `--no-optional-locks`，避免 status 的可选 index 刷新写入；没有运行 Git 写命令。

知识卡沿用 ADR 0020 的 MyCodex 自有 schema，默认保存到该实例 `<home>/gateway/spine/knowledge/library`。没有自动选择或写入外部 Obsidian Vault，也没有调用旧 journal.py / vault_writer.py。没有配置额外模型蒸馏命令，当前候选保留证据及待复核状态。

真实来源隔离验证只用 O_RDONLY / O_NOFOLLOW 有界读取网关 JSON，并把元数据与最后一轮受限、脱敏的 assistant 节选投影给临时 DailyService；未实例化指向工作存档的 ThreadStore，未复制完整聊天库、底层 CLI session 或工具载荷。结果为 4 条有效 CLI 会话、3 个仓库、4 条续接记录与 1 个候选。归档和 tombstone 记录不进入候选。

当前 Event Tap 未启用，因此原生轨迹为 0。这个数表示覆盖尚未开始，不能解释为当日没有原生工作。视图继续显示此缺口；本轮没有追溯原生全量聊天。启用后逐步积累原生生命周期证据。

## 3. 隔离验证边界

- 真实资料库只读，文件哈希不变。反馈、撤销、报告快照和知识卡均写入私有临时 Spine，测试后删除，没有向真实知识库留下测试卡片。
- 内建 MCP 的 radar_list / daily_digest 在同一真实来源后端交互通过。
- 独立 headless Chrome 运行编译后的纯工作台，后端请求经受控 registry/capability 分发：真实报告、默认筛选、非空草稿保护、空草稿预填、反馈撤销、临时入库、归档同步、日报复制、Escape 和 dispose 均通过。剪贴板与 HostActions 为该 fixture 的本地动作，没有操作系统剪贴板写入或实际宿主线程跳转。
- 真实来源 UI 截图只保存在任务临时证据路径，未提交到仓库。它是独立浏览器验证，不是原工作窗口验收；ADR 0023 已有人类确认的三个真实临时宿主行为仍分别成立。
- 探针首次只在最后保存结果时被私有目录检查拒绝：误把结果目标放在公共临时目录。改为保存在本轮私有准备目录后完整复跑通过；没有放宽存储权限检查。

## 4. 配置准备与后续边界

机器路径只进入本机私有候选配置，不写死于源码。候选配置与原配置位于同一目录，保留根据 configFile 所在目录计算实例 home 的现有语义；只新增 gateway.spine，其余引擎、实例 ID 与 profile 行为不变。实际解析验证新旧实例 home 一致。

准备 manifest 保存原配置哈希、候选路径、基线文件哈希和进程寿命。启用时应重新核对基线，只合入 Spine 改动，防止覆盖并行工作的配置变动。准备阶段未覆盖日常配置、运行中 connection.json 或启动回执。工作客户端 PID 37552、网关 PID 37526、助手 PID 37609 的寿命保持。随后经用户确认的配置应用见第 6 节。

按用户“重启前先协调”的约定，加载新版仍需最后协调；这不影响本轮只读接入与配置准备。P3 未实现、未配置，须先向用户确认功能设计。

## 5. 门禁

严格 typecheck / build 通过，新增 3 项来源检查，最终完整 `test:diy` 245/245 通过，无跳过；192 个 ESM 模块、460 条相对导入检查通过。源码审计和生成产物新鲜度记录见 [结构化证据](evidence/2026-11-02-spine-real-sources.json)。

VERSION、native core、共享 DEVELOPMENT 文档和其他工作现场保留；无提交、推送、Windows runner 或发行流程。

## 6. 用户确认后：启动配置已启用，等待手动重开

用户明确选择“本轮回复后手动重开并启用”。应用前再次核对当前原配置与准备基线哈希一致，候选配置剔除 gateway.spine 后与原配置完全一致，MyCodex.app 绑定仍指向本仓、原官方应用和原配置路径。

原配置已私有备份，Spine 配置经 fsync / 同目录原子替换写入日常启动配置。解析验证实例 home、引擎配置和原 profile 策略保持，新 generation 与已验证候选一致。没有执行 prepare/activate，没有改写运行中 connection.json 或启动回执，也没有替换后端连接、启动助手或重启任何工作进程。

实际入口的只读检查返回 `needs-quit`、`launchPerformed: false`，符合“新配置已准备、旧窗口仍运行”的状态。客户端、网关和助手的原寿命保持。需要用户在本轮回复结束后保存任务，用 ⌘Q 完整退出，再从原 MyCodex 图标打开；入口会按既有策略等待旧网关自然空闲退出，可能约一分钟。

目前仅启动配置已应用，不能声称运行中的窗口已经加载了 P2。重开后仍须核对新网关的 Spine/MCP/Event Tap 配置和助手状态，并由用户确认工作窗口中的雷达/日报入口。P3 继续等待单独的功能设计确认。
