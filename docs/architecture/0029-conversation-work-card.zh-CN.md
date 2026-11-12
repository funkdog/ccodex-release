# 小鼠头对话内共同工作卡片

## 已确认的产品方向

用户明确要求工作卡片进入小鼠头的对话，常用操作不必反复跳到工作台。对话负责形成、接续与推进工作；卡片和工作台引用同一个工作 ID 和版本。浏览或选择卡片不表示采用候选、启动任务或完成验收。

## 本轮接入

- 现有 MyCodex 工作台插件新增只读工具 `mycodex.show_work_card`。先定位确切的通用工作 ID，再返回同一网关的 `work_context` 快照及展示资源。数据读写工具仍独立，不在每次读取后反复渲染卡片。
- `gateway/spine/mcp-server.mts` 增加固定 UI 资源的列举与读取；仅允许 `ui://mycodex/work-card-v2.html`，不接受任意文件或远程 URL。正式读写连接及完整本机连接提供卡片资源，旧只读诊断模式保持原有工具范围。
- `bridge/diy/work-card.mts` 是自包含的对话组件。通过 MCP Apps 的 `ui/initialize`、工具结果通知、`tools/call` 和 `ui/update-model-context` 通道工作，按能力兼容已有 ChatGPT bridge。资源不含真实记录、网关凭据或 localhost 请求；记录经已授权宿主工具取得。
- 卡片展示本轮交回、阶段进展、带负责人的下一步、待判断事项和成果依据。选择接续工作时同步模型可见上下文；宿主只有消息能力时，由用户明确点击发起接续。未取得宿主回执不会宣称已接续。
- 可在卡片内更新进展和下一步。写入带确切 revision，冲突保留输入并展示新版；超时不自动重发写入。候选成果只有具有来源且内容未发生变化时才可采用，采用不会自动完成工作。
- 所有业务内容使用 DOM textContent，不解释材料中的 HTML。UI 资源限制外部连接和资源加载，不增加代码执行、Agent 派发、删除或其他会话读取。

## 当前交付证据与边界

74 个 TypeScript 源文件的运行输出已通过既有低优先级 wrapper 转换。按用户要求，没有运行测试套件、大型构建或平台安装包发布。VERSION 和原生补丁链未变。

在确认没有活动请求并核对进程身份后，只重载这条隧道监管的专属 MCP 子进程。原 ChatGPT、网关、隧道 daemon 及运行密钥均保留。通过原插件设置刷新工具后，云端已发现 `mycodex.show_work_card`，实际调用返回工作 `work-dot-workbench-collaboration` 的 revision 7 与结构化卡片数据。

用户随后交回真实小鼠头回复：「工作记录已读取，但交互卡片在当前对话中未能展示；卡片数据准备成功不代表界面渲染成功。」这是小鼠头对呈现状态的文字描述，尚无直接界面证据，因此本轮对话内呈现仍未通过验收。该回复没有给出工具调用名，尚不能确认此次是 `show_work_card` 还是普通 `work_context` 读取，不能直接归因为宿主不支持。

## 首次实际呈现失败后的修正

只读检查当前安装客户端 `26.1027.51404` 的资源解析与工具卡片组件，确认它接受 `text/html;profile=mcp-app`，并支持标准 `ui.csp` 元数据。这只能证明代码具有相关呈现路径，不证明真实小鼠头本次走到该路径。

发现原资源没有声明加载前的显示模式，且当前客户端默认把自定义资源标为可折叠。v2 资源补充官方文档支持的 `openai/ui.availableDisplayModes: ["inline"]`、客户端支持的 `preferredDisplayMode: "inline"` 和 `openai/widgetShowCodexWidgetInline: true`。后两项的依据是当前安装客户端的静态代码，属于有版本范围的兼容提示，不是跨宿主保证。资源 URI 升为 v2，防止沿用旧展示资源缓存。

卡片完成 MCP Apps 初始化并取得确切工作引用后，自动进行一次既有 `work_context` 只读调用，核对最新记录。该请求仅携带固定阶段标记，不发送额外业务内容；失败不自动重试。专属 shared-work MCP 进程把最近最多 32 条阶段事件写到绑定文件同目录的 `work-card-delivery.json`，仅含进程 ID、时间、固定资源 URI 与固定事件枚举，不含工作 ID、材料、聊天或凭据。普通上下文读取、展示工具、资源返回和带 bridge-ready 标记的读取分开记录。标记是诊断数据，不能作为权限、视觉可见或用户验收的证明。

