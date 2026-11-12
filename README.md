# MyCodex Adapters

在已有官方 ChatGPT/Codex 窗口中使用自己的模型与 CLI。默认沿用官方 Codex 的账号、Provider 和模型设置；需要 GitHub Copilot 时，按接入文档登录自己的账号。

当前版本：**0.1.0-rc.3，macOS Apple Silicon（ARM64）预发布候选版**。真实桌面验收尚未完成，当前不标为稳定版。

- [打开 RC.3 下载页](https://github.com/funkdog/ccodex-release/releases/tag/mycodex-adapters-v0.1.0-rc.3)
- [直接下载 macOS ARM64 平台包](https://github.com/funkdog/ccodex-release/releases/download/mycodex-adapters-v0.1.0-rc.3/mycodex-adapters-macos-arm64-0.1.0-rc.3.tar.gz)
- [用自己的 GitHub Copilot 账号接入](docs/CODEX-COPILOT-SETUP.zh-CN.md)
- [macOS 安装与使用说明](docs/ADAPTERS-MACOS.zh-CN.md)

## 安装

1. 安装 Node.js 24 或更新版本，并安装、登录兼容的官方 ChatGPT/Codex 客户端；应用版本范围见 macOS 使用说明。
2. 在 Release 下载 `.tar.gz` 平台包和对应 `.sha256` 文件，放在同一目录，校验后解压：

```bash
shasum -a 256 -c mycodex-adapters-macos-arm64-0.1.0-rc.3.tar.gz.sha256
tar -xzf mycodex-adapters-macos-arm64-0.1.0-rc.3.tar.gz
cd mycodex-adapters-macos-arm64-0.1.0-rc.3
./Install.command
```

3. 使用原生 Codex 时，向导默认保留官方现有设置。当前任务结束后正常退出客户端，再运行包内的 `Start.command`。
4. **要接入 GitHub Copilot，改按 [专用接入指南](docs/CODEX-COPILOT-SETUP.zh-CN.md) 操作。** RC.3 的简化向导尚未覆盖 `codex-copilot`；指南提供独立账号登录、自己的模型 ID、配置生成和实际启动命令。

解压目录需长期保留，不要从临时文件夹运行。此包不包含 Node、第三方 CLI、发布者的账号、Key 或聊天；请配置自己的账号。

## 使用范围

- 新聊天可选择已配置的执行引擎，已有聊天保留原引擎与历史。
- 按需接入 Claude Code 或已适配的 Antigravity ACP 运行时；这些连接不默认预填模型，详情见安装说明。
- 工作台、Squad、雷达、日报与跨引擎历史迁移未启用。
- 当前仅提供 macOS ARM64 候选包；不提供 Intel Mac、Windows 或 Linux 安装包。

Release 附有 `RC3-VERIFICATION.json`：精简范围自动门禁 265/265 通过，解压后的 476 项文件摘要与原生默认路径复验通过。真实客户端的发送、审批、取消和冷恢复验收仍待完成；目录可见不代表当前账号推理一定可用。

本仓库提供下载与接入文档，运行源码和编译模块包含在平台包内。GitHub 自动生成的 **Source code (zip / tar.gz)** 是此发行仓库的文档快照，不能替代上面的平台包。
