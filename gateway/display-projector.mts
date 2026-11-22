import "../tools/typescript-runtime.mjs";
import { randomUUID } from "node:crypto";
import type { ThreadItem, Turn } from "./contracts.mjs";
import type { DisplaySink, StoredDisplayRecord, ApprovalDecision } from "./display-contracts.mjs";

export const displayLimits = { output: 128 * 1024, arguments: 64 * 1024, thinking: 1024 * 1024, turn: 2 * 1024 * 1024, items: 512 } as const;
export function clipUtf8(text: string, max = displayLimits.output): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= max) return text;
  let end = max;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}
export function boundedJson(value: unknown, max = displayLimits.arguments): unknown {
  const json = JSON.stringify(value ?? null);
  // The preview itself is JSON encoded a second time; quotes/backslashes can
  // double its byte size. Reserve that worst case rather than exceeding max.
  return Buffer.byteLength(json) <= max ? JSON.parse(json) : { truncated: true, preview: clipUtf8(json, Math.max(0, Math.floor((max - 128) / 2))) };
}
export function projectStoredItemToV2(item: ThreadItem | StoredDisplayRecord) {
  switch (item.type) {
    case "reasoningRecord": return { id: item.id, type: "reasoning" as const, summary: item.summary, content: [] as string[] };
    case "commandRecord": return { id: item.id, type: "commandExecution" as const, command: item.command, cwd: item.cwd,
      commandActions: [{ ...(item.actionHint ?? { type: "unknown" as const }), command: item.command }],
      status: item.status, aggregatedOutput: item.output === null ? null : clipUtf8(item.output),
      exitCode: item.exitCode, durationMs: item.durationMs, processId: null };
    case "fileChangeRecord": return { id: item.id, type: "fileChange" as const, status: item.status,
      changes: item.changes.map(change => ({ path: change.path, diff: change.diff,
        kind: change.kind === "update" ? { type: change.kind, move_path: change.movePath ?? null } : { type: change.kind } })) };
    case "mcpCallRecord": return { id: item.id, type: "mcpToolCall" as const, server: item.server, tool: item.tool,
      arguments: item.arguments, result: item.result, error: item.error, durationMs: item.durationMs, status: item.status,
      mcpAppUi: null, mcpAppResourceUri: null, appContext: null, pluginId: null, readOnlyHint: null };
    case "webSearchRecord": return { id: item.id, type: "webSearch" as const, query: item.query, action: item.action };
    case "imageViewRecord": return { id: item.id, type: "imageView" as const, path: item.path };
    case "planRecord": return { id: item.id, type: "plan" as const, text: item.steps.map(step => `${step.status}: ${step.step}`).join("\n") };
    default: return structuredClone(item);
  }
}

export function recoverDisplayItems(turn: Turn) {
  for (const item of turn.items) if ("status" in item && item.status === "inProgress") {
    item.status = "failed";
    if (item.type === "mcpCallRecord") item.error = { message: "CLI outcome is unknown after interruption." };
    if (item.type === "dynamicToolCall") item.success = false;
  }
}

