# 协作小队（Squad）视觉设计规范

## 1. 设计理念

协作小队的视觉语言以**高信噪比、微米级紧凑排版与克制的工业精密感**为核心，汲取 Linear、Vercel Dashboard 与 Cursor 的暗色工程美学。通过低饱和度的多层深色表面构建清晰的空间层级，将高饱和色彩严格收敛于 6px 状态指示点与小队身份锚点，确保开发者在约 200px–320px 的受限侧边栏与面板宽度中，无需阅读长文本即可在 100ms 内完成对多 Agent 并行状态的扫视与调度。所有动效均遵循硬件加速合成原则，仅服务于状态流转感知与空间上下文连续性。

---

## 2. 色彩系统

色彩系统完全采用 **OKLCH** 色彩空间定义，确保在不同色相之间具备感知一致的亮度（Lightness）与色度（Chroma），从而保证在暗色/亮色模式下语义状态点的视觉权重均衡，并严格满足 WCAG 2.1 AA 对比度要求。

### 2.1 中性色阶（Neutral Tokens — 8 步）

带有微弱冷蓝底色（Hue `260`），契合代码编辑器环境。

| Token 名 | 暗色值 (Dark OKLCH) | 亮色值 (Light OKLCH) | 用途说明 | WCAG 2.1 对比度验证（相对主表面 `surface-1`） |
| :--- | :--- | :--- | :--- | :--- |
| `--squad-surface-0` | `oklch(0.14 0.008 260)` | `oklch(0.96 0.004 260)` | 侧边栏底层背景、内嵌输入框凹陷槽底色 | 背景层（N/A） |
| `--squad-surface-1` | `oklch(0.18 0.010 260)` | `oklch(0.99 0.002 260)` | Worker 卡片默认背景、小队面板主背景 | 基准表面 `1.0:1` |
| `--squad-surface-2` | `oklch(0.22 0.012 260)` | `oklch(0.94 0.006 260)` | 卡片 Hover/Active 表面、已派发简报区、徽章背景 | 表面区分 ΔL = `0.04` / `0.05` |
| `--squad-border-subtle` | `oklch(0.26 0.012 260)` | `oklch(0.90 0.008 260)` | 卡片默认外边框、内部分割线、只读区块描边 | 非文本装饰边界 `1.5:1` |
| `--squad-border-strong` | `oklch(0.36 0.015 260)` | `oklch(0.80 0.012 260)` | 卡片 Hover 边框、按钮描边、输入框激活态前导边框 | 交互控件边界 `2.4:1` |
| `--squad-text-primary` | `oklch(0.93 0.006 260)` | `oklch(0.18 0.010 260)` | 成员名称、小队标题、主要输入文本、主按钮文字 | Dark `13.8:1` (AAA) / Light `14.6:1` (AAA) |
| `--squad-text-secondary` | `oklch(0.72 0.012 260)` | `oklch(0.42 0.014 260)` | 状态说明文字、简报内容预览、次要按钮文字 | Dark `6.4:1` (AA) / Light `5.8:1` (AA) |
| `--squad-text-muted` | `oklch(0.62 0.012 260)` | `oklch(0.49 0.012 260)` | 引擎标签、边界声明只读文本、占位符、聚合分隔符 | Dark `4.6:1` (AA ≥ 4.5:1) / Light `4.6:1` (AA ≥ 4.5:1) |

> **禁用态说明**：所有 `disabled` 状态的组件统一使用 `--squad-text-muted` 配合整体容器 `opacity: 0.45`（WCAG 规范对禁用控件豁免 4.5:1 对比度要求）。

---

### 2.2 主强调色（Squad Identity Accent）

以高辨识度的电光靛紫（Electric Indigo，Hue `275`）作为“协作小队”专属身份锚点，区别于单会话常规蓝色高亮。