失败结果已通过统一写入工具登记到原工作 revision 8，并回读确认；下一步负责人为 Codex。没有重建连接、重新索要密钥、运行测试套件或重启用户客户端。

## v2 后续回执的证据更正

v2 进程记录在 `2026-11-04T10:47:20Z` 收到一次新的展示请求并返回了数据；此前的资源返回发生在刷新工具期间。尚未记录到带 `bridge-ready` 标记的卡片只读回执。事件不包含会话标识，因此与具体小鼠头对话的关联依据是发生时间与用户回述；缺少标记本身也不能证明卡片初始化必然失败。

用户随后转述「widget unavailable」，并在明确询问后确认该词只出现在小鼠头的文字回复里。因此它不是已确认的客户端错误、HTTP 错误或 MCP 错误，不能作为继续改动呈现代码的独立证据。目前停止重复展示调用，先核对现有回复附近的真实卡片或可展开工具块。更正后的状态已登记到原工作 revision 10；实际可见性与交互仍未验收。

## 用户截图与小鼠头实际呈现路径

用户随后提供实际浮窗截图，直接确认两次展示回复都是文字气泡，截图范围内没有工作卡片或可展开的应用入口。这次可以确认界面没有达到目标，但仍不能把回复里的 `widget unavailable` 当作原始系统错误。

沿当前安装客户端静态代码继续核对，发现浮窗并非完全缺少卡片能力：

- `avatar-overlay-native-page` 的浮窗消息列表调用房间控制器的 `renderMessageFooter`。
- `native-room` 在 footer 中渲染该消息的 widgets，按需加载 `OrbitMessageWidgetContent`。
- `native-api` 将消息中 `type: widget` 的附件转换为 hosted-widget 记录；对应解析器要求非空的 `html_asset_pointer` 与 `resolved_pineapple_uri` 元数据。
- `message-widget` 加载资源并复用 ecosystem widget 宿主。

因此，「普通 ChatGPT 有组件而小鼠头浮窗没有渲染器」不足以解释本次失败。待定位的是工具结果如何变成小鼠头可识别的卡片消息：可能是附件未生成、元数据未被识别或后续加载失败。当前工具没有暴露这条小鼠头消息的原始 widget 附件与宿主加载错误，不能在缺少该证据时选定某个分支。工作 revision 11 已记录此阻塞；没有继续修改展示代码、重复调用工具、操作内置聊天或运行测试。

## 直接执行入口对照与消息交付核查

用户明确要求助手直接执行定位后，使用正式会话工具在原有闲置普通 ChatGPT 聊天中发送了一条只读展示请求，再通过 Chrome CUA 直接观察。该聊天原先仅有一条「测试」消息，没有活动工作；未创建新会话。助手只提交一条请求，服务端实际观察到两次 `show_work_card` 调用，未将提示中的「仅一次」当成执行次数证据。

普通 ChatGPT 首先显示真实的「未能显示 MyCodex 工作台」占位。只点击现有组件的「重试」，不改源码、连接、CSP 或密钥后，卡片实际可见。随后点击「成果与依据」并返回「概览」，均读取到真实内容。桥接只读回执在 `2026-11-04T12:10:25.424Z` 返回，证实组件代码及标准桥接通路可以运行。该结果不证明首次加载稳定：另一个后台页面重新打开同一聊天时仍曾显示首次加载失败，首次失败的具体加载条件尚未查明。

继续通过网页进入同一个小鼠头聊天，确认历史展示回复依旧只有文字。向小鼠头发送一次只追溯旧错误、不重新展示的诊断问题，暂未收到新回复。随后使用 Chrome 自带 DevTools 的 Network Response 读取页面本来发起的最近消息请求，没有提取、复用 cookie 或 Authorization，也没有私下调用接口。

