# 用自己的 GitHub Copilot 账号接入 MyCodex

本文面向 macOS Apple Silicon 使用者：登录自己的 GitHub Copilot 账号，让官方 Codex 执行任务，通过 Copilot 提供模型。原有 Codex 账号、Provider 和聊天继续保留。

适用于 MyCodex Adapters `0.1.0-rc.3` 的**手动配置路径**。此版本的 `Configure.command` 尚未提供 `codex-copilot`，`Diagnose.command` / `Start.command` 封装也未覆盖这类连接；请使用本文的检查和启动命令。无需修改源码、安装 Copilot CLI 或填写 API Key。

## 1. 准备自己的安装目录

先安装 Node.js 24 或更新版本，安装并登录通过 MyCodex 兼容性检查的官方客户端。当前候选的宿主版本范围见 [macOS 使用说明](ADAPTERS-MACOS.zh-CN.md)。GitHub 账号需要有可用的 Copilot 权限，模型和额度以自己的账号及组织策略为准，参见 [GitHub Copilot 账号说明](https://docs.github.com/en/copilot/how-tos/manage-your-account/get-started-with-a-copilot-plan)。

解压平台候选包到长期保留的位置，在 macOS 终端进入该目录。下列第一行换成自己的路径；官方应用名称不同，也要调整应用路径：

```bash
cd "/你解压后的/mycodex-adapters-macos-arm64-0.1.0-rc.3"
export MYCODEX_PACKAGE="$PWD"
export MYCODEX_DESKTOP_APP="/Applications/ChatGPT.app"
export MYCODEX_SETTINGS_DIR="$HOME/.mycodex/copilot-personal"
export MYCODEX_CONFIG="$MYCODEX_SETTINGS_DIR/config.json"
export CODEX_COPILOT_HOME="$MYCODEX_SETTINGS_DIR/account"
export CODEX_COPILOT_BRIDGE_HOST="127.0.0.1"
export CODEX_COPILOT_BRIDGE_PORT="22791"
export CODEX_COPILOT_AUTH_MODE="saved"
unset CODEX_COPILOT_GITHUB_TOKEN
umask 077
mkdir -p "$CODEX_COPILOT_HOME"
node --version
```

这个目录只存放你自己的接入配置和登录数据。不要使用发布者的目录，也不要把它放进 `~/.codex`、源码目录或解压目录。若已经使用过 `copilot-personal`，保留原文件；新建另一套配置时换一个目录名。

首次登录前检查所选端口：

```bash
lsof -nP -iTCP:22791 -sTCP:LISTEN
```

无输出表示当前未发现监听进程。若被其他程序占用，选择另一个未占用端口，并修改上面的 `CODEX_COPILOT_BRIDGE_PORT`；后面的配置会使用同一个值，不要结束其他实例的进程。

## 2. 登录自己的 GitHub 账号

```bash
node "$MYCODEX_PACKAGE/bridge/cli.mjs" login --force
```

终端会显示登录网址和一次性验证码，并尝试打开浏览器。在 GitHub 页面确认是自己的账号，输入终端给出的验证码并完成授权；等待终端显示 `Signed in as ...`。浏览器未自动打开时，手动访问终端显示的 GitHub 网址。该过程使用 [GitHub Device Flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow)。

登录信息保存在自己的 `account` 目录中。不需要从 GitHub CLI、VS Code 或他人的安装目录复制 token；在其他工具中登录过，也不代表这套独立账号目录已经登录。

## 3. 查看账号实际返回的模型

```bash
node "$MYCODEX_PACKAGE/bridge/cli.mjs" status
node "$MYCODEX_PACKAGE/bridge/cli.mjs" models
```

确认账号名正确，并从列表中复制一个模型 ID。不要照抄维护者的型号或凭显示名猜 ID。目录读取不发送聊天提示词；**目录可见不等于实际推理成功**。

把下面的值换成刚才复制的 ID：

```bash
export MYCODEX_MODEL_ID="替换为自己目录中的模型ID"
```

如果登录成功但没有模型，先检查 Copilot 权限、组织策略、网络和服务状态；不要继续创建一个填满示例型号的配置。

## 4. 生成自己的配置

在同一个终端执行下面这段。它会自动填写你的账号目录、端口和模型 ID，只新建配置文件，已有文件不会被覆盖：

```bash
node --input-type=module <<'JS'
import fs from "node:fs";
const env = process.env;
const catalog = JSON.parse(fs.readFileSync(`${env.CODEX_COPILOT_HOME}/models.json`, "utf8"));
if (!catalog.models?.some(model => model.slug === env.MYCODEX_MODEL_ID)) {
  throw new Error("所选模型不在自己的目录中，请先完成第 3 步。");
}
const config = {
  configVersion: 1,
  defaultInstance: "copilot-personal",
  instances: [{
    id: "copilot-personal",
    mode: "app-server-gateway",
    host: "current",
    desktopApp: env.MYCODEX_DESKTOP_APP,
    gateway: {
      workbench: false,
      defaultEngine: "codex-copilot",
      engines: [{
        id: "codex-copilot",
        adapter: "codex-copilot",
        bridgeHome: env.CODEX_COPILOT_HOME,
        bridgePort: Number(env.CODEX_COPILOT_BRIDGE_PORT),
        enabledModels: [env.MYCODEX_MODEL_ID]
      }]
    }
  }]
};
fs.writeFileSync(env.MYCODEX_CONFIG, JSON.stringify(config, null, 2) + "\n",
  { flag: "wx", mode: 0o600 });
console.log(`已生成：${env.MYCODEX_CONFIG}`);
JS
```

配置字段含义：

| 字段 | 如何填写 |
| --- | --- |
| `desktopApp` | 自己已安装的官方应用绝对路径 |
| `bridgeHome` | 上面创建的私有 `account` 目录，不填写 API 地址 |
| `bridgePort` | 自己选择的未占用本机端口 |
| `id` / `adapter` | 此连接固定使用 `codex-copilot` |
| `enabledModels` | 自己从目录中选择的模型 ID，不放 API Key |
| `workbench` | 保持 `false`，使用精简能力 |

`enabledModels` 控制网关提供的模型列表。RC.3 的原生 Provider 仍读取账号的模型目录，不承诺所有原生模型菜单都只显示这一项；这条手动路径也没有自动完成逐模型推理验证。下一步必须用自己的账号实际发送一次，才能确认所选模型能用。

## 5. 启动并确认接入

先做只读检查：

```bash
node "$MYCODEX_PACKAGE/bridge/desktop-shortcut.mjs" --config "$MYCODEX_CONFIG" --check
```

检查不代替登录或实际回复。若当前客户端仍在运行，先结束自己的任务并正常退出，再从同一终端启动：

```bash
node "$MYCODEX_PACKAGE/bridge/desktop-shortcut.mjs" --config "$MYCODEX_CONFIG"
```

新建专用测试聊天，在底部“模型与引擎”中选择 **Codex · Copilot / API**（内部名称 `codex-copilot`），选择自己的模型，点“应用切换”，发送“请只回复 OK”。实际发送会使用自己的 Copilot 额度。正确回复后，正常退出、用上面的命令重开，确认同一聊天仍能续聊。

这条路径使用 Codex 的工具、权限和原生历史；已有聊天不改换执行引擎。原生 Codex 默认入口仍沿用官方账号和设置。不要选择另一个名为 Copilot CLI 的引擎来代替本文的 Codex + Copilot。

之后开新终端时，重新执行第 1 步的目录和环境变量设置，再执行启动命令即可；账号无需每次重新授权。更换包的位置后，更新 `MYCODEX_PACKAGE`。

## 常见问题

| 现象 | 处理方式 |
| --- | --- |
| 提示配置已存在（`EEXIST`） | 不覆盖原文件。使用原配置启动；确实需要另一套配置时换一个目录名重新接入 |
| `Configure.command` 找不到 Codex + Copilot，或诊断提示 CLI 路径缺失 | RC.3 的简化封装未覆盖这条连接；使用本文的 `bridge/cli.mjs` 和 `desktop-shortcut.mjs` 命令 |
| 登录的不是预期账号 | 核对环境变量指向自己的目录，再运行本文的 `login --force`，在浏览器选择正确账号 |
| 模型可见但发送报 401、403 或额度错误 | 核对账号、Copilot 权限、模型策略和额度；看到模型名不能证明账号可以调用它 |
| 新模型未出现，或仍显示旧配置 | 确认从本文入口完整重开了客户端；不要仅重新打开一个聊天 |
| 宿主版本不兼容 | 按 macOS 使用说明核对应用版本，停止启用当前增强，不跳过兼容性检查 |
| 想临时停用 | 正常退出增强客户端，从官方原图标打开；保留配置和历史，不删除账号目录 |

需要反馈时提供应用版本、操作步骤、脱敏错误和模型 ID 即可。不要上传 `account` 目录、GitHub token、验证码、个人聊天或原始日志。