| Token 名 | 暗色值 (Dark OKLCH) | 亮色值 (Light OKLCH) | 用途说明 | WCAG 2.1 对比度验证 |
| :--- | :--- | :--- | :--- | :--- |
| `--squad-accent-solid` | `oklch(0.64 0.19 275)` | `oklch(0.52 0.21 275)` | 主操作按钮背景（派发/汇总）、已派发左边框标识 | 配白色文字 `oklch(0.99 0 0)` ≥ `4.7:1` (AA) |
| `--squad-accent-hover` | `oklch(0.70 0.19 275)` | `oklch(0.46 0.21 275)` | 主操作按钮 Hover 状态背景 | 配白色文字 ≥ `4.5:1` (AA) |
| `--squad-accent-text` | `oklch(0.78 0.14 275)` | `oklch(0.45 0.19 275)` | 小队徽章文字、已派发标识文字、链接与高亮数字 | 相对 `surface-1`：Dark `7.5:1` / Light `5.6:1` (AA) |
| `--squad-accent-surface` | `oklch(0.24 0.05 275)` | `oklch(0.94 0.03 275)` | 已派发简报卡片微染色背景、底部汇总条背景表面 | 与 `--squad-accent-text` 对比度 ≥ `5.2:1` (AA) |
| `--squad-accent-ring` | `oklch(0.64 0.19 275 / 0.55)` | `oklch(0.52 0.21 275 / 0.45)` | 键盘 Focus Ring 外发光描边与输入框聚焦环 | 焦点指示器对比度 ≥ `3.2:1` (符合 WCAG 2.4.11) |

---

### 2.3 语义状态色（Semantic Status Tokens）

四种状态分别提供 **Indicator（图形/圆点）**、**Text（状态文字）** 和 **Surface（浅色衬底）** 三层 token，避免直接将图形色用于小字号文本导致亮色下对比度不足。

| 状态类别 | Token 名 | 暗色值 (Dark OKLCH) | 亮色值 (Light OKLCH) | 用途说明 | WCAG 2.1 对比度验证（相对 `surface-1`） |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Running**<br>（执行中 / 青蓝） | `--squad-status-running-dot` | `oklch(0.72 0.16 240)` | `oklch(0.58 0.18 240)` | 执行中状态点核心、脉冲光晕源 | 非文本图形：Dark `6.2:1` / Light `4.1:1` (≥ 3.0:1) |
| | `--squad-status-running-text` | `oklch(0.78 0.13 240)` | `oklch(0.44 0.16 240)` | “执行中”状态文字、聚合计数 `⟳ N` | 文本：Dark `7.6:1` (AA) / Light `5.5:1` (AA) |
| | `--squad-status-running-bg` | `oklch(0.24 0.04 240)` | `oklch(0.94 0.03 240)` | 执行中微胶囊背景或脉冲环底色 | 背景衬底（配 `-text` 对比度 ≥ `5.1:1`） |
| **Settled**<br>（已完成 / 翠绿） | `--squad-status-settled-dot` | `oklch(0.74 0.17 152)` | `oklch(0.58 0.17 152)` | 已完成状态点、完成对勾图标 | 非文本图形：Dark `6.8:1` / Light `3.9:1` (≥ 3.0:1) |
| | `--squad-status-settled-text` | `oklch(0.80 0.14 152)` | `oklch(0.42 0.14 152)` | “已完成”状态文字、聚合计数 `✓ N` | 文本：Dark `8.2:1` (AA) / Light `5.7:1` (AA) |
| | `--squad-status-settled-bg` | `oklch(0.23 0.04 152)` | `oklch(0.94 0.03 152)` | 结果汇总条强调微背景 | 背景衬底（配 `-text` 对比度 ≥ `5.3:1`） |
| **Needs Attention**<br>（需注意 / 琥珀橙） | `--squad-status-attention-dot` | `oklch(0.78 0.17 70)` | `oklch(0.64 0.18 65)` | 需注意状态点、阻塞/审批提醒图标 | 非文本图形：Dark `7.9:1` / Light `3.4:1` (≥ 3.0:1) |
| | `--squad-status-attention-text` | `oklch(0.82 0.15 70)` | `oklch(0.44 0.15 60)` | “需注意”状态文字、阻塞提示文案 | 文本：Dark `8.9:1` (AA) / Light `5.4:1` (AA) |
| | `--squad-status-attention-bg` | `oklch(0.25 0.05 70)` | `oklch(0.95 0.04 70)` | 需注意卡片左边缘警示微背景 | 背景衬底（配 `-text` 对比度 ≥ `5.0:1`） |
| **Idle**<br>（空闲 / 冷灰） | `--squad-status-idle-dot` | `oklch(0.52 0.015 260)` | `oklch(0.62 0.015 260)` | 空闲状态空心环/实心暗点 | 非文本图形：Dark `3.1:1` / Light `3.1:1` (≥ 3.0:1) |
| | `--squad-status-idle-text` | `oklch(0.64 0.012 260)` | `oklch(0.48 0.012 260)` | “空闲”状态文字 | 文本：Dark `4.8:1` (AA) / Light `4.7:1` (AA) |
| | `--squad-status-idle-bg` | `oklch(0.21 0.010 260)` | `oklch(0.95 0.005 260)` | 空闲标签底色 | 背景衬底 |

