import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";
import { resolveDesktopMode } from "../bridge/desktop-mode.mjs";
import { assertTypeScriptBuild } from "./typescript-state.mjs";
import { connectionModels, checkAdapterModel } from "./adapter-connection.mjs";

const root = path.resolve(import.meta.dirname, "..");
export const defaultConfig = () => path.join(os.homedir(), ".mycodex", "adapters", "config.json");
export const sdkEntry = () => path.join(root, "release/adapters-sdk/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs");

export function executablePath(value, env = process.env) {
  if (typeof value !== "string" || !value || /[\0\r\n]/.test(value)) throw new Error("请填写 CLI 文件路径，不能填写命令参数。");
  const candidates = path.isAbsolute(value) ? [value] : (env.PATH ?? "").split(path.delimiter).filter(Boolean).map(dir => path.join(dir, value));
  for (const file of candidates) {
    try { fs.accessSync(file, fs.constants.X_OK); const actual = fs.realpathSync(file); if (fs.statSync(actual).isFile()) return actual; } catch {}
  }
  throw new Error(`找不到可执行文件：${value}。请先安装 CLI，或填写完整路径。`);
}

export function adaptersConfiguration({ application, connections = [], env = process.env }) {
  if (!path.isAbsolute(application ?? "") || !application.endsWith(".app")) throw new Error("请选择官方 ChatGPT/Codex .app 的完整路径。");
  const engines = connections.map(connection => {
    if (!["claude-code", "antigravity-acp"].includes(connection.adapter)) throw new Error("本候选向导支持 Claude Code 或 Antigravity ACP 1.4.4；原生 Codex 无需外部 CLI。");
    const engine = { ...connection, executable: executablePath(connection.executable, env), enabledModels: [...(connection.enabledModels ?? [])] };
    if (engine.adapter === "claude-code") {
      const sdk = engine.sdkPath ?? sdkEntry(engine.adapter);
      if (!path.isAbsolute(sdk) || !fs.statSync(sdk).isFile()) throw new Error("所选 CLI 的适配依赖尚未安装，请通过配置向导安装。");
      engine.sdkPath = fs.realpathSync(sdk);
    }
    if (engine.adapter === "claude-code") engine.initialApprovalMode = "ask";
    if (engine.adapter === "antigravity-acp") engine.harnessPath = executablePath(engine.harnessPath, env);
    return engine;
  });
  return { configVersion: 1, defaultInstance: "adapters", instances: [{ id: "adapters", mode: "app-server-gateway", host: "current",
    desktopApp: application, gateway: { workbench: false, defaultEngine: engines[0]?.id ?? null, engines } }] };
}

export async function verifyAdapterModel(file, engineId, modelId, options = {}) {
  const original = fs.readFileSync(file, "utf8");
  const selection = resolveDesktopMode({ arguments: ["--config", file], inherited: {} });
  if (selection.gateway?.workbench !== false) throw new Error("不是本精简版配置。");
  const engine = selection.gateway.engines.find(item => item.id === engineId);
  if (!engine) throw new Error("请先连接自己的 CLI。");
  const proof = await checkAdapterModel(engine, modelId, options);
  if (fs.readFileSync(file, "utf8") !== original) throw new Error("连接配置已变化，检测结果未用于启用模型。请重新检测。");
  const config = JSON.parse(original), connection = config.instances.find(item => item.id === selection.id).gateway.engines.find(item => item.id === engineId);
  connection.enabledModels = [...new Set([...(connection.enabledModels ?? []), modelId])];
  const receipt = path.join(path.dirname(file), `.model-check-${randomUUID()}.json`);
  fs.writeFileSync(receipt, JSON.stringify({ schemaVersion: 1, engineId, ...proof }) + "\n", { flag: "wx", mode: 0o600 });
  try { return { ...saveAdaptersConfiguration(file, config, { replace: true }), ...proof }; }
  catch (error) { fs.rmSync(receipt, { force: true }); throw error; }
}

