# MyCodex Adapters 0.1.0-rc.4 — macOS Apple Silicon

RC.4 为预发布候选版，真实桌面验收仍待完成，不标为稳定版。[发布页](https://github.com/funkdog/ccodex-release/releases/tag/mycodex-adapters-v0.1.0-rc.4) 提供 macOS ARM64 平台包、SHA-256、全附件校验清单、使用说明、GitHub Copilot 账号接入指南和验证记录。

## 本次修复

- 保留 Desktop 附加上下文、工具命名空间、自定义工具输入、工具发现与图片结果。
- 缓冲先于工具名到达的流式参数，修复工具身份和参数丢失问题。
- 改善工具 Schema 转换、Google 显式工具选择及 Chat 模型提示词和能力声明。
- Chat 不能承载的历史/文件输入明确返回错误；长度或内容过滤终止如实返回 incomplete，不把部分工具调用标为完成。
- 打包时排除历史源码对应记录，避免带入旧版本元数据。

详细实现与限制见 [桥接修复说明](../architecture/0033-chat-compat-sync.zh-CN.md)。配置默认沿用官方 Codex 现有账号、Provider 和模型；需要 GitHub Copilot 时，按 [接入指南](../CODEX-COPILOT-SETUP.zh-CN.md) 登录自己的账号并选择自己的模型。简化向导尚未覆盖 codex-copilot。工作台、Squad、雷达、日报和跨引擎迁移继续关闭。

## 验证与源码

从公开源码的独立检出安装锁定依赖并执行精简门禁：**302/302 通过**，零失败、取消和跳过；78 个 TypeScript 源码生成 156 个产物，219 个 ESM 模块、511 条相对导入检查通过。

最终压缩包解压后，**476 项载荷文件摘要**、五个命令入口语法、无编译器配置往返、原生默认空网关准备/连接/退出、合成 CLI 候选与独立图标编译/签名通过。测试仅使用隔离临时 profile 和本地合成服务，没有操作真实桌面或调用真实模型；原生后台进程退出，临时文件已清理。

平台包 SHA-256：`f297bd77912fe079cfe43077d22c72f9b63cb6ea77a0564d419c5d3d25bafd86`。载荷摘要：`7e0828f789f580c0ade83d6bcbbf29ef9acfa85dd6b6ddc7821cec546fef720b`。冻结运行源码提交：`c7d960018f0435384b0090a0cc08d07b6d6c536c`；[逐文件对应记录](../../release/RC4-SOURCE.json) 绑定 313 个运行源码文件。

RC.4 的 Release 标签、源码分支 `codex/macos-adapters-rc4` 和专用源码标签 `mycodex-adapters-source-v0.1.0-rc.4` 均提供完整可维护源码及测试。GitHub 自动源码归档不含生成模块和第三方运行时，下载安装请使用平台包。RC.3 的旧标签和附件保持原样。

冻结包清单中的 published: false 表示打包时状态；实际发布状态以 GitHub Release 为准，liveDesktopAcceptance 继续保持 pending。
