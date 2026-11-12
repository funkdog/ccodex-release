# ADR 0019：MyCodex 工作台与内联评审 UI/UX 设计及交互规范

- 状态：设计规范已确立（2026-11-01）；供阶段 P2（AI 雷达、个人日报与认知蒸馏）、P3（双模型对抗评审）及 P4（PR/Issue 守护收件箱）统一实现。
- 适用范围：`bridge/diy/*.mts`（纯视图组件）与 `bridge/desktop-spine-ui.mts`（宿主挂载胶水）。所有 DIY 视图运行在独立 `ShadowRoot` 中，严格遵守零外部 UI 框架、零宿主混淆符号依赖与确定性 `dispose()` 契约。

---

## 1. 视觉原则与原生融合基调

1. **克制融入，绝不喧宾夺主**：主聊天流与代码编辑器始终拥有最高视觉权重。MyCodex 增强控件在静默态下占用面积最小化，避免像 P1 原型那样将悬浮按钮放在右下角（`bottom: 20px; right: 16px`）遮挡输入区右侧的发送键与回到底部按钮。
2. **原生级深浅色自适应（Zero-Config Theme Sync）**：严禁硬编码纯白 `#fff` 或纯黑 `#000`。通过 `light-dark()` 与 `color-scheme: light dark`（结合宿主根元素暗色态感知或系统 `prefers-color-scheme`）定义一套语义化 CSS 变量，使毛玻璃层级、1px 细边框、次级文字对比度与 macOS 原生 ChatGPT 完全一致。
3. **扫读优先，悬停渐进显露（Progressive Disclosure）**：卡片默认只展示决策必需的 3 个锚点（状态/契合度徽章、单行/双行标题、两行摘要），次级动作在悬停或键盘聚焦时高亮，杜绝满屏密集按钮。

---

## 2. Shadow DOM 共享设计令牌（CSS Design Tokens）

`bridge/diy/drawer.mts` 在 `:host` 上统一声明以下 CSS 自定义属性，所有挂载在抽屉槽位（`DrawerSlot`）内的子面板直接继承，无需重复维护色板：

```css
:host {
  color-scheme: light dark;
  --mc-font-sans: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", system-ui, sans-serif;
  --mc-font-mono: ui-monospace, "SF Mono", Menlo, Monaco, monospace;

  /* 表面与毛玻璃层级 */
  --mc-surface-glass: light-dark(rgba(250, 250, 250, 0.86), rgba(28, 28, 30, 0.84));
  --mc-surface-card: light-dark(#ffffff, #242426);
  --mc-surface-card-hover: light-dark(#f5f5f7, #2c2c2f);
  --mc-surface-subtle: light-dark(rgba(0, 0, 0, 0.04), rgba(255, 255, 255, 0.06));

  /* 边框与阴影 */
  --mc-border: light-dark(rgba(0, 0, 0, 0.08), rgba(255, 255, 255, 0.09));
  --mc-border-strong: light-dark(rgba(0, 0, 0, 0.16), rgba(255, 255, 255, 0.18));
  --mc-shadow-drawer: light-dark(
    0 12px 40px rgba(0, 0, 0, 0.12),
    0 16px 48px rgba(0, 0, 0, 0.48)
  );

  /* 文本层级 */
  --mc-text-primary: light-dark(#171717, #ececec);
  --mc-text-secondary: light-dark(#52525b, #a1a1aa);
  --mc-text-muted: light-dark(#71717a, #71717a);

  /* 语义状态色（低饱和度原生感） */
  --mc-accent-emerald-fg: light-dark(#047857, #34d399);
  --mc-accent-emerald-bg: light-dark(rgba(16, 185, 129, 0.12), rgba(52, 211, 153, 0.14));
  --mc-accent-amber-fg: light-dark(#b45309, #fbbf24);
  --mc-accent-amber-bg: light-dark(rgba(245, 158, 11, 0.12), rgba(251, 191, 36, 0.14));
  --mc-accent-rose-fg: light-dark(#be123c, #fb7185);
  --mc-accent-rose-bg: light-dark(rgba(244, 63, 94, 0.10), rgba(251, 113, 133, 0.14));

  /* 几何尺寸 */
  --mc-radius-drawer: 14px;
  --mc-radius-card: 10px;
  --mc-radius-pill: 999px;
  --mc-radius-btn: 7px;
}
```

---

