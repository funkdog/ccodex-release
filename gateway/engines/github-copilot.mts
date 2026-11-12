import "../../tools/typescript-runtime.mjs";
import type { EngineAdapter } from "../contracts.mjs";
import type { CopilotSdk, CopilotSessionOptions, CopilotSession } from "../sdk-contracts.mjs";
import { randomUUID } from "node:crypto";
import { approveOnce } from "./permissions.mjs";
import { extractToolOutput } from "../media.mjs";

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
    async run({ prompt, attachments, model, cwd, nativeSessionId, reasoningEffort, getApprovalMode = () => "ask", signal, onSession, onText, onTool, onCheckpoint, ask }) {
      const toolNames = new Map<string, string>();
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
            const mode = getApprovalMode();
            if (mode === "deny") return { kind: "reject" };
            // Managed human-approval requirements remain authoritative in all
            // modes. Changing host policy never weakens organization policy.
            const managed = invocation?.managedSettingsEnabled === true ||
              (request.managedApprovalRequired != null && request.managedApprovalRequired !== false) ||
              invocation?.promptRequest?.managedApprovalRequired === true;
            if (!managed && (mode === "auto" || (mode === "read-only" && request.kind === "read"))) return { kind: "approve-once" };
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
            if (event.agentId) return;
            try {
              if (!checkpointed && sent && event.type === "user.message" && event.id) { checkpointed = true; onCheckpoint?.(event.id); }
              if (event.type === "assistant.message_delta") { streamed = true; onText(event.data.deltaContent); }
              if (event.type === "assistant.message") finalText = event.data.content || finalText;
              if (event.type === "tool.execution_start") { toolNames.set(event.data.toolCallId, event.data.toolName); onTool?.({ phase: "start", id: event.data.toolCallId,
                name: event.data.toolName, input: event.data.arguments }); }
              if (event.type === "tool.execution_complete") onTool?.({ phase: "end", id: event.data.toolCallId,
                success: event.data.success, ...extractToolOutput(event.data.result?.content ?? event.data.error?.message, { toolName: event.data.toolName ?? toolNames.get(event.data.toolCallId), cwd }) });
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
