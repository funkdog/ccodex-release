# 修改 MyCodex Adapters 和反馈问题

RC.3 的可维护源码、测试和构建工具位于本仓库。日常修改以 `main` 为基础；`main` 已包含 [RC.3 之后的桥接修复](docs/architecture/0033-chat-compat-sync.zh-CN.md)，尚未打入现有下载包；`codex/macos-adapters-rc3` 分支和 `mycodex-adapters-source-v0.1.0-rc.3` 标签保留本次源码快照。

## 从源码开始

需要 Git、Node.js 24 或更新版本及 npm。在自己的工作目录执行：

```bash
git clone https://github.com/funkdog/ccodex-release.git
cd ccodex-release
git switch -c codex/my-fix
npm ci --ignore-scripts --no-audit --no-fund
npm run build
```

修改 TypeScript 的 `.mts` 文件；同目录的 `.mjs`、`.mjs.map` 和构建清单由构建命令生成，不提交。直接编写的 `.mjs` 文件仍是源码，例如 `tools/configure-adapters.mjs`。

主要入口：

| 要修改的行为 | 位置 |
| --- | --- |
| 安装配置、CLI 路径和模型选择 | `tools/configure-adapters.mjs`、`tools/adapter-connection.mjs` |
| GitHub Copilot 登录与 API 转发 | `bridge/auth.mjs`、`bridge/cli.mjs`、`bridge/server.mjs` |
| 引擎和模型菜单、原生快速模式 | `bridge/desktop-native-composer.mts`、`bridge/diy/execution-picker.mts` |
| Codex + Copilot 路由和模型目录 | `gateway/router.mts`、`gateway/copilot-provider.mts` |
| 各 CLI 的调用、模型、审批与取消 | `gateway/engines/` |
| 会话持久化、协议与恢复 | `gateway/protocol.mts`、`gateway/state.mts` |
| 回归用例 | `tests/` |

源码克隆不含账号、聊天、第三方 CLI 或离线运行时；包里关闭的历史工作台、Squad 等源码也不代表 RC.3 已启用这些功能。旧完整发行渠道的维护说明见 `docs/DEVELOPMENT.zh-CN.md`，RC.3 优先按本指南操作。

## 验证修改

先运行与改动有关的测试，再运行精简范围门禁。测试和构建使用仓库自带的调度器：

```bash
bash tools/Invoke-HeavyTask.sh node --test tests/configure-adapters-test.mjs
npm run test:adapters
```

浏览器用例需要 Playwright 与浏览器。macOS 默认使用 `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`，也可设置 `MYCODEX_TEST_BROWSER` 为自己的浏览器可执行路径。例如在源码工作目录准备测试依赖：

```bash
npm install --no-save --package-lock=false --ignore-scripts playwright
export MYCODEX_TEST_PLAYWRIGHT="$PWD/node_modules/playwright/index.mjs"
npm run test:adapters
```

有些集成用例还需要兼容的官方客户端或本机已安装的 CLI/SDK。按实际输出记录缺少的前置条件和跳过项，不把跳过或模拟用例称为真实桌面验收。测试只使用独立临时 profile；不要把日常账号配置交给自动测试。

自动门禁之外，涉及桌面行为的修改需在专用聊天验证真实发送、批准/拒绝、取消及正常重开续聊。保持当前会话，完成任务后再正常重开客户端；不为源码变更强制结束任务。

## 提交修复或反馈

1. 没有仓库写权限时先 Fork，在自己的 `codex/` 分支修改。
2. 为问题补一个能复现错误的用例，说明触发条件、修复后的行为和验证结果。
3. 向 `funkdog/ccodex-release` 的 `main` 提交 Pull Request；有复现信息但尚无修复时创建 Issue。

Issue 建议提供：RC 版本、macOS 架构、官方应用版本、执行引擎和模型 ID、最短复现步骤、期望与实际结果、脱敏报错。不要上传 token、Key、账号目录、私人聊天或原始日志。

## RC.3 源码与发布包的对应关系

`release/RC3-SOURCE.json` 记录已发布原包的 SHA-256、载荷摘要及 313 个运行源码文件的逐文件摘要。它们与 RC.3 平台包一致；测试、开发文档及其他维护源码另行提供。

既有 Release 标签 `mycodex-adapters-v0.1.0-rc.3` 和安装包保持不变。该标签最初指向发行文档，因此它自动生成的 Source code 压缩包仍是文档快照；完整源码请使用 `main`、源码分支或专用源码标签。日常开发产生的新提交不再冒称与旧 RC.3 完全一致。

源码公开不等于新的稳定发行。真实桌面验收仍待完成；不要直接覆盖已发布包。需要正式构建或涉及 native core 时，按 `AGENTS.md` 和现有发布门禁执行。
