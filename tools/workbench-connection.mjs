/** Persistent, per-user supervision of the existing official tunnel runtime.
 * Preparation never reads a credential. Setup is run by the user in Terminal;
 * A local helper owns its hidden password prompt and writes Security.framework.
 * No key is placed in
 * command arguments, a plist, a profile, stdout or a repository file. */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, ".."), script = path.join(root, "tools/workbench-connection.mjs");
const product = "MyCodexWorkbenchConnection", label = "local.mycodex.workbench-connection";
const execute = promisify(execFile), hash = value => createHash("sha256").update(value).digest("hex");
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const xml = value => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const privateFile = file => {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error("Expected an owned private file.");
  return fs.readFileSync(file, "utf8");
};
function directory(file) {
  fs.mkdirSync(file, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(file);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error("Expected an owned private directory.");
}
function write(file, value, mode = 0o600) {
  if (fs.existsSync(file)) privateFile(file);
  const pending = `${file}.${randomUUID()}.pending`;
  fs.writeFileSync(pending, typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode });
  try { fs.renameSync(pending, file); } finally { fs.rmSync(pending, { force: true }); }
}
function configAt(file) {
  const config = JSON.parse(privateFile(file));
  if (process.platform !== "darwin" || config.product !== product || config.schemaVersion !== 1 || config.label !== label ||
      !/^[a-z][a-z0-9-]{0,63}$/.test(config.alias) || !/^tunnel_[a-z0-9]+$/.test(config.tunnelId) ||
      !/^org-[A-Za-z0-9]+$/.test(config.organizationId) || config.script !== script || config.node !== process.execPath ||
      !/^[a-f0-9]{64}$/.test(config.clientSha256)) throw new Error("Connection setup does not match this installation.");
  for (const key of ["directory", "client", "profileDirectory", "gatewayConnection", "node", "script", "log", "stateFile", "plist"]) {
    if (typeof config[key] !== "string" || !path.isAbsolute(config[key]) || /[\0\r\n]/.test(config[key])) throw new Error("Invalid connection path.");
  }
  if (path.dirname(file) !== config.directory || config.plist !== path.join(os.homedir(), "Library/LaunchAgents", label + ".plist") ||
      config.keychainService !== "local.mycodex.workbench.tunnel" || config.keychainAccount !== config.alias ||
      config.log !== path.join(config.directory, "automatic-connection.log") || config.stateFile !== path.join(config.directory, "connection-state.json")) throw new Error("Connection binding changed.");
  directory(config.directory);
  const client = fs.lstatSync(config.client);
  if (!client.isFile() || client.isSymbolicLink() || hash(fs.readFileSync(config.client)) !== config.clientSha256) throw new Error("Official tunnel client changed; prepare again before enabling it.");
  return config;
}

export function prepareWorkbenchConnection(options) {
  if (process.platform !== "darwin") throw new Error("Persistent workbench connection currently supports macOS only.");
  const destination = path.resolve(options.directory);
  directory(destination);
  const configFile = path.join(destination, "automatic-connection.json");
  const launcher = path.join(destination, "设置MyCodex工作台自动连接.command");
  const config = { product, schemaVersion: 1, label, directory: destination, script, node: process.execPath,
    alias: options.alias, tunnelId: options.tunnelId, organizationId: options.organizationId,
    client: options.client, clientSha256: options.clientSha256, profileDirectory: options.profileDirectory,
    gatewayConnection: options.gatewayConnection, keychainService: "local.mycodex.workbench.tunnel", keychainAccount: options.alias,
    log: path.join(destination, "automatic-connection.log"), stateFile: path.join(destination, "connection-state.json"),
    plist: path.join(os.homedir(), "Library/LaunchAgents", label + ".plist") };
  if (fs.existsSync(configFile)) {
    const previous = configAt(configFile);
    if (previous.alias !== config.alias || previous.tunnelId !== config.tunnelId) throw new Error("Existing connection binding was preserved.");
  }
  const command = `#!/bin/bash\nset +x\numask 077\n${[process.execPath, script, "setup", configFile].map(quote).join(" ")}\nresult=$?\nprintf '\\n按回车关闭窗口。'\nIFS= read -r _\nexit "$result"\n`;
  const marker = path.join(destination, ".automatic-connection-install.json");
  if (fs.existsSync(launcher)) {
    const owned = JSON.parse(privateFile(marker));
    if (owned.product !== product || owned.launcherSha256 !== hash(privateFile(launcher))) throw new Error("Setup launcher has local changes; preserved.");
  }
  write(configFile, config);
  configAt(configFile);
  write(launcher, command, 0o700);
  write(marker, { product, launcherSha256: hash(command) });
  return { prepared: true, launcher, configFile, credentialRead: false, keychainModified: false, autostartEnabled: false };
}

