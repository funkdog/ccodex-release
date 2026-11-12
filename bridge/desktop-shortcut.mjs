import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveDesktopMode } from "./desktop-mode.mjs";
import { inspectBackendHost, currentHostEnvironment } from "./desktop-current-host.mjs";
import { launchDesktop } from "./desktop-launch.mjs";
import { readProcessIdentity, sameProcessLifetime } from "./desktop-process.mjs";
import { appServerGatewayBackend } from "./desktop-backends/app-server-gateway.mjs";
import { resolveUiHealth } from "./desktop-ui-health.mjs";
import { launchProtectedCurrentHost } from "./desktop-protected-start.mjs";
import { queueDesktopRepairSession } from "./desktop-repair-session.mjs";

function readReceipt(file) {
  if (!fs.existsSync(file)) return null;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024 ||
      stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error("Invalid private current-host receipt.");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** The macOS app is only a presentation shell. All launch policy remains here.
 * No UI automation, process termination, profile override or model invocation. */
export async function runDesktopShortcut({ root = path.resolve(import.meta.dirname, ".."), configFile,
  inherited = process.env, checkOnly = false, inspectHost = inspectBackendHost,
  inspectProcess = readProcessIdentity, read = readReceipt, launch = launchDesktop,
  backendFactory = appServerGatewayBackend, fallbackLaunch = launchProtectedCurrentHost,
  queueRepair = queueDesktopRepairSession, retirementTimeoutMs = 75000,
  delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)) } = {}) {
  const selection = resolveDesktopMode({ arguments: ["--config", configFile], inherited });
  if (selection.gateway?.workbench === false) queueRepair = async () => ({ action: "disabled" });
  if (selection.host !== "current" || selection.mode !== "app-server-gateway") throw new Error("MyCodex shortcut requires the current-host gateway configuration.");
  // A configured backend failure stays visible. The emergency path starts
  // the signed stock app without an empty or incompatible MyCodex router.
  const unavailable = reason => ({ application: selection.desktopApp, instanceId: selection.id,
    action: "needs-attention", backendState: "unavailable", backendReason: "startup-failed", checkOnly, launchPerformed: false,
    message: `MyCodex 后端尚未就绪，已配置引擎和会话归属保留。请修复后再点击 MyCodex。原因：${String(reason).slice(0, 1000)}` });
  const stockFallback = async (reason, backendReason = "startup-failed") => {
    if (checkOnly) return unavailable(reason);
    try {
      const result = await fallbackLaunch({ root, application: selection.desktopApp, home: selection.home, inherited, reason: String(reason) });
      let repairSession;
      try { repairSession = await queueRepair({ root, home: selection.home, application: selection.desktopApp,
        category: backendReason, reason: String(reason), env: currentHostEnvironment(inherited, {}) }); }
      catch (error) { repairSession = { action: "unavailable", reason: error.message }; }
      return { ...result, instanceId: selection.id, checkOnly: false, backendState: "unavailable", backendReason,
        uiState: "disabled", repairSession,
        message: `${result.message ?? "官方 ChatGPT 已启动，MyCodex 增强暂不可用。"} ${String(reason).slice(0, 500)}` };
    } catch (error) { return unavailable(`${reason}; 官方客户端兜底启动失败：${error.message}`); }
  };
  let host;
  try { host = inspectHost(selection.desktopApp); }
  catch (error) { return stockFallback(error.message, error.code === "HOST_PROTOCOL_MISMATCH" ? "protocol" : "inspection"); }
  const base = { application: host.application, instanceId: selection.id, checkOnly, launchPerformed: false };
  const pageRepair = async () => {
    if (checkOnly || host.uiAvailable !== false) return undefined;
    try { return await queueRepair({ root, home: selection.home, application: selection.desktopApp,
      category: "page-contract", reason: `ChatGPT ${host.applicationVersion ?? "updated"} page contract is unverified.`,
      env: currentHostEnvironment(inherited, {}) }); }
    catch (error) { return { action: "unavailable", reason: error.message }; }
  };
  if (host.running.length) {
    const receipt = read(path.join(selection.home, "current-host-launch.json"));
    const active = host.running.length === 1 && host.running[0];
    if (!active || receipt?.schemaVersion !== 1 || receipt.state !== "started" ||
        receipt.application !== host.application ||
        receipt.archiveSha256 !== host.archiveSha256 || receipt.cliSha256 !== host.cliSha256 ||
        receipt.identity?.pid !== active.pid || receipt.identity.lifetime !== active.lifetime ||
        receipt.identity.executable !== host.executable ||
        !sameProcessLifetime(receipt.identity, inspectProcess(active.pid))) {
      return { ...base, action: "activate-existing", pid: active?.pid ?? host.running[0].pid,
        backendState: "unavailable", backendReason: "launch-mismatch", uiState: "disabled",
        message: "已打开正在运行的官方 ChatGPT。当前窗口不是由这份 MyCodex 配置启动；增强需在任务结束后重新启动才能接入。" };
    }
    const backend = backendFactory({ root, home: selection.home, selection, nativeCli: host.nativeCli });
    // Additive CLI loading retains the original transport generation and app
    // receipt. Only the authenticated backend can prove that this old binding
    // now serves the selected configuration; inspection never rewrites it.
    const retained = binding => receipt.generation === selection.generation ||
      (binding?.generation === receipt.generation && binding.configGeneration === selection.generation &&
       receipt.connectionFile === path.join(selection.home, "gateway", "connection.json") && binding.connectionFile === receipt.connectionFile);
    if (receipt.generation !== selection.generation && !receipt.connectionFile)
      return { ...base, action: "activate-existing", pid: active.pid, backendState: "unavailable", backendReason: "launch-mismatch", uiState: "disabled" };
    try {
      const binding = await backend.check();
      if (!retained(binding)) return { ...base, action: "activate-existing", pid: active.pid,
        backendState: "unavailable", backendReason: "launch-mismatch", uiState: "disabled" };
    }
    catch (error) {
      if (error.code === "GATEWAY_RUNTIME_RETIRING" && retained(error.binding)) return { ...base, action: "activate-existing", pid: active.pid,
        backendState: "ready", backendReason: "update-pending", uiState: "disabled",
        message: "增强代码已更新，当前窗口仍运行旧版。任务结束后重新打开 MyCodex 即可加载。" };
      let repairSession;
      if (!checkOnly) {
        try { repairSession = await queueRepair({ root, home: selection.home, application: selection.desktopApp,
          category: "running-backend", reason: error.message, env: currentHostEnvironment(inherited, {}) }); }
        catch (cause) { repairSession = { action: "unavailable", reason: cause.message }; }
      }
      return { ...base, action: "activate-existing", pid: active.pid, backendState: "unavailable", backendReason: "unavailable",
        uiState: "disabled", repairSession,
        message: "现有 ChatGPT 已打开，但 MyCodex 网关不可用。会话保留，修复任务已尝试创建。" };
    }
    let ui = { uiState: "unsupported", uiReason: host.uiAvailable !== false && receipt.uiState === "unsupported" ? "reload-required" : "contract" };
    if (host.uiAvailable !== false && receipt.uiState !== "unsupported") {
      ui = { uiState: "unavailable", uiReason: "helper-exited" };
      if (receipt.helperIdentity && sameProcessLifetime(receipt.helperIdentity, inspectProcess(receipt.helperIdentity.pid))) {
        try { ui = resolveUiHealth(receipt, read(path.join(selection.home, "current-host-ui-status.json"))); }
        catch { ui = { uiState: "unavailable", uiReason: "invalid-report" }; }
      }
    }
    return { ...base, action: "activate-existing", pid: active.pid, backendState: "ready", ...ui,
      repairSession: await pageRepair() };
  }
  if (checkOnly) return { ...base, action: "ready-to-start" };
  // Each step retains the existing lock, exact installed-version checks and
  // final running-host recheck. An intervening ordinary launch is not killed.
  const deadline = Date.now() + retirementTimeoutMs;
  for (;;) {
    try { await launch({ root, inherited, selection: { ...selection, prepareOnly: true } }); break; }
    catch (error) {
      if (error.code !== "GATEWAY_RUNTIME_RETIRING") return stockFallback(error.message);
      if (Date.now() >= deadline) return stockFallback(error.message);
      if (inspectHost(selection.desktopApp).running.length) throw new Error("ChatGPT 已在等待期间启动；没有重启或关闭它。请稍后从 MyCodex 重新打开。");
      await backendFactory({ root, home: selection.home, selection, nativeCli: host.nativeCli }).retireIdle?.();
      await delay(2000);
      if (inspectHost(selection.desktopApp).running.length) throw new Error("ChatGPT 已在等待期间启动；没有重启或关闭它。请稍后从 MyCodex 重新打开。");
    }
  }
  let started;
  try { started = await launch({ root, inherited, selection: { ...selection, activate: true } }); }
  catch (error) {
    if (/still running|等待期间启动/.test(error.message)) throw error;
    return stockFallback(error.message);
  }
  return { ...base, action: "started", pid: started.pid, launchPerformed: true,
    backendState: started.backendState, uiState: started.uiState,
    activationVerified: started.activationVerified, helperLog: started.helperLog,
    repairSession: await pageRepair() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [flag, configFile, operation] = process.argv.slice(2);
  if (flag !== "--config" || !configFile || (operation && operation !== "--check") || process.argv.length > 5) {
    console.log(JSON.stringify({ action: "error", message: "Usage: desktop-shortcut.mjs --config <file> [--check]" })); process.exitCode = 1;
  } else {
    runDesktopShortcut({ configFile, checkOnly: operation === "--check" }).then(result => console.log(JSON.stringify(result)), error => {
      console.log(JSON.stringify({ action: "error", message: error.message })); process.exitCode = 1;
    });
  }
}
