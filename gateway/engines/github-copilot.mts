import "../../tools/typescript-runtime.mjs";
import type { EngineAdapter } from "../contracts.mjs";
import type { CopilotSdk, CopilotSessionOptions, CopilotSession } from "../sdk-contracts.mjs";
import { randomUUID } from "node:crypto";
import { approveOnce } from "./permissions.mjs";
import { extractToolOutput } from "../media.mjs";
import { object } from "./tool-display.mjs";

export function copilotEngine({ sdk, executable, env }: { sdk: CopilotSdk; executable?: string; env?: NodeJS.ProcessEnv }): EngineAdapter {
  const client = (cwd?: string) => new sdk.CopilotClient({ env, ...(cwd ? { workingDirectory: cwd } : {}),
    connection: sdk.RuntimeConnection.forStdio(executable ? { path: executable } : {}),
    logLevel: "error" });
  return {
    supportsImages: true, supportsModelSwitch: true,
    approvalModes: ["ask", "read-only", "auto", "deny"],
    supportsForkBoundary: true,
    async forkSession({ nativeSessionId, cwd, beforeEventId }) {
      const runtime = client(cwd);
      try {
        await runtime.start();
        if (typeof runtime.rpc?.sessions?.fork !== "function") throw new Error("This installed Copilot SDK cannot clone a session; no substitute session was created.");
        const forked = await runtime.rpc.sessions.fork({ sessionId: nativeSessionId, ...(beforeEventId ? { toEventId: beforeEventId } : {}) });
        if (!forked.sessionId || forked.sessionId === nativeSessionId) throw new Error("Copilot returned no independent fork identity.");
        return forked.sessionId;
      } finally { await runtime.stop(); }
    },
    async deleteSession({ nativeSessionId, cwd }) {
      const runtime = client(cwd);
      try { await runtime.start(); await runtime.deleteSession(nativeSessionId); }
      catch (error) {
        // A previous deletion can have committed before its response was lost.
        if (!(error instanceof Error) || !/session .*not found|session .*does not exist|unknown session/i.test(error.message)) throw error;
      } finally { await runtime.stop(); }
    },
    async models() {
      const runtime = client();
      try {
        await runtime.start();
        const auth = await runtime.getAuthStatus();
        if (!auth.isAuthenticated) throw new Error("GitHub Copilot CLI is not authenticated. Sign in using the CLI first.");
        return (await runtime.listModels()).filter(model => model.policy?.state !== "disabled");
      } finally { await runtime.stop(); }
    },
    async run({ prompt, attachments, model, cwd, nativeSessionId, reasoningEffort, getApprovalMode = () => "ask", signal, onSession, onText, onTool, onCheckpoint, ask, display }) {
      const toolNames = new Map<string, string>();
      const projected = new Map<string, "command" | "mcp">(), thoughts = new Set<string>();
      const runtime = client(cwd);
      let session: CopilotSession | undefined;
      let unsubscribe: (() => void) | undefined;
      let abort: (() => void) | undefined;
      try {
        await runtime.start();
        if (signal.aborted) return;
        const config: CopilotSessionOptions = { model, workingDirectory: cwd, streaming: true,
          ...(reasoningEffort != null ? { reasoningEffort } : {}),
          onPermissionRequest: async (request, invocation) => {
            if (signal.aborted) return { kind: "reject" };
            const mode = getApprovalMode();
            if (mode === "deny") return { kind: "reject" };
            // Managed human-approval requirements remain authoritative in all
            // modes. Changing host policy never weakens organization policy.
            const managed = invocation?.managedSettingsEnabled === true ||
              (request.managedApprovalRequired != null && request.managedApprovalRequired !== false) ||
              invocation?.promptRequest?.managedApprovalRequired === true;
            if (!managed && (mode === "auto" || (mode === "read-only" && request.kind === "read"))) return { kind: "approve-once" };
            if (display && request.kind === "shell" && request.toolCallId && request.fullCommandText) {
              const id = request.toolCallId;
              if (!projected.has(id)) {
                projected.set(id, "command"); display.commandStart({ id, command: request.fullCommandText, cwd: request.resolvedWorkingDirectory ?? cwd });
              }
              if (projected.get(id) === "command") {
                const decision = await display.requestCommandApproval({ itemId: id, command: request.fullCommandText, cwd: request.resolvedWorkingDirectory ?? cwd });
                const allowed = !signal.aborted && ["accept", "acceptForSession"].includes(decision);
                if (!allowed) display.commandEnd({ id, status: "declined" });
                return { kind: allowed ? "approve-once" : "reject" };
              }
            }
            return { kind: await approveOnce(ask,
              `GitHub Copilot CLI requests permission:\n${JSON.stringify(request)}`) ? "approve-once" : "reject" };
          },
          onUserInputRequest: async request => {
            const result = await ask([{ id: "input", header: "Copilot", question: request.question,
              isOther: request.allowFreeform !== false, isSecret: false,
              options: request.choices?.map(label => ({ label, description: label })) ?? null }]);
            const answer = result?.answers?.input?.answers?.join("\n");
            if (typeof answer !== "string") throw new Error("No user answer was provided.");
            return { answer, wasFreeform: !request.choices?.includes(answer) };
          },
        };
        const sessionId = nativeSessionId || randomUUID();
        onSession(sessionId);
        session = nativeSessionId ? await runtime.resumeSession(sessionId, config)
          : await runtime.createSession({ ...config, sessionId });
        onSession(session.sessionId);
        let turnError: unknown;
        let sent = false;
        let streamed = false;
        let finalText = "";
        let checkpointed = false;
        const done = new Promise<void>((resolve, reject) => {
          unsubscribe = session!.on(event => {
            if (event.agentId || signal.aborted && event.type !== "session.idle") return;
            try {
              if (display && event.type === "assistant.reasoning_delta" && event.data.reasoningId) {
                thoughts.add(event.data.reasoningId); display.thinkingDelta(event.data.reasoningId, event.data.deltaContent);
              }
              if (display && event.type === "assistant.reasoning" && event.data.reasoningId) {
                if (!thoughts.has(event.data.reasoningId) && event.data.content) display.thinkingDelta(event.data.reasoningId, event.data.content);
                display.thinkingDone(event.data.reasoningId); thoughts.delete(event.data.reasoningId);
              }
              if (!checkpointed && sent && event.type === "user.message" && event.id) { checkpointed = true; onCheckpoint?.(event.id); }
              if (event.type === "assistant.message_delta") { streamed = true; onText(event.data.deltaContent); }
              if (event.type === "assistant.message") finalText = event.data.content || finalText;
              if (event.type === "tool.execution_start") {
                const data = event.data, input = object(data.arguments), id = data.toolCallId;
                toolNames.set(id, data.toolName);
                if (!projected.has(id) && display && data.shellToolInfo && typeof input.command === "string" && input.command) {
                  projected.set(id, "command"); display.commandStart({ id, command: input.command, cwd });
                } else if (!projected.has(id) && display && (data.mcpConfigServerName || data.mcpServerName) && data.mcpToolName) {
                  projected.set(id, "mcp"); display.mcpStart({ id, server: data.mcpConfigServerName ?? data.mcpServerName!, tool: data.mcpToolName, arguments: data.arguments });
                }
                if (!projected.has(id)) onTool?.({ phase: "start", id, name: data.toolName, input: data.arguments });
              }
              if (event.type === "tool.execution_complete") {
                const data = event.data, kind = projected.get(data.toolCallId);
                const result = extractToolOutput(data.result?.content ?? data.error?.message ?? "", { toolName: data.toolName ?? toolNames.get(data.toolCallId), cwd });
                if (kind === "command") display?.commandEnd({ id: data.toolCallId, status: data.success ? "completed" : "failed", output: result.output, exitCode: data.shellExecution?.exitCode });
                else if (kind === "mcp") display?.mcpEnd({ id: data.toolCallId, status: data.success ? "completed" : "failed", result: { content: [{ type: "text", text: result.output }], structuredContent: data.result?.structuredContent }, errorMessage: data.error?.message });
                else onTool?.({ phase: "end", id: data.toolCallId, success: data.success, ...result });
              }
              if (event.type === "session.error") turnError = new Error(event.data.message || "Copilot CLI failed.");
              if (sent && event.type === "session.idle") turnError ? reject(turnError) : resolve();
            } catch (cause) { const error = cause instanceof Error ? cause : new Error(String(cause)); turnError = error; session!.abort().catch(reject); }
          });
          abort = () => {
            // abort acknowledgement is not terminal; wait for idle. The finally
            // block stops this run's own CLI, never another session's runtime.
            session!.abort().catch(reject);
          };
          signal.addEventListener("abort", abort, { once: true });
          sent = true;
          session!.send({ prompt, ...(attachments?.length ? { attachments } : {}) }).catch(reject);
          if (signal.aborted) abort!();
        });
        await done;
        if (!streamed && finalText) onText(finalText);
      } finally {
        if (abort) signal.removeEventListener("abort", abort);
        unsubscribe?.();
        try { await session?.disconnect(); } finally { await runtime.stop(); }
      }
    },
  };
}
