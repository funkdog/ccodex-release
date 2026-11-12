import "../../tools/typescript-runtime.mjs";
import type { EngineAdapter, AcpResult, AcpOption, AcpChoice, AcpParams, Ask, ApprovalMode, ChildOptions } from "../contracts.mjs";
import type { RpcPeer } from "../rpc-peer.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startAcpPeer } from "../acp-peer.mjs";
import { approveOnce } from "./permissions.mjs";
import { extractToolOutput } from "../media.mjs";

export function geminiEnvironment(env: NodeJS.ProcessEnv, cliHome: string) {
  const result = { ...env };
  for (const name of Object.keys(result)) if (/^(?:GEMINI_|GOOGLE_|GCLOUD_|CLOUDSDK_|CCODEX_|CODEX_|ELECTRON_)/.test(name) || ["NODE_OPTIONS", "MYCODEX_GOOGLE_TOKEN"].includes(name)) delete result[name];
  return { ...result, GEMINI_CLI_HOME: cliHome, GEMINI_CLI_NO_RELAUNCH: "1", GEMINI_TELEMETRY_ENABLED: "false",
    PATH: [path.dirname(process.execPath), result.PATH].filter(Boolean).join(path.delimiter) };
}

export function assertGeminiAccount(cliHome: string) {
  const directory = path.join(cliHome, ".gemini");
  for (const name of ["settings.json", "oauth_creds.json"]) {
    const file = path.join(directory, name);
    let stat; try { stat = fs.lstatSync(file); } catch { throw new Error("Gemini Google 账号尚未登录，请先完成独立 Google 登录；不会改用 Copilot 或 API key。"); }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024 || (process.platform !== "win32" && (stat.mode & 0o077))) throw new Error("Gemini 登录文件必须是本机私有普通文件。");
  }
  if (JSON.parse(fs.readFileSync(path.join(directory, "settings.json"), "utf8")).security?.auth?.selectedType !== "oauth-personal")
    throw new Error("This Gemini engine requires Google account login, not an API key or Vertex identity.");
}

/** Owns one CLI child and its stdio only; never attaches to a user's terminal. */
export async function startGeminiPeer({ executable, cliHome, env = process.env, cwd = cliHome, args = ["--acp"], stderr = "ignore" }: ChildOptions & { cliHome: string }) {
  if (!path.isAbsolute(executable || "") || !fs.statSync(executable).isFile() || !path.isAbsolute(cliHome || "")) throw new Error("Absolute Gemini executable and private CLI home are required.");
  return startAcpPeer({ executable, args, cwd, env: geminiEnvironment(env, cliHome), stderr });
}

export async function initializeGemini(peer: RpcPeer<AcpParams, AcpResult>) {
  const result = await peer.request("initialize", { protocolVersion: 1,
    clientInfo: { name: "mycodex", version: "0.1" }, clientCapabilities: {} }, { timeoutMs: 30000 });
  if (result.protocolVersion !== 1) throw new Error("Unsupported Gemini ACP protocol version.");
  return result;
}