服务器消息响应中，`Sentinel_2cb02cb23a9c81919cfe2383f243668c`（`2026-11-04T10:47:27.192489Z`）的正文正是 revision 9 与「widget unavailable」那条回复，其 `content.attachments` 为 `[]`，`inspector_url` 为 `null`。对该最近 20 条消息响应全文搜索 JSON 字面值 `"widget"`，结果为 `0 of 0`。因此，这次小鼠头尝试没有在返回的消息页中交付任何 widget 附件；客户端无从挂载这张卡片。此处已确认交付断点，但尚未确认上游为何没有生成附件，仍不能单凭该结果归因为模型错误、平台缺陷或插件兼容限制中的某一项。

本轮只进行了实际聊天与组件操作、日志和响应核查。没有运行测试套件、大型构建、修改客户端安装包或重新配置连接。工作 revision 12 已记录普通 ChatGPT 的可见正例和小鼠头附件为空的直接证据。可核查截图与结构化记录保存在本会话的可视化目录：`ordinary-chatgpt-card-visible.png`、`dot-message-empty-attachments.png`、`dot-card-message-delivery-evidence.json`。

## 原始错误不可得后的判断边界

再次读取小鼠头实际新回复，它明确表示只能看到旧聊天文字，拿不到先前展示工具的原始回执，无法核实完整工具名、参数、资源 URI 或错误码，并撤回「展示返回 The widget is unavailable」属于已核实事实的说法。因此，不能将这句文字作为平台错误或另一次真实展示调用已发生的证据；当前工具执行链仍需直接验证。

空附件是已确认的交付失败结果，并不是最终根因。后续优先核对小鼠头实际执行的展示动作与组件引用规则，其次核对该自定义卡片在小鼠头链路中的兼容性，同时保留普通 ChatGPT 首次加载失败提示的启动问题。已向现有小鼠头聊天发起只读的当前工具定义查询，不再次调用展示、不写记忆或改变连接。未证明不可解决，也未将任何一项假设记为已确认根因。

当前旧网关继续提供既有工作方法。MCP 源码变化会触发后续启动时的网关源码漂移检查；本轮没有伪造其运行指纹、放宽生命周期保护或强制重启网关。正式安装包发布仍未完成。

## 按当前契约执行两步发送后的新复现

已在原小鼠头聊天核对它当前可用的工具定义。其说明要求生成 widget 的工具结束后，立即调用 `user_message.send_message`，指定 `channel: "chatgpt"` 与 `metadata.include_widget: true`，中间不调用其他工具。该定义没有说明服务内部如何关联原始 widget，因此不推断其内部机制。

随后明确要求并执行一次 `show_work_card({id: "work-dot-workbench-collaboration"})`，紧接着发送包含上述标记的新卡片消息。本机独立阶段记录确认 `2026-11-04T12:38:35.315Z` 收到展示请求，`.323Z` 返回数据。小鼠头在本次执行后交回的回执说明第一步成功，第二步 `mcp__codex_apps__user_message_send_message` 返回：

> The widget is unavailable. Do not send the same caption as text-only or claim the card was delivered. A new text-only message can explain the problem or share a verified setup link if available. Delivery from an earlier attempt may be uncertain; do not automatically retry this send.

它报告回执没有独立错误码，未重试。发送参数和错误文字的证据来源是直接观察到的小鼠头本次回执回复，不是助手取得了内部发送服务的原始 JSON；第一步另有本机阶段记录支持。截图为本会话可视化目录下的 `dot-widget-send-explicit-failure.png`。

这个新复现表明，仅补发送顺序或 `include_widget` 参数没有解决当前问题。优先假设转为小鼠头发送器未识别或关联当前自定义 MCP 组件，或存在兼容/支持限制；还没有证据确认具体机制或只能由平台修复。普通 ChatGPT 首次加载问题仍保留为独立疑点，不将其已显示的正例当作小鼠头验收成功。工作已更新至 revision 14 并回读；本次没有修改运行源码、重连、重启或运行测试。

参考：

- [OpenAI Docs：Add UI to your MCP server](https://developers.openai.com/plugins/build/chatgpt-ui)
- [OpenAI Docs：Plugin reference](https://developers.openai.com/plugins/reference)
- [本轮接入证据](evidence/2026-11-04-conversation-work-card.json)
