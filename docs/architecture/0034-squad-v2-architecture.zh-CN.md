# ADR 0034：Squad V2——单写者共享状态、双轴角色槽与原生分屏协同架构

日期：2026-11-16（Asia/Shanghai）。状态：**架构与接口契约基线（供三路并行工作树实施与空白终审验收）**。
演进关系：在 `0033` 基础上吸收实战复盘与社区多智能体工程共识，废弃“子会话读写全量流水账 `ISSUE.md` + 调 MCP 互点名 + 360px 挤压式自定义悬浮抽屉”的 V1 设计。

---

## 1. 核心问题与四大架构取舍

1. **拓扑与状态解释权（Orchestrator-Worker 星型控制）**：
   - 主会话（Orchestrator）独占路由决策权、业务进展解释权与共享事实表写入权；
   - 子会话（Slot Worker）剥离一切 `mycodex.squad_*` 协作工具与全队历史流水账，仅专注完成本分区的交付。
2. **会话寿命双模式（`stateful` vs `clean`）**：
   - `stateful`（持久队友）：用于模块深耕、多模态分镜/设计迭代，保留跨轮领域记忆，支持人与主会话随时进入对话微调；
   - `clean`（空白验证者）：用于代码审查、验收挑刺、红蓝对抗，每次派发开启零历史包袱的新会话，仅输入验收判据与真实产物/Diff 引用，杜绝上下文退化（Context Rot）与路径偏见。
3. **空间隔离双模式（`shared` vs `worktree`）**：
   - `shared`（默认）：原工作目录运行，适用于调研、方案碰撞、独立原型或多媒体资产生成；
   - `worktree`：并行修改同一 Git 仓库代码时启用，自动维护小队集成分支 `squad/<id>` 与角色独立工作树 `role/<id>/<slot>`（软链共享依赖），物理隔离构建并精确统计 `commits / changed / outsideTouches`。
4. **物理静止探针与异步通知（Quiescence Snapshot & Notice Bus）**：
   - Gateway 内核**不越权判定业务收口**，仅监控客观物理信号：排除活跃内部 subagent 后的会话静止态（`quiescent`）、阻塞等待态（`waiting`）或报错态（`failed`）；
   - 子会话结束时可写本地 `.mycodex/result.md`（声明 `status: done | blocked | escalate` 及必填的 `Assumptions & Trade-offs` 隐性决策清单）；若未写文件即静止或中断，内核自动采集物理文件增量与末条输出合成快照；
   - 主会话派发后立即结束回合交还输入框；待主会话处于 `idle` 时，Gateway 合并投递单行结构化 `[Squad Notice]`（含人类直接切入子会话对话后的回流通知）。

---

## 2. 高信噪比与防注意力涣散（Anti-ADHD）产品交互

彻底告别过程日志刷屏与自定义窄抽屉遮挡，依托 Codex 原生客户端三大界面分工：

1. **主对话流 + 轻量内嵌里程碑卡（Inline Milestone Cards）**：
   - 仅在关键决策节点嵌入 MCP App 交互卡片：**立项对齐卡（Blueprint Card）** 与 **阶段交付/裁决卡（Convergence Card）**；
   - 支持**双通道拍板**：既可在卡片/分屏点击 `[批准开跑]`，也可直接在主输入框自然语言回复，共用同一 `expectedRevision` 状态接口。
2. **右侧 Codex 原生分屏工作台（Squad Studio Split Tab，通过 `open_in_codex` 打开）**：
   - 平时安静零滚屏；仅当存在待批门禁、子会话请求契约升级（`escalate`）或阻塞时，顶部浮现 `Needs You` 拦截条；
   - 上半区展示当前生效的 `STATE`（验收判据勾选进度、可折叠公共契约、纵向缩进角色拓扑树）；
   - 下半区展示角色抽检卡（含模型、耗时、物理文件增删条与边界校验），点击角色在分屏内原地展开其 `brief / result（含关键假设与取舍）` 与改动文件，点击文件联动打开 Codex 原生 Diff 视图，95% 场景无需切走主对话。
3. **左侧原生会话栏微徽标 + 子会话返回锚点**：
   - 左侧栏主会话行尾保留紧凑状态胶囊，临时子会话默认折叠隐藏（支持一键扶正）；进入子会话深聊时提供一键返回主会话入口。

---

## 3. 主会话工具面收敛（6 个核心原语）

共享类型定义统一以 `gateway/spine/squad-v2-contracts.mts` 为准：

1. `mycodex.squad_init`：初始化小队、可选 `squad/<id>` 集成分支、初始 `STATE.md` 并返回分屏 `studioUrl`。
2. `mycodex.squad_state`：按 `expectedRevision` 原位更新 `STATE.md`（目标判据、公共契约、动态任务图、开启/裁决 Gate）。
3. `mycodex.squad_dispatch`：向一个或多个槽位非阻塞派发任务（指定 `stateful | clean`、`shared | worktree`、`touches` 与任务描述，自动生成角色裁剪视图 `.mycodex/brief.md`）。
4. `mycodex.squad_status`：只读获取 `SquadStudioSnapshot`（支持渲染内嵌里程碑卡或短探针查询）。
5. `mycodex.squad_integrate`：将已验证通过的角色 `worktree` 分支合入小队集成分支或目标分支。
6. `mycodex.squad_close`：收束小队（支持将指定 `stateful` 槽位扶正至主侧栏，保留全部真实会话不归档）。

---

## 4. 并行拆包与无交集写边界

- **会话 1（`role-protocol` · 底层协议与子会话运行时清障）**：
  - 写范围：`bridge/translate.mjs`, `bridge/request-sanitize.mjs`, `gateway/squad-native-peer.mts`, `gateway/host-threads.mts` 及对应协议/宿主单测。
- **会话 2（`role-kernel` · Squad V2 状态内核、Worktree 与异步通知管道）**：
  - 写范围：`gateway/spine/squad-*.mts`（可新增 V2 模块并保持旧测试平滑迁移）, `gateway/spine/mcp-server.mts` 及对应后端单测。
- **会话 3（`role-studio` · 分两阶段门禁推进）**：
  - **阶段 C1（视觉原型 Gate）**：仅新增 `docs/design/squad-v2-studio-prototype.html` 并用 `open_in_codex` 供用户拍板，**严禁修改 `bridge/` 或 `tests/`**；
  - **阶段 C2（拍板后生产落地）**：写范围 `bridge/diy/squad-card.mts`（或复用升级卡片组件）、分屏前端视图、`bridge/desktop-sessions.mjs`、`bridge/desktop-native-composer.mts`、`bridge/desktop-spine-ui.mts` 及前端浏览器测试。
- **会话 4（`clean-verifier` · 空白终审）**：
  - 待前三路合入 `codex/squad-v2` 后全新拉起，只读审查完整 Diff 并执行项目门禁。
