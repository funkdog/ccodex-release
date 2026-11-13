# MyCodex Adapters

在已有官方 ChatGPT/Codex 窗口中使用自己的模型与 CLI。默认沿用官方 Codex 的账号、Provider 和模型设置；需要 GitHub Copilot 时，按接入文档登录自己的账号。

当前版本：**0.1.0-rc.4，macOS Apple Silicon（ARM64）预发布候选版**。真实桌面验收尚未完成，当前不标为稳定版。

- [打开 RC.4 下载页](https://github.com/funkdog/ccodex-release/releases/tag/mycodex-adapters-v0.1.0-rc.4)
- [直接下载 macOS ARM64 平台包](https://github.com/funkdog/ccodex-release/releases/download/mycodex-adapters-v0.1.0-rc.4/mycodex-adapters-macos-arm64-0.1.0-rc.4.tar.gz)
- [用自己的 GitHub Copilot 账号接入](docs/CODEX-COPILOT-SETUP.zh-CN.md)
- [macOS 安装与使用说明](docs/ADAPTERS-MACOS.zh-CN.md)
- [RC.4 修复与验证记录](docs/releases/mycodex-adapters-0.1.0-rc.4.md)

## 安装

1. 安装 Node.js 24 或更新版本，并安装、登录兼容的官方 ChatGPT/Codex 客户端；应用版本范围见 macOS 使用说明。
2. 在 Release 下载 `.tar.gz` 平台包和对应 `.sha256` 文件，放在同一目录，校验后解压：

```bash
shasum -a 256 -c mycodex-adapters-macos-arm64-0.1.0-rc.4.tar.gz.sha256
tar -xzf mycodex-adapters-macos-arm64-0.1.0-rc.4.tar.gz
cd mycodex-adapters-macos-arm64-0.1.0-rc.4
./Install.command
```

3. 使用原生 Codex 时，向导默认保留官方现有设置。当前任务结束后正常退出客户端，再运行包内的 `Start.command`。
4. **要接入 GitHub Copilot，按 [专用接入指南](docs/CODEX-COPILOT-SETUP.zh-CN.md) 操作。** RC.4 的简化向导尚未覆盖 `codex-copilot`；指南提供独立账号登录、自己的模型 ID、配置生成和实际启动命令。

从 RC.3 升级时解压到新的长期目录，保留原账号和配置。原生/CLI 配置使用新包的向导选择“使用当前配置”；Copilot 手动配置使用新包路径设置 `MYCODEX_PACKAGE`，保留已有个人配置并按指南正常重开。不删除旧目录中的个人数据，不热替换正在运行的任务。

解压目录需长期保留，不要从临时文件夹运行。此包不包含 Node、第三方 CLI、发布者的账号、Key 或聊天；请配置自己的账号。

## 使用范围与修复

- 新聊天可选择已配置的执行引擎，已有聊天保留原引擎与历史。
- 按需接入 Claude Code 或已适配的 Antigravity ACP 运行时；连接不默认预填模型，详情见安装说明。
- RC.4 修复 Chat Completions 的上下文保留、流式工具身份、Schema 转换和截断状态处理，详见发行记录。
- 工作台、Squad、雷达、日报与跨引擎历史迁移未启用。
- 当前仅提供 macOS ARM64 候选包；不提供 Intel Mac、Windows 或 Linux 安装包。

Release 附有 `RC4-VERIFICATION.json`：精简范围自动门禁 **302/302 通过**，解压后 **476 项载荷文件摘要**及原生默认网关复验通过。真实客户端的发送、审批、取消和冷恢复验收仍待完成；目录可见不代表当前账号推理一定可用。

## 源码与修复

`main` 提供可维护源码、测试、锁定依赖与构建工具。开始修改前阅读 [开发贡献指南](CONTRIBUTING.md)。

```bash
git clone https://github.com/funkdog/ccodex-release.git
cd ccodex-release
npm ci --ignore-scripts --no-audit --no-fund
npm run build
```

- [RC.4 源码分支](https://github.com/funkdog/ccodex-release/tree/codex/macos-adapters-rc4)
- [RC.4 固定源码标签](https://github.com/funkdog/ccodex-release/tree/mycodex-adapters-source-v0.1.0-rc.4)
- [RC.4 源码与平台包对应记录](release/RC4-SOURCE.json)
- [反馈问题](https://github.com/funkdog/ccodex-release/issues/new)；修复可通过 Fork 和 Pull Request 提交到 `main`。

源码不含账号、依赖缓存、生成的运行文件或第三方运行时副本。RC.4 的源码标签和 Release 自动 Source code 归档包含完整源码与测试；它们需要构建，使用者安装请下载平台包。后续 `main` 可继续接收修复，固定标签用于复现本次源码。

历史 [RC.3 下载页](https://github.com/funkdog/ccodex-release/releases/tag/mycodex-adapters-v0.1.0-rc.3)、[RC.3 固定源码标签](https://github.com/funkdog/ccodex-release/tree/mycodex-adapters-source-v0.1.0-rc.3) 及附件保持原样。
