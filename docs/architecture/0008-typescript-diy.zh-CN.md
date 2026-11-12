# ADR 0008：DIY 组件、网关与引擎适配器使用 TypeScript

状态：已完成 Mac 本机源码迁移与隔离验证；当前运行的客户端及网关保持原生命周期。正式发行与原窗口重新加载不属于本次验证。

## 源码与运行产物

本轮将 `gateway/` 的 21 个模块及以下 4 个 UI 模块迁移为严格检查的 `.mts` 源码：

- `bridge/desktop-native-session.mts`
- `bridge/desktop-native-composer.mts`
- `bridge/desktop-cli-selector.mts`
- `bridge/desktop-gateway-ui.mts`

新增契约位于 `gateway/contracts.mts`、`gateway/sdk-contracts.mts`、`gateway/google-contracts.mts`、`bridge/desktop-diy-contracts.mts` 和 `bridge/desktop-host-contracts.mts`。它们覆盖引擎能力、模型目录、线程和 turn、工具事件、审批与业务提问、RPC、UI 服务及挂载/卸载。

`.mts` 是 TypeScript 的 ESM 源码后缀，编译为同位置、同名的 `.mjs` 与 `.mjs.map`。现有启动器、相对 import、资源定位和函数序列化入口因此继续使用原运行路径。**只编辑和提交 `.mts`，不提交这些生成文件或构建 manifest。** 未迁移的 `.mjs` 仍是源码，不应批量忽略或改写。

根 `package.json` 为私有开发包，精确锁定 TypeScript 7.0.2 和 Node 24 类型。构建引导与运行校验工具继续使用直接可执行的 `.mjs`，使离线运行不依赖 TypeScript 编译器。`allowJs` 仅用于读取既有 JS 接缝；`checkJs: false` 不会关闭 `.mts` 的 `strict` 检查。没有使用 `any` 类型、`ts-ignore` 或 `ts-nocheck` 绕过迁移。

外部 SDK 仍由既有配置的绝对路径加载，使用本地最小结构契约描述实际消费的方法。工具输入等不透明数据保留 `unknown`。这些契约不是厂商完整 schema，也不能替代账号、版本、协议与权限的运行时核验。

## 开发命令

需要 Node 24 和 npm。首次安装在仓库目录执行：

```sh
bash tools/Invoke-HeavyTask.sh npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm run build
npm run test:diy
npm run watch
```

`typecheck` 不写输出；`build` 在临时目录通过完整类型检查后，只推广 `.mts` 对应的运行文件，不改写被导入的遗留 JS。`test:diy` 先构建，再运行相关定向回归与 ESM 依赖检查。`watch` 每轮单独取得并释放既有 heavy-task 锁，不在空闲时长期占锁。所有编译和测试都通过仓库调度器，不要直接运行整仓测试或另开并行编译器。

没有 npm 命令但已安装依赖时，可用相同 Node 执行 `node tools/typescript-task.mjs build`，其他模式为 `typecheck`、`test`、`watch`、`check`。`npm run check:generated` 只检查构建新鲜度，离线运行也可使用。

Windows 的入口和文件清单已做静态适配；本次没有执行 PowerShell、Windows runner 或跨平台发行。用户指定的本轮 Mac 开发边界不变。

## 新建 DIY 组件

新 UI 组件放在 `bridge/diy/*.mts`，引擎放在 `gateway/engines/*.mts`；这两个目录的编译输出已被 Git 忽略。`bridge/**/*.mts` 与 `gateway/**/*.mts` 自动纳入构建。使用 `.mjs` 后缀书写相对 import；TypeScript 会解析到对应 `.mts`，Node 会加载生成的 `.mjs`。

组件只依赖注入的业务服务与 DOM，返回 `host` 和 `dispose()`。原生路由、版本固定的模块和选择器仍由宿主适配器负责，不引入第二套 UI 框架或通用管理服务。例如 `bridge/diy/catalog-status.mts`：