## 3. 全局布局与两大交互承载面

### 3.1 承载面 A：右上角状态胶囊 + 右侧悬浮工作台抽屉（升级 `drawer.mts`）

1. **右上角唤起胶囊（Top-Right Status Pill）**
   - **定位**：`position: fixed; top: 10px; right: 16px; height: 28px; z-index: 990; -webkit-app-region: no-drag`（避开 macOS 左上角红绿灯窗口控制区与底部 Composer 热区；若宿主顶栏右侧存在原生按钮，预留安全右边距或可配置偏移）。
   - **视觉形态**：圆角胶囊（`padding: 0 10px; border-radius: var(--mc-radius-pill)`），内含：
     - 品牌微标 `✦ MyCodex`（`12px`，字重 `500`）；
     - **动态角标点（Status Dot & Count）**：无未读高优项时仅显示静态品牌名；有新雷达高契合项显示翠绿小圆点 + 数字（如 `· 3`）；当 P4 守护触发熔断待人工介入时变为琥珀色小圆点；
     - 悬停 `title` 提示快捷键：`MyCodex 工作台 (⌘⇧M)`。
   - **全局快捷键**：监听 `Meta + Shift + KeyM`（macOS）切换抽屉开合；抽屉打开时按 `Escape` 关闭并将焦点精确归还触发前元素（保留 P1 已验证的 `returnFocus` 机制）。

2. **悬浮毛玻璃滑出抽屉（Floating Slide-Over Drawer）**
   - **尺寸与边距**：不再贴死屏幕边缘，采用 macOS 悬浮面板形态：`position: fixed; top: 44px; right: 12px; bottom: 12px; width: min(460px, calc(100vw - 24px)); border-radius: var(--mc-radius-drawer)`，配 `backdrop-filter: blur(20px) saturate(1.4)` 与 `1px solid var(--mc-border)`。
   - **三段固定骨架**：
     - **顶栏（Header，`46px`）**：左侧标题 `MyCodex 工作台`，右侧刷新状态轻提示与 `×` 关闭按钮（`28×28px`）。
     - **一级模块导航（Primary Tabs）**：紧凑底线/胶囊导航，承载 `📡 AI 雷达`、`📓 日报·蒸馏`、`🛡️ 守护`（槽位支持动态传入 `badge?: number | string` 与 `tone?: "neutral" | "positive" | "warning"`）。
     - **滚动内容区（Scrollable Panel）+ 底部单行状态条（Status Footer，`aria-live="polite"`）**：切换槽位时显示微骨架态而非闪烁文字，保留 P1 的 `AbortSignal` 竞态清理保护。

---

### 3.2 承载面 B：输入框上方「内联交叉评审托盘」（阶段 P3 专用槽位）

双模型对抗评审与当前正在编写的代码强绑定，**不放进右侧全局抽屉**，而是就近挂载在底部 Composer 容器正上方：

- **底栏触发器**：在现有 `mountNativeEnginePicker`（模型 / 推理强度 / 审批策略）同行右侧增加紧凑按钮 `⇄ 交叉评审`（高度 `28px`，保持与原生底栏控件完全一致的无边框悬停态）。
- **内联结果托盘（Inline Review Tray）**：
  - 评审完成或进行中时，在 Composer 输入框上方展开圆角卡片（最大高度 `220px`，内部可滚动）：
  - **托盘头部**：显示实际执行的只读异构审稿引擎（如 `⇄ 异构净室评审 · Antigravity Gemini-4-Argon · 只读`）与收起按钮。
  - **分级勾选行**：每条发现占单行或双行，格式为 `[Checkbox] [P0/P1/P2/Nit 标签] [file:line 代码锚点] — 问题描述`；默认自动勾选 `P0`/`P1`，`Nit` 默认不勾选。
  - **一键回流按钮**：右下角主操作按钮 `注入输入框修复 (N)`，调用 `HostActions.injectText()` 将勾选条目格式化为清晰的修复指令追加至当前输入框（**绝不自动点击发送**，保留人工最终确认权）。

---

## 4. 阶段 P2 两大核心面板交互细则

### 4.1 `radar-panel.mts`：每日 AI 雷达面板

1. **二级筛选栏（Filter Bar）**
   - 水平胶囊筛选：`全部` | `🔥 高契合`（默认激活或置顶） | 按报告分类标签动态聚合；最右侧展示上次采集同步时间（如 `08:30 已同步`）与手动增量同步图标按钮 `↻`。
