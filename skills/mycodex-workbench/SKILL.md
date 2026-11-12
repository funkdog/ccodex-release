---
name: mycodex-workbench
description: 读取和更新 MyCodex 工作台的共同目标、工作、依据与下一步，供小鼠头委派的已连接本机任务接续同一份工作。用于“记到工作台”“继续这项工作”“更新共同依据”；不把普通聊天自动登记为工作。
---

这是本机工作台入口。小鼠头可将记录操作委派到已连接的这台电脑；本机执行者把结果交回发起会话，保留双方身份。能运行本入口不代表已经验证云端小鼠头可以发现或调用它。

下文用 `WORKBENCH` 表示安装时绑定的完整命令，原样运行，无需在 PATH 中查找 node：

<!-- local-command -->
MYCODEX_WORKBENCH_COMMAND
<!-- /local-command -->

- `WORKBENCH status`：检查当前运行网关是否已加载共同工作能力。`ready: false` 时说明缺少哪些方法，不代用户重启当前客户端或建立另一个存储。
- `WORKBENCH describe`：读取与 MCP 共用的参数 schema。其他命令从标准输入接收一个 JSON 对象，空输入相当于 `{}`，上限 32 KiB。
- `WORKBENCH goals`、`WORKBENCH list`：定位已有目标与工作；list 用 `goalId`、`offset`、`limit` 分页，按 `nextOffset` 继续。
- `WORKBENCH context`：输入 `{"id":"确切工作ID"}`，读取原意、采用的依据、候选结果、问题和下一步。多个可能目标时先消除歧义，不把浏览对象当成当前讨论绑定。
- `WORKBENCH goal`、`WORKBENCH record`：登记目标或更新工作，必须给出稳定的 `id` 和 `expectedRevision`。新建用 0，更新用刚读到的版本。ID 使用字母、数字、下划线或连字符，不为重试生成新 ID。record 只提交需要变化的字段；context 数组会整体替换，修改前先读全保留其他条目。

工作记录保留用户原意和实际进展。尚在规划时可以是 draft；要进入可推进状态，提供预期交回、判据和带负责人的下一步。不按工作类型编造步骤，不要求仓库或 Git。模型提出的方案记为 candidate；用户明确采用且有真实来源时才写 adopted，未知来源留空，不编造聊天引用或把执行者会话冒充小鼠头的发起会话。已有 `supervisorThreadId` 只有在确知真实目标会话时填写。

写入成功后用 `context` 回读该工作；向发起方交回目标 ID、工作 ID、revision、变化、下一步及未决问题。回执证明记录已保存，不证明用户已看到页面变化、结果已验收或某个 agent 已执行工作。

入口从不自动重试。冲突时回读并合并；`outcome: unknown` 表示请求可能已保存，先按原 ID 查询再决定，不能盲目重复写入。连接失败时报告缺少的证据，不读取连接文件内容、不直接编辑工作存储、不另建文件代替工作台。

连接失败会提供脱敏的 `code`、`phase`，可用时还有 `systemCode`。`GATEWAY_ACCESS_DENIED` 表示当前执行环境拒绝访问，不能据此判断网关停机；报告这些字段，由用户或宿主提供受支持的具体连接授权。不要改成全权限、开放其他传输或通过直接改存储绕过限制。`GATEWAY_ENDPOINT_MISSING`、`GATEWAY_CONNECTION_REFUSED`、`GATEWAY_HANDSHAKE_FAILED`、`GATEWAY_INITIALIZE_FAILED` 分别保留地址缺失、拒绝连接、握手和初始化的边界，交回原始字段再决定下一步。