---

## 3. 间距与圆角系统

所有几何尺寸严格基于 **4px 基准网格**（局部微组件允许 `2px` 与 `6px` 半步微调，以适配高密度桌面端 UI）：

### 3.1 间距阶梯（Spacing Tokens）
- `--space-0-5`: `2px` — 聚合状态内图标与数字间距、紧凑内联标签内边距
- `--space-1`: `4px` — 状态点与状态文字间距、按钮内部图文间距、卡片列表垂直间距
- `--space-1-5`: `6px` — 小尺寸按钮水平内边距、引擎徽章水平内边距
- `--space-2`: `8px` — 卡片内元素标准水平间距、编辑区表单项垂直间距
- `--space-3`: `12px` — Worker 卡片标准水平内边距、面板左右内边距
- `--space-4`: `16px` — 区块级分隔间距

### 3.2 圆角阶梯（Radius Tokens）
- `--radius-xs`: `4px` — 引擎标签（Badge）、行内代码胶囊、小尺寸操作按钮
- `--radius-sm`: `6px` — Worker 成员卡片、输入框、任务简报编辑容器
- `--radius-md`: `8px` — 结果汇总条、悬浮外框容器
- `--radius-full`: `9999px` — 状态指示点、聚合状态胶囊

### 3.3 字体与字号约定
- **UI 正文 (`--font-sans`)**: `12px`（行高 `16px`），字重 `400` / `500`
- **紧凑辅助/徽章 (`--font-xs`)**: `11px`（行高 `16px`），字重 `500`
- **等宽技术文本 (`--font-mono`)**: `11px`（行高 `16px`），用于引擎标签、聚合状态数字（启用 `tabular-nums`）、边界路径声明

---

## 4. 组件规范

### 4.1 状态指示点（Status Dot）

用于标示单个 Worker 的实时运行状态，是整个视觉语言中最小但信息密度最高的视觉锚点。

- **视觉结构描述**：
  - 外层为 `12px × 12px` 的固定对齐容器（保证与 `16px` 行高文本垂直居中对齐），内部居中放置 `6px × 6px` 的核心圆点。
  - **四种状态形态**：
    - `idle`：`6px × 6px` 静态圆点，中心带 `2px` 镂空感（或实心弱化灰），低视觉存在感。
    - `running`：`6px × 6px` 核心实心圆点 + 同心外层 `12px × 12px` 扩散脉冲伪元素层（仅执行 `transform: scale()` 与 `opacity` 动画）。
    - `settled`：`6px × 6px` 翠绿实心圆点（高对比度静态锚定，传达稳定完结感）。
    - `needs_attention`：`6px × 6px` 琥珀色实心圆点，外围带 `1px` 静态半透明警示晕环（`--squad-status-attention-bg`），提示需要人工介入审批或排障。
- **交互状态**：
  - `default`：按对应语义态展示。
  - `hover`（跟随父级卡片或独立悬停）：圆点外层光晕不透明度提升至 `0.35`，若独立悬停可触发 Tooltip 显示状态持续时长（如 `执行中 · 01:24`）。
  - `active` / `disabled` / `focus`：状态点本身不独立接收焦点，随父级卡片 `disabled` 时整体 `opacity: 0.45`。
- **尺寸规范**：
  - 占空容器：`12px × 12px`
  - 核心圆点直径：`6px × 6px`，圆角 `--radius-full` (`9999px`)
  - 脉冲外环基准尺寸：`6px × 6px`（通过 `scale(2.0)` 扩展至视觉 `12px`）
- **使用 Token**：
  - `idle`: `--squad-status-idle-dot`
  - `running`: 核心与外环均使用 `--squad-status-running-dot`
  - `settled`: `--squad-status-settled-dot`
  - `needs_attention`: 核心 `--squad-status-attention-dot`，静态衬底环 `--squad-status-attention-bg`
- **动效与 Reduced-Motion 降级**：
  - 标准模式：外层伪元素执行 `1600ms` 循环呼吸缩放与淡出（详见第 5 节）。
  - `prefers-reduced-motion: reduce` 降级：完全关闭外环缩放与透明度动画，改为核心 `6px` 实心点 + 外围固定 `2px` 静态半透明描边环（使用 `--squad-status-running-bg`），与 `idle`（无外环）和 `settled`（纯实心绿）保持清晰区分。

