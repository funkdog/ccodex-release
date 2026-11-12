import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveDesktopMode } from "./desktop-mode.mjs";
import { inspectBackendHost, runningHost } from "./desktop-current-host.mjs";
import { runDesktopShortcut } from "./desktop-shortcut.mjs";
import { connectGateway } from "../gateway/ipc.mjs";
import { readRoutingConnection } from "../gateway/routed-stdio.mjs";
import { latestDesktopRepairSession } from "./desktop-repair-session.mjs";

type Level = "ok" | "info" | "warning";
interface Feature { id: string; label: string; state: "ready" | "checking" | "unavailable"; detail: string; stateLabel?: string }
export interface DesktopStatus { schemaVersion: 1; level: Level; title: string; summary: string;
  features: Feature[]; steps: string; incident: string; appPid: number | null; observedAt: string;
  notice?: "degraded" | "recovered" | null; menuLabel?: string; launchAvailable?: boolean }
type Result = { action: string; backendState?: string; backendReason?: string; uiState?: string; uiReason?: string; pid?: number;
  repairSession?: { action: string; mode?: string } | null };

export function presentDesktopStatus(result: Result, appPid: number | null = result.pid ?? null): DesktopStatus {
  const updatePending = result.backendReason === "update-pending";
  const backend = (result.action === "activate-existing" || updatePending) && result.backendState === "ready";
  const stopped = result.action === "ready-to-start";
  const pending = backend && (result.uiState === "starting" ||
    ["unreported", "stale", "invalid-report", "pending", "retrying", "initialization-timeout", "reload-required"].includes(result.uiReason ?? ""));
  const ui = backend && result.uiState === "ready";
  const reasons: Record<string, string> = {
    contract: "当前页面版本尚未适配，模型菜单、会话控件和 DIY 页面组件暂不可用。",
    "reload-required": "当前页面版本的适配已准备；此窗口启动时未加载页面增强，任务结束后正常重开 MyCodex 即可加载。",
    "helper-exited": "页面增强进程已退出；后端路由仍可用。",
    unreported: "页面增强未上报状态，不能确认是否正常。下次正常重开时会加载状态监测。",
    stale: "页面状态报告已过期，不能确认当前接入是否正常。",
    retrying: "页面连接暂时中断，正在自动重试；后端路由仍可用。",
    "invalid-report": "页面状态报告无法读取，不能确认当前接入是否正常。",
    unavailable: "页面绑定已停止；后端路由仍可用。",
    "initialization-timeout": "页面接入结果仍未确认，后台会继续检查；尚不能据此判定功能故障。",
  };
  const title = updatePending ? "增强更新待加载" : stopped ? "ChatGPT 尚未启动" : backend && ui ? "MyCodex 接入正常"
    : pending ? result.uiReason === "reload-required" ? "页面增强待加载" : result.uiReason === "unreported" ? "状态监测待加载"
      : result.uiReason === "pending" ? "页面增强正在初始化" : "页面状态待确认"
      : backend ? "部分增强需要关注" : "后端接入需要关注";
  const features: Feature[] = [
    { id: "backend", label: "Provider 与 CLI 网关", state: backend ? "ready" : stopped || updatePending ? "checking" : "unavailable",
      ...(updatePending ? { stateLabel: backend ? "运行中" : "待确认" } : {}),
      detail: updatePending && backend ? "当前网关连接正常；有新代码尚未加载，现有任务可继续。"
        : backend ? "路由接入检查通过；模型额度、登录和实际回复另行确认。" : stopped ? "启动后检查。"
        : result.backendReason === "update-pending" ? "源码已更新，当前窗口仍运行旧路由；任务结束后重新打开 MyCodex 加载。"
          : result.backendReason === "protocol" ? "官方 app-server 协议检查未通过，需要适配后恢复第三方续聊。"
            : result.action === "needs-quit" ? "当前窗口的启动方式或接入配置与 MyCodex 不一致。"
              : "后端接入检查未通过。查看实例 gateway/stderr.log 确认原因。" },
    { id: "page", label: "模型菜单、会话控件与 DIY 页面", state: ui ? "ready" : pending || stopped || updatePending || !backend ? "checking" : "unavailable",
      ...(pending ? { stateLabel: ["unreported", "reload-required"].includes(result.uiReason ?? "") ? "待加载" : result.uiReason === "pending" ? "初始化中" : "待确认" } : {}),
      detail: ui ? "页面绑定检查通过；各项交互仍以实际使用为准。" : stopped ? "启动后检查。"
        : reasons[result.uiReason ?? ""] ?? "页面增强状态尚未确认。" },
  ];
  return { schemaVersion: 1, level: stopped || pending || updatePending ? "info" : backend && ui ? "ok" : "warning", title,
    summary: updatePending ? "本地有新代码，当前运行版本未被替换。" : backend ? ui ? "后端路由和页面增强均已接入。" : "后端路由保留。页面增强单独检测和恢复。"
      : stopped ? "从 MyCodex 图标启动原来的 ChatGPT。" : "现有窗口和会话保持运行；没有自动重启或切换引擎。",
    features, steps: updatePending ? "无需现在重启。等当前任务结束后正常重开 MyCodex，即可加载更新。"
      : stopped ? "状态检查不会启动客户端。" : backend && ui ? "无需操作。可随时从菜单栏查看兼容状态。"
      : pending ? result.uiReason === "reload-required" ? "无需现在重启。适配已准备，任务结束后正常退出 ChatGPT，再从 MyCodex 打开以加载页面增强。"
        : "无需现在重启。可继续工作，后台会自动检查；也可随时从菜单栏查看状态。"
        : backend ? result.uiReason === "contract" && result.repairSession?.action === "created"
          ? "页面版本适配会话已创建；后端可继续使用，可在 Codex 项目会话中查看。"
          : result.uiReason === "contract" && result.repairSession?.action === "launching"
            ? "正在创建页面版本适配会话；后端可继续使用。"
            : result.uiReason === "contract" && result.repairSession?.action === "failed"
              ? "页面适配会话创建失败；后端可继续使用，请查看私有 repair 日志。"
              : "页面连接问题会自动复查。若需要加载新版，请在任务结束后 ⌘Q，再点击 MyCodex。"
          : result.repairSession?.action === "created" ? result.repairSession.mode === "read-only-diagnosis"
            ? "已发起只读修复诊断；当前源码有未提交改动，可在 Codex 项目会话中查看结果。"
            : "已发起隔离的自动修复任务；可在 Codex 项目会话中查看进展。"
          : result.repairSession?.action === "launching" ? "正在创建修复会话；官方 ChatGPT 可继续使用。"
          : result.repairSession?.action === "failed" ? "修复会话创建失败；官方 ChatGPT 可继续使用，请查看 MyCodex 私有 repair 日志。"
          : "MyCodex 增强不可用；官方 ChatGPT 可继续使用。请查看实例日志。",
    incident: [result.action, result.backendState, result.backendReason, result.uiState, result.uiReason].join(":"), appPid,
    observedAt: new Date().toISOString(),
    ...(stopped ? { launchAvailable: true } : {}),
    ...(updatePending ? { menuLabel: "MyCodex · 待更新" }
      : pending ? { menuLabel: result.uiReason === "pending" ? "MyCodex · 检查中" : "MyCodex · 待确认" } : {}) };
}

