# ADR 0032：异构模型与外部执行器的原生 UI 保真技术方案及方案治理清单

日期：2026-11-13（Asia/Shanghai）。状态：**已归档正式技术方案（Tech Spec & Review Baseline）**，供开发会话按阶段独立实施、架构会话逐项评审验收。与 `0031-model-sources-and-handoff.zh-CN.md`（会话创建后锁定执行引擎与模型来源）配套生效，并替代早期 P3 重型执行方案与单层 `dynamicToolCall` 透传假设。

## 1. 问题背景与核心定位

Codex 官方体系内部通过两条标准切口降低模型、执行内核（Rust Harness）与多端界面（Desktop / VS Code / CLI）之间的协同成本：

```text
推理模型 ──[切口 1: ModelInfo + Responses SSE]──► Codex Rust Harness ──[切口 2: App-Server v2 RPC]──► Codex Desktop UI
```

MyCodex 的异构接入本质上分别工作在这两个切口上，面对两类性质不同的问题：

1. **推理平面（Model Plane，切口 1）**：保留原生 Codex Rust Harness（100% 继承宿主沙箱、MCP、Computer Use 与原生卡片生成），将后端推理替换为 GitHub Copilot 或第三方 `Chat Completions` / SDK 模型。核心矛盾是**模型协议信号有损与后训练先验失配**。
2. **显示平面（Display Plane，切口 2）**：由外部独立 Agent 执行器（Claude Code、Gemini CLI、Copilot CLI、Antigravity）自管会话、工具与各自 MCP，Codex 仅承担工作台与显示器职责。核心矛盾是**外部执行流向 Codex 原生 UI 卡片的合成投影**。

本标准确立两条总原则：
- **借力官方解耦抽象，不自造平行中间层**：推理平面直接复用官方 `ModelInfo`（`model_catalog_json`）作为声明式能力底座；显示平面直接复用官方 `app-server v2` 的三拍生命周期（`item/started` -> `*Delta` -> `item/completed`）与 `ThreadItem` 契约，不另发明冗余的私有事件方言。
- **零静默有损与诚实降级（Fail-Closed & Honest Fallback）**：模型输入无法无损表达时明确报错阻断，绝不静默丢弃上下文；UI 卡片缺少事实字段时自动退回通用工具卡，绝不伪造退出码、路径或可跳转会话句柄。

---

## 2. 卷一：推理平面标准（原生 Harness + 异构模型）

### 2.1 声明式能力底座（基于 `ModelInfo` 扩展）

不通过模型名称硬编码分支，统一由目录生成层（`bridge/catalog.mjs`）产出符合原生核心 Schema 的 `ModelInfo`，并在扩展命名空间记录传输方言能力：

| 能力维度 | `route = "responses"` | `route = "chat"`（基础兼容档） | `route = "chat"`（已验证强模型档，后续演进） |
| --- | --- | --- | --- |
| 传输通道 | HTTP SSE / WebSocket v2 | 强制 HTTP（`prefer_websockets: false`） | 强制 HTTP（`prefer_websockets: false`） |
| 补丁工具 | `apply_patch_tool_type: "freeform"` | 保持 `"freeform"`，桥接层单层 `{ input }` 封装还原 | 同左 |
| 搜索与实验工具 | 保留模板原配置 | 关闭服务端 `web_search` 与未验证实验工具 | 按实测能力白名单显式开启 |
| 工具编排模式 | 保留 `tool_mode`（如 `code_mode_only`） | 默认移除 `tool_mode`，走标准函数调用 | 经实测通过后可开启 `code_mode_only` |
| 系统指令模板 | 原生双通道模板 | 独立通用单流模板规则（去除 `multi_tool_use.parallel` 及 `commentary/final` 通道假设） | 配合桥接层 `phase` 推导对齐步骤折叠 |

> 单流指令已归档为 `assets/chat-instructions.md`：基于仓内官方 gpt-5.4 模板完整保留工作区、文件链接、编辑、评审与前端契约，仅替换不兼容的双通道/parallel-tool 指令及模型身份，并移除当前核心不再展开的 personality 占位符。目录不再为该占位符额外复制风格变量。本机 codex-cli 0.167.0-alpha.4.1 按字面量处理该模板；不宣称恢复已不受支持的 friendly/pragmatic 原生风格选择。不能将“单流适配”理解为删减工作契约。

### 2.2 `Responses <-> Chat` 编译器守卫规则

1. **输入准入守卫（禁止静默丢弃）**：
   - 遇到无状态接口无法还原的 `previous_response_id`、`compaction`、`item_reference` 或未提取内容的 `input_file`，必须在发往上游前直接返回 HTTP `400`（`code: "unsupported_input"`）并记录错误审计。
2. **Schema 分级降维（Lowering）**：
   - 优先将非递归本地 `$ref`、单元素组合关键字及属性级可空联合（`anyOf: [T, null]`）化简为原生单层 JSON Schema；
   - 仅对无法无损拍平的根级互斥多态联合（`oneOf` / `anyOf`）或开放必填字段回退至可逆的 `{ input: "<JSON string>" }` 包装，保留完整原始 Schema 文本。
3. **反向流状态保真（含待修缺陷归口）**：
   - **延迟工具定型**：流式 `tool_calls` 必须缓冲至收到非空 `function.name` 后再发射 `response.output_item.added`，确保 `custom`、`tool_search` 与命名空间身份准确还原。
   - **截断与过滤诚实终止**：`finish_reason: "length" | "content_filter"` 必须映射为 `response.incomplete`（附 `incomplete_details`），严禁将未闭合的工具参数标记为 `completed`。
   - **思考流与步骤阶段还原（立项优先修复项）**：当上游流返回 `delta.reasoning_text` / `delta.reasoning_content` 时，映射为 `reasoning` item 及 `response.reasoning_summary_text.delta` 事件以恢复“Thought for Xs”折叠卡片；当单轮流后续伴随 `tool_calls` 时，前置文本消息标记 `phase: "commentary"`，无工具调用的终态文本标记 `phase: "final_answer"`，恢复客户端工作流时间线聚合折叠。
   - **单网关收敛目标**：后续应将 `gateway/google-provider.mts` 的请求/流转换收敛至同一套编译中间层，消除双处重复维护。

---

## 3. 卷二：显示平面标准（外部 Agent 执行器 -> Codex 原生 UI）

### 3.1 核心工程机制（对齐官方三大解耦设计）

外部 CLI 会话不经过原生 Codex Rust Harness，由 `gateway` 直接实现 `app-server v2` 显示协议。为实现后端适配器与前端 UI 版本的双向解耦，严格复用官方验证过的三项机制：

1. **三拍权威终态自愈（Three-Beat Authoritative Lifecycle）**：
   - 所有卡片统一遵循 `item/started`（建卡占位） -> `*Delta`（纯展示流式增量） -> `item/completed`（全量权威终态快照整卡覆盖）。
   - `Delta` 仅负责实时滚动反馈，不作为持久真值；窗口晚连接、重连或局部截断均由 `item/completed` 终态对象一次性自愈。
2. **原始真值与最佳努力语义提示分离（Raw Truth + Best-Effort Hint）**：
   - 参照 `commandExecution` 将 `command`（必填保底真值）与 `commandActions`（`read | search | listFiles | unknown` 美化提示）分离的模式：前端识别提示则渲染紧凑胶囊，不识别或解析不足则自动回退标准终端框，永不因美化失败丢失原始信息。
3. **事实落盘与视图投影分离（Rollout Storage vs View Projection）**：
   - 参照原生 `rollout.jsonl` 不直接存储前端 `v2/ThreadItem` 的设计，`StoredThread` 落盘稳定的底层事实记录（保留原始参数、工作目录、退出码、补丁与完整状态），在 `thread/read` 与 `thread/turns/list` 出口实时经过同一纯函数投影为当前客户端版本的 `v2/ThreadItem`，实现客户端跨版本升级**零历史数据迁移**。

```text
Claude SDK / Gemini ACP / Copilot SDK
        │
        ▼  （各适配器仅调用类型安全的 DisplaySink，不直接拼接 JSON-RPC）
Gateway Display Projector（gateway/display-projector.mts，唯一 v2 出口）
        │
        ├──► 实时流：item/started -> *Delta -> item/completed / turn/*Updated / requestApproval
        └──► 存储层：StoredThread 保存规范化 StoredTurnRecord，读取出口按需实时投影为 v2 ThreadItem
```

