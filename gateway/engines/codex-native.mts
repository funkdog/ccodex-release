import type { EngineAdapter, RunContext, Question } from "../contracts.mjs";
import { startNativePeer } from "../native-peer.mjs";
import { approveOnce } from "./permissions.mjs";
import fs from "node:fs";
import path from "node:path";

/** A gateway-owned Codex execution has its own native session/profile. The
 * public conversation remains in ThreadStore, just like every other CLI. */
export function codexNativeExecution({ executable, home, args, env = process.env }: {
  executable: string; home: string; args: string[]; env?: NodeJS.ProcessEnv;
}): Pick<EngineAdapter, "run" | "supportsModelSwitch" | "supportsImages" | "approvalModes"> {
  return { supportsModelSwitch: true, supportsImages: true, approvalModes: ["ask", "auto", "deny"],
    async run(context: RunContext) {
      if (context.signal.aborted) return;
      fs.mkdirSync(home, { recursive: true, mode: 0o700 });
      const stat = fs.lstatSync(home);
      if (!stat.isDirectory() || stat.isSymbolicLink() || typeof process.getuid === "function" && (stat.uid !== process.getuid() || stat.mode & 0o077)) throw new Error("Native execution requires a private owned profile.");
      const config = path.join(home, "config.toml");
      if (!fs.existsSync(config)) fs.writeFileSync(config, 'cli_auth_credentials_store = "file"\ncheck_for_update_on_startup = false\n[features]\napps = false\nplugins = false\nremote_plugin = false\n', { flag: "wx", mode: 0o600 });
      const peer = await startNativePeer({ executable, args: ["app-server", ...args], cwd: context.cwd, env: { ...env, CODEX_HOME: home }, stderr: "ignore" });
      let threadId: string | undefined, turnId: string | undefined, settled = false;
      let resolve!: () => void, reject!: (error: Error) => void;
      const done = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
      // Avoid an unhandled rejection if startup fails before the turn wait.
      void done.catch(() => {});
      const streamed = new Set<string>();
      const abort = () => { if (threadId && turnId) void peer.request("turn/interrupt", { threadId, turnId }).catch(() => {}); };
      peer.onClose = () => { if (!settled) reject(new Error("Codex execution disconnected before a terminal turn result; no request was replayed.")); };
      peer.onNotification = message => {
        const p = message.params as Record<string, unknown> | undefined;
        if (!p || p.threadId !== threadId) return;
        if (message.method === "item/agentMessage/delta" && typeof p.delta === "string") {
          streamed.add(String(p.itemId)); context.onText(p.delta);
        } else if (message.method === "item/started" || message.method === "item/completed") {
          const item = p.item as Record<string, unknown> | undefined;
          if (!item || typeof item.id !== "string") return;
          if (item.type === "agentMessage") {
            if (message.method === "item/completed" && !streamed.has(item.id) && typeof item.text === "string") context.onText(item.text);
          } else if (!["userMessage", "reasoning"].includes(String(item.type))) {
            context.onTool?.(message.method === "item/started" ? { phase: "start", id: item.id, name: String(item.type), input: item }
              : { phase: "end", id: item.id, success: !["failed", "declined"].includes(String(item.status)), output: item });
          }
        } else if (message.method === "turn/completed") {
          const turn = p.turn as { id?: string; status?: string; error?: { message?: string } };
          if (turnId && turn.id !== turnId) return;
          settled = true;
          if (turn.status === "completed" || context.signal.aborted) resolve();
          else reject(new Error(turn.error?.message || `Codex turn ended with ${turn.status}.`));
        }
      };
      peer.onRequest = message => {
        void (async () => {
          const params = message.params as Record<string, unknown>;
          let result: unknown;
          if (["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(message.method!)) {
            const mode = context.getApprovalMode?.() ?? "ask";
            const allowed = !context.signal.aborted && (mode === "auto" || mode !== "deny" && await approveOnce(context.ask, JSON.stringify(params)));
            result = { decision: allowed ? "accept" : "decline" };
          } else if (message.method === "item/tool/requestUserInput" && Array.isArray(params.questions)) result = await context.ask(params.questions as Question[]);
          else { peer.notify({ id: message.id, error: { code: -32601, message: "This native interaction is unsupported by the gateway; no grant was supplied." } }); return; }
          if (!peer.closed) peer.notify({ id: message.id, result });
        })().catch(() => { if (!peer.closed) peer.notify({ id: message.id, error: { code: -32000, message: "Native interaction was not approved." } }); });
      };
      context.signal.addEventListener("abort", abort, { once: true });
      try {
        await peer.request("initialize", { clientInfo: { name: "mycodex_conversation", version: "1" }, capabilities: { experimentalApi: true } }, { timeoutMs: 10000 });
        peer.notify({ method: "initialized" });
        const response = await peer.request<{ thread: { id: string } }>(context.nativeSessionId ? "thread/resume" : "thread/start", {
          ...(context.nativeSessionId ? { threadId: context.nativeSessionId } : {}), model: context.model, cwd: context.cwd,
          approvalPolicy: "on-request", sandbox: "workspace-write", config: { ...(context.reasoningEffort ? { model_reasoning_effort: context.reasoningEffort } : {}) },
        }, { timeoutMs: 15000 });
        threadId = response.thread.id; context.onSession(threadId);
        if (context.signal.aborted) return;
        const input: object[] = [{ type: "text", text: context.prompt, text_elements: [] }];
        for (const image of context.attachments ?? []) input.push({ type: "image", url: `data:${image.mimeType};base64,${image.data}` });
        const started = await peer.request<{ turn: { id: string } }>("turn/start", { threadId, model: context.model, input,
          ...(context.reasoningEffort ? { effort: context.reasoningEffort } : {}) });
        turnId = started.turn.id;
        if (context.signal.aborted) abort();
        await done;
      } finally { settled = true; context.signal.removeEventListener("abort", abort); await peer.dispose?.(); }
    } };
}
