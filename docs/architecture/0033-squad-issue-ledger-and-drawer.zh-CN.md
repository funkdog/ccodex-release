# ADR 0033：松耦合小队协作底座——常备角色、类 Issue 交接账本与隐藏式二级分栏技术方案

日期：2026-11-13（Asia/Shanghai）。状态：**已归档正式技术实现方案（Tech Spec & Review Baseline）**，供独立开发会话直接实施、主架构会话评审验收。
关联关系：与 `0031-model-sources-and-handoff.zh-CN.md`（会话引擎与来源锁定）、`0032-heterogeneous-model-and-display-standard.zh-CN.md`（异构推理与原生卡片投影）正交互补，**代码写入集合与 `0032` 零重叠，可完全并行开发**。替代旧 `0026` P3 重型五角色模型与早期 `desktop-sessions.mjs` 左侧栏 DOM 劫持分组实现。

---

## 1. 产品定位与核心设计原则

Squad 的核心定位是**跨异构会话（原生 Codex 各模型源 + 各类独立 CLI Agent）的松耦合协作底座**，而非强制绑死工作流的重型状态机：

1. **注意力清晰分层**：
   - **左侧主会话栏（Codex 原生侧栏）**：零 DOM 结构劫持，只展示人深度参与、负责进度跟踪与重大决策共识的高价值主会话。
   - **右侧隐藏式二级分栏（Context-Bound Squad Drawer）**：平时收起，仅在主视图右上角以紧凑微胶囊提示当前会话关联的小队聚合状态；拉开后展示当前小队的常备角色槽、成员状态卡片与类 Issue 交接时间线，支持主/子会话一键秒切。
2. **类 GitHub Issue 纯追加共享账本（Append-Only Issue Ledger）**：
   - 废弃单次覆盖、丢失历史的裸 `brief.json / result.json` 模式，升级为人类一眼可读、Agent 秒级对齐上下文的纯追加交接账本（同步物化为 `ISSUE.md`）。清楚记录：**什么时候、谁干了什么、留下了什么物理文件证据、叫了谁接着干**。
3. **全量可发现与零默认归档（Safe Lifecycle & Full Discoverability）**：
   - 每个子会话均为真实的原生或网关会话，后端 `thread/list`、`thread/search`、`thread/read`、`mycodex_squad_list` **100% 原样返回**，确保其他会话、全局搜索与日报插件可完整发现并读取。
   - **严禁默认自动调用 `thread/archive`**：解散小队或收束回单会话仅解除活跃编组关系（或切换视图折叠标记），成员会话保持 `archived: false` 可读、可搜、可随时追加消息续聊；真实归档仅在用户显式点击单会话「归档」动作时触发。
4. **随时无损收束（Collapse to Solo）**：
   - 前期发散/正交并行期可通过常备角色槽 1 秒扇形展开；进入评审修复、跑门禁、回 MR 等高频串行长尾阶段时，支持一键把账本结论收束回主会话，或将上下文最全的开发子会话“扶正（Promote）”至左侧主栏独立收尾，消除多头协调负担。

---

## 2. 核心数据模型与磁盘契约

所有小队数据继续独立存储于实例私有目录 `.mycodex/` 下（目录 `0700`、文件 `0600`、临时文件 + `fsync` + 原子 `rename`，拒绝符号链接），**零侵入 `gateway/contracts.mts` 的 `StoredThread` 字段**。

### 2.1 实例级常备角色配置（`.mycodex/squad-roles.json`）

不硬编码固定的几个 CLI；角色模型绑定直接复用全量动态模型目录（`diy/squad/catalog`：涵盖原生 Codex 默认源、GitHub Copilot 源、`ccodex sources` 自定义 API 源、`codex-gemini` 及所有已配置 CLI 引擎）：