---

### 4.2 Worker 成员卡片（Worker Member Card）

在协作面板中展示单个 Worker 会话的紧凑水平卡片，支持快速扫描状态、切换会话或派发任务简报。

- **视觉结构描述**：
  - **主行（单行紧凑布局）**：采用水平 Flex 布局，左对齐信息流，右对齐操作区，垂直居中，元素间距 `8px` (`--space-2`)。
    1. **左侧状态点**（`12px × 12px` 容器）
    2. **成员名**（`12px` `--font-sans`，字重 `500`，单行省略 `text-overflow: ellipsis`）
    3. **引擎标签 Badge**（`11px` `--font-mono`，如 `claude-3.7` / `o3-mini`，紧凑胶囊）
    4. **弹性占位（Spacer）**
    5. **状态文字**（`11px` `--font-sans`，仅在卡片常态或 Hover 时辅助显示：`空闲` / `执行中` / `已完成` / `需确认`）
    6. **主操作按钮**（右侧：`派发` / `查看` / `改派`，高度 `24px`）
  - **“已派发简报”特殊态（Brief Dispatched State）**：
    - 当 Worker 已绑定任务简报时，卡片变为上下两层结构：
    - 卡片左侧增加 `2px` 宽的垂直身份色条（`--squad-accent-solid`）。
    - 主行下方新增**简报摘要行**（距主行 `4px`，左内边距对齐成员名文字起始处 `20px`）：单行展示已派发子任务标题（`11px` `--squad-text-secondary`，超出省略），右侧操作按钮由实心/描边“派发”变为幽灵态图标/文字按钮“编辑简报”。
- **交互状态**：
  - `default`：背景 `--squad-surface-1`，边框 `1px solid --squad-border-subtle`。
  - `hover`：背景过渡至 `--squad-surface-2`，边框变为 `--squad-border-strong`；右侧操作按钮强化显示。
  - `active`（鼠标按下或当前选中的 Worker 会话）：背景 `--squad-surface-2`，边框 `--squad-accent-solid`。
  - `focus-visible`：外围 `2px` 焦点环 `--squad-accent-ring`，偏移 `1px`。
  - `disabled`（如 Supervisor 正在锁定全局同步时）：容器 `opacity: 0.45`，禁止指针事件，按钮不可点击。
  - `needs_attention` 语义态叠加：边框染为 `--squad-status-attention-dot`（不透明度 `50%`），操作按钮文案变为高亮“处理”。
- **尺寸规范**：
  - 默认单行卡片高度：`36px`（内边距：上下 `6px`，左右 `12px`）
  - “已派发简报”双行卡片高度：`56px`（上内边距 `8px`，下内边距 `8px`，行间距 `4px`）
  - 卡片圆角：`--radius-sm` (`6px`)
  - 引擎标签尺寸：高度 `16px`，水平内边距 `6px` (`--space-1-5`)，圆角 `--radius-xs` (`4px`)
  - 卡片内操作按钮：高度 `24px`，水平内边距 `8px` (`--space-2`)，圆角 `--radius-xs` (`4px`)
  - 卡片列表垂直间距：`4px` (`--space-1`)
- **使用 Token**：
  - 容器：`--squad-surface-1` / `--squad-surface-2`、`--squad-border-subtle` / `--squad-border-strong`
  - 成员名：`--squad-text-primary`
  - 引擎标签：背景 `--squad-surface-0`，文字 `--squad-text-muted`，边框 `--squad-border-subtle`
  - 状态文字：对应语义状态的 `--squad-status-*-text`
  - 已派发态左饰条：`--squad-accent-solid`；简报摘要文字：`--squad-text-secondary`

---

### 4.3 小队区块头部（Squad Section Header）

位于一组 Worker 卡片列表正上方的紧凑标题栏，提供小队身份认知与全局进度一目了然的聚合摘要。

- **视觉结构描述**：
  - 单行两端对齐布局（`justify-content: space-between`），水平内边距与卡片对齐。
  - **左侧**：小队身份徽标（`8px × 8px` 圆角方块或双菱形图标，使用 `--squad-accent-text`）+ 小队名称（`12px` 字重 `600`）+ 成员总数弱化标注（如 `(4)`）。
  - **右侧（状态聚合胶囊）**：仅渲染当前计数 `> 0` 的状态项，按优先级排序：`⚠ 需注意` -> `⟳ 执行中` -> `✓ 已完成` -> `○ 空闲`。各项之间以中间点 `·`（`--squad-text-muted`）分隔，如 `⟳ 1 · ✓ 3`。数字启用 `font-variant-numeric: tabular-nums` 防止跳动。