function privateDirectory(directory) {
  const missing = [];
  let ancestor = directory;
  while (!fs.existsSync(ancestor)) { missing.push(ancestor); ancestor = path.dirname(ancestor); }
  if (fs.realpathSync(ancestor) !== ancestor) throw new Error("配置目录不能经过符号链接。");
  for (const next of missing.reverse()) fs.mkdirSync(next, { mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error("配置目录必须是属于当前用户的私有目录（0700）。");
}

export function saveAdaptersConfiguration(file, config, { replace = false } = {}) {
  file = path.resolve(file);
  privateDirectory(path.dirname(file));
  const exists = fs.existsSync(file);
  let previous;
  if (exists) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size > 256 * 1024) throw new Error("已有配置不是安全的私有普通文件。");
    if (!replace) throw new Error("已有配置保持不变；如需更新，请在配置向导中明确确认。");
    const selected = resolveDesktopMode({ arguments: ["--config", file], inherited: {} });
    if (selected.id !== "adapters" || selected.gateway.workbench !== false) throw new Error("不能覆盖其他 MyCodex 配置。");
    previous = fs.readFileSync(file, "utf8");
  }
  const pending = path.join(path.dirname(file), `.adapters-${randomUUID()}.pending`);
  try {
    fs.writeFileSync(pending, JSON.stringify(config, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    const selected = resolveDesktopMode({ arguments: ["--config", pending], inherited: {} });
    if (selected.gateway.workbench !== false || selected.gateway.spine !== undefined) throw new Error("该入口只接受多 CLI 精简配置。");
    if (exists) {
      if (fs.readFileSync(file, "utf8") !== previous) throw new Error("配置已被其他进程修改，请重试。");
      const backup = `${file}.${randomUUID()}.backup`;
      fs.writeFileSync(backup, previous, { flag: "wx", mode: 0o600 });
      fs.renameSync(pending, file);
    } else { fs.linkSync(pending, file); }
    return { configFile: file, engines: selected.gateway.engines.map(engine => engine.id), restartRequired: true };
  } finally { fs.rmSync(pending, { force: true }); }
}

export async function diagnoseAdapters(file, { inspectHost, catalog = false, factory } = {}) {
  assertTypeScriptBuild(root);
  const selected = resolveDesktopMode({ arguments: ["--config", file], inherited: {} });
  if (selected.gateway?.workbench !== false || selected.gateway.spine) throw new Error("不是多 CLI 精简配置。");
  inspectHost ??= (await import("../bridge/desktop-current-host.mjs")).inspectBackendHost;
  const host = inspectHost(selected.desktopApp);
  if (host.uiAvailable === false) throw new Error(`当前客户端 ${host.applicationVersion} 未通过界面兼容性校验；先不要安装或启用增强。`);
  const checks = [];
  for (const engine of selected.gateway.engines) {
    const enabledModels = engine.enabledModels ?? [];
    try {
      executablePath(engine.executable);
      if (engine.adapter === "claude-code" && !fs.statSync(engine.sdkPath).isFile()) throw new Error("Claude SDK 不可用。");
      if (engine.adapter === "antigravity-acp") {
        executablePath(engine.harnessPath);
        const { assertAntigravityAccount } = await import("../gateway/engines/antigravity.mjs");
        assertAntigravityAccount(engine.cliHome);
      }
      const candidates = catalog ? (await connectionModels(engine, { factory })).map(model => ({ id: model.id, name: model.name })) : undefined;
      checks.push({ engine: engine.id, ready: true, enabledModels,
        ...(candidates ? { candidates, unavailableSelections: enabledModels.filter(id => !candidates.some(model => model.id === id)) } : {}),
        authenticationVerified: false, inferenceVerified: false });
    } catch {
      checks.push({ engine: engine.id, ready: false, enabledModels, authenticationVerified: false, inferenceVerified: false,
        message: "请先在自己的 CLI 中确认登录、模型与权限，再运行 Configure.command；未验证的模型不会进入菜单。" });
    }
  }
  return { ready: checks.every(check => !check.enabledModels.length || check.ready), nativeConfiguration: "official-existing", applicationVersion: host.applicationVersion,
    uiCompatible: host.uiAvailable !== false, catalogChecked: catalog, liveDesktopVerified: false, checks };
}

function run(executable, args, env = process.env, cwd = process.cwd()) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: "inherit", env, cwd, shell: false });
    child.once("error", reject); child.once("exit", code => code === 0 ? resolve() : reject(new Error(`CLI 退出（${code}）。`)));
  });
}