2. **情报卡片结构（3 秒扫读布局）**
   - **首行元数据**：左侧契合度/评分胶囊（`>= 85` 用翠绿 `--mc-accent-emerald-*`，其余用中性灰） + 右侧信源小标（`GitHub` / `HN` / `X` / `Paper` 及时间）。
   - **标题行**：`13.5px`，字重 `600`，最多 2 行截断，点击标题在系统默认浏览器打开原始外部链接（或展开完整技术细节折叠块）。
   - **核心看点摘要**：`12.5px`，颜色 `--mc-text-secondary`，行高 `1.45`，默认最多展示 2–3 行。
   - **卡片底部动作栏**：
     - 主按钮 **`⚡ 结合本仓评估`**：调用 `HostActions.prefillDraft()`，切换到新建草稿并填入结构化评估提示词（含雷达条目标题、链接、核心摘要与“请结合当前工作区架构评估引入价值与落地方案”）；若当前草稿已有未发送内容，则在抽屉底部状态栏温和提示“当前草稿非空，已保留原内容；请清空或发送后再试”，不弹窗打断。
     - 次按钮 **`📥 存知识卡`**：调用 `diy/radar/save_card` 写入知识库蒸馏队列，成功后按钮原地变为 `✓ 已存卡`（禁用防重）。
     - 轻反馈 **`👍` / `👎`**：调用 `diy/radar/feedback` 更新本地偏好权重；点击 `👎` 后卡片平滑折叠为一行“已降权此类主题 · 撤销”。

### 4.2 `daily-panel.mts`：个人日报与认知蒸馏面板

采用顶部 **三段式分段控制器（Segmented Control）** 适应早/晚不同使用场景：

1. **视图 1：`🌅 早间续接 (Handoff)`（早上打开默认关注）**
   - 按工作区仓库聚合跨引擎（原生 GPT、`Codex + Copilot`、`Copilot CLI`、`Antigravity`）近期活跃且未归档的重点会话。
   - 每张卡片展示：**仓库名 + 引擎通道标签**、**会话标题**、**上次停留状态摘要**（最后轮次完成时间、状态或关联分支变更统计）。
   - 右侧主动作 **`→ 跳回会话`**：调用 `HostActions.openThread(threadId)` 直接在左侧主窗口切回该聊天。
2. **视图 2：`📝 团队日报 (Digest)`（晚间下班一键外发）**
   - 展示聚合当日全引擎会话轨迹与多仓库 `git log` 后生成的结构化脱敏总结（按项目分点列出：已完成、进行中、风险/阻塞）。
   - 右上角提供 **`📋 复制 Markdown`** 按钮（复制后原地反馈 `✓ 已复制` 1.5 秒）与 **`↻ 重新汇总`** 按钮。
3. **视图 3：`💎 候选知识卡 (Vault)`（经验沉淀闭环）**
   - 展示符合 `knowledge-card-v2.schema.json` 的当日提炼候选卡（标题、问题背景、关键结论、标签 `#tags`）。
   - 支持单行内联微调标题/标签后点击 **`✓ 写入知识库`**，调用后端 `vault_writer` 落盘。

---

## 5. 无障碍、动画与工程护栏

1. **动画与性能**：抽屉开合仅使用 `transform: translateX(...)` 与 `opacity`（`160ms cubic-bezier(0.2, 0.8, 0.2, 1)`），同时遵守 `@media (prefers-reduced-motion: reduce)` 自动降级为瞬时切换；严禁使用高频 `setInterval` 轮询重绘抽屉 DOM。
2. **事件隔离**：延续 P1 经过验证的 Shadow Root 局部事件冒泡隔离（`pointerdown`、`keydown`、`input` 等 `stopPropagation`），确保在抽屉内输入筛选词、编辑知识卡标题或按回车时，**绝对不会抢占原生 ChatGPT 编辑器焦点或误触发主窗口发送消息**。
3. **无外部资源依赖**：所有图标使用内联极简 SVG（`14×14px`，`stroke="currentColor"`）或原生系统符号，禁止发起任何外部字体、CDN 图标或远程图片请求，确保离线可用且零 CSP 报错。
4. **宽屏抽屉避让**：在窗口宽度充足（如 `>= 1120px`）时，工作台抽屉展开期间应避免遮挡主聊天区右侧文本及输入框上方的内联评审托盘。