### 3.2 技术方案：TypeScript 核心接口与存储契约

在 `gateway/contracts.mts` 与新增的 `gateway/display-projector.mts` 中定义向后兼容的扩展契约（保留既有 `onText` / `onTool` / `onImage` 兼容旧测试引擎，新增可选结构化通道 `display`）：

```ts
/** 磁盘持久化事实记录（StoredThread.turns[].items 扩展联合类型，兼容 schemaVersion: 1） */
export type StoredDisplayRecord =
  | { id: string; type: "reasoningRecord"; summary: string[]; status: "inProgress" | "completed" | "failed" }
  | {
      id: string;
      type: "commandRecord";
      command: string;
      cwd: string;
      actionHint?:
        | { type: "read"; path: string; name: string }
        | { type: "search"; query: string | null; path: string | null }
        | { type: "listFiles"; path: string | null }
        | { type: "unknown" };
      output: string | null;
      exitCode: number | null;
      durationMs: number | null;
      status: "inProgress" | "completed" | "failed" | "declined";
    }
  | {
      id: string;
      type: "fileChangeRecord";
      changes: { path: string; kind: "add" | "update" | "delete"; movePath?: string | null; diff: string }[];
      status: "inProgress" | "completed" | "failed" | "declined";
    }
  | {
      id: string;
      type: "mcpCallRecord";
      server: string;
      tool: string;
      arguments: unknown;
      result: { content: unknown[]; structuredContent?: unknown } | null;
      error: { message: string } | null;
      durationMs: number | null;
      status: "inProgress" | "completed" | "failed";
    }
  | {
      id: string;
      type: "webSearchRecord";
      query: string;
      action: { type: "search"; query?: string | null; queries?: string[] | null }
        | { type: "openPage"; url?: string | null }
        | { type: "findInPage"; url?: string | null; pattern?: string | null }
        | { type: "other" } | null;
    }
  | { id: string; type: "imageViewRecord"; path: string }
  | { id: string; type: "planRecord"; explanation: string | null; steps: { step: string; status: "pending" | "inProgress" | "completed" }[] };

/** 供各 CLI 适配器调用的语义写入器（由 GatewayProtocol 在单 Turn 作用域内实例化） */
export interface DisplaySink {
  thinkingDelta(id: string, delta: string): void;
  thinkingDone(id: string): void;
  commandStart(input: { id: string; command: string; cwd: string; actionHint?: Extract<StoredDisplayRecord, { type: "commandRecord" }>["actionHint"] }): void;
  commandOutputDelta(id: string, delta: string): void;
  commandEnd(input: { id: string; status: "completed" | "failed" | "declined"; output?: string | null; exitCode?: number | null; durationMs?: number | null }): void;
  fileChangeStart(input: { id: string; changes: { path: string; kind: "add" | "update" | "delete"; movePath?: string | null; diff: string }[] }): void;
  fileChangeEnd(input: { id: string; status: "completed" | "failed" | "declined"; changes?: { path: string; kind: "add" | "update" | "delete"; movePath?: string | null; diff: string }[] }): void;
  planUpdate(input: { explanation?: string | null; steps: { step: string; status: "pending" | "inProgress" | "completed" }[] }): void;
  mcpStart(input: { id: string; server: string; tool: string; arguments: unknown }): void;
  mcpEnd(input: { id: string; status: "completed" | "failed"; result?: unknown; errorMessage?: string | null; durationMs?: number | null }): void;
  webSearch(input: { id: string; query: string; action?: Extract<StoredDisplayRecord, { type: "webSearchRecord" }>["action"] }): void;
  imageView(input: { id: string; path: string }): void;
  requestCommandApproval(input: { itemId: string; command: string; cwd: string; reason?: string | null }): Promise<"accept" | "acceptForSession" | "decline" | "cancel">;
  requestFileApproval(input: { itemId: string; reason?: string | null }): Promise<"accept" | "acceptForSession" | "decline" | "cancel">;
}
```

**单一投影纯函数契约**：
- `projectStoredItemToV2(item: ThreadItem | StoredDisplayRecord): V2ThreadItem`：集中完成字段命名转换、命令动作补全（缺失 `actionHint` 时填 `{ type: "unknown", command }`）以及字节上限裁剪（单条输出上限 `128 KiB`）。历史旧会话中的 `ToolItem(dynamicToolCall)` 原样直通，无需迁移旧文件。
- **唯一出口挂载点**：在 `gateway/protocol.mts` 的 `publicTurn(turn)`（原第 22 行；以符号定位，行号随 import 漂移）中统一对 `value.items` 调用 `projectStoredItemToV2`。严禁在 `thread/read`、`thread/resume`、`thread/turns/list`、`turn/completed` 各处分散重复拼装卡片结构。实时卡片也调用同一纯函数。实际完整类型位于 `gateway/display-contracts.mts`，由 `contracts.mts` 引用/导出；命令与文件事实可附 `source: { tool, arguments }`，不向客户端泄露存储字段。

### 3.2.1 关键时序修复：`GatewayProtocol.execute()` 分段消息状态机

**实施前缺陷（已修复源码，见 5.0）**：原 `GatewayProtocol.execute()` 在 `turn/started` 时预先创建唯一一个 `phase: "final_answer"` 的空 `agentMessage`，将 CLI 多步工具调用之间的所有过渡文本拼接到同一个消息块内，直到回合结束才 `turn.items.push(item)` 倒插至末尾，导致：**（a）文字与工具卡片时序倒置；（b）中间说明缺少 `phase: "commentary"` 无法折叠进工作流步骤组**。

**目标状态机规格**：
1. 移除回合开头的预建空 `agentMessage`，改为按事件到达顺序**懒创建当前活跃文本段** `activeText: { id: string; text: string } | null`。
2. 当 `onText(delta)` 到达时：若 `activeText === null`，创建新段（初始流态 `phase: "commentary"`）并发射 `item/started`，随后发射 `item/agentMessage/delta`（全回合累计文本上限仍保持 `1 MiB`）。
3. 文本段首次创建时即按到达顺序插入 `turn.items`。当任何非文本事件开始时（`thinkingDelta` 首次触发、`commandStart`、`fileChangeStart`、`mcpStart`、`webSearch`、`imageView` 或旧 `onTool(start)`）：若 `activeText !== null`，立即以 `phase: "commentary"` 发射 `item/completed`，重置 `activeText = null`，不得重复插入该段。
4. 当 `run()` 正常结束进入收尾时：
   - 若 `activeText !== null`，将其标记为 `phase: "final_answer"` 并发射 `item/completed`；
   - 若 `activeText === null`，不重复闭合或升级已完成项；若回合以工具结束且模型未再输出总结文本，不伪造空文本消息。异常或中断时，活跃文本段以 `commentary` 闭合。

### 3.2.2 出口与 itemsView 的精确施工契约

投影顺序固定为 `structuredClone(turn)` → 剔除 `nativeStartEventId` → 每项 `projectStoredItemToV2` → userMessage 的 `publicInput` 规范化 → 视图过滤。所有步骤不修改 ThreadStore，不迁移旧 JSON。线程列表/恢复经 `publicThread` 调用；`thread/items/list` 从投影后的 turn 展平。未知的历史通用卡克隆直通，不将新 Record 类型透传给客户端。

| 出口 / 视图 | 精确结果 |
| --- | --- |
| `thread/read`、`thread/resume`、`turn/completed`、`thread/items/list` | 保留全部已投影卡片及实际发生顺序。 |
| `thread/turns/list` 不传 itemsView | 等价 `summary`。 |
| `itemsView: "notLoaded"` | `items: []`，保留 turn 元数据及分页游标，不进行额外工具执行。 |
| `itemsView: "summary"` | **仅**保留 `userMessage / agentMessage / imageGeneration`，且保留所有分段 agentMessage（含 commentary）；排除 reasoning、commandExecution、fileChange、mcpToolCall、webSearch、imageView、plan 与 dynamicToolCall。 |
| `itemsView: "full"` | 全部已投影项，不额外筛选。 |
| 其他 itemsView | `-32602`，不静默回落默认视图。 |

