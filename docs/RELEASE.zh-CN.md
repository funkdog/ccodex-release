# Ccodex Release 安装与升级指南 (v1.2.36)

## 下载入口（四平台全量维护）

[打开企业仓库 Release 页面 (v1.2.36)](https://github.com/nifan_microsoft/ccodex-release/releases/tag/v1.2.36)

- **Windows 11 X64（Intel / AMD）**：[CCodex-1.2.36-Desktop-26.1007.9446.0-Windows-X64-Setup.exe](https://github.com/nifan_microsoft/ccodex-release/releases/download/v1.2.36/CCodex-1.2.36-Desktop-26.1007.9446.0-Windows-X64-Setup.exe)
- **Windows 11 ARM64（骁龙 / ARM）**：[CCodex-1.2.36-Desktop-26.1007.9446.0-Windows-ARM64-Setup.exe](https://github.com/nifan_microsoft/ccodex-release/releases/download/v1.2.36/CCodex-1.2.36-Desktop-26.1007.9446.0-Windows-ARM64-Setup.exe)
- **macOS Apple Silicon (ARM64)**：[codex-copilot-macos-arm64-1.2.36.tar.gz](https://github.com/nifan_microsoft/ccodex-release/releases/download/v1.2.36/codex-copilot-macos-arm64-1.2.36.tar.gz)
- **macOS Intel (X64)**：[codex-copilot-macos-x64-1.2.36.tar.gz](https://github.com/nifan_microsoft/ccodex-release/releases/download/v1.2.36/codex-copilot-macos-x64-1.2.36.tar.gz)
- **Linux X64**：[codex-copilot-linux-x64-1.2.36.tar.gz](https://github.com/nifan_microsoft/ccodex-release/releases/download/v1.2.36/codex-copilot-linux-x64-1.2.36.tar.gz)
- **Linux ARM64**：[codex-copilot-linux-arm64-1.2.36.tar.gz](https://github.com/nifan_microsoft/ccodex-release/releases/download/v1.2.36/codex-copilot-linux-arm64-1.2.36.tar.gz)
- **SHA256 校验清单**：[SHA256SUMS.txt](https://github.com/nifan_microsoft/ccodex-release/releases/download/v1.2.36/SHA256SUMS.txt)

当前版本为 **1.2.36**，内置隔离的 **Codex Desktop 26.1007.9446.0**（应用版本 `26.1007.71326` / `codex-cli 0.162.x`）与 **GitHub Copilot CLI 1.0.97**。

## 校验与安装

| 平台 / 架构 | 安装包文件名 | 大小 | SHA256 |
|---|---|---:|---|
| Windows ARM64 | `CCodex-1.2.36-Desktop-26.1007.9446.0-Windows-ARM64-Setup.exe` | 1.98 GiB | `1c0c31d7208dbf4e6d335a6cdc9813a6280a284e7362b7017ee21bacb1ba4bd9` |
| Windows X64 | `CCodex-1.2.36-Desktop-26.1007.9446.0-Windows-X64-Setup.exe` | 1.97 GiB | `9f940e594a8ddbd1c4835901ee0de38ae50a40d513e488c8a84680fd680516d0` |
| macOS ARM64 | `codex-copilot-macos-arm64-1.2.36.tar.gz` | 328.4 MiB | `64b41f9c68e89d7237951cb84651ae4f78770440a0beba599be9ea1bbc2c31f0` |
| macOS X64 | `codex-copilot-macos-x64-1.2.36.tar.gz` | 353.0 MiB | `01dd85ea1736c16eac92581fc906b548cfa7429761dd3ee3a67c6340830827d9` |
| Linux ARM64 | `codex-copilot-linux-arm64-1.2.36.tar.gz` | 365.2 MiB | `2db22130571093c2598f9398d640b153ea4a1ccb2a66f0f00a5ddccdd74528e3` |
| Linux X64 | `codex-copilot-linux-x64-1.2.36.tar.gz` | 373.4 MiB | `086c047a9a45edb73753dc49c377aa33530828b3008d86985dfce80726f4cbe8` |
| 全平台校验清单 | `SHA256SUMS.txt` | 672 B | `0c978bb01d245c53f911e60525fb851a86d5f8778ece2533d0615dbc5c2465f0` |

在下载目录打开 PowerShell：

```powershell
Get-FileHash -Algorithm SHA256 .\CCodex-1.2.36-Desktop-26.1007.9446.0-Windows-X64-Setup.exe
```

## 新版本热更新提醒（CLI & Desktop）

从 1.2.36 起，CLI 与 Desktop 均内置了针对本仓库 Release 的热更新检测与一键升级能力：
- **CLI 热提醒**：启动 `ccodex` 时自动检测 `nifan_microsoft/ccodex-release` 是否有新版本，并在终端显示新版本提示框。
- **Desktop 热提醒**：当检测到新版本时，Desktop 右下角自动弹出更新提醒卡片，支持点击 **立即下载并安装更新** 或复制命令。
- **一键升级命令**：
  ```powershell
  ccodex release-update --check
  ccodex release-update
  ```
  自动识别当前平台架构，下载对应 Release 资产并严格校验 SHA-256 后执行原地升级，保留所有登录凭据与历史会话。

ARM 电脑替换为 ARM64 文件名。结果应与 `SHA256SUMS.txt` 和上表一致。
SHA256 验证完整性，不等同于发布者代码签名。

运行 EXE，建议预留至少 16 GiB 空间。安装期间会解压全部离线资源并完成重校验，可能需要数分钟。
无需预装 Node、Git、Codex、Copilot 或 Desktop，不需要另外运行旧 Recovery 工具。
遇到系统或组织阻止时，应按公司终端准入流程处理，不要关闭安全防护来绕过策略。

## 使用

开始菜单打开 **Ccodex Desktop**，首次登录通过图形入口及浏览器授权自己的 GitHub Copilot 账户。
安装包不包含发布者登录；Microsoft 365 连接需另外授权。
已登录后的正常 Desktop 启动不弹出终端窗口。

新终端运行：

```powershell
ccodex
ccodex features
ccodex release-doctor
ccodex -C "D:\Projects\my-project"
```

`ccodex` 使用调用时的工作目录。CLI 快捷方式默认打开用户“文档/Ccodex Workspace”。
Desktop 使用用户选择的项目，不以程序安装目录作为项目。
有其他未知 `ccodex` 命令时，不覆盖对方；使用本安装的 **Ccodex CLI** 快捷方式。

## 中文、权限与隔离

左侧“最近”标题右侧点击 **管理**；即使没有聊天也可打开会话管理。
底部按钮显示实际模型及 Effort；点击后在原生面板的模型标题旁选择 **Context**，
强度仍由原生滑块控制。Context 与强度分别保存，切换其一不应重置另一个。
旧同名 EXE 不含本轮修复，应重新下载并核对当前 SHA256。

新 profile 默认简体中文；已有语言偏好保留。
语言：Settings > General > Language > 简体中文。
权限：Settings > General > Permissions；入口可见不代表自动获得权限，仍需用户明确选择并遵守组织策略。

Release 使用独立安装、配置、凭据、聊天、缓存、桥接进程与端口。
开发者日常版用 `ccodex-dev`，原版 `codex` / `copilot` 不替换。
软件隔离不是虚拟机隔离；共享项目文件、系统网络配置和同一云端账户的权益仍为共享条件。

## 更新、卸载与测试范围

同版本新包可重新下载安装；不可变资源槽按内容区分构建，不以目录名称相似判断归属。
升级前正常退出本安装的旧 Release Desktop；不需要退出原版或开发版。
卸载只处理本安装拥有的程序，个人数据是否保留以卸载选项为准。
不要手动删除开发版、原版软件、凭据或聊天目录来“修复”安装。

当前 EXE 摘要及验收记录见 [验收资料](validation/)。
本轮更新会话入口、底部选择栏和私有文档运行时目录切换的有界重试；
原生核心、第三方固定运行时、凭据规则和权限默认值未改变。
具体 UI 交互、安装方式和摘要见 [本轮界面修复验收](validation/UI-VALIDATION.zh-CN.md)。
X64 为 ARM64 系统仿真验证；真实首次授权、付费推理及全部企业能力没有在本轮重验。