```ts
export interface SquadRolePreset {
  id: string;                     // 稳定短标识，如 "dev" | "design" | "reviewer" | 自定义 slug
  handle: string;                 // 人类可读点名标识，如 "开发" | "设计" | "评审"（不含 @，展示与引用时带 @）
  kind: "cli" | "native";
  model: string;                  // 动态目录中的真实模型 ID（如 "claude-code/claude-sonnet-4-6" 或 "fixture-codex-a"）
  reasoningEffort?: string | null;
  defaultPromptPrefix?: string;   // 可选角色职责简述（如 "按 ub-mode-lite 只读审查代码风险，不直接改源码"）
  updatedAt: number;
}

export interface SquadRoleStore {
  schemaVersion: 1;
  roles: SquadRolePreset[];
}
```

### 2.2 小队索引扩展契约（`.mycodex/squads.json`，向后兼容既有 v1 记录）

在 `gateway/spine/squad-lite.mts` 中扩展可选字段，旧版无 `schemaVersion` 记录加载时无损兼容：

```ts
export interface SquadMember {
  threadId: string;
  role: "supervisor" | "worker";
  shortName: string;              // 对应角色 handle（如 "开发"、"评审"、"worker-1"），小队内唯一（大小写不敏感）
  engine: string;
  model?: string | null;
  hostRef?: HostThreadRef;
  sidebarHidden?: boolean;        // worker 默认 true（仅前端左侧栏纯样式折叠，后端 thread/list 不删减）；扶正独立后置为 false
}

export interface SquadLiteRecord {
  id: string;                     // "sq-" + 8 hex
  anchorThreadId: string;
  label: string;
  goal?: string;
  status?: "active" | "closed";   // closed 表示协作已收口，关联关系与账本保留在主会话历史折叠区，不销毁聊天
  maxAutoHops?: number;           // 默认 3：无人工介入时连续自动点名唤醒的最大跳数
  autoHopsUsed?: number;          // 当前连续自动跳数，人工派单或放行时归零
  ballInCourt?: string | null;    // 当前接棒的成员 shortName（如 "开发" / "supervisor" / null）
  hopPausedForHuman?: boolean;    // 达到 maxAutoHops 触发刹车待人工过目放行
  createdAt: number;
  updatedAt?: number;
  members: SquadMember[];
}
```

### 2.3 类 Issue 纯追加交接账本（`.mycodex/squad-relay/<squadId>/`）

每个小队维护机器真值文件 `ledger.json`（网关单写者串行原子更新），并在每次写入后同步渲染物化同目录下的 **`ISSUE.md`**（供人类直接阅读及新入队 Agent 低 Token 对齐全局记忆）：

```ts
export type LedgerEntryKind =
  | "assign"          // 主会话或人工派单
  | "handoff"         // 成员完成阶段工作并交棒给下一角色
  | "review"          // 评审角色给出结论（可附 verdict）
  | "blocked"         // 遇到权限、歧义或环境阻塞求助
  | "note"            // 同步阶段进展，不转移接棒权
  | "system_fallback";// 成员回合已结束（idle）但未显式记账时，由网关自动补写的诚实代记

export interface SquadLedgerEntry {
  seq: number;                    // 1, 2, 3... 单调递增楼层号
  entryId: string;                // 幂等去重键（客户端/工具传入 requestId）
  createdAt: number;              // Unix ms（系统盖章，禁止模型伪造）
  authorThreadId: string;         // 发言会话真实 ID（系统绑定）
  authorHandle: string;           // 如 "supervisor" | "开发" | "评审"
  authorEngine: string;           // 如 "claude-code" | "codex"
  kind: LedgerEntryKind;
  verdict?: "approved" | "changes_requested" | "commented" | null;
  summary: string;                // 必填（<= 4000 字符）：结论 + 对下一棒的具体诉求
  nextHandle: string | null;      // 明确点名的下一棒（如 "评审"、"开发"、"supervisor" 或 null）
  files?: string[];               // 物理文件或文档锚点指针（<= 50 项，禁止贴大段源码 diff）
  verification?: string | null;   // 已执行的验证命令结果与明确未验证缺口
  dispatchTurnId?: string | null; // 若本条触发了目标会话唤醒，记录目标 turnId 供完工追踪
}

export interface SquadLedger {
  schemaVersion: 1;
  squadId: string;
  entries: SquadLedgerEntry[];
}
```

**`ISSUE.md` 标准渲染格式（4+1 提单标准物化）**：

