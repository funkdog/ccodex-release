# Work IQ 接入与使用

本文件只说明通用实现、配置和验证方法，不包含任何真实企业环境的测试记录、
账户信息、业务样本、内部系统清单或访问结果。

## 功能与边界

Work IQ 是可选的 Microsoft 365 企业连接。开发版和 Release 各自使用自己的
profile、账户绑定与凭据缓存，CLI 和 Desktop 在同一安装内共享这一连接。
GitHub Copilot 登录不等于 Microsoft 365 授权，也不会赋予其他账户企业访问权限。

实际可用资源、工具、读写能力及许可证要求由当前用户、租户、连接器、
服务端策略和组织批准决定。模块存在、工具名称可见或合成测试通过，
都不能证明已经获得真实企业数据访问权或与第一方客户端完全等价。

默认关闭企业连接和下游数据处理同意；使用者需要自行登录，并在组织允许后显式启用。
401、403 或策略拒绝不会触发自动换账户、换接口或交互登录回退。

## 实现结构

```text
本安装的 CLI / Desktop
  -> 独立 profile 中的 stdio MCP 适配器
  -> 官方 Work IQ HTTPS 服务
  -> 当前账户获准的资源与工具
```

`bridge/workiq/` 包含：

- `settings.mjs`：配置、明确启用状态、数据处理同意及账户/租户绑定。
- `auth.mjs` / `oauth-code.mjs`：MSAL、授权码与 PKCE；设备码只作为用户明确选择的登录方式。
- `cache.mjs` / `vault.ps1`：Windows 当前用户 DPAPI 加密缓存、并发锁及过期锁恢复。
- `transport.mjs`：连接服务、分页发现工具、保留 schema、引用、进度与错误状态。
- `server.mjs`：本地 MCP 握手、状态与工具目录发现；不因握手自动登录或读取业务数据。
- `desktop.mjs`：图形账户面板、登录、取消、启用与禁用。
- `actions.mjs`：加密的待批准写操作队列。
- `main.mjs`：命令行入口。

账号与真实 tenant ID 都需要绑定，静默续期只使用已选身份；
缓存顺序、默认 `organizations` authority 或旧工具目录不作为换账户依据。
适配器不读取其他产品的凭据库，不打包发布者账户缓存。
DPAPI 的边界是当前操作系统用户，并非防御所有同用户进程的独立安全区。

本实现使用的服务 endpoint、OAuth client ID 和 scope 是公开服务标识，
不是用户密码、access token、client secret 或预置管理员授权。

## 写操作与审批

已知写工具，以及没有明确只读标记的未知工具，首先生成待批准记录，
不在首次工具调用时执行云端动作。记录绑定账户、租户、参数摘要、
过期时间和一次性执行状态；本地批准仍不能替代服务端许可。

用户可在 Desktop 的 Work IQ 面板查看准确参数并批准，或在自己的交互终端使用：

```powershell
ccodex workiq actions list
ccodex workiq actions show <id>
ccodex workiq actions approve <id>
```

批准要求完整确认输入。Agent 不得通过 shell 代替用户批准自己的操作。
网络超时后不能推断动作未执行，也不能自动重发发送、删除或其他写操作。
这些保护不改变本安装已有的沙箱或全局权限设置。

## 配置与使用

以下命令用于独立 Release；维护开发版时将 `ccodex` 换为 `ccodex-dev`。

```powershell
ccodex workiq install
ccodex workiq configure
ccodex workiq status
ccodex workiq doctor
ccodex workiq login
```

默认授权码登录使用 PKCE。用户手动打开返回的 Microsoft 授权地址；
端口冲突、取消、超时或身份变化不会提交新绑定。
只有用户明确选择时，才使用设备码：

```powershell
ccodex workiq login --method device-code
```

确认组织允许下游数据处理后再执行：

```powershell
ccodex workiq enable --acknowledge-data-sharing
ccodex workiq tools --live
```

Desktop：账户菜单 > Microsoft 365 / Work IQ。
登录、启用和数据处理同意分别处理，不以安装或登录成功代替同意。

对于尚未动态暴露的实际工具，先使用
`ccodex_workiq_status(include_tool_schemas=true)` 获取当前 schema，再通过
`ccodex_workiq_call` 传入准确工具名及参数；它仍经过原有身份绑定与审批队列。
工具目录变化需要刷新 MCP 或开始新会话，不强制终止活动会话。

## 数据处理

业务工具结果可能进入 Ccodex 对话并交给所选模型提供方。
这不自动继承第一方 Microsoft 365 客户端的全部数据保护、保留、驻留或审计保障。
只有组织允许这种处理方式时才能启用。

适配器不将业务正文写入自有诊断日志，但对话记录及模型请求仍可能包含工具结果。
安装和连接配置不会主动读取邮件、Teams、会议或文档正文。
遇到权限拒绝，应停止请求，不通过格式、别名或另一账户规避限制。

## 验证方法

自动回归使用临时 profile、合成身份、合成业务内容和固定 SDK，
只能证明接入实现、状态隔离、错误处理和审批流程。
企业环境验证必须另获用户与组织授权，使用最小样本；
发送、邀请、编辑、删除等验证还需要单独批准的测试对象。
本说明不发布任何真实环境验证结果，也不声称所有企业能力已经验收。

```powershell
& .\tools\Invoke-HeavyTask.ps1 'powershell -NoProfile -File .\tools\Test-WorkIq.ps1 -Full'
```

## 公开参考

- [Microsoft Work IQ](https://github.com/microsoft/work-iq)
- [官方 Work IQ 插件](https://github.com/microsoft/work-iq/tree/main/plugins/workiq)
- [管理员说明](https://github.com/microsoft/work-iq/blob/main/ADMIN-INSTRUCTIONS.md)
- [MSAL](https://github.com/AzureAD/microsoft-authentication-library-for-js)

这些公开资料用于了解协议和接入要求，不替代当前组织的批准或真实授权。
