import "../../tools/typescript-runtime.mjs";
import type { EngineAdapter, AcpResult, AcpOption, AcpChoice, AcpParams, Ask, ApprovalMode, ChildOptions } from "../contracts.mjs";
import type { RpcPeer } from "../rpc-peer.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { startAcpPeer } from "../acp-peer.mjs";
import { approveOnce } from "./permissions.mjs";
import { extractToolOutput } from "../media.mjs";

export function macHttpsProxy(env: NodeJS.ProcessEnv, { platform = process.platform, inspect = () => spawnSync("/usr/sbin/scutil", ["--proxy"], { encoding: "utf8", timeout: 5000 }) } = {}) {
  if (platform !== "darwin" || Object.keys(env).some(name => /^(?:https?|all|wss?)_proxy$/i.test(name) && env[name])) return {};
  const result = inspect(); if (result.status !== 0) return {};
  const field = (name: string) => result.stdout.match(new RegExp(`^\\s*${name} : (.+)$`, "m"))?.[1]?.trim();
  const host = field("HTTPSProxy"), port = Number(field("HTTPSPort"));
  if (field("HTTPSEnable") !== "1" || !host || !/^[a-zA-Z0-9.:[\]-]+$/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) return {};
  const proxy = `http://${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${port}`;
  // Python websockets otherwise prefers macOS's SOCKS setting, which the
  // official runtime cannot use without python-socks. Use the same configured
  // HTTPS proxy's HTTP CONNECT transport in this child only.
  return { HTTPS_PROXY: proxy, https_proxy: proxy,
    ...(!env.NO_PROXY && !env.no_proxy ? { NO_PROXY: "localhost,127.0.0.1,::1", no_proxy: "localhost,127.0.0.1,::1" } : {}) };
}

export function antigravityEnvironment(inherited: NodeJS.ProcessEnv, { cliHome, harnessPath }: { cliHome: string; harnessPath: string }, proxy = macHttpsProxy(inherited)) {
  const env = { ...inherited };
  for (const name of Object.keys(env)) if (/^(?:GEMINI_|GOOGLE_|GCLOUD_|CLOUDSDK_|AGY_|ANTIGRAVITY_|CCODEX_|CODEX_|ELECTRON_|NODE_REPL_|SKY_CUA_|BROWSER_USE_)/.test(name) || ["NODE_OPTIONS", "MYCODEX_GOOGLE_TOKEN"].includes(name)) delete env[name];
  return { ...env, ...proxy, GEMINI_HOME: cliHome, AGY_ACP_FORCE_FILE_STORAGE: "1", ANTIGRAVITY_HARNESS_PATH: harnessPath };
}

export function assertAntigravityAccount(cliHome: string) {
  const directory = path.join(cliHome, "antigravity-acp");
  for (const name of ["settings.json", "acp_token.json"]) {
    let stat; try { stat = fs.lstatSync(path.join(directory, name)); }
    catch { throw new Error("Antigravity 订阅账号尚未登录，请先完成独立 Google 授权；不会使用 API key 或 Copilot。"); }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024 || (process.platform !== "win32" && (stat.uid !== process.getuid!() || (stat.mode & 0o077)))) throw new Error("Antigravity account files must be private owned regular files.");
  }
  if (JSON.parse(fs.readFileSync(path.join(directory, "settings.json"), "utf8")).auth?.type !== "oauth-personal") throw new Error("This Antigravity engine requires personal Google subscription authentication.");
}

export async function initializeAntigravity(peer: RpcPeer<AcpParams, AcpResult>) {
  const result = await peer.request("initialize", { protocolVersion: 1,
    clientInfo: { name: "mycodex", version: "0.1" }, clientCapabilities: {} }, { timeoutMs: 30000 });
  if (result.protocolVersion !== 1 || result.agentInfo?.name !== "antigravity-acp" || result.agentInfo.version !== "1.4.4") throw new Error("Antigravity ACP runtime differs from the verified 1.4.4 contract.");
  return result;
}