```markdown
# [sq-a1b2c3d4] 0032 协议落地与边界审查
- **主会话**: Mycodex核心架构方案讨论 (`codex://threads/<anchorThreadId>`)
- **当前状态**: active · **当前接棒**: @评审 · **自动接力计数**: 1/3
- **小队目标**: 完成 DisplayProjector 落地并通过回归门禁
- **成员名册**:
  - `@supervisor` · codex (`codex://threads/<anchorThreadId>`)
  - `@开发` · claude-code (`codex://threads/<worker1Id>`)
  - `@评审` · codex (`codex://threads/<worker2Id>`)

---

### #1 · 2026-11-13 17:00:12 · [assign] @supervisor ──► @开发
按 `0032` Phase 1 实现 `display-projector.mts` 与分段消息状态机，完成后请直接点名 `@评审` 交叉检查。
- **涉及文件/依据**: `docs/architecture/0032-heterogeneous-model-and-display-standard.zh-CN.md`
- **验证与边界**: 仅改 `gateway/`，跑通 `typescript-task.mjs test`
- **来源会话**: `codex://threads/<anchorThreadId>`
```

---

## 3. 协作引擎核心运行机制（`gateway/spine/squad-service.mts`）

### 3.1 「记账 + 拍肩膀唤醒」原子闭环（Post & Wake）

新增核心方法 `post_entry`（同时暴露于 `diy/squad/post`、MCP `mycodex_squad_post` 与本地 CLI `squad-cli.mjs post`），并保持旧 `dispatch` / `report` 作为兼容别名自动写入一条对应账本条目：

1. **幂等与身份校验**：按 `entryId/requestId` 幂等去重；核实 `authorThreadId` 属于该 `squadId`（人工从面板发起时归属 `supervisor` 或指定操作人）。
2. **追加账本并刷新 `ISSUE.md`**：生成递增 `seq` 与系统时间戳；更新 `ballInCourt` 规则为：
   - `kind === "note"`（同步进展，不移交责任）：保持原 `ballInCourt` 不变；
   - `kind === "blocked"` 且 `nextHandle === null`：自动将 `ballInCourt` 置回 `"supervisor"`（等待人工或主会话排障，不触发自动唤醒）；
   - 其余类型（`assign / handoff / review / system_fallback`）：`ballInCourt = nextHandle`（显式传 `null` 时置为 `null`，不得残留上一任 Worker 名字）。
   随后原子写盘 `ledger.json` 与 `ISSUE.md`。
3. **自动接力唤醒与「跳数刹车（Hop Limit）」**：
   - 若 `nextHandle === null` 或 `nextHandle === "supervisor"`：不自动触发 Worker 新回合；若 `nextHandle === "supervisor"`，重置待办锚点到主会话，右上角胶囊高亮提醒用户查看最新交回。
   - 若 `nextHandle` 指向某个 `worker`：
     - **人工发起（面板点击或主会话直接发起）**：重置 `autoHopsUsed = 0`，`hopPausedForHuman = false`，立即执行唤醒投递；
     - **Worker 自动点名另一 Worker**：检查 `autoHopsUsed < (record.maxAutoHops ?? 3)`：
       - 未超限：`autoHopsUsed += 1`，检查目标 Worker 是否处于空闲（`idle`）。若空闲则自动发送唤醒简报（包含最新账本条目、`ISSUE.md` 绝对路径、以及回写 `mycodex_squad_post` / `squad-cli.mjs post` 的简明示例）；若目标正在 `running`，记入待唤醒队列，等其当前回合结束后投递，绝不中途打断；
       - **已达上限（触发防乒乓死循环刹车）**：不自动发消息，置 `hopPausedForHuman = true`，在面板与右上角胶囊标记琥珀色 `⚠ 已内部接力 3 轮，待你确认放行`。用户点击「继续放行」后清零 `autoHopsUsed` 并投递挂起的那一跳。

### 3.2 漏记账「系统代记」自动兜底（Anti-Stall Fallback）

解决实战中模型在聊天窗口说完了话却忘记调用记账工具导致的协作断链：

1. 每次唤醒某 Worker 执行第 `#N` 楼任务时，记录关联执行句柄 `{ workerId, afterSeq: N, turnId }`。
2. 当检测到该 Worker 的对应回合已进入终态（`completed` / `failed` / `interrupted` 或会话恢复 `idle`），且 `ledger.json` 中没有来自该 Worker 且 `seq > N` 的新记录时：
   - 面板该成员卡片显示琥珀色 `⚠ 回合已结束（未写账本）`，并提供一键 **`[代记末条回复]`** 按钮（读取该会话最新一条助手文本摘要写入 `system_fallback` 楼层并把 `ballInCourt` 交回 `supervisor`）；
   - 对于网关直管的 CLI Worker，也可在回合正常结束 2 秒宽限期后无记录时自动追加一条诚实的 `system_fallback` 记录（明确标注 `[系统代记 · 未显式点名下一棒]`，绝不伪造 `approved` 结论）。