function keychainArgs(config) { return ["-a", config.keychainAccount, "-s", config.keychainService]; }
async function keychainPresent(config) {
  try { await execute("/usr/bin/security", ["find-generic-password", ...keychainArgs(config)], { timeout: 5000, maxBuffer: 32768 }); return true; }
  catch { return false; }
}
async function userPasswordPrompt(config) {
  // security(1)'s getpass silently caps input at 128 bytes. Keep long keys in
  // the user-operated helper, with no credential argv or interactive history.
  const helper = path.join(root, "tools/workbench-keychain.py");
  const stat = fs.lstatSync(helper);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Invalid keychain helper.");
  const child = spawn("/usr/bin/python3", [helper, config.keychainAccount], { stdio: "inherit" });
  await new Promise((resolve, reject) => {
    child.once("error", () => reject(new Error("无法打开系统钥匙串输入。")));
    child.once("exit", code => code === 0 ? resolve() : reject(new Error("密钥未保存；自动连接没有启用。")));
  });
}
function agentPlist(config, configFile) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${[config.node, script, "run", configFile].map(value => `<string>${xml(value)}</string>`).join("")}</array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>60</integer><key>ProcessType</key><string>Background</string><key>Nice</key><integer>10</integer>
<key>LowPriorityIO</key><true/><key>LimitLoadToSessionType</key><string>Aqua</string>
<key>StandardOutPath</key><string>${xml(config.log)}</string><key>StandardErrorPath</key><string>${xml(config.log)}</string>
</dict></plist>\n`;
}
async function setup(configFile) {
  const config = configAt(configFile);
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("请由本人双击设置启动器，在本机终端完成一次配置。");
  const agent = agentPlist(config, configFile), receiptFile = path.join(config.directory, ".launch-agent-install.json");
  if (fs.existsSync(config.plist)) {
    const receipt = JSON.parse(privateFile(receiptFile));
    if (receipt.product !== product || receipt.plistSha256 !== hash(privateFile(config.plist)) || receipt.plistSha256 !== hash(agent)) throw new Error("同名登录项有其他改动，未覆盖。");
  }
  const before = await runtimeStatus(config).catch(() => null);
  const replaceKey = before?.requiresCredential === true;
  console.log(replaceKey ? "云端拒绝了已保存的运行密钥。旧版输入可能将长密钥截断到 128 字符；此版已修复。可重新输入原先创建的完整密钥，不必先新建。更新钥匙串后，仅重连此工作台隧道；原工作数据和 ChatGPT 保持运行。\n"
    : "MyCodex 工作台：一次设置，后续自动连接。\n将运行密钥保存在本机默认钥匙串，并启用当前用户的登录自启动。\n沿用已有插件、隧道和读写权限；不重启 ChatGPT。\n");
  const input = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await input.question(replaceKey ? "同意更换已保存的密钥并重连此工作台连接？[y/N] " : "同意保存凭据并启用自动连接？[y/N] "); input.close();
  if (!/^(?:y|yes|是)$/i.test(answer.trim())) { console.log("没有修改钥匙串或登录启动项。"); return; }
  if (replaceKey || !await keychainPresent(config)) {
    console.log("请在下面的系统隐藏提示中输入完整、有效且具有 Tunnels Read + Use 权限的运行密钥。不要输入遮罩文本，不要发到聊天。");
    await userPasswordPrompt(config);
  } else console.log("复用已保存的 MyCodex 工作台钥匙串凭据。");
  fs.mkdirSync(path.dirname(config.plist), { recursive: true });
  if (!fs.existsSync(config.log)) write(config.log, ""); else privateFile(config.log);
  write(config.plist, agent);
  write(receiptFile, { product, plistSha256: hash(agent) });
  const domain = `gui/${process.getuid()}`, service = `${domain}/${label}`;
  let loaded = false;
  try { await execute("/bin/launchctl", ["print", service], { timeout: 5000 }); loaded = true; } catch {}
  if (replaceKey) {
    // Only the user-owned setup flow may rotate a rejected credential and
    // replace this one runtime. The background monitor never stops a daemon.
    if (loaded) { await execute("/bin/launchctl", ["bootout", domain, config.plist], { timeout: 15000 }); loaded = false; }
    if (before.running) await execute(config.client, ["runtimes", "stop", config.alias], { timeout: 15000, maxBuffer: 1024 * 1024 });
  }
  if (!loaded) await execute("/bin/launchctl", ["bootstrap", domain, config.plist], { timeout: 10000 });
  await execute("/bin/launchctl", ["kickstart", service], { timeout: 10000 });
  console.log("自动恢复机制已启用，正在接入现有隧道……");
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const current = await runtimeStatus(config);
      if (current.requiresCredential) {
        console.log(current.controlPlaneHttpStatus === 401 ? "云端仍拒绝当前密钥（401）。自动连接已安装，但尚未接通；请使用完整有效密钥再次运行本设置。"
          : "当前密钥没有所需隧道权限（403）。自动连接已安装，但尚未接通；请确认所属组织和 Tunnels Read + Use 权限。"); return;
      }
      if (current.running && current.ready && current.healthy) {
        console.log("连接已就绪。普通关闭、重开 ChatGPT 不需要重新输入密钥。\n连接进程退出后自动恢复；Mac 登录后自动启动。\n可以返回聊天回复：已完成自动连接设置，连接已就绪。"); return;
      }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  console.log("自动恢复机制已安装，连接尚未就绪；后台会继续恢复。请在聊天说明“自动连接已设置，仍待就绪”，不要发送密钥或日志。");
}

async function runtimeStatus(config) {
  const result = await execute(config.client, ["runtimes", "status", config.alias, "--json"], { timeout: 10000, maxBuffer: 1024 * 1024 });
  const status = JSON.parse(result.stdout);
  if (status.alias !== config.alias || status.tunnel_id !== config.tunnelId || typeof status.process_running !== "boolean") throw new Error("Runtime binding differs.");
  let controlPlane = null, mcp = null;
  // Daemon /readyz can be green while cloud polling is rejected with 401.
  // Require the official component snapshot before reporting a connection.
  const value = status.local?.effective_health?.health_details_url ?? status.local?.health?.health_details_url;
  if (status.process_running && typeof value === "string") {
    const url = new URL(value);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname) || url.username || url.password || url.pathname !== "/health") throw new Error("Unexpected runtime health endpoint.");
    const response = await fetch(url, { signal: AbortSignal.timeout(3000), redirect: "error" });
    if (!response.ok) throw new Error("Runtime component status is unavailable.");
    const bytes = await response.text();
    if (bytes.length > 1024 * 1024) throw new Error("Runtime status exceeds budget.");
    const snapshot = JSON.parse(bytes);
    controlPlane = snapshot.components?.["control-plane"] ?? null; mcp = snapshot.components?.mcp ?? null;
  }
  const httpStatus = Number.isInteger(controlPlane?.details?.http_status) ? controlPlane.details.http_status : null;
  const cloudConnected = controlPlane?.status === "ok" && controlPlane?.state === "polling";
  return { running: status.process_running, daemonReady: status.ready === true,
    ready: status.ready === true && cloudConnected && mcp?.status !== "error", healthy: status.healthy === true && cloudConnected,
    controlPlaneState: controlPlane?.state ?? "unknown", controlPlaneHttpStatus: httpStatus,
    requiresCredential: !cloudConnected && [401, 403].includes(httpStatus), mcpState: mcp?.state ?? "unknown" };
}
async function runtimeKey(config) {
  const result = await execute("/usr/bin/security", ["find-generic-password", ...keychainArgs(config), "-w"], { timeout: 15000, maxBuffer: 16384 });
  const key = result.stdout.trim();
  if (!key || /[\0\r\n]/.test(key)) throw new Error("Keychain credential is unavailable.");
  return key;
}
async function connectRuntime(config, key) {
  const mcp = [config.node, path.join(root, "gateway/spine/mcp-server.mjs"), config.gatewayConnection, "--shared-work"].map(quote).join(" ");
  await execute(config.client, ["runtimes", "connect", "--alias", config.alias, "--profile", config.alias,
    "--profile-dir", config.profileDirectory, "--tunnel-id", config.tunnelId, "--runtime-api-key", "env:CONTROL_PLANE_API_KEY", "--mcp-command", mcp], {
    timeout: 45000, maxBuffer: 1024 * 1024,
    env: { ...process.env, CONTROL_PLANE_API_KEY: key, CONTROL_PLANE_ORGANIZATION_ID: config.organizationId,
      HEALTH_LISTEN_ADDR: "127.0.0.1:0", MCP_STDIO_SEND_INITIALIZED_NOTIFICATION: "true" },
  });
}
async function run(configFile) {
  const config = configAt(configFile);
  let stopping = false, credential = null, previous = null, timer;
  const stop = () => { stopping = true; clearTimeout(timer); }; process.once("SIGTERM", stop); process.once("SIGINT", stop);
  const state = value => {
    write(config.stateFile, { product, schemaVersion: 1, alias: config.alias, state: value, observedAt: new Date().toISOString(), monitorPid: process.pid });
    if (value !== previous) { console.log(JSON.stringify({ at: new Date().toISOString(), state: value })); previous = value; }
  };
  try {
    while (!stopping) {
      try {
        const status = await runtimeStatus(config);
        if (stopping) break;
        if (status.running) {
          if (status.requiresCredential) credential = null;
          state(status.requiresCredential ? "credential_rejected" : status.ready && status.healthy ? "connected" : "recovering");
        }
        else {
          state("reconnecting");
          if (!credential) { try { credential = await runtimeKey(config); } catch { state("keychain_unavailable"); } }
          if (credential && !stopping) {
            await connectRuntime(config, credential);
            const current = await runtimeStatus(config);
            state(current.requiresCredential ? "credential_rejected" : current.running && current.ready && current.healthy ? "connected" : "recovering");
          }
        }
      } catch { state("connection_unavailable"); }
      if (!stopping) {
        let wake;
        await new Promise(resolve => { wake = resolve; timer = setTimeout(resolve, 60000); process.once("SIGTERM", wake); process.once("SIGINT", wake); }).finally(() => {
          clearTimeout(timer); process.off("SIGTERM", wake); process.off("SIGINT", wake);
        });
      }
    }
  } finally { credential = null; process.off("SIGTERM", stop); process.off("SIGINT", stop); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [command, file] = process.argv.slice(2);
  try {
    if (!file || process.argv.length !== 4) throw new Error("Usage: workbench-connection.mjs <prepare|setup|run|status> <explicit config>");
    if (command === "prepare") console.log(JSON.stringify(prepareWorkbenchConnection(JSON.parse(privateFile(file)))));
    else if (command === "setup") await setup(path.resolve(file));
    else if (command === "run") await run(path.resolve(file));
    else if (command === "status") {
      const config = configAt(path.resolve(file)); console.log(JSON.stringify({ runtime: await runtimeStatus(config), automatic: fs.existsSync(config.stateFile) ? JSON.parse(privateFile(config.stateFile)) : null }));
    } else throw new Error("Unsupported connection operation.");
  } catch (error) {
    // Child process errors can contain captured stdout (including a keychain
    // result). Never log or serialize their message, output or environment.
    console.error(command === "setup" ? "自动连接设置未完成；请检查本机钥匙串输入与同名登录项，现有聊天和工作数据保持不变。" : "工作台连接操作未完成；凭据未输出。背景连接会稍后重试。");
    process.exitCode = 1;
  }
}