export function geminiCliEngine({ executable, cliHome, env, start = startGeminiPeer, accountCheck = assertGeminiAccount }: { executable: string; cliHome: string; env?: NodeJS.ProcessEnv; start?: typeof startGeminiPeer; accountCheck?: typeof assertGeminiAccount }): EngineAdapter {
  return {
    displayName: "Gemini CLI（Google）", supportsImages: true, approvalModes: ["ask", "deny"],
    async models() {
      accountCheck(cliHome);
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cc-gemini-catalog-"));
      let peer: Awaited<ReturnType<typeof startGeminiPeer>> | undefined;
      try {
        peer = await start({ executable, cliHome, env, cwd });
        const connected = peer;
        peer.onRequest = message => connected.notify({ id: message.id, error: { code: -32601, message: "Discovery grants no client tools." } });
        const info = await initializeGemini(peer);
        const session = await peer.request("session/new", { cwd, mcpServers: [] }, { timeoutMs: 45000 });
        return (session.models?.availableModels ?? []).map(m => ({ id: m.modelId, name: m.name,
          description: m.description, inputModalities: info.agentCapabilities?.promptCapabilities?.image ? ["text", "image"] : ["text"] }));
      } finally { await peer?.dispose(); fs.rmSync(cwd, { recursive: true, force: true }); }
    },
    async run({ prompt, attachments, model, cwd, nativeSessionId, reasoningEffort, signal, onSession, onText, onTool, onImage, ask, getApprovalMode = () => "ask" }) {
      accountCheck(cliHome);
      if (reasoningEffort != null) throw new Error("Gemini CLI ACP does not advertise reasoning overrides.");
      if (signal.aborted) return;
      const peer = await start({ executable, cliHome, env, cwd });
      let sessionId: string | undefined, sending = false, callbackError: unknown, cancelled: ReturnType<typeof setTimeout> | undefined;
      let commandsReady!: () => void;
      const commands = new Promise<void>(resolve => { commandsReady = resolve; });
      const tools = new Set();
      const abort = () => {
        if (sessionId && sending && !peer.closed) peer.notify({ method: "session/cancel", params: { sessionId } });
        // Also bounds a CLI that does not acknowledge cancellation.
        cancelled ??= setTimeout(() => void peer.dispose(), 2000);
      };
      peer.onNotification = message => {
        if (message.method !== "session/update") return;
        const { sessionId: id, update } = message.params ?? {};
        if (sessionId && id !== sessionId) return;
        if (update?.sessionUpdate === "available_commands_update") commandsReady();
        if (!sending || signal.aborted) return; // Resumed history is already in the gateway.
        try {
          if (update?.sessionUpdate === "agent_message_chunk" && update.content && !Array.isArray(update.content)) {
            if (update.content.type === "text" && typeof update.content.text === "string") onText(update.content.text);
            if (update.content.type === "image") for (const image of extractToolOutput(update.content).images) onImage?.(image);
          }
          if (update && ["tool_call", "tool_call_update"].includes(update.sessionUpdate)) {
            if (!tools.has(update.toolCallId)) { tools.add(update.toolCallId); onTool?.({ phase: "start", id: update.toolCallId, name: update.title || "Gemini tool", input: update.rawInput ?? {} }); }
            if (["completed", "failed"].includes(update.status)) onTool?.({ phase: "end", id: update.toolCallId, success: update.status === "completed", ...extractToolOutput(update.content ?? update.rawOutput ?? "", { toolName: update.title, cwd }) });
          }
        } catch (cause) { const error = cause instanceof Error ? cause : new Error(String(cause)); callbackError = error; abort(); }
      };
      peer.onRequest = async message => {
        try {
          if (message.method !== "session/request_permission" || message.params?.sessionId !== sessionId || !sending) throw new Error("Unsupported Gemini client request.");
          const option = message.params!.options?.find(value => value.kind === "allow_once");
          const allowed = option && !signal.aborted && getApprovalMode() !== "deny" &&
            await approveOnce(ask, `Gemini CLI requests permission:\n${JSON.stringify(message.params!.toolCall)}`);
          peer.notify({ id: message.id, result: { outcome: allowed && !signal.aborted
            ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" } } });
        } catch { if (!peer.closed) peer.notify({ id: message.id, result: { outcome: { outcome: "cancelled" } } }); }
      };
      signal.addEventListener("abort", abort, { once: true });
      try {
        const info = await initializeGemini(peer);
        if (signal.aborted) return;
        if (nativeSessionId && !info.agentCapabilities?.loadSession) throw new Error("This Gemini CLI cannot restore the stored session; no new session was substituted.");
        const session = await peer.request(nativeSessionId ? "session/load" : "session/new",
          { ...(nativeSessionId ? { sessionId: nativeSessionId } : {}), cwd, mcpServers: [] }, { timeoutMs: 45000 });
        sessionId = nativeSessionId || session.sessionId;
        if (!sessionId) throw new Error("Gemini returned no session ID.");
        onSession(sessionId);
        // Pinned CLI emits this after replaying the loaded history. Never use
        // a timer/quiet period to guess when replay ended.
        let timer;
        try { await Promise.race([commands, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Gemini session readiness was not acknowledged.")), 10000); })]); }
        finally { clearTimeout(timer); }
        if (!session.models?.availableModels?.some(row => row.modelId === model)) throw new Error("Selected Gemini model is unavailable for this account; no fallback.");
        await peer.request("session/set_model", { sessionId, modelId: model }, { timeoutMs: 10000 });
        if (attachments?.length && !info.agentCapabilities?.promptCapabilities?.image) throw new Error("This Gemini runtime cannot accept images.");
        if (signal.aborted) return;
        sending = true;
        const result = await peer.request("session/prompt", { sessionId, prompt: [
          ...(prompt ? [{ type: "text", text: prompt }] : []),
          ...(attachments ?? []).map(a => ({ type: "image", data: a.data, mimeType: a.mimeType }))] });
        if (callbackError) throw callbackError;
        if (!signal.aborted && result.stopReason !== "end_turn") throw new Error(`Gemini turn ended with ${result.stopReason || "unknown status"}.`);
      } finally { sending = false; clearTimeout(cancelled); signal.removeEventListener("abort", abort); await peer.dispose(); }
    },
  };
}