### 3.3 收束与扶正原语（长尾阶段减负）

1. **汇总回主会话（`diy/squad/summarize` 升级）**：
   - 基于 `ledger.json` 提取各角色最新有效结论、涉及文件去重列表与未决风险，生成结构化 Markdown 摘要注入主会话输入框草稿（保留原有草稿）或按需发送。
   - 支持可选参数 `closeSquad: boolean`：置为 `true` 时将小队标为 `status: "closed"`（从活跃小队切换至历史关联区），**绝不调用 `thread/archive`**。
2. **扶正子会话至左侧主栏（`diy/squad/promote_member`）**：
   - 将指定 Worker 的 `sidebarHidden` 置为 `false`（可选同时将其他评审角色的未处理意见注入该 Worker 输入框草稿，并将小队标为 `closed`），使左侧主栏立即显现该会话，零上下文损耗转入单会话收尾。

### 3.4 同回合有界等待原语（`diy/squad/wait`）与「三等三不等 + 动态脱手」调度策略

在「纯异步投递（Post & Yield）」之外，提供跨异构引擎统一的**同回合有界等待原语**（`diy/squad/wait`、MCP `mycodex.squad_wait`、本地 CLI `squad-cli.mjs wait`），使主会话在短闭环任务中无需拆成多轮人工催问，同时严格防止长任务挂死对话或因权限审批卡死后台。

#### 3.4.1 接口契约与四态唤醒判定

```ts
export interface SquadWaitParams {
  squadId: string;
  sinceSeq?: number;        // 观察基准楼层（通常传刚完成的 post 返回的 entry.seq；默认当前末条 seq）
  targetHandles?: string[]; // 可选指定关注的成员 handle（如 ["@评审"]）；省略则关注所有活跃/待办 worker
  timeoutMs?: number;       // 0..120000，默认 30000（0 表示立即返回一次非阻塞状态快照）
}

export type SquadWaitOutcome =
  | "settled"      // 出现 seq > sinceSeq 的交棒/评审/代记结论且目标不再运行，或球已回到 @supervisor
  | "needs_human"  // 最高优先级立即唤醒：命中 blocked 账本、跳数刹车、交互审批/提问等待、投递失败或回合结束漏记账
  | "timeout"      // 到达 timeoutMs 窗口上限，目标仍在 running 或 queued
  | "idle";        // 当前无 running/queued 任务且无新进展
```

- **`needs_human` 立即唤醒条件（任一满足即刻返回，绝不等满 `timeoutMs`）**：
  1. 账本新增 `seq > sinceSeq` 且 `kind === "blocked"`（或评审结论为需要人工裁决）；
  2. `ledger.hopPausedForHuman === true`（已触发连续自动接力上限刹车）；
  3. 目标成员实时状态含人工交互阻塞（原生 `status.activeFlags` 包含 `waitingOnApproval` / `waitingOnUserInput`，或状态为 `needs_attention | error | systemError | failed`）；
  4. 目标成员最新未恢复投递处于 `state === "failed"` 或 `"sending"`（结果未决）；
  5. 目标成员最新派发回合已进入终态（`completed | failed | interrupted`）但未写入 `seq > delivery.seq` 的账本条目（即命中未回报 `missingReports` 或 CLI 后台回合因审批拒绝而 `failed`，返回时附带 `reason: "unreported_turn" | "turn_failed"` 与诊断摘要）。