async function selectAndVerify(rl, file, engine) {
  console.log("正在读取此 CLI 的候选目录。候选不代表账号已有权限，也不会自动进入菜单。");
  let models;
  try { models = await connectionModels(engine); }
  catch { console.log("候选目录读取失败。请先在自己的 CLI 完成登录并确认模型设置；原生 Codex 仍可使用。"); return; }
  models.forEach((model, index) => console.log(`${index + 1}. ${model.name || model.id} (${model.id})`));
  const choice = (await rl.question("选择要验证的一个模型编号 [回车暂不添加]：")).trim();
  if (!choice) return;
  const model = /^\d+$/.test(choice) && models[Number(choice) - 1];
  if (!model) throw new Error("模型编号无效，未发送请求。");
  const consent = (await rl.question(`向你选择的 ${model.id} 发送一次短文本请求，可能消耗自己的额度。验证时禁用工具；成功后才加入菜单 [输入 yes]：`)).trim();
  if (consent !== "yes") { console.log("未发送请求，模型未启用。"); return; }
  try {
    const result = await verifyAdapterModel(file, engine.id, model.id, { approved: true });
    console.log(`验证成功：${result.modelId} 已加入菜单，正常重开客户端后生效。`);
  } catch (error) { console.log(error.message); }
}

async function interactive(file) {
  if (!process.stdin.isTTY) throw new Error("请在终端运行配置向导。");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log("MyCodex macOS 精简版配置\n默认沿用官方 Codex 已有的账号、Provider 和模型设置。无需添加 CLI、API 地址或 Key。\n外部 CLI 可按需接入；只显示你选定并验证成功的模型。");
    const exists = fs.existsSync(file);
    let selected;
    if (exists) {
      selected = resolveDesktopMode({ arguments: ["--config", file], inherited: {} });
      if (selected.id !== "adapters" || selected.gateway?.workbench !== false) throw new Error("不能覆盖其他 MyCodex 配置。");
    }
    const application = selected?.desktopApp ?? ((await rl.question("官方应用完整路径 [/Applications/ChatGPT.app]：")).trim() || "/Applications/ChatGPT.app");
    const { inspectBackendHost } = await import("../bridge/desktop-current-host.mjs");
    const host = inspectBackendHost(application);
    if (host.uiAvailable === false) throw new Error(`客户端 ${host.applicationVersion} 尚未兼容；配置未写入。`);
    let connections = selected?.gateway.engines ?? [];
    for (const engine of connections) console.log(`已连接 ${engine.id}：已启用 ${(engine.enabledModels ?? []).join(", ") || "无（需要验证）"}`);
    console.log("1. 使用当前配置（首次安装仅原生 Codex）\n2. 添加自己的 CLI\n3. 为已有 CLI 添加并验证模型\n4. 停用一个外部 CLI\n5. 仅使用原生 Codex");
    const action = (await rl.question("选择 [1]：")).trim() || "1";
    if (!["1", "2", "3", "4", "5"].includes(action)) throw new Error("选项无效，配置未写入。");
    let toVerify;
    if (action === "2") {
      const adapterChoice = (await rl.question("CLI 类型：1 Claude Code；2 Antigravity ACP 1.4.4 [1]：")).trim() || "1";
      if (!["1", "2"].includes(adapterChoice)) throw new Error("请选择已适配的 CLI 类型。");
      const adapter = adapterChoice === "1" ? "claude-code" : "antigravity-acp";
      const id = (await rl.question(`为此连接命名（小写字母、数字、短横线）[${adapter}]：`)).trim() || adapter;
      if (!/^[a-z][a-z0-9-]{0,63}$/.test(id) || connections.some(engine => engine.id === id)) throw new Error("连接名称无效或已存在，请用不同名称；已有连接保持不变。");
      const executable = (await rl.question("自己的已安装 CLI 可执行文件命令或完整路径：")).trim();
      executablePath(executable);
      const connection = { id, adapter, executable, enabledModels: [] };
      if (adapter === "claude-code" && !fs.existsSync(sdkEntry())) {
        if ((await rl.question("下载锁定的 Claude Agent SDK 0.3.312（CLI 仍使用你的路径）[输入 yes]：")).trim() !== "yes") throw new Error("依赖未安装，连接未添加。可继续使用原生 Codex。");
        await run("npm", ["ci", "--prefix", path.join(root, "release/adapters-sdk"), "--omit=optional", "--ignore-scripts", "--no-audit", "--no-fund"]);
      }
      if (adapter === "antigravity-acp") {
        console.log("仅接入你已安装且完成个人 Google 授权的 ACP 1.4.4 运行时；普通 Gemini/agy 命令不能替代该协议。");
        connection.harnessPath = (await rl.question("localharness_external 完整路径：")).trim();
        connection.cliHome = (await rl.question("已有账号目录（包含 antigravity-acp/settings.json 和 acp_token.json）的完整路径：")).trim();
      }
      connections = [...connections, connection];
      toVerify = id;
    } else if (["3", "4"].includes(action)) {
      const id = (await rl.question("现有连接名称：")).trim();
      if (!connections.some(engine => engine.id === id)) throw new Error("连接不存在，配置未改变。");
      if (action === "3") toVerify = id;
      else connections = connections.filter(engine => engine.id !== id);
    } else if (action === "5") connections = [];
    if (!exists || ["2", "4", "5"].includes(action)) {
      const config = adaptersConfiguration({ application, connections });
      if (exists && (await rl.question("保存以上连接变更？旧配置会备份，正常重开后生效 [输入 yes]：")).trim() !== "yes") throw new Error("配置未改变。");
      saveAdaptersConfiguration(file, config, { replace: exists });
    }
    if (toVerify) {
      const configured = resolveDesktopMode({ arguments: ["--config", file], inherited: {} });
      await selectAndVerify(rl, file, configured.gateway.engines.find(engine => engine.id === toVerify));
    }
    console.log("配置完成。无需添加外部模型也可使用原生 Codex。\n下一步运行 Diagnose.command；当前任务结束后正常退出官方客户端，再运行 Start.command。\n可选 Install-Launcher.command 创建桌面入口。需要其他模型时再次运行 Configure.command。");
  } finally { rl.close(); }
}