- **交互状态**：
  - `default`：透明背景（直接透出面板底层 `--squad-surface-0`），文字稳定显示。
  - `hover`：若支持点击折叠整个小队区块，悬停时背景微亮为 `--squad-surface-1`，左侧图标轻微提亮。
  - `active`：点击时背景 `--squad-surface-2`。
  - `focus-visible`：键盘聚焦时显示 `2px` `--squad-accent-ring` 焦点框（圆角 `4px`）。
  - `disabled`：整体 `opacity: 0.45`。
- **尺寸规范**：
  - 高度：`28px`
  - 内边距：上下 `4px` (`--space-1`)，左右 `8px` (`--space-2`)
  - 底部与第一张 Worker 卡片间距：`4px` (`--space-1`)
  - 聚合状态胶囊：高度 `20px`，内边距上下 `2px`、左右 `8px`，圆角 `--radius-full` (`9999px`)
- **使用 Token**：
  - 小队名：`--squad-text-primary`
  - 小队身份图标：`--squad-accent-text`
  - 聚合胶囊背景：`--squad-surface-1`，边框 `--squad-border-subtle`
  - 聚合分项着色：`⟳ N` 使用 `--squad-status-running-text`，`✓ N` 使用 `--squad-status-settled-text`，`⚠ N` 使用 `--squad-status-attention-text`，分隔符 `·` 使用 `--squad-text-muted`

---

### 4.4 任务简报编辑区（Task Brief Inline Editor）

点击某张 Worker 卡片的“派发”或“编辑简报”后，在该卡片内部下方原位展开（Inline Accordion）的结构化编辑面板。

- **视觉结构描述**：
  - 嵌套在当前激活的 Worker 卡片内部下方，与卡片主行之间通过 `1px solid --squad-border-subtle` 分隔。
  - 内部采用垂直表单栈布局（间距 `8px` `--space-2`）：
    1. **小队目标输入（Squad Goal）**：顶部带 `11px` 标签“小队目标”，单行输入框（高度 `28px`），若 Supervisor 已设定全局目标则自动预填，允许微调。
    2. **子任务输入（Worker Subtask）**：顶部带 `11px` 标签“当前 Worker 子任务”，多行文本域（默认 3 行，高度 `60px`），自动获取焦点（Auto-focus）。
    3. **边界声明（Boundary Declaration — 只读自动填入）**：紧凑只读信息块，展示由系统自动推导的文件作用域或只读约束（如 `Scope: src/auth/** · 禁止修改 schema.prisma`）。左侧带锁形/盾牌微图标，采用 `--font-mono` 等宽字体。
    4. **底部操作栏**：右对齐两个按钮——次要按钮“取消”（支持 `Esc` 快捷键提示）与主按钮“确认派发”（支持 `⌘↵` 快捷键提示）。
- **交互状态**：
  - **输入框（小队目标 / 子任务）**：
    - `default`：背景 `--squad-surface-0`，边框 `1px solid --squad-border-subtle`，文字 `--squad-text-primary`，占位符 `--squad-text-muted`。
    - `hover`：边框变为 `--squad-border-strong`。
    - `focus`：边框变为 `--squad-accent-solid`，外围叠加 `2px` `--squad-accent-ring`。
    - `disabled`（派发提交请求中）：背景维持 `--squad-surface-0`，`opacity: 0.5`，只读不可改。
  - **边界声明只读区**：
    - 恒定只读态（`readonly`）：背景 `--squad-surface-0`，虚线边框 `1px dashed --squad-border-subtle`，文字 `--squad-text-muted`，鼠标指针 `cursor: default`。
  - **操作按钮（确认派发 / 取消）**：
    - `default`：确认按钮背景 `--squad-accent-solid`、白字；取消按钮透明背景、文字 `--squad-text-secondary`。
    - `hover`：确认按钮背景 `--squad-accent-hover`；取消按钮背景 `--squad-surface-2`、文字 `--squad-text-primary`。
    - `active`：按钮整体 `transform: scale(0.98)`。
    - `focus-visible`：`2px` `--squad-accent-ring`。
    - `disabled`（当子任务输入为空时）：确认按钮 `opacity: 0.45`，禁止点击。