- **防死锁与超时管道硬约束**：
  1. **严禁在 `SquadService.serial` 互斥锁内阻塞等待**：`wait` 仅在短快照读取时进入 `serial`（毫秒级释放），挂起期间监听内存状态变更通知（`changed` / `protocol` 回合完成通知 + 1s~2s 轻量复核与 `context.signal` 取消），确保等待期间 Worker 调用 `squad_post` 绝不死锁；
  2. **端到端超时对齐**：`mcp-server.mts`、`squad-cli.mts` 与 `desktop-gateway-ui.mts` 对 `diy/squad/wait` 的请求超时预算放宽至 `Math.min(130000, Math.max(15000, timeoutMs + 10000))`，避免 `timeoutMs > 15000` 时被底层 15 秒默认 RPC 超时提前截断；客户端 socket 断开或 MCP 请求取消时通过 `AbortSignal` 立即终止等待。

#### 3.4.2 模型调度准则（必须同步写入 `squad_post` / `squad_wait` 工具描述）

原语只提供机制；模型在调用 `squad_post` 派单后是否紧跟 `squad_wait`，遵循明确的**「三等、三不等、动态脱手」**准则：

1. **三等（同回合调用 `squad_wait` 闭环）**：
   - **闭环验收指令**：用户明确表达“让评审看完没问题就直接同步 / 盯到跑完告诉我结果”；
   - **关键路径短探针**：主会话下一步决策强依赖某子会话的只读查证、边界确认或快速审查（预期数十秒内返回）；
   - **小范围定点返工**：评审只抓到 1~2 处明确小问题，派回修复后同回合等待复核收口。
2. **三不等（`squad_post` 后立即结束当前回合，交还主会话控制权）**：
   - **重型长耗时开发/全量构建测试**：预期耗时数分钟以上，长挂会锁住主聊天输入框；
   - **用户仍在主会话并行讨论其他议题**：主会话需保持随时响应；
   - **开放式探索或人类审美拍板任务**：产出原型或方案草稿后本就需人亲自过目。
3. **动态脱手（Bounded Detach）**：
   - **遇 `needs_human` 立即脱手**：一旦 `squad_wait` 返回 `status: "needs_human"`（需审批、提问、跳数刹车、投递失败或漏记账），必须**立即结束等待**并向用户报告具体阻塞点与操作入口，**严禁对同一人工阻塞状态原地循环重调 `squad_wait`**；
   - **有界窗口上限**：默认单次等待 `30000ms`（常规最多连续等待 `1~2` 个窗口）；若到期仍为 `timeout`（目标仍在健康 `running`）且用户未明确要求“一直等到跑完”，主动结束本轮汇报当前进度，交由右上角小队胶囊后台跟踪。

---

## 4. 前端交互与宿主零侵入改造规格

### 4.1 彻底移除左侧栏分组 DOM 劫持（关键减负项）

1. **废弃 `bridge/desktop-sessions.mjs` 中的 `installDesktopSquads` 假分组 DOM 插入逻辑**：不再向 `.app-shell-left-panel` 插入自定义 `<section data-squad-id>`，不再篡改左侧栏分组树与项目文件夹结构。
2. **轻量可选的左侧栏行折叠**：仅对 `status === "active"` 小队中 `sidebarHidden !== false` 的 `worker` 会话行设置单行 CSS 隐藏属性（不移动 DOM 节点、不拦截后端 `thread/list` RPC）。若客户端未来版本更改行属性选择器，最坏退化仅是子会话在项目文件夹下正常露出，不产生任何功能异常。

### 4.2 独立一级抽屉入口与右上角上下文感知胶囊

1. **抽屉一级插槽扶正（`bridge/diy/workbench.mts` & `bridge/diy/work-panel.mts`）**：
   - 在 `workbench.mts` 的 `slots` 首项注册独立的 `{ id: "squad", label: "协作小队", mount: mountSquadPanel }`；
   - 从 `work-panel.mts` 中移除顶部混排的 `mountSquadPanel` 调用，并清理/隐藏已淘汰的旧 P3 五角色工位网格与 Wave 2 按钮（保留 `0028` 通用共同工作记录视图）。