async function main() {
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("当前候选版仅验证 macOS Apple Silicon（ARM64）。");
  if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("需要 Node.js 24 或更新版本。");
  const [command = "configure", ...args] = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--config" || !path.isAbsolute(args[1]))) throw new Error("参数：<configure|doctor|models|start|install-launcher> [--config /完整路径/config.json]");
  const file = args[1] ?? defaultConfig();
  if (command === "configure") return interactive(file);
  if (["doctor", "models"].includes(command)) {
    const result = await diagnoseAdapters(file, { catalog: command === "models" });
    console.log(JSON.stringify(result, null, 2)); if (!result.ready) process.exitCode = 1; return;
  }
  const selected = resolveDesktopMode({ arguments: ["--config", file], inherited: {} });
  if (selected.gateway.workbench !== false) throw new Error("不是本精简版配置。");
  if (command === "install-launcher") {
    const { installMacLauncher } = await import("./install-macos-launcher.mjs");
    console.log(JSON.stringify(installMacLauncher({ configFile: file, bundleIdentifier: "local.mycodex.adapters.launcher", destination: path.join(os.homedir(), "Applications", "MyCodex Adapters.app") }), null, 2)); return;
  }
  if (command === "start") {
    const result = await diagnoseAdapters(file);
    if (!result.ready) throw new Error("CLI 检查未通过；请先运行 Diagnose.command。");
    const { runDesktopShortcut } = await import("../bridge/desktop-shortcut.mjs");
    const started = await runDesktopShortcut({ configFile: file, queueRepair: async () => ({ action: "disabled" }) });
    console.log(JSON.stringify(started, null, 2));
    if (started.backendState !== "ready" || started.uiState !== "ready") console.log("请核对上方状态；进程启动不代表界面验收完成。若普通客户端仍运行，结束任务后正常退出，再从本入口打开。");
    return;
  }
  throw new Error("未知命令。");
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