摘要中的工具缺席是显式视图合同，不是落盘丢失；客户端展示工具历史必须请求 full 或 items/list。不可通过把工具塞入摘要来绕过客户端分页语义。

### 3.3 原生卡片映射与各 CLI 字段提取细则（对齐 `app-server v2`）

适配器按真实拿到的结构化事实调用投影 Builder，对应点亮以下 Codex 内置组件；必填事实缺失时一律降级为 `dynamicToolCall`：

| 场景语义 | 目标 `v2` 卡片 / 通知 | 必填事实字段与映射规则 | 典型外部来源 |
| --- | --- | --- | --- |
| **思考过程** | `ThreadItem(reasoning)` + `item/reasoning/summaryTextDelta` | 流式思考文本推入 `summary` 增量，结束发 `item/completed` | Claude `thinking_delta`、ACP `agent_thought_chunk` |
| **文件读取 / 搜索 / 列目录** | `ThreadItem(commandExecution)` | 填入 `command`、`cwd`，`commandActions` 按语义填 `read`（含 `path`、`name`）、`search`（含 `query`、`path`）或 `listFiles`（含 `path`），点亮紧凑文件/搜索胶囊 | Claude `Read / Grep / Glob / LS`、ACP `kind: "read" \| "search"` |
| **Shell 命令执行** | `ThreadItem(commandExecution)` + `item/commandExecution/outputDelta` | `commandActions: [{ type: "unknown", command }]`；流式日志做单条字节上限截断（128 KiB）后推送增量，结束填入真实 `exitCode` 与 `durationMs` | Claude `Bash`、ACP `kind: "execute"`、Copilot shell 工具 |
| **代码与文件修改** | `ThreadItem(fileChange)` + `turn/diff/updated` | `changes: [{ path, kind: { type: "add" \| "update" \| "delete" }, diff }]`；同回合累积统一补丁同步推送 `turn/diff/updated` 点亮右上角变更抽屉 | Claude `Edit / MultiEdit / Write`、ACP `content.type === "diff"` |
| **任务计划与进度** | `turn/plan/updated`（可选伴随 `ThreadItem(plan)`） | `plan: [{ step, status: "pending" \| "inProgress" \| "completed" }]`，点亮输入框上方悬浮进度卡片 | Claude `TodoWrite`、ACP `plan` 更新 |
| **网页搜索与抓取** | `ThreadItem(webSearch)` | `query` 及 `action: { type: "search" \| "openPage" \| "findInPage" }` | Claude `WebSearch / WebFetch`、ACP `kind: "fetch"` |
| **图片查看与产出** | `ThreadItem(imageView)` / `ThreadItem(imageGeneration)` | 本地受控图片读取映射 `imageView({ path })`；产出图片经 `MediaStore` 校验落盘后映射 `imageGeneration` | 各 CLI 读图工具及多模态输出 |
| **外部自管 MCP 调用** | `ThreadItem(mcpToolCall)` | 解析 `server`、`tool`、`arguments`、`result` / `error`、`durationMs`；`mcpAppUi` 固定置 `null`（不穿透宿主沙箱 iframe） | Claude `mcp__<server>__<tool>`、各 CLI 挂载的 MCP |
| **未归类 / 字段不足工具** | `ThreadItem(dynamicToolCall)` | `namespace: thread.engineId`、`tool`、`arguments`、`contentItems`（现有兜底行为） | 任意自定义或缺少结构化参数的工具 |

**各适配器精确字段提取规则（禁止猜测未声明字段）**：

1. **Claude Code（`gateway/engines/claude-code.mts`）**：
   - 流式思考：监听 `message.type === "stream_event"` 中 `content_block_start(thinking)` 与 `content_block_delta(thinking_delta)`，调用 `display.thinkingDelta(blockId, delta.thinking)`；`content_block_stop` 时调用 `display.thinkingDone(blockId)`。
   - `Read`：`input.file_path` 为非空绝对路径时映射 `commandRecord`，`command: "Read " + JSON.stringify(file_path)`，`actionHint: { type: "read", path: file_path, name: path.basename(file_path) }`；该 command 是描述性真值，不交给 shell 执行。
   - `Grep` / `Glob`：仅在 pattern 为非空字符串时映射 `commandRecord`，`actionHint: { type: "search", query: input.pattern, path: typeof input.path === "string" && input.path ? path.resolve(cwd, input.path) : null }`；不使用 String() 把非法对象强转为查询。
   - `LS`：映射 `commandRecord`，`actionHint: { type: "listFiles", path: typeof input.path === "string" ? input.path : cwd }`。
   - `Bash`：`typeof input.command === "string"` 时映射 `commandRecord`，`actionHint: { type: "unknown" }`；从 `tool_result` 提取输出文本与退出状态（`is_error === true` 时 `status: "failed"`，未提供明确整数退出码时 `exitCode: null`，严禁在失败时伪造 `0` 或 `-1`）。
   - `Edit` / `MultiEdit` / `Write`：以 cwd 内有界普通 UTF-8 文件的工具执行前快照构造完整 unified diff；验证替换定位与 replace_all，不用片段冒充文件第 1 行。缺少前后事实、越界路径、符号链接、非 UTF-8、过大或歧义替换时回退 `dynamicToolCall`，不执行显示层补丁。
   - `TodoWrite`：todos 为最多 100 项数组，每项 content 为非空字符串且 status 为已知三态；`in_progress / inProgress -> inProgress`、`completed -> completed`、`pending -> pending`。未知状态回退通用卡；只在工具成功后更新计划，不把请求当成已执行结果。
   - `WebSearch` / `WebFetch`：`input.query` 或 `input.url` 存在时映射 `webSearchRecord`（`search` 或 `openPage`）。
   - `mcp__<server>__<tool>`：匹配 `/^mcp__(.+?)__(.+)$/`，首个双下划线分隔 server 与 tool，保留单下划线。名称只表示显示身份，不提高信任或授予宿主 MCP 权限。
2. **ACP 引擎共享提取器（新增 `gateway/engines/acp-display.mts`，供 `gemini-cli.mts` 与 `antigravity.mts` 共用）**：
   - `sessionUpdate === "agent_thought_chunk"` 且 `content.type === "text"` -> `display.thinkingDelta`。
   - `sessionUpdate === "plan"` 且 `Array.isArray(update.entries)` -> 映射 `entries`（`content -> step`，`status` 归一为三态）调用 `display.planUpdate`。
   - `sessionUpdate === "tool_call" | "tool_call_update"`：
     - 若 `content` 含 `{ type: "diff", path, oldText, newText }` -> 生成 unified diff 映射 `fileChangeRecord`；
     - 若 `kind === "read"` 且 `locations?.[0]?.path` 存在 -> `commandRecord(read)`；
     - 若 `kind === "search"` -> `commandRecord(search)`；
     - 若 `kind === "execute"` 且 `rawInput.command` 为非空字符串 -> `commandRecord(unknown)`；不把 title 当成实际 shell 命令；
     - 其余 -> 回退 `dynamicToolCall`。
### 3.3.1 逐工具字段公式与预算（实现/评审共用）

以下 `i = object(tool_use.input)`；`cwd = RunContext.cwd`；`P(x) = path.resolve(cwd, x)`；`B(x) = path.basename(x)`。函数只生成展示事实，不执行 command、URL 或 diff。所有启动均以真实 SDK tool id 关联，网关另分配 UUID；同 id 不重复建卡，迟到/重复终态不重放工具。保留有界原始 source 参数，实时投影不暴露 source。