2. **右上角触发胶囊动态感知（`bridge/diy/drawer.mts` & `workbench.mts`）**：
   - 监听宿主路由变化（复用 `hostActions.currentThreadId()`）：
     - 若当前会话关联了活跃小队（无论是 Supervisor 还是某个 Worker），胶囊显示 `✦ 小队 · ⟳1 · ✓2`（存在 `hopPausedForHuman` 或未记账提醒时显示琥珀色 `⚠`），打开抽屉时默认聚焦 `squad` 插槽并定位到当前关联小队；
     - 若当前是普通无小队会话，胶囊保持安静的 `✦ MyCodex`。
3. **二级分栏三段式高密度布局（`bridge/diy/squad-panel.mts`，严格采用 `squad-visual-spec.md` OKLCH Token）**：
   - **上段（导航与角色区）**：
     - 无小队时：展示**常备角色名片槽**（如 `@开发`、`@设计`、`@评审`，点击齿轮可从全量动态 `catalog` 改绑任意原生 Codex / API 来源 / CLI 模型及推理强度，支持 `+ 新增角色`），勾选角色 + 输入首条派单即可一键建队开跑；同时提供「⚡ 一键快审当前改动」快捷动作；
     - 有小队时：顶部显示 `28px` 小队区块头（队名 + `⟳ / ✓ / ⚠` 胶囊）与置顶 `★ 主会话 (SUPERVISOR)` 锚点行（从任意子会话一键切回主会话），下方紧跟 `36px` 紧凑单行成员卡（点击行调 `hostActions.openThread(id)` 秒切主视图聊天，分栏保持开启不闪退；点击右侧动作展开内联派单框或执行「代记回复 / 扶正独立」）。
   - **中段（Issue 交接账本时间线）**：
     - 按 `#1, #2, #3...` 展示简洁交接卡片（时间、`@发言者 -> @下一棒`、结论摘要、涉及文件胶囊、点击直达原会话）；若触发跳数刹车，顶部显著展示 `[继续放行下一跳]` 按钮。
   - **下段（Sticky 44px 收束操作条）**：
     - 提供 `[汇总回主会话 ↵]` 与 `[结束小队（保留全部会话）]`，**不包含任何默认自动归档勾选项**。
4. **Renderer 序列化红线提醒**：
   - `bridge/desktop-spine-ui.mts` 中的 `buildSpinePatch` 通过 `.toString()` 将 DIY 组件注入宿主页面。任何在 `bridge/diy/squad-panel.mts` 或新增辅助模块中引用的顶层函数/常量，**必须显式注册进 `buildSpinePatch` 闭包绑定**，严禁遗漏导致运行期 `ReferenceError`。
5. **轮询降频与事件驱动**：
   - 将原 `squad-panel.mts` 中无条件 `2000ms` 重轮询改为：依赖 `services.subscribe(kind === "squad")` 实时事件推送 + 仅在面板打开且存在 `running` 成员时以 `5000ms` 轻量拉取指定小队状态，避免阻塞串行队列。

---

## 5. 工具面收敛（MCP & 本地 CLI）

1. **MCP 工具精简与升级（`gateway/spine/mcp-server.mts`）**：
   - 新增/升级：`mycodex_squad_post`（按 `4+1` 标准写账本并可选唤醒 `nextHandle`）、`mycodex_squad_wait`（按 `sinceSeq` 与「三等三不等 + 动态脱手」准则做有界等待或 `timeoutMs: 0` 快照探测）、`mycodex_squad_ledger`（读取指定小队的完整 `ISSUE.md` / 结构化账本）、`mycodex_squad_roles`（读取常备角色表以便主会话直接按 `@开发`、`@评审` 名字拉人）；
   - 兼容保留：`squad_list`、`squad_create`、`squad_create_member`、`squad_brief`（内部转调 `assign` 记账）、`squad_report`（内部转调 `handoff/review` 记账）；
   - **下线废弃工具暴露**：移除旧 P3 的 `mycodex_work_upsert`、`mycodex_squad_dispatch`、`mycodex_squad_integrate`、`mycodex_squad_handoff` 的 MCP 注册（保留源码文件不动以防历史引用报错），释放工具配额并消除模型误调。