/** One sink per run. IDs from untrusted runtimes never become gateway IDs. */
export function createDisplaySink({ turn, context, notify, beforeItem, save, signal, request }: {
  turn: Turn; context: { threadId: string; turnId: string }; signal: AbortSignal;
  notify(method: string, params: unknown): void; beforeItem(): void; save(): void;
  request(method: string, params: unknown): Promise<unknown>;
}) {
  const records = new Map<string, StoredDisplayRecord>();
  let bytes = 0, plan: Extract<StoredDisplayRecord, { type: "planRecord" }> | undefined;
  const charge = (value: unknown) => {
    bytes += Buffer.byteLength(JSON.stringify(value));
    if (bytes > displayLimits.turn) throw new Error("Display turn exceeds 2 MiB.");
  };
  const emit = (method: string, record: StoredDisplayRecord) => notify(method, { ...context, item: projectStoredItemToV2(record),
    ...(method === "item/started" ? { startedAtMs: Date.now() } : { completedAtMs: Date.now() }) });
  const add = <T extends StoredDisplayRecord>(key: string, record: T): T | undefined => {
    if (signal.aborted || records.has(key)) return;
    if (records.size >= displayLimits.items) throw new Error("Display item count exceeds 512.");
    charge(record); beforeItem(); records.set(key, record); turn.items.push(record); save(); emit("item/started", record); return record;
  };
  const end = (record: StoredDisplayRecord, persist = true) => { if (persist) save(); emit("item/completed", record); };
  const diff = () => notify("turn/diff/updated", { ...context, diff: turn.items.flatMap(item =>
    item.type === "fileChangeRecord" && item.status === "completed" ? item.changes.map(change => change.diff) : []).join("\n") });
  const approval = async (method: string, key: string, type: "commandRecord" | "fileChangeRecord", fields: object): Promise<ApprovalDecision> => {
    const record = records.get(key);
    if (signal.aborted || !record || record.type !== type || record.status !== "inProgress") return "cancel";
    try {
      const result = await request(method, { ...context, ...fields,
        ...(record.type === "commandRecord" ? { command: record.command, cwd: record.cwd } : {}),
        itemId: record.id, startedAtMs: Date.now() });
      const decision = result && typeof result === "object" && "decision" in result ? result.decision : null;
      // acceptForSession is narrowed to one invocation by adapters; no CLI policy is mutated.
      return !signal.aborted && typeof decision === "string" && ["accept", "acceptForSession", "decline", "cancel"].includes(decision) ? decision as ApprovalDecision : "cancel";
    } catch { return "cancel"; }
  };
  const sink: DisplaySink = {
    thinkingDelta(key, delta) {
      if (signal.aborted || !delta) return;
      let record = records.get(key);
      if (!record) record = add(key, { id: randomUUID(), type: "reasoningRecord", summary: [""], status: "inProgress" });
      if (record?.type !== "reasoningRecord" || record.status !== "inProgress") return;
      const remaining = displayLimits.thinking - Buffer.byteLength(record.summary.join(""));
      const text = clipUtf8(delta, remaining); charge(text); record.summary[0] += text;
      if (text) notify("item/reasoning/summaryTextDelta", { ...context, itemId: record.id, summaryIndex: 0, delta: text });
    },
    thinkingDone(key) { const record = records.get(key); if (record?.type === "reasoningRecord" && record.status === "inProgress") { record.status = "completed"; end(record); } },
    commandStart(input) { add(input.id, { ...input, id: randomUUID(), type: "commandRecord", status: "inProgress", output: null, exitCode: null, durationMs: null }); },
    commandOutputDelta(key, delta) {
      if (signal.aborted) return;
      const record = records.get(key); if (record?.type !== "commandRecord" || record.status !== "inProgress") return;
      const text = clipUtf8(delta, displayLimits.output - Buffer.byteLength(record.output ?? "")); charge(text);
      record.output = (record.output ?? "") + text;
      if (text) notify("item/commandExecution/outputDelta", { ...context, itemId: record.id, delta: text });
    },
    commandEnd(input) {
      const record = records.get(input.id); if (record?.type !== "commandRecord" || record.status !== "inProgress") return;
      record.status = input.status;
      if (input.output != null) { record.output = clipUtf8(input.output); charge(record.output); }
      record.exitCode = Number.isInteger(input.exitCode) && input.exitCode! >= -2147483648 && input.exitCode! <= 2147483647 ? input.exitCode! : null;
      record.durationMs = Number.isSafeInteger(input.durationMs) && input.durationMs! >= 0 ? input.durationMs! : null; end(record);
    },
    fileChangeStart(input) { add(input.id, { id: randomUUID(), type: "fileChangeRecord", changes: structuredClone(input.changes), source: input.source, status: "inProgress" }); },
    fileChangeEnd(input) {
      const record = records.get(input.id); if (record?.type !== "fileChangeRecord" || record.status !== "inProgress") return;
      if (input.changes) { charge(input.changes); record.changes = structuredClone(input.changes); }
      record.status = input.status; end(record); diff();
    },
    planUpdate(input) {
      if (signal.aborted) return;
      const value = { explanation: input.explanation ?? null, steps: structuredClone(input.steps) }; charge(value);
      if (!plan) plan = add("plan", { id: randomUUID(), type: "planRecord", ...value });
      else { beforeItem(); Object.assign(plan, value); }
      if (!plan) return;
      end(plan); notify("turn/plan/updated", { ...context, explanation: plan.explanation, plan: plan.steps });
    },
    mcpStart(input) { add(input.id, { ...input, id: randomUUID(), type: "mcpCallRecord", arguments: boundedJson(input.arguments), status: "inProgress", result: null, error: null, durationMs: null }); },
    mcpEnd(input) {
      const record = records.get(input.id); if (record?.type !== "mcpCallRecord" || record.status !== "inProgress") return;
      record.status = input.status; record.durationMs = Number.isSafeInteger(input.durationMs) && input.durationMs! >= 0 ? input.durationMs! : null;
      if (input.result != null) {
        const result = boundedJson(input.result, displayLimits.output);
        record.result = result && typeof result === "object" && "content" in result && Array.isArray(result.content)
          ? { content: result.content, ...("structuredContent" in result ? { structuredContent: result.structuredContent } : {}) }
          : { content: [{ type: "text", text: JSON.stringify(result) }] }; charge(record.result);
      }
      record.error = input.status === "failed" ? { message: clipUtf8(input.errorMessage ?? "External MCP call failed.") } : null;
      charge(record.error); end(record);
    },
    webSearch(input) { const record = add(input.id, { ...input, id: randomUUID(), type: "webSearchRecord", action: input.action ?? null }); if (record) end(record); },
    imageView(input) { const record = add(input.id, { ...input, id: randomUUID(), type: "imageViewRecord" }); if (record) end(record); },
    requestCommandApproval(input) {
      const record = records.get(input.itemId);
      if (record?.type !== "commandRecord" || record.command !== input.command || record.cwd !== input.cwd) return Promise.resolve("cancel");
      return approval("item/commandExecution/requestApproval", input.itemId, "commandRecord", { command: input.command, cwd: input.cwd, reason: input.reason ?? null, availableDecisions: ["accept", "acceptForSession", "decline", "cancel"] });
    },
    requestFileApproval(input) { return approval("item/fileChange/requestApproval", input.itemId, "fileChangeRecord", { reason: input.reason ?? null }); },
  };
  return { sink, finish() {
    for (const record of records.values()) if ("status" in record && record.status === "inProgress") {
      record.status = record.type === "reasoningRecord" && turn.status === "completed" ? "completed" : "failed";
      if (record.type === "mcpCallRecord") record.error = { message: "CLI ended without a tool result; outcome is unknown." };
      end(record, false);
    }
  } };
}
