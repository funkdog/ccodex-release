# Ccodex ARM64 启动与同版本覆盖验收

历史基线报告：下述文件摘要及耗时属于 UI 修复前的安装包。
当前同版本替换包见 [本轮界面修复验收](UI-VALIDATION.zh-CN.md)，勿用下述旧摘要校验新下载。

本报告只绑定本次完整 EXE。原 Release 标签、版本号和安装文件名保持不变；旧同名下载需重新下载并核对新哈希。

## 文件与安装

- 安装包：`CCodex-1.2.35-Desktop-26.928.3736.0-Windows-ARM64-Setup.exe`。
- 大小：2,034,740,203 字节。
- SHA256：`15a593d434b84dcd1995a1d8b793bd6682f72a9f41509ee6da6d4c40462daa99`。
- 42,561 个资源逐文件解压核验 SHA256；不含真实凭据或会话。
- 220 项回归通过，失败、取消、跳过均为 0。
- 最终 EXE 实际升级返回 0，保留语言、字体、权限显示和自有数据；14 项离线诊断通过。

## 启动实测

| 测量 | 毫秒 |
|---|---:|
| 已登录条件下，真实 GUI 入口到启动校验完成 | 12639 |
| GUI 入口到中文界面及增强控件可用 | 25508 |
| 重复点击并复用自己的窗口 | 5081 |
| CLI 入口到原生输入界面 | 4420 |
| CLI 版本查询（三次） | 333 / 364 / 324 |

GUI 测试使用预置模拟账户/模型目录和已停止的桥接进程，不等于真实首次授权耗时。首次引导操作数为 4；如存在引导点击，界面可用时间包含这些测试动作。CLI 在独立测试仓库确认首次信任，未借用发布者主目录的项目配置；原生终端正常退出。

真实 GUI 子进程没有可见终端；窗口、端点、进程生命周期、SQLite 状态和实际后端握手均通过校验。原版程序和开发版正在运行的进程未被关闭。

## 角色与边界

开发版公共命令仅 `ccodex-dev`，Release 命令为 `ccodex`，Desktop 入口为 **Ccodex Desktop**。各自程序、profile、登录和缓存独立；Release 只注册自己的命令目录，未知同名命令不覆盖。

- ARM64 validation ran on this Windows ARM64 host, not on every colleague machine.
- This round did not repeat real GitHub login, paid inference or every enterprise/Computer Use integration.
- GUI startup testing uses a prepublished synthetic catalog. First authorization and a catalog-less first run require network and user interaction.
- First onboarding, explicit workspace trust, security scanning, disk state and endpoint policies can add latency.
- Shared project files and project-local configuration, system proxies/firewalls and a cloud account's entitlements remain shared boundaries.
- Startup integrity caching detects resource identity changes; full inventory checks remain available through release-doctor.
- Installer has no organization code signature. Team redistribution rights and endpoint admission remain organizational responsibilities.