---

## 6. CLI / ACP 会话图片与截图正文内联展开契约（标准协议投影修复）

### 6.1 根因核实

经对照真实网关线程落盘记录、官方 `codex app-server generate-json-schema`（`0.165.0-alpha.1.2`）与宿主渲染器分组逻辑，第三方引擎（如 `antigravity-acp`、`gemini-cli`）生成的图片或查看的截图未能展开到对话正文，由三处链路共同导致：

1. **引擎适配层盲转字符串**：`gateway/engines/antigravity.mts` 与 `gateway/engines/gemini-cli.mts` 在 `tool_call_update` 完成时直接执行 `JSON.stringify(update.content ?? update.rawOutput ?? "")`，把 ACP 标准多模态块（`{ type: "image", mimeType, data }`）序列化成数百 KB 的原始 JSON 文本。
2. **协议投影层截断并塞入折叠块**：`gateway/protocol.mts` 将所有工具完成结果一律包装为 `dynamicToolCall` 的 `inputText` 并硬截断在 `128 KiB`，既截碎了 Base64 图片载荷，又触发宿主渲染器将 `dynamicToolCall` 归入 `collapseWhenPossible: true` 的顶部折叠活动条（`Run generate image...`）。
3. **历史摘要视图过滤遗漏**：`gateway/protocol.mts` 处理 `thread/turns/list`（默认 `itemsView: "summary"`）时仅保留 `userMessage` 与 `agentMessage`，即使轮次中存在图片条目，重新打开历史会话时也会被过滤掉。

### 6.2 标准协议投影修复规范（零私有 DOM 注入）

无需通过 CDP 篡改官方消息流 DOM，直接复用官方 `0.165.0-alpha` 标准 `ThreadItem` 中的 **`imageGeneration`（`ImageGenerationThreadItem`）** 契约即可让宿主原生画廊组件在正文中完整展开图片（自带点击大图预览、右键复制图片、侧栏打开能力）：

1. **扩展引擎事件契约（`gateway/contracts.mts`）**：
   - 支持适配器在工具产出或显式查看本地有效图片文件时上报结构化图片产物（例如 `onImage` 或 `ToolEvent` 附带 `images?: ({ kind: "blob"; mimeType: string; data: string } | { kind: "file"; path: string })[]`），同时将 `dynamicToolCall` 自身的文本输出净化为可读摘要（如 `[Image output: <mimeType>, <bytes> bytes]`），彻底杜绝向 `threads/<id>.json` 写入截断的 Base64 垃圾文本。
2. **私有媒体落盘防膨胀（`<home>/gateway/media/<threadId>/`）**：
   - `ThreadStore` 单线程 JSON 上限为 `8 MiB`。对于内联 Base64 图片块，网关必须解码校验后以 `0o600`（`O_NOFOLLOW | O_EXCL`，拒绝符号链接与超限体积，单图上限如 `10 MiB`）落盘至 `<home>/gateway/media/<threadId>/<itemId>.<ext>`，并在 `deleteThread` 时联动清理对应媒体目录。
   - 对于工具明确生成或读取的本机已存在常规图片文件（`.png` / `.jpg` / `.jpeg` / `.webp` / `.gif`，经 `lstat` 核验为非符号链接常规文件且大小在宿主直传上限 `10 MiB` 内），可直接引用其真实绝对路径（或拷入线程媒体目录保真）。
3. **标准 `imageGeneration` 条目发射与 `summary` 保留（`gateway/protocol.mts`）**：
   - 对每张产出的有效图片，生成标准 `ThreadItem`：
     ```json
     {
       "id": "<uuid>",
       "type": "imageGeneration",
       "status": "completed",
       "savedPath": "<absolute-local-path>",
       "result": "file://<encoded-absolute-local-path>"
     }
     ```
   - 实时流式阶段依次发送 `item/started` 与 `item/completed` 通知；宿主渲染器的 `generated-image-source` 会自动通过本地宿主 `workspaceFiles.readBinary` 读取 `savedPath` 并在对话正文中独立展开渲染。
   - 在 `thread/turns/list` 的 `itemsView === "summary"` 过滤白名单中纳入 `"imageGeneration"`（与 `"userMessage"`、`"agentMessage"` 并列），确保切换会话或重启客户端后历史图片依然完整展示在正文中。
