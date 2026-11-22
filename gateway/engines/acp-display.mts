import "../../tools/typescript-runtime.mjs";
import path from "node:path";
import type { AcpUpdate, AcpParams, DisplaySink, ToolEvent } from "../contracts.mjs";
import { object, planSteps, unifiedDiff, endToolDisplay, displayOutputText } from "./tool-display.mjs";
import { extractToolOutput } from "../media.mjs";
import { boundedJson, displayLimits } from "../display-projector.mjs";

export function createAcpDisplay(display: DisplaySink | undefined, cwd: string, onTool: ((event: ToolEvent) => void) | undefined) {
  const tools = new Map<string, { update: AcpUpdate; mapping?: { kind: "command" | "file"; start(): void }; started: boolean; done: boolean; output: string }>();
  const diffChanges = (update: AcpUpdate) => {
    const blocks = (Array.isArray(update.content) ? update.content : []).filter(c => c.type === "diff");
    const changes = blocks.map(c => typeof c.path === "string" && (typeof c.oldText === "string" || c.oldText === null) && typeof c.newText === "string"
      ? unifiedDiff(path.resolve(cwd, c.path), c.oldText ?? "", c.newText, c.oldText === null ? "add" : "update") : null);
    return changes.length && changes.every(c => c !== null) ? changes : null;
  };
  let thought = 0, thinking = false;
  const closeThought = () => { if (thinking) { display?.thinkingDone(`acp-thought:${thought++}`); thinking = false; } };
  return {
    closeThought,
    async approve(tool: AcpParams["toolCall"]): Promise<boolean | null> {
      if (!display || !tool?.toolCallId) return null;
      this.update({ ...tool, toolCallId: tool.toolCallId, sessionUpdate: "tool_call", status: "pending" });
      const state = tools.get(tool.toolCallId);
      if (!state?.mapping) return null;
      const command = object(state.update.rawInput).command;
      const decision = state.mapping.kind === "file" ? await display.requestFileApproval({ itemId: tool.toolCallId })
        : await display.requestCommandApproval({ itemId: tool.toolCallId, command: typeof command === "string" ? command : state.update.title!, cwd });
      const allowed = decision === "accept" || decision === "acceptForSession";
      if (!allowed) {
        state.done = true;
        if (state.mapping.kind === "file") display.fileChangeEnd({ id: tool.toolCallId, status: "declined" });
        else display.commandEnd({ id: tool.toolCallId, status: "declined" });
      }
      return allowed;
    },
    update(update: AcpUpdate) {
      if (update.sessionUpdate === "agent_thought_chunk") {
        if (display && update.content && !Array.isArray(update.content) && update.content.type === "text" && typeof update.content.text === "string") {
          thinking = true; display.thinkingDelta(`acp-thought:${thought}`, update.content.text);
        }
        return;
      }
      closeThought();
      if (update.sessionUpdate === "plan") {
        const steps = planSteps(update.entries);
        if (!steps && display) throw new Error("ACP plan has unsupported entries; no fabricated plan was displayed.");
        if (steps) display?.planUpdate({ steps }); return;
      }
      if (!["tool_call", "tool_call_update"].includes(update.sessionUpdate) || typeof update.toolCallId !== "string" || !update.toolCallId) return;
      const id = update.toolCallId;
      let state = tools.get(id);
      if (state?.done) return;
      if (!state) {
        if (tools.size >= displayLimits.items) throw new Error("ACP tool count exceeds 512.");
        state = { update, started: false, done: false, output: "" }; tools.set(id, state);
      }
      else state.update = { ...state.update, ...update };
      if (state.done) return;
      const current = state.update, input = object(current.rawInput);
      if (!state.started && display && Buffer.byteLength(JSON.stringify(input)) <= displayLimits.arguments) {
        const source = { tool: current.title ?? "ACP tool", arguments: boundedJson(input) };
        const changes = diffChanges(current);
        if (changes) state.mapping = { kind: "file", start: () => display.fileChangeStart({ id, changes, source }) };
        else {
          const file = current.locations?.[0]?.path;
          const command = current.kind === "execute" && typeof input.command === "string" && input.command ? input.command
            : ["read", "search"].includes(current.kind ?? "") && current.title ? current.title : null;
          if (command && (current.kind !== "read" || file)) state.mapping = { kind: "command", start: () => display.commandStart({ id, command, cwd, source,
            actionHint: current.kind === "read" ? { type: "read", path: path.resolve(cwd, file!), name: path.basename(file!) }
              : current.kind === "search" ? { type: "search", query: typeof input.pattern === "string" ? input.pattern : null, path: file ? path.resolve(cwd, file) : null } : { type: "unknown" } }) };
        }
      }
      if (!state.started && (state.mapping || !display || ["completed", "failed"].includes(current.status))) {
        state.started = true;
        if (state.mapping) state.mapping.start();
        else onTool?.({ phase: "start", id, name: current.title || "ACP tool", input: current.rawInput ?? {} });
      }
      if (["completed", "failed"].includes(current.status)) {
        state.done = true;
        const result = extractToolOutput(current.content ?? current.rawOutput ?? "", { toolName: current.title, cwd });
        if (state.mapping?.kind === "file" && display) display.fileChangeEnd({ id, status: current.status === "completed" ? "completed" : "failed", changes: diffChanges(current) ?? undefined });
        else if (state.mapping && display) endToolDisplay(display, state.mapping, id, current.status === "completed", current.content ?? current.rawOutput ?? "", current.rawOutput);
        else onTool?.({ phase: "end", id, success: current.status === "completed", ...result });
        state.update = { ...current, content: undefined, rawInput: undefined, rawOutput: undefined };
        state.output = "";
      } else if (state.mapping?.kind === "command" && display && current.content) {
        const text = displayOutputText(current.content);
        // ACP content updates are snapshots, not guaranteed append deltas.
        // Emit only a proved suffix; a replacement is healed by the terminal item.
        if (text.startsWith(state.output)) display.commandOutputDelta(id, text.slice(state.output.length));
        state.output = text;
      }
    },
  };
}
