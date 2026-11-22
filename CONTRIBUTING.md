# 参与 MyCodex 开发

日常修改从公开仓库的 `main` 开始。提交前阅读 [项目开发与发布规则](AGENTS.md)。如果你要复现旧 Adapters 候选包，请使用下文的固定源码标签。

## 准备开发环境

需要 Git、Node.js 24 或更新版本及 npm。在自己的工作目录执行：

```bash
git clone https://github.com/funkdog/ccodex-release.git
cd ccodex-release
git switch -c codex/my-fix
npm ci
npm run build
```

网关、引擎和桌面 UI 使用 `.mts` 源码。构建生成原路径下的 `.mjs`、`.mjs.map` 和构建清单。提交源码与测试即可。没有同名 `.mts` 的手写 `.mjs` 仍是源码，例如 [响应协议桥接](bridge/translate.mjs)。

| 要修改的行为 | 源码入口 |
| --- | --- |
| 会话协议、执行引擎路由与模型目录 | [协议](gateway/protocol.mts)、[路由](gateway/router.mts)、[引擎适配](gateway/engines/) |
| GitHub Copilot 登录、API 转发与原生模型接入 | [账号认证](bridge/auth.mjs)、[桥接服务](bridge/server.mjs)、[Copilot Provider](gateway/copilot-provider.mts) |
| 桌面会话、模型菜单与宿主版本兼容 | [原生编辑器](bridge/desktop-native-composer.mts)、[执行引擎选择](bridge/diy/execution-picker.mts)、[宿主契约](bridge/desktop-current-host-contract.mjs) |
| Squad 派发、回执、Git 工作树与合入 | [V2 内核](gateway/spine/squad-v2-kernel.mts)、[状态](gateway/spine/squad-v2-state.mts)、[工作树](gateway/spine/squad-v2-workspace.mts) |
| Squad MCP、原生分屏和内嵌卡片 | [MCP 工具](gateway/spine/squad-commands.mts)、[Studio](bridge/diy/squad-studio.mts)、[对话卡片](bridge/diy/squad-card.mts) |

涉及 Squad 协议或职责边界时，可先读 [ADR 0034](docs/architecture/0034-squad-v2-architecture.zh-CN.md)、[ADR 0035](docs/architecture/0035-squad-v2-retrospective-and-closeout.zh-CN.md) 和 [视觉规范](docs/design/squad-visual-spec.md)。

## 验证修改

先用重任务包装器运行受影响测试，再执行类型、生成物和项目门禁。macOS 或 Linux 示例：

```bash
npm run typecheck
npm run build
npm run check:generated
bash tools/Invoke-HeavyTask.sh node --test tests/squad-protocol-test.mjs tests/squad-lifecycle-test.mjs
npm run test:diy
```

Windows 的 npm 命令会自动选择适用的包装器，手动运行重任务使用 `tools/Invoke-HeavyTask.ps1`。自动测试使用独立临时 profile。浏览器用例需要 Playwright 和 Chromium。macOS 默认查找 Google Chrome，也可用 `MYCODEX_TEST_BROWSER` 指向自己的浏览器可执行文件。

```bash
npm install --no-save --package-lock=false --ignore-scripts playwright
export MYCODEX_TEST_PLAYWRIGHT="$PWD/node_modules/playwright/index.mjs"
bash tools/Invoke-HeavyTask.sh node --test tests/squad-v2-ui-test.mjs
```

若要同时验证 `release-update-test.mjs` 的六平台 `node-pty` 文件布局，将 `MYCODEX_TEST_NODE_PTY_ROOT` 指向带 `prebuilds/` 的独立 `node-pty` 包目录。已有的 `bin/node-pty/` 本地载荷也会被检查。

涉及桌面路径时，在专用测试会话验证发送、批准或拒绝、取消与正常重开续聊。保留已有会话，等当前任务结束后正常重启。检查报告写明已跑的用例、真实宿主版本，以及因缺少依赖、账号或运行环境而跳过的验证。

## 提交修复或反馈

1. 在自己的分支上修改，按需通过 Fork 提交。修复尽量补充最小复现用例。
2. 在 [Pull Request](https://github.com/funkdog/ccodex-release/pulls) 写明触发条件、实际改动及验证结果，目标分支选 `main`。
3. 在 [Issue](https://github.com/funkdog/ccodex-release/issues) 提供复现步骤、预期与实际行为、应用和系统版本、执行引擎及脱敏错误。账号目录、令牌、聊天和原始日志应留在本地。

公开源码变更先暂存，再运行 `node tools/check-source-publication.mjs`。发布提交保留第一方源码、测试和锁定依赖。第三方二进制、个人配置和生成物使用安装或构建流程管理。

## 固定发行快照

| 快照 | 源码标签 | 平台包与源码对应记录 |
| --- | --- | --- |
| RC.4 | [`mycodex-adapters-source-v0.1.0-rc.4`](https://github.com/funkdog/ccodex-release/tree/mycodex-adapters-source-v0.1.0-rc.4) | [RC4-SOURCE.json](release/RC4-SOURCE.json) |
| RC.3 | [`mycodex-adapters-source-v0.1.0-rc.3`](https://github.com/funkdog/ccodex-release/tree/mycodex-adapters-source-v0.1.0-rc.3) | [RC3-SOURCE.json](release/RC3-SOURCE.json) |

固定记录绑定各自平台包及运行源码摘要。`main` 继续维护 Gateway 和 Squad V2。候选版真实桌面验收和正式打包各有独立门禁，参见 [源码维护与发布](docs/DEVELOPMENT.zh-CN.md)。