| Claude 工具 | 准入、字段提取与闭合公式 |
| --- | --- |
| Read | `typeof i.file_path === "string" && path.isAbsolute(i.file_path)`；command 为 `Read + JSON.stringify(path)`；read.path 原路径，read.name = B(path)。offset/limit 等不猜测，保留在 source。 |
| Grep | pattern 非空；command = `"Grep " + JSON.stringify(i)`；search.query = pattern；search.path = 非空 path ? P(path) : null。 |
| Glob | 与 Grep 相同，command 前缀为 Glob；pattern 是 glob 表达式，不冒充正则。 |
| LS | path 缺省用 cwd；非空字符串用 P(path)；listFiles.path 同该值；非法 path 类型降级。 |
| Bash | command 为非空字符串；command 原样保留，cwd 使用上下文；unknown 动作；工具结果 is_error 为 true 时 failed，其余 completed；没有结构化整数 exitCode 时 **null**，不得从“成功”推算 0。 |
| Edit | file_path 为绝对路径且真实位置在 cwd 内；读取至多 96 KiB 的普通文件，验证 UTF-8/非二进制；old_string 非空，new_string 允许空；唯一匹配时替换，多个匹配只允许 replace_all 为 true；以完整 before/after 生成 update diff。 |
| MultiEdit | 与 Edit 相同；edits 为 1–100 项数组；按数组顺序在上一步 after 上应用相同替换规则，任何一步失败整项降级，不拼接伪 hunk。 |
| Write | content 必须字符串；存在文件读取有界 before，kind=update；不存在且 cwd 内父目录可验证时 before=""、kind=add；不根据空内容猜测 delete。 |
| TodoWrite | `todos[].content -> steps[].step`，单步最多 4096 UTF-8 字节、最多 100 步；status 严格按上文三态，成功结果才发 turn/plan/updated。 |
| WebSearch | 非空 query；query 原样，action={type:search, query}；成功结果后建卡，失败不伪造已成功搜索。 |
| WebFetch | url 必须能解析且协议为 http/https；query=url，action={type:openPage,url}；不请求该 URL，只展示 CLI 已执行的动作。 |
| mcp__* | 按首分隔符取 server/tool，arguments=i；result 从 tool_result.content 的有界安全内容生成；is_error -> failed+error.message；mcpAppUi/appContext/pluginId 固定 null。图片走 MediaStore，不把 base64 作为终端正文无限保存。 |
| 未知 / 字段不全 | dynamicToolCall 保留 namespace=engineId、工具名、受限参数和结果，不伪造 command/path/diff/exitCode。 |

结果文本仅从结构化文本块或明确字符串取得；其余安全 JSON 显式保留。持续日志可用时通过 commandOutputDelta 推送；只有最终结果的 SDK 不伪造中间流。durationMs 只有明确非负安全整数才保存，否则 null。

| ACP 更新 | 精确提取与降级规则 |
| --- | --- |
| agent_thought_chunk | content 必须非数组且 type=text、text 为字符串；同一连续思考段按 turn 内序号分配 id，正文/工具/plan 前 thinkingDone。 |
| plan | entries 按 Claude TodoWrite 的 content/status 公式；无效形状明确报错，不把未知状态强行 pending。 |
| tool_call / tool_call_update | 按 toolCallId 合并已提供字段；缺字段的补丁不清空旧值，终态去重。pending/in_progress 不是 completed；第一次能够分类时建卡，终态仍不能分类则通用卡。 |
| diff 内容 | 优先于 kind；每块明确 path/oldText/newText 才生成完整 unified diff，路径用 P(path)；不能证明前后状态则通用卡。 |
| kind=read | locations[0].path 必须存在，title 为非空原始动作说明；command=title，read.path=P(location.path)，name=B(path)。 |
| kind=search | title 非空；command=title，query 仅取字符串 rawInput.pattern，否则 null；path 仅取 locations[0].path，否则 null。 |
| kind=execute | command 只取非空 rawInput.command，cwd=上下文，unknown 动作；rawOutput.exitCode/durationMs 只有严格结构化数值才采用。 |
| 其他 kind / 不充分事实 | 原始 title/rawInput/content 安全降级；不从标题正则猜文件修改、shell 退出码或 MCP 服务器。 |

Copilot 使用 SDK 明确提供的 reasoningId/deltaContent、shellToolInfo 与原始 arguments.command、shellExecution.exitCode、mcpConfigServerName（优先）/mcpServerName + mcpToolName；原生命令审批只在 shell 权限给出 toolCallId/fullCommandText 时启用。字段不齐继续旧通用卡/问卷权限，不从工具名称猜测。当前字段依据为官方 SDK 1.0.32 类型，旧 SDK 缺省兼容；此项不声称旧安装版本具有新字段。

统一预算：参数 64 KiB、单结果/单 diff 128 KiB、思考 1 MiB、显示累计 2 MiB/512 项；超大参数降级并显式保留 truncated 预览，输出按 UTF-8 边界裁剪；预览 before+after 额外限制为 96 KiB。计划 100 项/每步 4096 字节。媒体另受 MediaStore 10 MiB/张、16 张/事件及线程限额约束。预算达到后不能继续积累无限内存；不逐 token 写盘。

### 3.4 原生审批投影规范（Approval Projection）

1. **命令审批**：当外部 CLI 请求执行命令且持有明确命令文本时，先确保对应 `commandExecution` 处于 `inProgress`，再发送 `item/commandExecution/requestApproval`（`availableDecisions: ["accept", "acceptForSession", "decline", "cancel"]`）。请求的 command/cwd 必须与该事实项相同，否则取消；两类审批均包含 `threadId / turnId / itemId / startedAtMs`。不下发 `proposedExecpolicyAmendment` 或网络策略修订项，避免误导用户以为写入了原生 Codex 策略文件。
2. **文件写入审批**：当外部 CLI 请求修改文件且可构造预览补丁时，先发出 `inProgress` 的 `fileChange`，再发送 `item/fileChange/requestApproval`。
3. **通用权限与业务提问**：其余权限请求与多选/自由文本追问继续使用 `item/tool/requestUserInput`。
4. **组织策略优先**：CLI 侧受管强制询问标记（如 `managedApprovalRequired`、`serverPolicyAskOnly`、`decisionReasonType: "rule" | "safetyCheck"`）优先级高于网关 `auto` 审批模式，保持原安全边界不变。

### 3.5 明确不穿透的能力边界（防止伪造交互）

以下 Codex 原生 UI 能力依赖原生 Rust Harness 内部句柄或宿主专属后端，外部 CLI 路径明确标为不支持，禁止伪造假控件：

1. **可输入交互式终端面板**（`TerminalInteraction` / 右侧实时 PTY 输入）：外部 CLI 子进程不暴露 PTY，终端卡片仅作只读流式输出展示。
2. **内嵌交互式 MCP App 画布**（`mcpAppUi`）：外部 CLI 的 MCP 连接与宿主隔离，固定为静态结果卡片。
3. **单步原子回滚**（`ThreadReverted` / Undo Turn）：在目标 CLI 未提供可验证的工作区+会话同步回滚原语前，不暴露回滚入口。
4. **运行中插话转向**（`TurnSteer` / Queued 胶囊）：外部 CLI 维持单回合串行运行，运行期仅支持 `turn/interrupt` 中断。
5. **进程内子代理点击跳转**（`subAgentActivity` / `collabAgentToolCall`）：该卡片必填可由客户端调用 `thread/read` 打开的真实 `agentThreadId`。仅对 **Squad Lite** 创建的真实 Worker 会话开放跳转；Claude Task 父项保留通用工具卡，`parent_tool_use_id` 子流显示为内联 reasoning 折叠摘要，父项结果到达时闭合。不伪造官方父子线程关系或虚拟 threadId。

### 3.6 存储与视图读取兼容规则

1. **读写解耦**：`StoredThread`（`gateway/state.mts`）保存网关规范化的稳定语义记录，向后兼容既有 `schemaVersion: 1` 中的 `dynamicToolCall`、`userMessage`、`agentMessage`、`imageGeneration`。不在磁盘文件中硬编码未受控的临时前端字段。
2. **列表视图**：遵守 3.2.2 的精确过滤；summary 不放工具，full 与实时重连出口完整投影。不得把“所有视图都显示全量”误作保真修复。
3. **崩溃恢复一致**：沿用 `ThreadStore` 现有的启动恢复规则——若网关异常退出时某条 `StoredDisplayRecord` 仍处于 `inProgress`，重启加载时统一收敛为 `failed`，绝不自动重放外部副作用。

---

## 4. 与 Codex UI 同步演进的自动化门禁（防掉队与防破坏）

为避免人工跟踪滞后或客户端升级破坏现有会话，建立双向契约门禁：

