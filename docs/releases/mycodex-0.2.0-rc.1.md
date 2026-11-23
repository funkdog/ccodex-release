# MyCodex 0.2.0-rc.1

macOS Apple Silicon（ARM64）候选版。安装后默认启用原生 Codex、`mycodex` MCP 和右侧 `Squad Studio`，沿用官方客户端的登录与聊天。Host 契约加入 ChatGPT `26.1117.41037`，修复启动诊断任务时互斥的 CLI 参数。Claude Code、Antigravity ACP 1.4.4 与 GitHub Copilot 可按需启用。

## 安装

下载 `mycodex-macos-arm64-0.2.0-rc.1.tar.gz` 及对应 `.sha256`，运行 `shasum -a 256 -c mycodex-macos-arm64-0.2.0-rc.1.tar.gz.sha256`。解压后依次运行 `./Install.command`、`./Diagnose.command`。等当前任务结束，正常退出官方客户端，再执行 `./Start.command`。需要 Node.js 24 或更新版本。配置步骤见 [macOS 指南](../ADAPTERS-MACOS.zh-CN.md) 和 [GitHub Copilot 接入指南](../CODEX-COPILOT-SETUP.zh-CN.md)。

## 产物与验证

| 文件 | 内容 |
| --- | --- |
| `mycodex-macos-arm64-0.2.0-rc.1.tar.gz` | 预编译包、安装入口与包内载荷清单 |
| `mycodex-macos-arm64-0.2.0-rc.1.tar.gz.sha256` | 归档的 SHA-256 |
| `RELEASE-0.2.0-RC1.json` | 归档大小、摘要、源码提交与载荷校验结果 |

本候选以公开 main `77692f8` 为基线。包内 `MYCODEX-MANIFEST.json` 包含逐文件摘要和默认配置。源码绑定见 [RC-0.2.0-RC1-SOURCE.json](../../release/RC-0.2.0-RC1-SOURCE.json)。预定发行标签为 [`mycodex-v0.2.0-rc.1`](https://github.com/funkdog/ccodex-release/releases/tag/mycodex-v0.2.0-rc.1)。

本地门禁覆盖 TypeScript、生成文件一致性、Squad 协议与生命周期、签名宿主契约、隔离网关与 MCP 连接以及归档完整性。真实桌面窗口和外部账号推理的验收证据随发布审核单独提交。