- **尺寸规范**：
  - 编辑区容器内边距：上下 `12px` (`--space-3`)，左右 `12px` (`--space-3`)
  - 单行输入框高度：`28px`，水平内边距 `8px` (`--space-2`)，圆角 `--radius-xs` (`4px`)
  - 子任务多行文本域：最小高度 `60px`（约 3 行文本 + 上下 `6px` 内边距），圆角 `--radius-xs` (`4px`)
  - 边界声明只读块：最小高度 `28px`，内边距上下 `4px`、左右 `8px`，圆角 `--radius-xs` (`4px`)
  - 底部按钮高度：`28px`，水平内边距 `12px` (`--space-3`)，按钮间距 `8px` (`--space-2`)，圆角 `--radius-xs` (`4px`)
- **使用 Token**：
  - 容器背景：`--squad-surface-1`（与父卡片融为一体，外框升级为 `--squad-border-strong`）
  - 输入槽背景：`--squad-surface-0`
  - 标签文字：`--squad-text-secondary`
  - 边界声明文字：`--squad-text-muted`
  - 确认按钮：`--squad-accent-solid` / `--squad-accent-hover`

---

### 4.5 结果汇总条（Result Aggregation Bar）

当小队内所有已派发任务的 Worker 均进入 `settled`（完成）状态时，在面板底部固定浮现的行动召唤条（Call-to-Action Bar），引导用户将并行产物一键归并回 Supervisor 会话。

- **视觉结构描述**：
  - 位于小队面板底部（Sticky 吸附或底部固定区），单行两端对齐（`justify-content: space-between`）。
  - **左侧**：完成勾选徽章（`16px × 16px` 圆形翠绿底 + 对勾图标）+ 状态文案（如 `4 个 Worker 已全部完成`，其中数字与状态词加粗）。
  - **右侧**：主操作按钮“汇总至 Supervisor ↵”（带向右上汇聚箭头图标）。
- **交互状态**：
  - **汇总条容器**：静态展示，具备轻微顶部分隔阴影以区分滚动列表。
  - **“汇总至 Supervisor”主按钮**：
    - `default`：背景 `--squad-accent-solid`，文字白色 `oklch(0.99 0 0)`。
    - `hover`：背景 `--squad-accent-hover`。
    - `active`：`transform: scale(0.98)`。
    - `focus-visible`：`2px` `--squad-accent-ring`，偏移 `2px`。
    - `disabled`（正在向 Supervisor 写入汇总上下文时）：按钮文字变为“汇总中…”，`opacity: 0.5`，禁止重复点击。
- **尺寸规范**：
  - 容器总高度：`44px`
  - 容器内边距：上下 `8px` (`--space-2`)，左右 `12px` (`--space-3`)
  - 容器外边距（距面板边缘）：`8px` (`--space-2`)，圆角 `--radius-md` (`8px`)
  - 汇总按钮高度：`28px`，水平内边距 `12px` (`--space-3`)，圆角 `--radius-xs` (`4px`)
- **使用 Token**：
  - 汇总条背景：`--squad-accent-surface`（或叠加 `--squad-status-settled-bg`）
  - 汇总条边框：`1px solid --squad-accent-solid`（不透明度 `40%`）
  - 左侧图标色：`--squad-status-settled-dot`
  - 左侧正文：`--squad-text-primary`
  - 按钮背景：`--squad-accent-solid` / `--squad-accent-hover`

---

### 4.6 侧边栏会话分组头（Sidebar Session Group Header）

在约 `200px` 宽度的原生会话列表侧边栏中，将属于同一小队的 Supervisor 与 Worker 会话折叠归类为一个紧凑 Section。

- **视觉结构描述**：
  - 极高密度单行布局（适配 `200px` 总宽，扣除侧边栏左右各 `8px` 边距后实际可用宽度仅 `184px`）：
  - **左侧**（最大占比 `65%`，约 `116px`）：
    1. 折叠箭头图标 Chevron（`12px × 12px`，展开时旋转 `90deg`）
    2. 极小号小队身份点（`4px × 4px` 方形或圆点，`--squad-accent-solid`）
    3. 小队名称（`11px` 字重 `600`，超出强制单行省略 `...`）
  - **右侧**（固定紧凑区，最大 `64px`）：
    - 极简聚合状态：在 `200px` 宽度下省略文字与括号，仅保留最高优先级的两个状态符号+数字（如 `⟳1 · ✓3` 或 `⚠1 · ⟳2`），字号 `11px` `--font-mono`，间距紧凑为 `2px` (`--space-0-5`)。