1. **官方 Schema 实时提取校验**：测试套件调用本机安装的 `codex app-server generate-json-schema --experimental`，获取当前客户端权威的 `v2/ItemStartedNotification.json`、`v2/Turn*Notification.json` 与 `ServerRequest.json`，对 `DisplayProjector` 产出的全部卡片和审批负载做结构校验。
2. **UI 能力覆盖账本（Coverage Ledger & Drift Audit）**：维护显式账本文件，将官方导出的全部 `ThreadItem` 变体与核心通知逐项标记为：
   - `projected`（已实现投影）；
   - `unsupported_by_boundary`（见 3.4 节物理隔离项，附原因）；
   - 新版 Codex 升级出现未登记的变体或新增必填字段时，审计测试立即输出差集清单，将“被动撞坑发现差距”转为“升级当天自动生成待办账单”。
3. **推理模板差集审计**：当更新 `assets/catalog-templates.json` 时，自动对比新旧模板的 `ModelInfo` 字段集与系统指令锚点，防止上游新增模型能力开关或修改指令措辞时桥接层静默失效。

---

## 5. 分阶段立项路线图

### 5.0 实施记录（2026-11-13，本地源码）

- Phase 0 已实现源码：`bridge/translate.mjs` 只将非空 `reasoning_text`（优先）或 `reasoning_content` 转换为有序摘要事件；`reasoning_opaque` 在 Chat 路径忽略，不写入 output 的 encrypted_content，opaque-only 不创建卡片、不闭合或拆开当前正文。正文、工具开始前闭合可读思考项；含工具调用的整个 Chat 响应中文本均为 `commentary`，仅无工具调用且正常结束的活跃末段为 `final_answer`；截断末段保留 `commentary`。
- Phase 1 前置时序修复已实现源码：`GatewayProtocol.execute()` 按首次文本事件创建并立即按序插入文本段，工具/图片开始前闭合前段，正常收尾闭合末段；异常与中断保留 `commentary`；全回合文本按 UTF-8 字节累计限制为 1 MiB。不生成空文本项。
- 隔离验证覆盖流式/非流式翻译、SSE 顺序与递增序号、多段文本、旧历史回读、工具后恢复正文、纯工具回合及原生 app-server 的思考摘要通知与最终文本 phase。原生测试使用合成上游、本机已安装核心及临时 profile，不证明真实供应商推理或 Desktop 视觉折叠效果。
- Phase 1–3 已进入本地源码：DisplaySink、事实存储/恢复与统一投影、Claude/ACP 逐工具映射、基础原生审批、MCP/网页/受控图片、无虚拟跳转的子任务摘要、Copilot 可验证字段映射、官方 Schema/覆盖账本门禁、独立 Chat 模板与 Google 方言适配。验证结果以本次最终检查记录为准；本记录不表示当前工作窗口加载、真实供应商验证或正式发布。
- 初轮本地门禁：**469/469 通过、0 跳过**；严格类型、构建指纹、237 个模块/563 个相对 import 校验通过，官方 Schema 为本机 `codex-cli 0.167.0-alpha.4.1` 导出。该计数是初轮证据，不替代评审修订后的复验。38 份既有文档清单、重号、Markdown 围栏/本地链接及差量空白检查通过。完整命令、源码快照和未验证边界见[验证记录](evidence/2026-11-13-display-standard.json)。本次未执行正式发布、原工作窗口重启或真实供应商账号推理。
- 首轮评审修订：恢复官方 Chat 工作契约及 personality 变量；含工具调用的 Chat 末段保持 commentary；Schema 测试动态加载 Ajv。当时相关 88/88 通过，但其中“保留 opaque 输出、跨轮拒绝 reasoning”的规则已被下述 P0 更正淘汰，不能继续作为准入依据。无 node_modules 的可选/强制模式隔离验证记录保留；独立 personality 实核复审结论见另存的 rereview 证据，不能仅凭占位符存在宣告原生风格注入可用。
- P0 更正：原生核心会将桥接层返回的 reasoning 项带入工具结果回传或后续用户轮次，因此先写 encrypted_content 再拒收会造成自锁。Chat 输出不再包含 opaque 状态，输入跳过 reasoning/web_search_call 元数据，保留完整物化的 message/function_call/function_call_output。原生工具往返测试同时注入可读思考和合成 opaque token，检验工具执行后的请求及下一用户轮均正常 completed；最新结果以验证记录中的 opaqueRoundTripFix 为准。没有修改并行 Squad 源码或活跃运行时。
- personality 最小收口：采纳实核复审，删除 Chat 模板中的死占位符及额外变量拷贝；断言改为禁止未展开的 personality 字面量，并验证完整编辑、脏工作树保护、可点击文件链接、评审严重度和前端契约仍在。相关 91/91 测试通过、0 跳过，typecheck/build/check 通过。原 rereview 证据作为发现时的历史保留，由主证据的 personalityLiteralClosure 记录收口结果。本次仅准备通过验证的源码，本机空闲 bridge 热同步由主评审会话统一执行。

### Phase 0：推理平面卡片保真修复（`bridge/translate.mjs`）
- **改动文件**：`bridge/translate.mjs`、`tests/chat-translation-test.mjs`。
- **技术规格**：
  1. 解析流式 `delta.reasoning_text` / `delta.reasoning_content`（及非流式 `message.reasoning_text` / `message.reasoning_content`），按 Responses 协议严格依序发射：
     - `response.output_item.added`（`{ type: "reasoning", id, status: "in_progress", summary: [] }`）
     - `response.reasoning_summary_part.added`（`{ summary_index: 0, part: { type: "summary_text", text: "" } }`）
     - `response.reasoning_summary_text.delta`（逐分片增量）
     - 在正文或工具开始前闭合可读思考项：发射 `response.reasoning_summary_text.done` -> `response.reasoning_summary_part.done` -> `response.output_item.done`。忽略 `delta.reasoning_opaque`，不得写入 encrypted_content；只有 opaque 时不建 reasoning 项。
  2. 在 `ensureText` / `closeText` 中维护 `phase`：若文本块因后续思考或工具开始提前关闭，闭合项写入 `phase: "commentary"`；正常 `finish()` 必须使用 `closeText("completed", toolStates.size === 0 ? "final_answer" : "commentary")`。工具分片在前、文本分片在后也仍是 commentary，等待原生 Harness 执行工具后的下一次模型响应。截断末段仍为 commentary；已闭合前段不再接受增量。此处是单次 Chat 模型响应，与 `GatewayProtocol.execute()` 等待整个外部 Agent run 完成后闭合最终文本的规则不同。

**SSE 完整顺序与字段表**：所有事件含 `type`、从 0 开始连续递增的 `sequence_number`。`output_index` 是该项首次出现时的 output 数组下标，后续事件保持不变；`item_id` 永不因增量变更。流态初始 phase 是暂定 commentary，权威 phase 在 output_item.done 和终态 response.output 中确认。

