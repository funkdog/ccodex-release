import "../../tools/typescript-runtime.mjs";
import type { EngineAdapter } from "../contracts.mjs";
import type { ClaudeSdk, ClaudeQuery } from "../sdk-contracts.mjs";
import { randomUUID } from "node:crypto";
import { approveOnce } from "./permissions.mjs";
import { extractToolOutput } from "../media.mjs";
import { claudeApiOverlay, claudeApiModels } from "../claude-api-profile.mjs";

export function claudeCodeEngine({ sdk, executable, env, credentialProfile, environment = () => env ?? process.env }: { sdk: ClaudeSdk; executable?: string; env?: NodeJS.ProcessEnv; credentialProfile?: string; environment?: () => NodeJS.ProcessEnv }): EngineAdapter {
  const options = { settingSources: ["user", "project", "local"],
    permissionMode: "default", ...(executable ? { pathToClaudeCodeExecutable: executable } : {}) };
  const safeError = (cause: unknown, effective: NodeJS.ProcessEnv) => {
    let message = cause instanceof Error ? cause.message : "Claude Code failed.";
    for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]) if (effective[key]) {
      for (const secret of new Set([effective[key]!, encodeURIComponent(effective[key]!), JSON.stringify(effective[key]!).slice(1, -1)]))
        message = message.split(secret).join("[redacted]");
    }
    return new Error(message);
  };
  const close = async (query: ClaudeQuery | undefined, effective: NodeJS.ProcessEnv) => {
    try { query?.close(); await query?.return?.(); } catch (error) { throw safeError(error, effective); }
  };
  return {
    displayName: "Claude Code", supportsModelSwitch: true, approvalModes: ["ask", "auto", "deny"],
    async models() {
      const effective = environment();
      const overlay = credentialProfile ? claudeApiOverlay(credentialProfile, effective) : null;
      const discovery = new AbortController(), timer = setTimeout(() => discovery.abort(), 30000);
      let release!: () => void;
      const hold = new Promise<void>(resolve => { release = resolve; });
      let query;
      try {
        query = sdk.query({ prompt: (async function* () { await hold; })(),
          options: { ...options, env: effective, abortController: discovery, ...(overlay ? { settings: overlay.file } : {}), persistSession: false, settingSources: [] } });
        const models = await query.supportedModels();
        let result = [...new Map(models.map(model => [model.resolvedModel ?? model.value, {
          id: model.resolvedModel ?? model.value, name: model.displayName, description: model.description,
          ...(model.supportedEffortLevels?.length ? { supportedReasoningEfforts: model.supportedEffortLevels } : {}),
        }])).values()];
        if (credentialProfile) {
          const available = await claudeApiModels(effective, fetch, discovery.signal);
          if (available) result = available.flatMap(remote => {
            const native = result.find(model => model.id === remote.id);
            return native ? [native] : [];
          });
        }
        const configured = effective.ANTHROPIC_MODEL;
        if (configured && !result.some(model => model.id === configured)) result.unshift({ id: configured, name: configured,
          description: "用户明确配置的 Claude API 模型；账户可用性需通过真实推理验证。" });
        return result;
      } catch (error) { throw safeError(discovery.signal.aborted ? new Error("Claude Code 模型目录读取超时；没有启动推理。") : error, effective); }
      finally { clearTimeout(timer); release(); try { await close(query, effective); } finally { overlay?.dispose(); } }
    },
    async run({ prompt, model, cwd, nativeSessionId, reasoningEffort, signal, onSession, onText, onTool, onImage, ask, getApprovalMode = () => "ask", verification = false }) {
      if (signal.aborted) return;
      const effective = environment();
      const toolNames = new Map<string, string>();
      const sessionId = nativeSessionId || randomUUID();
      onSession(sessionId); // Save a recoverable identity before launching inference.
      const abortController = new AbortController();
      const abort = () => abortController.abort();
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort!();
      let query;
      let overlay: ReturnType<typeof claudeApiOverlay> | null = null;
      let resultSeen = false;
      let streamed = false;
      try {
        overlay = credentialProfile ? claudeApiOverlay(credentialProfile, effective) : null;
        query = sdk.query({ prompt, options: { ...options, env: effective, ...(overlay ? { settings: overlay.file } : {}), model, cwd, abortController,
          ...(reasoningEffort != null ? { effort: reasoningEffort } : {}),
          includePartialMessages: true, persistSession: !verification,
          ...(verification ? { tools: [], maxTurns: 1, settingSources: [] } : {}),
          ...(nativeSessionId ? { resume: nativeSessionId } : { sessionId }),
          canUseTool: async (name, input, permission) => {
            if (signal.aborted || permission?.signal?.aborted) return { behavior: "deny", message: "CLI request cancelled." };
            if (name === "AskUserQuestion") {
              const questions = input.questions;
              if (!Array.isArray(questions) || !questions.length || questions.length > 3 || questions.some(q => q.multiSelect)) {
                return { behavior: "deny", message: "This question shape is not supported by the Desktop adapter." };
              }
              const answer = await ask(questions.map((q, index) => ({ id: `q${index}`, header: q.header,
                question: q.question, options: q.options, isOther: true, isSecret: false })));
              const answers = Object.fromEntries(questions.map((q, index) => {
                const values = answer?.answers?.[`q${index}`]?.answers;
                if (!Array.isArray(values) || !values.length) throw new Error("User question was not answered.");
                return [q.question, values.join("\n")];
              }));
              return { behavior: "allow", updatedInput: { ...input, answers } };
            }
            const mode = getApprovalMode();
            if (mode === "deny") return { behavior: "deny", message: "CLI permissions are disabled for this chat." };
            // CLI rules and managed denials are evaluated before this callback.
            // A rule-forced or explicitly cautious prompt still needs a person.
            const forced = Boolean(permission?.matchedAskRule || permission?.defaultToNo || permission?.serverPolicyAskOnly ||
              ["rule", "safetyCheck"].includes(permission?.decisionReasonType ?? ""));
            const allow = (mode === "auto" && !forced) || await approveOnce(ask, `Claude Code requests ${name}:\n${JSON.stringify(input)}`);
            return allow && !signal.aborted && !permission?.signal?.aborted ? { behavior: "allow", updatedInput: input }
              : { behavior: "deny", message: "Permission was not granted by the Desktop user." };
          },
        } });
        for await (const message of query) {
          if (message.type === "system" && message.subtype === "init") {
            if (message.session_id !== sessionId) throw new Error("Claude Code returned a different session identity; no substitute session was accepted.");
            if (effective.ANTHROPIC_API_KEY && message.apiKeySource && message.apiKeySource !== "ANTHROPIC_API_KEY") throw new Error("Claude Code did not select the configured API key.");
            onSession(message.session_id);
          }
          if (message.type === "stream_event" && !message.parent_tool_use_id &&
              message.event?.type === "content_block_delta" && message.event.delta?.type === "text_delta") {
            streamed = true;
            onText(message.event.delta.text);
          }
          if (!message.parent_tool_use_id && ["assistant", "user"].includes(message.type)) {
            for (const block of message.message?.content || []) {
              if (block.type === "tool_use") { toolNames.set(block.id, block.name); onTool?.({ phase: "start", id: block.id, name: block.name, input: block.input }); }
              if (block.type === "image") for (const image of extractToolOutput(block).images) onImage?.(image);
              if (block.type === "tool_result") onTool?.({ phase: "end", id: block.tool_use_id,
                success: !block.is_error, ...extractToolOutput(block.content, { toolName: toolNames.get(block.tool_use_id), cwd }) });
            }
          }
          if (message.type === "result") {
            resultSeen = true;
            if (message.is_error || message.subtype !== "success") throw new Error(message.errors?.join("\n") || message.result || "Claude Code turn failed.");
            if (!streamed && typeof message.result === "string") onText(message.result);
          }
        }
        if (!resultSeen && !signal.aborted) throw new Error("Claude Code ended without a terminal result; outcome is unknown.");
      } catch (error) { throw safeError(error, effective); }
      finally { try { await close(query, effective); } finally { signal.removeEventListener("abort", abort); overlay?.dispose(); } }
    },
  };
}