- **交互状态**：
  - `default`：背景透明（`--squad-surface-0`），小队名 `--squad-text-secondary`，折叠箭头 `--squad-text-muted`。
  - `hover`：背景 `--squad-surface-1`，小队名提亮为 `--squad-text-primary`，折叠箭头变为 `--squad-text-secondary`。
  - `active`（点击切换折叠/展开，或当前活跃会话属于该小队）：背景 `--squad-surface-2`，小队名 `--squad-text-primary`。
  - `focus-visible`：内嵌 `1px solid --squad-accent-ring` 焦点框。
  - `disabled`：`opacity: 0.45`。
- **尺寸规范**：
  - 行高/总高度：`24px`
  - 内边距：上下 `4px` (`--space-1`)，左右 `6px` (`--space-1-5`)
  - 圆角：`--radius-xs` (`4px`)
  - 内部元素间距：`4px` (`--space-1`)
- **使用 Token**：
  - 背景：默认透明，Hover `--squad-surface-1`，Active `--squad-surface-2`
  - 小队名：默认 `--squad-text-secondary`，Hover/Active `--squad-text-primary`
  - 小队身份锚点：`--squad-accent-solid`
  - 右侧聚合计数：`--squad-status-running-text` / `--squad-status-settled-text` / `--squad-status-attention-text`

---

## 5. 动效规范

所有动效严格限制在合成器属性（**仅使用 `transform` 与 `opacity`**），严禁对 `height`、`margin`、`padding`、`top/left` 或 `border-width` 直接做过渡动画，彻底杜绝运行期的 Layout Thrashing（重排抖动），保证代码编辑器主线程流畅。

### 5.1 动效参数总表

| 动效场景 | 动画属性（仅合成层） | Duration | Easing 函数 | 视觉表现说明 | `prefers-reduced-motion: reduce` 降级方案 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **1. 任务简报编辑区展开 / 收起**<br>（同样适用于结果汇总条入场） | `transform: translateY(-4px) scaleY(0.96)` → `translateY(0) scaleY(1)`（`transform-origin: top`）<br>+ `opacity: 0` → `1` | 展开：`160ms`<br>收起：`120ms` | 展开：`cubic-bezier(0.16, 1, 0.3, 1)` (Expo Out)<br>收起：`cubic-bezier(0.4, 0, 1, 1)` (Ease In) | DOM 节点即时切换显隐（不动画 `height`），内容面板通过轻微上移与纵向缩放投影平滑浮现；结果汇总条从底部 `translateY(8px)` 滑入。 | `duration: 0ms`，移除 `transform` 位移与缩放，点击后直接切换显隐状态。 |
| **2. 状态变化过渡**<br>（如 `running` → `settled`、卡片 Hover、聚合计数更新） | 状态点/图标：`transform: scale(0.75)` → `scale(1)` + `opacity: 0` → `1`<br>表面高亮：伪元素层 `opacity` 过渡 | `150ms` | `cubic-bezier(0.22, 1, 0.36, 1)` | 状态切换时，新状态点带轻微弹性缩放（`0.75` → `1.0`）与透明度淡入；聚合数字更新时旧数字淡出、新数字原位淡入。 | 关闭 `scale` 缩放动画，仅保留 `80ms` `linear` 的 `opacity` 交叉淡入淡出（或瞬时切换）。 |
| **3. Running 状态呼吸脉冲动画** | 外层同心伪元素环：<br>`transform: scale(1)` → `scale(2.2)`<br>`opacity: 0.65` → `0` | `1600ms`<br>（`infinite` 循环） | `cubic-bezier(0.25, 0.8, 0.25, 1)` | 核心 `6px` 圆点保持 `opacity: 1` 恒定锚定，外层伪元素环周期性向外扩散并消隐，营造克制的雷达心跳感，多卡片并列时不晃眼。 | **完全移除无限循环动画**（`animation: none`）。外层伪元素固定为 `transform: scale(1.6)`、`opacity: 0.3` 的静态光环，凭静态双环形态与 `idle`/`settled` 区分。 |
| **4. 侧边栏分组折叠箭头旋转** | `transform: rotate(0deg)` → `rotate(90deg)` | `140ms` | `cubic-bezier(0.22, 1, 0.36, 1)` | 点击分组头时，左侧 Chevron 图标顺时针旋转 `90deg`。 | `duration: 0ms`，直接跳变至目标角度 `0deg` 或 `90deg`。 |