| 顺序 / 触发 | 事件 | 必须携带的字段与内容 |
| --- | --- | --- |
| 首个输出之前 | response.created → response.in_progress | response.id/object/model/status=in_progress/output=[] 等共同 Response 字段。 |
| 首个非空可读 reasoning_text/content | response.output_item.added | output_index、item={id,type:reasoning,status:in_progress,summary:[]}；opaque 不触发建卡。 |
| 首个可读思考分片 | response.reasoning_summary_part.added | output_index、item_id、summary_index=0、part={type:summary_text,text:""}。opaque-only 不发任何 reasoning 事件。 |
| 每个可读分片 | response.reasoning_summary_text.delta | 上述索引 + delta。同一 chunk 同时声明两个别名时 reasoning_text 优先，避免重复。 |
| 正文/工具开始，或回合收尾 | response.reasoning_summary_text.done → response.reasoning_summary_part.done → response.output_item.done | text 为累计摘要；part={type:summary_text,text}；done.item.summary=[part]。没有可读思考就没有 reasoning 项需要闭合。 |
| opaque 字符串分片 | 无事件、无输出字段 | 忽略 reasoning_opaque，不解密、不写 summary/encrypted_content、不输出日志，不回传给后续 Chat 请求；不能因 opaque 分片拆分正文或显示空思考卡片。 |
| 每段正文首次非空内容 | response.output_item.added → response.content_part.added | item={id,type:message,role:assistant,status:in_progress,phase:commentary,content:[]}；part={type:output_text,text:"",annotations:[],logprobs:[]}，content_index=0。 |
| 正文增量 | response.output_text.delta | output_index、item_id、content_index=0、delta、logprobs=[]。 |
| 思考/工具开始前闭合正文 | response.output_text.done → response.content_part.done → response.output_item.done | 全量 text/part；item.phase=commentary。随后新正文另建 item，不复用 done 状态。 |
| 工具首分片但尚无 name | 暂存，不发 output_item.added | 提前闭合前置文本/思考，缓冲 call_id 与参数，等待非空 name 才判定 function/custom/tool_search 身份。 |
| 工具具备 name | response.output_item.added → 参数 delta（可用时） | output_index、id、call_id、name/namespace 和正确工具类型；函数参数保持可逆 lowering。 |
| 正常 finish | 活跃正文三拍闭合 → 未闭合工具参数 done / output_item.done → response.completed | toolStates.size=0 时末正文 phase=final_answer，否则 commentary；response.completed 表示本次模型响应传输完成，不表示工具已执行或 Agent 回合已结束。没有活跃正文不制造空段、不升级已闭合前段。最终 output 按 added 顺序。 |
| length / content_filter | 活跃正文/思考以 incomplete 闭合 → response.incomplete | incomplete_details.reason 分别 max_output_tokens/content_filter；工具不得标 completed 或执行残缺参数。 |
| 上游错误 / 翻译预算超限 | 已开始的正文/思考收敛为 incomplete → response.failed | error 采用标准化对象；无输出时仍按既有 HTTP 错误路径。不能再发 response.completed。 |

非流式 `choice.message` 与流式 `choice.delta` 走同一个状态机：只省略 write SSE，最终 JSON 中 output 顺序/可读摘要/phase 相同，均不包含 opaque 状态。`buildChatRequest` 跳过 reasoning 与 web_search_call 元数据，包括旧版桥接产生的带 encrypted_content 的 reasoning；这不会删除相邻已物化的 message、function_call 或 function_call_output，也不会将 opaque token 发送给上游。它与替代历史正文的 compaction 不同：previous_response_id、compaction、item_reference、未提取内容的 input_file 仍在上游调用前返回 HTTP 400 / unsupported_input。该规则不承诺供应商 opaque 模型状态重放，但必须保证明文会话及工具结果能继续往返；0031 的引擎/来源绑定边界继续生效。翻译累计输入 delta 限 4 MiB，避免无限缓冲工具参数/思考。
- **验收标准**：`codex-copilot` 下运行 `gemini-4-carbon` 产生原生可折叠 `Reasoning` 卡片，工具调用前的说明自动折叠进工作流步骤组。

### Phase 1：显示平面核心卡片与存储投影（Claude Code + ACP）
- **改动文件**：`gateway/contracts.mts`、`gateway/display-contracts.mts`、`gateway/display-projector.mts`、`gateway/protocol.mts`、`gateway/state.mts`、`gateway/engines/tool-display.mts`、`gateway/engines/acp-display.mts`、Claude/Gemini/Antigravity 适配器及对应测试。
- **技术规格**：
  1. 实现 `DisplaySink` 与 `projectStoredItemToV2`，打通 `StoredDisplayRecord` 落盘、异常退出状态收敛与 `thread/read`、`thread/turns/list` 出口投影。
  2. Claude Code 映射：`thinking_delta` -> `thinkingDelta`；`Read / Grep / Glob / LS` -> `commandRecord(read | search | listFiles)`；`Bash` -> `commandRecord(unknown)`；`Edit / MultiEdit / Write` -> 计算统一补丁写入 `fileChangeRecord` 并触发 `turn/diff/updated`；`TodoWrite` -> `planUpdate`。
  3. ACP（Gemini CLI / Antigravity 共用提取器）映射：`agent_thought_chunk` -> `thinkingDelta`；`plan` -> `planUpdate`；`tool_call(kind, content, locations)` 按 `kind` 与 `diff` 内容块分别映射 `commandRecord` 或 `fileChangeRecord`。
- **验收标准**：隔离网关与浏览器组件验收确认四类原生卡片渲染、流式更新及重启后历史回读一致，旧 `dynamicToolCall` 会话无回归。

### Phase 2：原生审批交互与扩展卡片
- **改动文件**：`gateway/display-projector.mts`、`gateway/engines/claude-code.mts`、`gateway/engines/gemini-cli.mts`、`gateway/engines/github-copilot.mts`。
- **技术规格**：接通 `requestCommandApproval` / `requestFileApproval` 原生审批弹窗（限制四项基础决策），点亮 `mcpToolCall`、`webSearch`、`imageView` 及 Claude `parent_tool_use_id` 子任务折叠进度回显。

### Phase 3：自动化 Schema 差集门禁与单编译层收敛
- **改动文件**：`tests/display-schema-drift-test.mjs`、`assets/display-coverage-ledger.json`、`assets/chat-instructions.md`、`bridge/catalog.mjs`、`gateway/google-provider.mts`、`gateway/google-translation.mts`；Ajv 为固定版本的开发期 Schema 校验依赖，不进入运行时编译器。
- **技术规格**：接入 `codex app-server generate-json-schema` 自动校验全部投影样本与未分类新卡片差集报告；抽离独立单流系统指令模板文件；将 `google-provider` 请求转换收敛至共享中间层。

---

## 6. 全仓架构与技术方案淘汰、更新及归档治理

### 6.1 盘点口径与逐份处置表

2026-11-13 初轮归档的路径快照：`docs/architecture/*.md` 共 **39 份**，其中 **38 份既有文档 + 本文 0032**；`docs/design/squad-visual-spec.md` 另计。评审返工期间并行新增的 0033 不属于此快照或本次修改范围。不能将“全仓所有 Markdown”与这 38 份架构文档混称为同一个集合。本表覆盖这 38 份的路径与契约边界，不表示重新执行了所有历史账号、客户端或发布验收。

状态含义：Active 是对应领域仍有效；Update 是保留原文但按新边界解释；Historical 是保留证据、不再作为当前施工命令；Superseded 仅淘汰指定设计，不删除历史事实或据此声称残留代码已下线。所有链接使用完整文件名，重号不得只写编号。