2. **本地 CLI 同步（`gateway/spine/squad-cli.mts`）**：
   - 同步支持 `post`、`wait` 与 `ledger` 子命令，使未配置 MCP 的外部 CLI Worker 或协调脚本也能通过单条命令向同一账本原子记账交棒或做有界等待。

---

## 6. 分步实施拆包与代码评审验收清单（与 `0032` 完全无冲突）

> **并行隔离声明**：本方案仅修改 `gateway/spine/squad-*.mts`、`gateway/spine/mcp-server.mts`、`bridge/diy/{workbench,drawer,squad-panel,work-panel}.mts`、`bridge/desktop-spine-ui.mts`、`bridge/desktop-sessions.mjs` 及对应 `tests/*squad*`。**严禁触碰 `0032` 正在开发的 `gateway/protocol.mts`、`gateway/state.mts`、`gateway/display-projector.mts`、`gateway/engines/*` 与 `bridge/translate.mjs`**。

### Step 1：后端账本、常备角色与防死循环引擎
- **文件**：`gateway/spine/squad-roles.mts`（新增）、`gateway/spine/squad-ledger.mts`（新增，含 `ISSUE.md` 物化）、`gateway/spine/squad-lite.mts`、`gateway/spine/squad-service.mts`、`gateway/spine/squad-commands.mts`、`gateway/spine/squad-cli.mts`、`gateway/spine/mcp-server.mts`。
- **验收点**：
  - `post` 原子记账 + `ISSUE.md` 生成格式校验；
  - Worker A `post(next: "@评审")` 自动唤醒空闲 Worker B；连续自动唤醒达 `maxAutoHops (3)` 时准确停机置 `hopPausedForHuman = true`，人工 `resume_hops` 后放行；
  - Worker 回合结束未记账（含多轮派单、CLI 后台审批失败无助手文本场景）时，准确按最新派发回合识别缺口并支持 `system_fallback` 诚实代记；
  - `wait` 有界等待在 `settled` / `needs_human` 时毫秒级立即唤醒，绝不锁死 `serial` 互斥队列，支持 `timeoutMs > 15000` 端到端无提前 RPC 超时及连接断开自动取消；
  - 下线 4 个旧 P3 MCP 工具后，`spine-mcp-test.mjs` 通过；
  - 全程 `archived` 状态保持 `false`，`thread/list` 完整返回所有子会话。

### Step 2：右侧隐藏二级分栏 UI、常备角色槽与左侧栏去劫持
- **文件**：`bridge/desktop-sessions.mjs`、`bridge/diy/drawer.mts`、`bridge/diy/workbench.mts`、`bridge/diy/squad-panel.mts`、`bridge/diy/work-panel.mts`、`bridge/desktop-spine-ui.mts`。
- **验收点**：
  - `buildSpinePatch` 序列化在隔离浏览器（Playwright/Puppeteer）中挂载零 `ReferenceError`；
  - 左侧栏不再插入假分组 DOM，仅对活跃 `sidebarHidden` worker 行做样式折叠，`promote_member` 后立即恢复显示；
  - 右上角胶囊随路由在普通会话与关联小队会话间准确切换状态摘要；
  - 面板完整呈现 OKLCH 双主题 36px 成员卡、常备角色一键拉起、Issue 账本时间线、主/子会话秒切、末条回复一键代记、以及无自动归档的安全收口。

### Step 3：门禁与清理纪律
- 必须使用 `node tools/typescript-task.mjs typecheck / build / test / check`（或 `tools/Invoke-HeavyTask.sh`）验证全绿；
- 不修改 `VERSION`、`NATIVE_PATCH_CHAIN.json`，不重启用户活跃客户端会话，清理全部 `/tmp` 隔离测试目录与子进程。