/** Source drift is not a dead backend. Authenticate the existing connection
 * before reporting it as running; an unreachable old gateway still fails. */
export async function confirmPendingGateway(result: Result, connectionFile: string): Promise<Result> {
  if (result.backendReason !== "update-pending") return result;
  const socket = await connectGateway(readRoutingConnection(connectionFile));
  socket.end();
  return { ...result, backendState: "ready" };
}

/** Each observed incident is surfaced once; a user reopening the launcher can
 * always inspect the latest state. Healthy startup never produces a popup. */
export function createStatusNotifier({ now = Date.now }: { now?: () => number } = {}) {
  const active = new Map<string, number | null>();
  return (current: DesktopStatus) => {
    const failed = current.level === "warning" ? current.features.filter(feature => feature.state === "unavailable").map(feature => feature.id) : [];
    if (current.level === "warning" && !failed.length) failed.push("monitor");
    let recovered = false, degraded = false;
    for (const [feature, since] of active) {
      const healthy = feature === "monitor" ? current.level === "ok" : current.features.some(item => item.id === feature && item.state === "ready");
      if (!healthy) active.set(feature, null);
      else if (since === null) active.set(feature, now());
      else if (now() - since >= 30000) { active.delete(feature); recovered = true; }
    }
    for (const feature of failed) if (!active.has(feature)) { active.set(feature, null); degraded = true; }
    if (degraded) return "degraded";
    if (recovered) return "recovered";
    return null;
  };
}

