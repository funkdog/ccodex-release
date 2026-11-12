# 账户与机器迁移

迁移 CodexCopilot 时，应在目标机器重新安装并独立认证。不要复制正在使用的
`%USERPROFILE%\.codex-copilot` 目录。

## 同一机器切换 GitHub 账户

```powershell
codex-copilot account switch
codex-copilot status
codex-copilot models
```

CLI 命令与 Desktop 底部的 **GitHub Copilot** profile bar 共用由 bridge 管理的
同一个 device-flow 会话。验证完成后，bridge 会原子发布凭据、模型目录和 account
generation。运行中的 ccodex 会立即使用新账户；Desktop 会重启本地 app-server 并
reload，使账户、模型选择列表和底部模型 bar 同时更新。GitHub 验证页通过 Windows
默认系统浏览器打开；账户面板中的 **Desktop settings** 会直接进入 Desktop 内置设置页。

## 迁移到另一台机器

源机器：

Windows：

```powershell
codex-copilot export .\codex-copilot-transfer.zip
```

macOS / Linux：

```bash
codex-copilot export ./codex-copilot-transfer.tar.gz
```

目标机器：

1. 必须选择与目标机器一致的独立包：
   `windows-arm64` / `windows-x64`、`macos-arm64` / `macos-x64` 或
   `linux-arm64` / `linux-x64`。不再提供跨系统或跨架构的统一安装包。
2. Windows 双击 `install.cmd`，或者执行：

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\install.ps1
   ```

   如果机器缺少官方 Codex/ChatGPT Desktop，安装器会尝试通过 `winget` 安装
   Microsoft Store 产品 `9PLM9XGG6VKS`。其中自带的 Codex CLI 与 Node.js runtime
   会被自动复用，无需单独安装 CLI。

   macOS 或 Linux 解压对应的 `.tar.gz` 后执行：

   ```bash
   ./install.sh
   ```

   macOS Desktop 需要机器上已有官方 `Codex.app`；Linux 版本只提供 CLI。

3. 如果目标机器没有可用的 Copilot 凭据，按提示完成 GitHub device login。
4. 验证：

   ```text
   codex-copilot doctor
   ccodex exec --skip-git-repo-check "Reply exactly OK"
   ```

## 升级已有安装

不需要先卸载旧版本。使用同一系统、同一架构的新包覆盖升级。隔离 profile、GitHub
账户以及 model / Context / effort 选择会保留。

## 安全边界

迁移包只包含安装器、运行时代码、skill，以及首选模型、reasoning effort 和
context tier，不包含：

- `github-auth.json` 或任何 OAuth token
- Windows Credential Manager 数据
- 会话、日志、数据库和 OAuth lock
- MCP 密钥、`.env` 文件或机器相关 named pipe

目标 profile 会从目标机器自己的 `%USERPROFILE%\.codex\config.toml` 生成，
避免把源机器的绝对路径和本地插件状态复制过去。