export function antigravityConfigOption(session: AcpResult, category: string) {
  return session.configOptions?.find(option => option.category === category && option.type === "select");
}
const choices = (option: AcpOption | undefined): AcpChoice[] => (option?.options ?? []).flatMap(value => Array.isArray(value.options) ? value.options : [value]);
async function setOption(peer: RpcPeer<AcpParams, AcpResult>, sessionId: string, session: AcpResult, category: string, value: string) {
  const option = antigravityConfigOption(session, category);
  if (!option || !choices(option).some(choice => choice.value === value)) throw new Error(`Antigravity does not advertise ${category} ${value}; no fallback.`);
  const changed = await peer.request("session/set_config_option", { sessionId, configId: option.id, value }, { timeoutMs: 15000 });
  if (antigravityConfigOption(changed, category)?.currentValue !== value) throw new Error(`Antigravity did not acknowledge ${category} ${value}.`);
  return { ...session, ...changed };
}

/** Approval options on interaction_* calls are answers to business questions,
 * never a grant of tool permission (including in automatic policy modes). */
export async function antigravityPermission(params: AcpParams, { ask, getApprovalMode, signal }: { ask: Ask; getApprovalMode: () => ApprovalMode; signal: AbortSignal }) {
  if (signal.aborted) return { outcome: { outcome: "cancelled" } };
  const options = params.options;
  if (!Array.isArray(options) || !options.length || options.length > 30) return { outcome: { outcome: "cancelled" } };
  const ids = options.map(option => option?.optionId);
  if (ids.some(id => typeof id !== "string" || !id) || new Set(ids).size !== ids.length)
    return { outcome: { outcome: "cancelled" } };
  if (params.toolCall?.toolCallId?.startsWith("interaction_")) {
    const labels = options.map(option => option.name);
    if (new Set(labels).size !== labels.length || labels.some(label => typeof label !== "string" || !label)) throw new Error("Unsupported Antigravity question choices; no answer supplied.");
    const detail = (params.toolCall.content ?? []).filter(c => c.type === "content" && c.content?.type === "text").map(c => c.content!.text).join("\n");
    const answer = await ask([{ id: "antigravity-question", header: "Antigravity", question: [params.toolCall.title, detail].filter(Boolean).join("\n"),
      isOther: false, isSecret: false, options: labels.map(label => ({ label, description: label })) }]);
    const supplied = answer?.answers?.["antigravity-question"]?.answers;
    const selected = supplied?.length === 1 && options.find(option => option.name === supplied[0]);
    return { outcome: selected && !signal.aborted ? { outcome: "selected", optionId: selected.optionId } : { outcome: "cancelled" } };
  }
  const option = options.find(value => value.kind === "allow_once");
  const mode = getApprovalMode();
  const allowed = option && mode !== "deny" && (mode === "auto" ||
    await approveOnce(ask, `Antigravity requests permission:\n${JSON.stringify(params.toolCall)}`));
  return { outcome: allowed && !signal.aborted ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" } };
}

export function antigravityEngine({ executable, harnessPath, cliHome, env = process.env,
  start = startAcpPeer, accountCheck = assertAntigravityAccount, environment = antigravityEnvironment }: { executable: string; harnessPath: string; cliHome: string; env?: NodeJS.ProcessEnv; start?: typeof startAcpPeer; accountCheck?: typeof assertAntigravityAccount; environment?: typeof antigravityEnvironment }): EngineAdapter {
  const connect = (cwd: string) => start({ executable, cwd, env: environment(env, { cliHome, harnessPath }) });
  return {
    displayName: "Antigravity（Google 订阅）", supportsImages: true, supportsModelSwitch: true, approvalModes: ["ask", "auto", "deny"],
    async models() {
      accountCheck(cliHome);
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cc-antigravity-catalog-")); let peer: Awaited<ReturnType<typeof startAcpPeer>> | undefined;
      try {
        peer = await connect(cwd);
        const connected = peer;
        peer.onRequest = message => connected.notify({ id: message.id, error: { code: -32601, message: "Discovery grants no client tools or sign-in." } });
        const info = await initializeAntigravity(peer);
        const session = await peer.request("session/new", { cwd, mcpServers: [] }, { timeoutMs: 60000 });
        const available = choices(antigravityConfigOption(session, "model"));
        if (!available.length) throw new Error("Antigravity returned no selectable models.");
        const result: import("../contracts.mjs").Model[] = [];
        for (const model of available) {
          const configured = await setOption(peer, session.sessionId, session, "model", model.value);
          const effort = antigravityConfigOption(configured, "thought_level");
          result.push({ id: model.value, name: model.name, description: model.description,
            inputModalities: info.agentCapabilities?.promptCapabilities?.image ? ["text", "image"] : ["text"],
            supportedReasoningEfforts: choices(effort).map(value => value.value), defaultReasoningEffort: effort?.currentValue });
        }
        return result;
      } finally { await peer?.dispose(); fs.rmSync(cwd, { recursive: true, force: true }); }
    },
    async run({ prompt, attachments, model, cwd, nativeSessionId, reasoningEffort, signal, onSession, onText, onTool, onImage, ask, getApprovalMode = () => "ask" }) {
      accountCheck(cliHome); if (signal.aborted) return;
      const peer = await connect(cwd); let sessionId: string | undefined, sending = false, callbackError: unknown, cancelTimer: ReturnType<typeof setTimeout> | undefined;
      const tools = new Set();
      const abort = () => {
        if (sending && !peer.closed) peer.notify({ method: "session/cancel", params: { sessionId } });
        cancelTimer ??= setTimeout(() => void peer.dispose(), 2000);
      };
      peer.onNotification = message => {
        if (message.method !== "session/update" || message.params?.sessionId !== sessionId || !sending || signal.aborted) return;
        const update = message.params!.update!;
        try {
          if (update?.sessionUpdate === "agent_message_chunk" && update.content && !Array.isArray(update.content)) {
            if (update.content.type === "text" && typeof update.content.text === "string") onText(update.content.text);
            if (update.content.type === "image") for (const image of extractToolOutput(update.content).images) onImage?.(image);
          }
          if (update && ["tool_call", "tool_call_update"].includes(update.sessionUpdate)) {
            if (!tools.has(update.toolCallId)) { tools.add(update.toolCallId); onTool?.({ phase: "start", id: update.toolCallId, name: update.title || "Antigravity tool", input: update.rawInput ?? {} }); }
            if (["completed", "failed"].includes(update.status)) onTool?.({ phase: "end", id: update.toolCallId, success: update.status === "completed", ...extractToolOutput(update.content ?? update.rawOutput ?? "", { toolName: update.title, cwd }) });
          }
        } catch (cause) { const error = cause instanceof Error ? cause : new Error(String(cause)); callbackError = error; abort(); }
      };
      peer.onRequest = async message => {
        try {
          if (message.method !== "session/request_permission" || message.params?.sessionId !== sessionId || !sending) {
            peer.notify({ id: message.id, error: { code: -32601, message: "Unsupported Antigravity client request; no tool, login or answer supplied." } }); return;
          }
          peer.notify({ id: message.id, result: await antigravityPermission(message.params!, { ask, getApprovalMode, signal }) });
        } catch (cause) { const error = cause instanceof Error ? cause : new Error(String(cause));
          callbackError = error;
          if (!peer.closed) peer.notify({ id: message.id, result: { outcome: { outcome: "cancelled" } } });
          abort();
        }
      };
      signal.addEventListener("abort", abort, { once: true });
      try {
        const info = await initializeAntigravity(peer);
        if (signal.aborted) return;
        if (nativeSessionId && !info.agentCapabilities?.sessionCapabilities?.resume) throw new Error("This Antigravity runtime cannot resume without replaying history; no substitute session was created.");
        let session = await peer.request(nativeSessionId ? "session/resume" : "session/new",
          { ...(nativeSessionId ? { sessionId: nativeSessionId } : {}), cwd, mcpServers: [] }, { timeoutMs: 60000 });
        sessionId = nativeSessionId || session.sessionId;
        if (!sessionId || (nativeSessionId && session.sessionId && session.sessionId !== nativeSessionId)) throw new Error("Antigravity returned a different session identity.");
        onSession(sessionId);
        session = await setOption(peer, sessionId, session, "model", model);
        if (reasoningEffort != null) session = await setOption(peer, sessionId, session, "thought_level", reasoningEffort);
        await peer.request("session/set_mode", { sessionId, modeId: "default" }, { timeoutMs: 15000 });
        if (attachments?.length && !info.agentCapabilities?.promptCapabilities?.image) throw new Error("This Antigravity runtime does not advertise image input.");
        if (signal.aborted) return;
        sending = true;
        const result = await peer.request("session/prompt", { sessionId, prompt: [
          ...(prompt ? [{ type: "text", text: prompt }] : []), ...(attachments ?? []).map(a => ({ type: "image", data: a.data, mimeType: a.mimeType }))] });
        if (callbackError) throw callbackError;
        if (!signal.aborted && result.stopReason !== "end_turn") throw new Error(`Antigravity ended with ${result.stopReason || "unknown status"}.`);
      } finally { sending = false; clearTimeout(cancelTimer); signal.removeEventListener("abort", abort); await peer.dispose(); }
    },
  };
}