/** A resident read-only watcher avoids signature/schema work on every poll.
 * Files changing invalidates the trusted host cache; process identities and
 * gateway connectivity are still checked every time. No CDP or model requests. */
export function createDesktopStatusReader(configFile: string) {
  let fingerprint: string | null = null, host: ReturnType<typeof inspectBackendHost> | null = null;
  return async (): Promise<DesktopStatus> => {
    let repairHome: string | undefined;
    try {
      const selection = (resolveDesktopMode as unknown as (options: { arguments: string[]; inherited: NodeJS.ProcessEnv }) =>
        { desktopApp: string; home: string })({ arguments: ["--config", configFile], inherited: process.env });
      repairHome = selection.home;
      const files = ["Contents/Info.plist", "Contents/MacOS/ChatGPT", "Contents/Resources/app.asar",
        "Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"];
      const current = selection.desktopApp + files.map(file => {
        const stat = fs.lstatSync(path.join(selection.desktopApp, file), { bigint: true });
        return `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
      }).join("/");
      if (!host || current !== fingerprint) { host = inspectBackendHost(selection.desktopApp); fingerprint = current; }
      const checked = { ...host, running: runningHost(host.executable) };
      const result = await (runDesktopShortcut as unknown as (options: { configFile: string; checkOnly: boolean;
        inspectHost: () => typeof checked }) => Promise<Result>)({ configFile, checkOnly: true, inspectHost: () => checked });
      const confirmed = await confirmPendingGateway(result, path.join(selection.home, "gateway", "connection.json"));
      return presentDesktopStatus({ ...confirmed,
        repairSession: confirmed.backendState === "unavailable" || confirmed.uiReason === "contract"
          ? latestDesktopRepairSession(selection.home, confirmed.uiReason === "contract" ? "page-contract" : undefined) : null }, checked.running[0]?.pid ?? null);
    } catch (cause) {
      // Never expose configuration values, prompts or SDK error payloads here.
      return presentDesktopStatus({ action: "inspection-unavailable", uiReason: "inspection",
        backendReason: (cause as NodeJS.ErrnoException).code === "HOST_PROTOCOL_MISMATCH" ? "protocol" : "inspection",
        repairSession: repairHome ? latestDesktopRepairSession(repairHome) : null });
    }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [flag, configFile, mode] = process.argv.slice(2);
  if (flag !== "--config" || !configFile || !["--once", "--watch"].includes(mode) || process.argv.length !== 5) {
    console.error("Usage: desktop-status.mjs --config <file> <--once|--watch>"); process.exitCode = 1;
  } else {
    const read = createDesktopStatusReader(configFile);
    const notice = createStatusNotifier();
    do {
      const current = await read();
      console.log(JSON.stringify({ ...current, notice: notice(current) }));
      if (mode === "--once") break;
      await new Promise(resolve => setTimeout(resolve, 15000));
    } while (true);
  }
}