```ts
import type { MountedComponent, UiServices } from "../desktop-diy-contracts.mjs";

export function mountCatalogStatus({ document, container, services }: {
  document: Document;
  container: HTMLElement;
  services: Pick<UiServices, "listModels">;
}): MountedComponent {
  const host = document.createElement("span");
  let disposed = false;
  host.textContent = "读取模型…";
  container.append(host);
  services.listModels().then(models => {
    if (!disposed) host.textContent = `${models.length} 个可用模型`;
  }, error => {
    if (!disposed) host.textContent = error instanceof Error ? error.message : String(error);
  });
  return { host, dispose() { disposed = true; host.remove(); } };
}
```

这只是开发示例，未在产品中自动挂载。若组件需要 `.toString()` 注入浏览器，函数体必须能独立运行：纯类型 import 会擦除，运行时 import 的值不会随函数自动打包。现有 native composer 显式序列化其依赖；新增依赖也必须通过独立浏览器 fixture 验证。`erasableSyntaxOnly` 与高版本 ESM 输出用于避免引入闭包外编译 helper。

在上述目录之外新增 `.mts` 时，需为对应 `.mjs`、`.mjs.map` 添加精确的 Git ignore 规则，避免把编译结果当源码提交。

## 陈旧产物与运行保护

`tools/typescript-build-manifest.json` 记录源码、遗留 JS 接缝、构建配置、锁文件、工具及输出摘要。构建期间输入变化会中止推广；类型检查失败保留已有运行文件。删除源模块后，只删除上次 manifest 确认归属且内容未被修改的旧输出。

网关入口、当前宿主准备、backend staging、模块检查和打包入口会拒绝缺失或陈旧构建。TS、配置和 source map 也进入既有 Desktop 源码指纹，防止改了源码却继续准备旧 JS。运行检查只读文件，不自动安装依赖、编译、替换网关或重启客户端。

离线包携带源码、根构建配置、manifest 和编译后 JS；运行不需要 `node_modules/typescript`。源码克隆后需先安装开发依赖并构建，不能将 GitHub 源码归档当作已编译安装包。

## 验证范围

- 严格类型检查包含编译期反例，确保非法审批策略、错误工具事件、缺少工作目录、错误 RPC 身份和缺失卸载方法会被拒绝。
- 构建测试覆盖离线运行、源码/输出/配置/新增源文件失效、缺失 source map、陈旧入口拒绝、类型错误时保留产物、新 DIY 文件自动编译与删除后的输出清理。
- 现有网关、引擎、原生会话与启动器定向回归运行在生成的 JS 上；账户和 native CLI 测试使用隔离 profile。
- 独立 Chrome fixture 验证编译后函数的序列化注入、交互、重挂载和卸载，不读取或操作当前 ChatGPT 窗口。

本次没有修改 native core、VERSION、用户登录或会话数据，没有提交、推送或发布。当前客户端何时重新加载仍由用户协调；Antigravity 的“稍后手动重开”决定继续有效。

2026-10-29 本机验收：131 项定向测试全部通过、无跳过；21 项独立浏览器检查通过，包括直接导入编译后的 ESM 图；158 个 ESM、357 个相对依赖通过模块检查。38 个本次源码/配置文件通过源码安全检查。证据见 [验证记录](evidence/2026-10-29-typescript-diy.json) 和 [浏览器报告](evidence/2026-10-29-typescript-browser.json)。

额外探索的旧发行/Unix 检查为 95 项，其中 85 通过、9 失败、1 跳过。失败包括历史 workflow 路径预期、旧 Desktop 启动行为预期、安装 fixture 执行权限、路径保护和旧 shell 变量问题；详细列表保留在验证记录中。这些失败路径本轮未修改，也未据此宣称全仓或正式发行通过；本轮未扩展去修复这些旧流程。