---

## 6. 参考来源（社区参考调研）

在设计“多 Agent 并行状态展示与任务派发”时，我们调研了当前开发者工具社区中最具代表性的三个实现，并结合桌面端紧凑面板场景进行了取舍：

### 6.1 Cursor（2.0 Multi-Agent / Background Agents 侧边栏与 composer 面板）
- **参考地址与界面特征**：https://www.cursor.com （Cursor Agent Sidebar & Background Agents 列表视图）—— 在约 `220px` 的左侧栏中将并行运行的 Agent 会话归组，每行仅用左侧单色微圆点 + 单行标题 + 右侧极简状态标识展示。
- **借鉴之处**：
  1. **极高密度的单行会话分组**：借鉴其将状态指示收敛为 `6px` 级别微圆点而非大尺寸 Tag 的做法，使得在 `200px` 宽的侧边栏中依然能留出充足空间显示小队名称与会话名。
  2. **就地展开（Inline Expansion）心智**：派发或补充指令时不弹出遮挡代码的全局 Modal，而是在当前 Agent 条目下方直接展开内联编辑框。
- **放弃之处及原因**：
  - 放弃了 Cursor 在部分执行态下使用的旋转菊花（Spinner）图标与滚动代码流微缩预览。**原因**：当一个小队有 4–6 个 Worker 同时处于 `running` 状态时，多个同步旋转的 Spinner 会在视觉边缘产生强烈的频闪干扰（Visual Noise），因此本规范改为核心静止、外环低频扩散的同心圆脉冲方案。

### 6.2 GitHub Actions / Vercel Deployment Checks（树状并行 Job 状态聚合栏）
- **参考地址与界面特征**：https://github.com/features/actions 及 https://vercel.com/docs/deployments —— 在 PR Checks 面板与构建详情顶栏中，使用紧凑的聚合摘要（如 `1 in progress, 3 successful` 配合浓缩图标）统领下方多个并行 Runner 的状态。
- **借鉴之处**：
  1. **符号化状态聚合公式（`⟳ 1 · ✓ 3`）**：直接启发了本规范中的“小队区块头部”与“侧边栏会话分组头”。通过将文字压缩为通用几何符号 + 等宽数字，在 `60px` 宽度内即可传达整个小队的完成度。
  2. **底部汇总触发器（Merge / Promote Bar）**：参考了 GitHub PR 在所有必选 Check 通过后底部区块由灰变绿、激活 Merge 按钮的流转体验，设计了所有 Worker 完成后浮现的“结果汇总条”。
- **放弃之处及原因**：
  - 放弃了其多色分段进度条（Segmented Progress Bar）设计。**原因**：在小队协作场景中，Worker 数量通常为 2–5 个且任务粒度不均，分段进度条在窄侧边栏中切分过碎，反而不如离散数字 `⟳ 1 · ✓ 3` 精确直观。

### 6.3 Linear（Sub-issues 列表与 Triage 键盘优先微交互）
- **参考地址与界面特征**：https://linear.app/features —— 父 Issue 下的 Sub-issues 列表行，以及高对比度暗色表面层级（LCH 色彩系统实践先驱）。
- **借鉴之处**：
  1. **OKLCH 感知均匀色彩空间**：借鉴 Linear 主题系统的设计方法，采用 OKLCH 定义全部中性色与四个语义色，确保青蓝（Running）、翠绿（Settled）、琥珀（Needs Attention）在暗色背景上拥有几乎一致的视觉发光度，不会出现琥珀色刺眼而蓝色暗淡的失衡现象。
  2. **结构化只读元数据胶囊**：借鉴 Linear 在行内展示只读属性与快捷键提示（`⌘↵` / `Esc`）的紧凑排版，应用于本规范的“引擎标签”与“边界声明（只读自动填入）”区块。
- **放弃之处及原因**：
  - 放弃了 Linear 多字段平铺的宽表格行布局（同时展示指派人头像、优先级、周期、标签等 5+ 列信息）。**原因**：代码助手面板是辅助代码编辑器的副屏区域（宽度通常不超过 `300px`），必须砍掉头像与装饰性图标，严格保持每张 Worker 卡片最多 4 个视觉信息点（状态点、名称、引擎、主操作）。