| # | 既有文档（相对本目录） | 归档判定 | 现行边界 / 后续治理 |
| --- | --- | --- | --- |
| 1 | [0001-multi-mode-app-server.zh-CN.md](0001-multi-mode-app-server.zh-CN.md) | Update | 隔离实例仅为测试；最终宿主以 0002 为准，显示契约以 0032 为准。 |
| 2 | [0002-current-chatgpt-host.zh-CN.md](0002-current-chatgpt-host.zh-CN.md) | Active | 当前宿主、活动会话保护与本地开发/正式发布分界。 |
| 3 | [0003-native-session-integration.zh-CN.md](0003-native-session-integration.zh-CN.md) | Update | 保留原生创建与侧栏；旧扁平工具展示由本文替代。 |
| 4 | [0004-cli-session-controls.zh-CN.md](0004-cli-session-controls.zh-CN.md) | Update | CLI 审批偏好与宿主策略分离仍有效；已识别命令/文件改用原生审批。 |
| 5 | [0005-codex-copilot-images.zh-CN.md](0005-codex-copilot-images.zh-CN.md) | Update | 双执行路径仍有效；推理事件与图像校验遵循本文，历史目录数量不是当前保证。 |
| 6 | [0006-google-account-gemini.zh-CN.md](0006-google-account-gemini.zh-CN.md) | Update | 保留个人订阅被拒绝的真实证据；存在 SDK 源码不代表该个人账号恢复可用。 |
| 7 | [0007-antigravity-subscription.zh-CN.md](0007-antigravity-subscription.zh-CN.md) | Update | 订阅 Agent 边界保留；ACP 显示使用本文。不能把它说成纯模型 API。 |
| 8 | [0008-typescript-diy.zh-CN.md](0008-typescript-diy.zh-CN.md) | Active | 严格 .mts、生成指纹、包装构建及不提交生成物。 |
| 9 | [0009-desktop-26.1023.51421.zh-CN.md](0009-desktop-26.1023.51421.zh-CN.md) | Historical | 特定旧宿主版本的兼容证据；不可用于放行新 ASAR。 |
| 10 | [0010-idle-provider-bridge-upgrade.zh-CN.md](0010-idle-provider-bridge-upgrade.zh-CN.md) | Active | 精确实例身份与空闲升级规则仍有效；不授权本任务刷新活动 bridge。 |
| 11 | [0011-native-provider-model-switch.zh-CN.md](0011-native-provider-model-switch.zh-CN.md) | Update | 模型标识往返仍有效；同引擎、同来源约束见完整路径的 0031 来源方案。 |
| 12 | [0012-cold-model-catalog.zh-CN.md](0012-cold-model-catalog.zh-CN.md) | Active | 冷目录、原生权限边界，不以目录可见代替真实推理验证。 |
| 13 | [0013-antigravity-session-approval.zh-CN.md](0013-antigravity-session-approval.zh-CN.md) | Update | 精确 ACP 选项、业务问题与权限分离保留；展示入口按本文升级。 |
| 14 | [0014-existing-cli-model-switch.zh-CN.md](0014-existing-cli-model-switch.zh-CN.md) | Update | 仅同引擎且同来源的可切换模型；不作为跨运行时接续授权。 |
| 15 | [0015-core-session-management.zh-CN.md](0015-core-session-management.zh-CN.md) | Active | 原生会话管理、删除与归属的现有保护继续生效。 |
| 16 | [0016-native-draft-model-settings.zh-CN.md](0016-native-draft-model-settings.zh-CN.md) | Active | 原生草稿与已提交设置的事实所有者；不由 display projector 写入。 |
| 17 | [0017-mycodex-symbiotic-architecture.zh-CN.md](0017-mycodex-symbiotic-architecture.zh-CN.md) | Update | Spine 分层保留；重型 P3 执行设想不作为新显示功能的依赖。 |
| 18 | [0018-spine-p1.zh-CN.md](0018-spine-p1.zh-CN.md) | Active | Registry、日志、预算和隔离基础；不是执行许可。 |
| 19 | [0019-ui-ux-design-spec.zh-CN.md](0019-ui-ux-design-spec.zh-CN.md) | Update | 工作台视觉按 Squad 视觉规范；对话卡片按本文官方协议，不构建私有平行卡片。 |
| 20 | [0020-spine-p2.zh-CN.md](0020-spine-p2.zh-CN.md) | Active | 来源、雷达、日报与知识视图职责保留。 |
| 21 | [0021-host-upgrade-isolation.zh-CN.md](0021-host-upgrade-isolation.zh-CN.md) | Active | 宿主/后端/页面升级隔离，不因 UI 升级重建会话。 |
| 22 | [0022-host-rpc-draft-settings.zh-CN.md](0022-host-rpc-draft-settings.zh-CN.md) | Active | host-rpc 设置归属；本文只改变展示投影。 |
| 23 | [0023-isolated-desktop-acceptance.zh-CN.md](0023-isolated-desktop-acceptance.zh-CN.md) | Active | 隔离验收方法；新增卡片需补充本方案的 Schema 与历史回读证据。 |
| 24 | [0023-native-compatibility-status.zh-CN.md](0023-native-compatibility-status.zh-CN.md) | Active | 兼容状态报告职责；具体版本与 PID 是历史快照。 |
| 25 | [0024-upgrade-continuity-acceptance.zh-CN.md](0024-upgrade-continuity-acceptance.zh-CN.md) | Active | 后端、模型与续聊连续性，不能由页面挂载成功替代。 |
| 26 | [0025-nonintrusive-status-notices.zh-CN.md](0025-nonintrusive-status-notices.zh-CN.md) | Active | 提醒分级、去重、源码待加载与故障的区分。 |
| 27 | [0025-spine-real-sources.zh-CN.md](0025-spine-real-sources.zh-CN.md) | Active | 真实来源只读同步；不把旧稿同步说成新采集。 |
| 28 | [0026-spine-p3-review-design.zh-CN.md](0026-spine-p3-review-design.zh-CN.md) | Superseded（执行设计） | 新功能不依赖五角色、Wave、自动 worktree 派发；可复用的授权/回执规则不能随意移除。 |
| 29 | [0027-host-rpc-draft-creation.zh-CN.md](0027-host-rpc-draft-creation.zh-CN.md) | Active | 真实宿主创建动作与首发归属，不通过显示卡片创建线程。 |
| 30 | [0028-shared-work-context.zh-CN.md](0028-shared-work-context.zh-CN.md) | Active | 无仓库依赖的共同记录、候选/采用分离，不等同于执行系统。 |
| 31 | [0029-conversation-work-card.zh-CN.md](0029-conversation-work-card.zh-CN.md) | Active | 工作记录交互卡；与外部 CLI 的静态 MCP 结果是不同边界。 |
| 32 | [0030-claude-code-api.zh-CN.md](0030-claude-code-api.zh-CN.md) | Update | 认证、密钥与环境覆盖仍有效；扁平回显和问卷式工具审批升级为本文原生映射。 |
| 33 | [0031-macos-baseline-closeout.zh-CN.md](0031-macos-baseline-closeout.zh-CN.md) | Historical（验收快照） | 保留当轮加载/未验收状态，不声称所有后续功能已在原窗口上线。 |
| 34 | [0031-model-sources-and-handoff.zh-CN.md](0031-model-sources-and-handoff.zh-CN.md) | Active | 来源与引擎锁定；switchExecution 已明确拒绝，不能把保留的路由名误认为可用切换能力。 |
| 35 | [implementation-plan.zh-CN.md](implementation-plan.zh-CN.md) | Historical | R0–R5 原始实施过程，当前显示施工入口为本文各 Phase。 |
| 36 | [p3-implementation-status.zh-CN.md](p3-implementation-status.zh-CN.md) | Historical / Superseded（执行设计） | 真实历史测试结论保留，不把“隔离验证”扩写为日常产品已启用。 |
| 37 | [r0-desktop-probe.zh-CN.md](r0-desktop-probe.zh-CN.md) | Historical | 早期确定性协议探针，不是当前 CLI/账号可用性证据。 |
| 38 | [r1-r3-gateway.zh-CN.md](r1-r3-gateway.zh-CN.md) | Historical | 早期网关原型及隔离启动，不是最终宿主部署方案。 |

### 6.2 待淘汰的代码与实际处置边界

| 残留位置 | 已核对事实 | 治理动作及退出证据 |
| --- | --- | --- |
| `gateway/spine/mcp-server.mts` 的 `mycodex.work_upsert`、`mycodex.squad_dispatch`、`mycodex.squad_handoff`、`mycodex.squad_integrate` | 仍有工具定义和方法路由；不是已经删除的死代码。名字是点号形式，不能用臆造的下划线名检索后宣称不存在。 | Deprecated 新调用设计；下线前核对共享工作读取、旧记录恢复、工具发现调用者与现有 P3 测试，新增兼容拒绝说明，再移除暴露。当前显示功能不调用它们。 |
| `gateway/spine/work-dispatch.mts`、`reaction-store.mts`、旧 WorkItem/Squad 实现 | 历史执行与授权记录可能仍有调用者，不能只因新 Squad 文件存在就删除。 | 保留历史读取；无调用者、无恢复依赖且隔离回归通过后才删除。Squad Lite 新执行契约见 `squad-service.mts`、`squad-commands.mts` 及其测试，视觉规范不能充当授权协议。 |
| `gateway/engines/codex-native.mts`、`gateway/engines/index.mts` | 裸核私有 profile 写入禁用 apps/plugins 的设置，index 仍有绑定和直接适配器测试；普通 gateway 新建拒绝 nativeProvider，跨引擎切换也被拒绝。 | 标记为待退役/兼容评估分支，而非当前日常接入入口；不得声称它保留宿主 MCP/CUA，也不得修改已有历史 profile。删除前核对历史运行与直接测试用途。 |
| `GatewayProtocol.switchExecution`、`gateway/router.mts` 的 `thread/execution/switch`、`gateway/thread/adopt` | 路由名仍保留，但两处 switchExecution 方法体均明确抛出“引擎和来源已固定”；conversation-switch 测试覆盖 settings/send/adopt 无旁路。 | 作为兼容拒绝入口保留；治理时可删除无引用的旧接续辅助代码，但必须维持拒绝和历史归属。不存在仅由 UI 隐藏来实施锁定的缺口。 |
| `GatewayProtocol.execute()` 的预建唯一 final 文本项 | 已由本任务的懒创建分段状态机替代。 | 回归覆盖前文/思考/工具/末文、纯工具、异常、重启回读；不得恢复倒插拼接。 |
| `bridge/catalog.mjs` 的 Chat 正文正则改写 | 已改为版本控制的 `assets/chat-instructions.md`。 | Chat 不再依赖官方 GPT 指令措辞；Responses 模板仍保留，修改需更新差集账本。 |
| Claude / ACP 的一律 `dynamicToolCall` 透传 | 已识别的结构化事实改走 DisplaySink；未知工具继续保留通用卡。 | 仅淘汰“所有工具只用一种卡”的假设，不能删除诚实降级通道。 |
| Google SDK 自行处理阶段/思考/终态的旧路径 | Google 方言适配收敛到 `google-translation.mts` + 共享 `createResponsesWriter`。 | 不再丢弃 `thought`；工具签名存储仍由 Google 适配器拥有。 |

本次治理归档不等于执行上述所有跨域删除。用户本轮要求的显示功能开发、历史淘汰清单与“删除正在被其他工作使用的实现”是不同动作；未满足退出证据的条目必须保留为 Deprecated/待对齐，不能伪造已完成状态。

### 6.3 编号冲突清单

| 编号 | 完整文件 A | 完整文件 B | 本次处理 |
| --- | --- | --- | --- |
| 0023 | `0023-isolated-desktop-acceptance.zh-CN.md` | `0023-native-compatibility-status.zh-CN.md` | 全路径引用；不改名、不破坏历史链接。 |
| 0025 | `0025-nonintrusive-status-notices.zh-CN.md` | `0025-spine-real-sources.zh-CN.md` | 同上；注意实际拼写为 nonintrusive。 |
| 0031 | `0031-macos-baseline-closeout.zh-CN.md` | `0031-model-sources-and-handoff.zh-CN.md` | 区分历史验收与来源规范，不用“0031 已完成”替代领域结论。 |

后续如统一编号，须同一变更更新所有入链、索引和引用，保留旧路径重定向/说明；本次不作未经验证的全仓重命名。

### 6.4 现行有效核心基线索引

| 领域 | 权威入口 |
| --- | --- |
| 当前宿主与升级隔离 | [0002](0002-current-chatgpt-host.zh-CN.md)、[0021](0021-host-upgrade-isolation.zh-CN.md) |
| 构建与验收 | [0008](0008-typescript-diy.zh-CN.md)、[0023 隔离验收](0023-isolated-desktop-acceptance.zh-CN.md)、[0024](0024-upgrade-continuity-acceptance.zh-CN.md) |
| 非代码共同记录与交互卡 | [0028](0028-shared-work-context.zh-CN.md)、[0029](0029-conversation-work-card.zh-CN.md) |
| Claude 自有 API 认证与密钥边界 | [0030](0030-claude-code-api.zh-CN.md) |
| 模型来源与引擎锁定规范 | [0031 来源方案](0031-model-sources-and-handoff.zh-CN.md)，后端拒绝入口与残留兼容代码的区别见 6.2 |
| 轻量小队 | [视觉规范](../design/squad-visual-spec.md) 仅管视觉；执行契约以 `gateway/spine/squad-commands.mts`、`squad-service.mts` 和对应测试为准 |
| 异构模型与显示 | 本文；可执行类型以 `gateway/display-contracts.mts` 为准，外部线协议以本机官方 Schema 导出为准 |

## 7. 开发交付与代码评审门禁（Review Checklist）

开发提交评审时逐项填写“证据路径/命令/退出码/覆盖范围/缺失项”，不能只贴总通过数。源码完成、隔离模拟通过、真实账号通过、原窗口加载、正式发布是五种不同结论。

- [ ] **任务归属**：记录分支、工作区及开始时 dirty/untracked 清单；只交付本任务差量。保留 `docs/DEVELOPMENT.zh-CN.md`、已有 0031、Squad 设计及其他非本任务脏文件，不覆盖、清理或顺手提交。
- [ ] **红线**：未修改 `VERSION`、`NATIVE_PATCH_CHAIN.json`、native patch 树、已验证安装包或 `dist` 发布档案；未调用 Publish-Release、提版本、六平台打包、修改官方 ASAR 或终止活动 Desktop/Gateway。显示功能不需要 native core 改动。
- [ ] **构建纪律**：通过 `npm run typecheck`、`npm run build`、`npm run check:generated`；测试用 `npm run test:diy` 或 `tools/Invoke-HeavyTask.sh <node> --test ...`。Windows 用对应 ps1 包装器。保持全局锁和六任务上限；不裸跑全量 node/cargo/ninja/msbuild。
- [ ] **失败先行证据**：分段消息与 reasoning 测试确实能击中原缺陷；修后验证有序 started/delta/completed、UTF-8 上限、纯工具无空项、异常/中断无伪 final。
- [ ] **真实 Schema**：`tests/display-schema-drift-test.mjs` 对本机 `generate-json-schema --experimental` 产出的 ThreadItem、通知及 ServerRequest 校验，覆盖每个新增卡片与审批。验收设置 `MYCODEX_REQUIRE_DISPLAY_SCHEMA=1`；缺 exporter 不得以 skip 代替验收。记录 executable 和平台。
- [ ] **差集账本**：新增 item 变体、通知、必填字段或模板内容变化触发测试失败；每项为 projected 或 unsupported_by_boundary，后者必须有具体原因。先审查差集再刷新账本，禁止机械更新摘要掩盖漂移。
- [ ] **隔离协议/历史**：临时私有 profile、socket、媒体目录；thread/read、resume、items/list、turns/list 的 summary/full/notLoaded 与重启回读都经过同一投影。旧 schemaVersion 1 dynamicToolCall 原样兼容，读取不迁移旧文件。
- [ ] **失败与恢复**：崩溃后所有仍 inProgress 的记录归为 failed/unknown；未知退出码为 null；缺命令、路径、old/new、权限事实时通用卡降级；不得自动重试外部动作、伪造退出码 0、PTY 或子会话 ID。
- [ ] **审批安全**：CLI deny、组织强制 ask、业务问题、取消/断连/超时及非法策略修订回复逐项验证。只转发基础决策，不更新 CLI/宿主策略；acceptForSession 在不支持可信会话缓存的适配器中收窄为单次许可。子代理没有独立身份时不伪造跳转。
- [ ] **性能与输出预算**：单项输出 128 KiB、原始参数 64 KiB、思考 1 MiB、规范化显示回合累计 2 MiB、最多 512 个显示项；文本全回合另限 UTF-8 1 MiB。大参数明确降级；不按 JS 字符数冒充字节数；不为生成 Diff读取无限文件或递归扫描工作区。ThreadStore 8 MiB 和 IPC 8 MiB 既有总门禁保留。
- [ ] **I/O 与数据边界**：仅结构变更/终态持久化，不逐 token fsync；文件预览只读取 cwd 内受限普通文件，不执行工具字符串；图片须 MediaStore 校验后引用受控路径。MCP App 固定 null；供应商签名和密钥不进通用日志、源码或浏览器存储。
- [ ] **CLI/Desktop 证据**：隔离原生 app-server 接受 reasoning、工具与图片的真实协议验证；原生真实窗口的折叠、Diff 抽屉和审批展示单列证据。未加载当前窗口或无真实账号条件时明确注明，不重启用户工作会话凑验收。
- [ ] **交付卫生**：只提交 .mts 源码及测试/必要资源，不提交其生成 .mjs/.map、build manifest、profile、第三方 SDK 或日志。确认自有构建/测试后代退出、临时构建目录清理；不清理其他会话工件。

建议交回格式：阶段与范围；本次文件清单；每项门禁的命令、退出码和日志；隔离环境/核心身份；实际 Desktop 与账号证据；待治理项及发布状态。缺失证据应写具体缺什么，不能用“已归档正式方案”推导“全部功能已在用户窗口可用”。
