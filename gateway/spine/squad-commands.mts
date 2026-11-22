import type { SquadCardReview } from "./squad-v2-contracts.mjs";

const string = { type: "string", minLength: 1 };
const uuid = { type: "string", format: "uuid" };
const ref = { type: "object", additionalProperties: false, required: ["hostId", "accountId", "runtimeId", "threadId"], properties: { hostId: string, accountId: string, runtimeId: uuid, threadId: uuid } };
// V2 keeps legacy gateway RPC aliases so deployment does not require changing
// the server registration table. Workers receive file contracts, never tools.
const object = { type: "object" };
const ids = { type: "array", maxItems: 256, uniqueItems: true, items: string };
const slotIds = { ...ids, maxItems: 20 };
const slotDeliverables = { type: "object", maxProperties: 20, additionalProperties: {
  type: "array", maxItems: 24, items: { type: "object", additionalProperties: false, required: ["kind", "label"], properties: {
    kind: { type: "string", enum: ["mr", "issue", "commit", "branch", "report", "artifact"] }, label: { ...string, maxLength: 240 },
    target: { ...string, maxLength: 2048 }, detail: { ...string, maxLength: 1000 }, href: { ...string, maxLength: 2048 },
    previewKind: { type: "string", enum: ["commit", "markdown", "text"] }, previewRef: { ...string, maxLength: 2055 },
  } },
} };
const closure = { acceptSlots: slotIds, verifyCriteria: ids, retireSlots: slotIds, slotDeliverables };
const revision = { type: "integer", minimum: 1 };
const strings = { type: "array", items: string };
const nullableString = { type: ["string", "null"] };
const timestamp = { type: "integer", minimum: 0 };
const stateSchema = { type: "object", additionalProperties: false, properties: {
  title: string, intent: { type: "string" }, invariants: strings, contracts: strings,
  criteria: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "text"], properties: {
    id: string, text: string, detail: nullableString, verifiedBy: nullableString, verifiedAt: { ...timestamp, type: ["integer", "null"] },
  } } },
  openBlockers: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "summary", "createdAt"], properties: {
    id: string, slotId: nullableString, summary: string, createdAt: timestamp,
  } } },
  activeGate: { type: ["object", "null"], additionalProperties: false, required: ["id", "kind", "title", "question", "status"], properties: {
    id: string, kind: { type: "string", enum: ["blueprint", "decision", "convergence"] }, title: string, question: string,
    recommendedOptionId: nullableString, options: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "label", "summary"], properties: {
      id: string, label: string, summary: string,
    } } },
    status: { type: "string", enum: ["open", "approved", "changes_requested"] },
    resolutionText: nullableString, openedAt: timestamp, resolvedAt: { ...timestamp, type: ["integer", "null"] }, stateRevision: timestamp,
  } },
} };
const slots = { type: "array", minItems: 1, maxItems: 20, items: { type: "object", additionalProperties: false,
  required: ["slotId", "task"], properties: {
    slotId: string, handle: string, goal: string, criteriaIds: ids,
    task: { ...string, description: "Current outcome, context and constraints. Provide original material paths through inputs." },
    touches: strings, forbid: strings, dependsOn: strings, artifacts: strings, inputs: strings,
    readOnly: { type: "boolean" }, freshSession: { type: "boolean" },
    continuity: { type: "string", enum: ["stateful", "clean"] },
    workspace: { type: "string", enum: ["shared", "worktree", "scratch"] },
    repo: { type: "object", additionalProperties: false, required: ["source"], properties: {
      source: string, baseRef: string, branch: string, submodules: { type: "boolean" },
    } },
    engine: { type: "string", enum: ["cli", "native"] }, model: string, reasoningEffort: string,
  },
} };
const workerEnvironment = "Each slot is an independent, peer-level high-reasoning instance with a full terminal, Git and test toolchain. The kernel automatically collects Git commits, branches and changed files. Use Pass-by-Reference with slot inputs for original review text, error logs, design documents or sibling worktree source paths. Direct references give workers the complete evidence and avoid delays and distortion from secondhand summaries.";
const criteriaDescription = "Use criteria.text for a concise human outcome title and criteria.detail for optional, falsifiable technical acceptance standards.";
const v2Specs = {
  init: ["create", "Keep one standing Squad per conversation. Initialize or reuse its active Squad and Studio URL by anchorThreadId. Evolve STATE and existing slots for later waves. Use forceNew:true only for an explicit user-requested reset. " + criteriaDescription + " " + workerEnvironment,
    { anchorThreadId: uuid, anchorHostRef: ref, title: string, intent: string, state: stateSchema, workspace: { type: "string", enum: ["shared", "worktree"] }, forceNew: { type: "boolean" } }, ["anchorThreadId"]],
  state: ["roles", "Single-writer shared state update or Gate resolution. Use acceptSlots and verifyCriteria IDs for incremental acceptance with the current expectedRevision. " + criteriaDescription,
    { squadId: string, expectedRevision: revision, patch: stateSchema, resolveGate: object, ...closure }, ["squadId", "expectedRevision"]],
  dispatch: ["dispatch", "Dispatch new work asynchronously to the standing Squad. Reuse its STATE and slots between waves. Main defines What/Why, acceptance criteria and boundaries, and workers choose How. Bind the round with goal and criteriaIds. Use acceptSlots and verifyCriteria to close prior work. You can combine patch or resolveGate with expectedRevision for serial validation and dispatch. Validation rejection leaves STATE unchanged. Inspect uncertain runtime delivery before retrying. Stateful slots reuse their session by default and clean slots start fresh. " + criteriaDescription + " " + workerEnvironment,
    { squadId: string, expectedRevision: revision, patch: stateSchema, resolveGate: object, ...closure, slots }, ["squadId", "slots"]],
  status: ["list", "Read the Squad Studio snapshot silently in the background. Use show_squad_card only for a meaningful human Gate or curated technical review. Address by squadId or anchorThreadId (active Squad first, otherwise latest updated). Physical completion is not business acceptance.", { squadId: string, anchorThreadId: uuid }, []],
  integrate: ["summarize", "Merge a quiescent role worktree, accept its current round and verify bound criteria in one call; optional verifyCriteria adds criterion IDs. Reject dirty worktrees and outsideTouches. Prior task=done calls remain compatible.", { squadId: string, slotId: string, expectedRevision: revision, verifyCriteria: ids }, ["squadId", "slotId", "expectedRevision"]],
  close: ["dissolve", "Close the standing Squad only when the user explicitly requests dissolution or reset; never close between work waves. Preserve all real chats. Optionally promote stateful slots.", { squadId: string, promoteSlots: { type: "array", items: string } }, ["squadId"]],
} as const;
export const squadV2Commands = Object.fromEntries(Object.entries(v2Specs).map(([name, [method, description, properties, required]]) => [name, {
  method: `diy/squad/${method}`, description, inputSchema: { type: "object", additionalProperties: false, properties, required },
}]));
export const squadTools = Object.entries(squadV2Commands).map(([name, spec]) => ({
  name: `mycodex.squad_${name}`, description: spec.description, inputSchema: spec.inputSchema,
  annotations: { readOnlyHint: name === "status", destructiveHint: false, idempotentHint: name === "status", openWorldHint: false },
}));

export const showSquadCardTool = {
  name: "mycodex.show_squad_card", title: "展示阶段技术品鉴卡",
  description: "Explicitly present one existing Squad in this conversation when a human must decide a Gate, or a stage has technical choices, trade-offs, performance methods or risks worth reviewing. Do not call after every status check. Supply a one-sentence summary and 1-6 curated highlights in your own synthesis; avoid dumping worker audit disclaimers. Address by squadId or anchorThreadId (active first, otherwise latest updated). Read-only; does not change STATE or imply acceptance.",
  inputSchema: { type: "object", additionalProperties: false, required: [] as string[], properties: {
    anchorThreadId: uuid,
    squadId: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$" },
    summary: { type: "string", minLength: 1, maxLength: 500 },
    highlights: { type: "array", minItems: 1, maxItems: 6, items: { type: "object", additionalProperties: false, required: ["title", "body"], properties: {
      title: { type: "string", minLength: 1, maxLength: 120 }, body: { type: "string", minLength: 1, maxLength: 2400 }, kind: { type: "string", enum: ["tradeoff", "architecture", "performance", "risk"] },
    } } },
  } },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

export interface SquadAddress { squadId?: string; anchorThreadId?: string }
export function parseSquadAddress(input: Record<string, unknown>): SquadAddress {
  if (input.squadId === undefined && input.anchorThreadId === undefined ||
      input.squadId !== undefined && (typeof input.squadId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(input.squadId)) ||
      input.anchorThreadId !== undefined && (typeof input.anchorThreadId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(input.anchorThreadId))) throw new Error('Supply an exact squadId or anchorThreadId.');
  return { ...(input.squadId !== undefined ? { squadId: input.squadId as string } : {}), ...(input.anchorThreadId !== undefined ? { anchorThreadId: input.anchorThreadId as string } : {}) };
}
export function parseSquadCardInput(raw: unknown): SquadAddress & { review: SquadCardReview } {
  const object = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid squad card arguments.');
    return value as Record<string, unknown>;
  };
  const text = (value: unknown, max: number): string => {
    if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('Invalid squad card text.');
    return value.trim();
  };
  const input = object(raw);
  if (Object.keys(input).some(key => !['squadId','anchorThreadId','summary','highlights'].includes(key))) throw new Error('Invalid squad card arguments.');
  const address = parseSquadAddress(input);
  const review: SquadCardReview = {};
  if (Object.hasOwn(input, 'summary')) review.summary = text(input.summary, 500);
  if (Object.hasOwn(input, 'highlights')) {
    if (!Array.isArray(input.highlights) || input.highlights.length < 1 || input.highlights.length > 6) throw new Error('Supply 1-6 curated highlights.');
    review.highlights = input.highlights.map(value => {
      const item = object(value);
      if (Object.keys(item).some(key => !['title','body','kind'].includes(key)) || (item.kind !== undefined && (typeof item.kind !== 'string' || !['tradeoff','architecture','performance','risk'].includes(item.kind)))) throw new Error('Invalid squad card highlight.');
      return { title: text(item.title, 120), body: text(item.body, 2400), ...(item.kind !== undefined ? { kind: item.kind as NonNullable<SquadCardReview['highlights']>[number]['kind'] } : {}) };
    });
  }
  return { ...address, review };
}

const specs = {
  post: ["Append an Issue entry and wake one named worker. Supply conclusion/next action, owned file pointers and actual verification/gaps. System stamps time and member identity. Reuse requestId for reconciliation. 三等：闭环快审验收、短耗时关键路径查证、小范围定点返工，可同回合 wait。三不等：重型开发或全量构建、用户仍在主会话互动、探索或审美拍板，post 后直接交还用户。动态脱手：needs_human 立即向人汇报具体阻塞，严禁对同一人工阻塞循环 wait；常规最多 1~2 个有界窗口后转后台胶囊跟踪。", { squadId: string, authorThreadId: uuid, requestId: string, kind: { type: "string", enum: ["assign", "handoff", "review", "blocked", "note"] }, summary: { ...string, maxLength: 4000 }, next: { type: ["string", "null"] }, files: { type: "array", maxItems: 50, items: string }, verification: string, verdict: { type: "string", enum: ["approved", "changes_requested", "commented"] } }, ["squadId", "authorThreadId", "requestId", "kind", "summary", "next"]],
  wait: ["Bounded same-turn read. Pass post entry.seq as sinceSeq to avoid races; default timeout 30000ms, zero gives an immediate snapshot. Returns settled / needs_human / timeout / idle. 三等：闭环快审验收、短耗时关键路径查证、小范围定点返工，可同回合 wait。三不等：重型开发或全量构建、用户仍在主会话互动、探索或审美拍板，post 后直接交还用户。动态脱手：needs_human 立即向人汇报具体阻塞，严禁对同一人工阻塞循环 wait；常规最多 1~2 个有界窗口后转后台胶囊跟踪。", { squadId: string, sinceSeq: { type: "integer", minimum: 0 }, targetHandles: { type: "array", maxItems: 20, items: string }, timeoutMs: { type: "integer", minimum: 0, maximum: 120000 } }, ["squadId"]],
  ledger: ["Read a bounded page of the append-only ledger/ISSUE.md. Follow nextOffset until null; issuePath points to the complete materialization.", { squadId: string, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 20 } }, ["squadId"]],
  roles: ["Read or explicitly replace standing role presets. Models must come from squad_catalog.", { roles: { type: "array", items: { type: "object" } } }, []],
  resume_hops: ["Human release of paused worker-to-worker relay; resets the hop budget.", { squadId: string }, ["squadId"]],
  fallback: ["Explicitly copy the completed unreported turn's final assistant text to an honest system_fallback entry; never implies review approval.", { squadId: string, workerId: uuid, requestId: string }, ["squadId", "workerId", "requestId"]],
  promote_member: ["Reveal a worker in the main sidebar. Optionally close the squad, preserving all chats and ledger.", { squadId: string, threadId: uuid, closeSquad: { type: "boolean" } }, ["squadId", "threadId"]],
  list: ["List Squad Lite groups and connected CLI/native Codex sessions, including exact native host references.", { threadId: uuid, squadId: string }, []],
  catalog: ["List configured CLI and native Codex models for explicit worker creation; no chat is created.", {}, []],
  create: ["Explicitly establish a Squad Lite group anchored to an existing supervisor chat. Native anchors require anchorHostRef from squad_list. Does not fork.", { anchorThreadId: uuid, anchorHostRef: ref, label: string }, ["anchorThreadId", "label"]],
  add: ["Manually join an existing CLI or native Codex chat as worker. Native members require their exact hostRef.", { squadId: string, threadId: uuid, shortName: string, hostRef: ref }, ["squadId", "threadId", "shortName"]],
  create_member: ["Explicitly create a new worker chat in a selected CLI or native Codex model, then join it to this squad. Reuse requestId after an uncertain response; never invent another request to retry it.", { squadId: string, shortName: string, kind: { type: "string", enum: ["cli", "native"] }, model: string, reasoningEffort: string, cwd: string, hostRef: ref, requestId: uuid }, ["squadId", "shortName", "kind", "requestId"]],
  brief: ["Push a briefing string to one exact worker, across CLI/native runtimes. This explicitly starts a turn. Reuse requestId when reconciling an uncertain response.", { squadId: string, workerId: uuid, squadGoal: string, task: string, exclusions: { type: "array", items: string }, requestId: uuid }, ["squadId", "workerId", "squadGoal", "task", "requestId"]],
  report: ["Write this worker's result to the squad's local result file. Include dispatchId from the received brief so late results cannot complete another task. Reporting is not acceptance of the deliverable.", { squadId: string, workerId: uuid, dispatchId: uuid, summary: string, status: { type: "string", enum: ["completed", "failed"] }, completedAt: { type: "integer", minimum: 0 }, artifactPath: string, error: string }, ["squadId", "workerId", "summary", "status"]],
  summarize: ["Explicitly send current file results back to the bound supervisor, whether CLI or native Codex. Reuse requestId after uncertainty.", { squadId: string, requestId: uuid, closeSquad: { type: "boolean" }, draftOnly: { type: "boolean" } }, ["squadId", "requestId"]],
  remove: ["Remove a worker from the group and clean its relay files; preserve the chat.", { squadId: string, threadId: uuid }, ["squadId", "threadId"]],
  dissolve: ["Close this squad; preserve all chats, history and ledger.", { squadId: string }, ["squadId"]],
  rebind: ["Explicitly reconnect a native member after runtime replacement, verifying the same host, account and thread. Does not replay pending actions.", { squadId: string, threadId: uuid, hostRef: ref }, ["squadId", "threadId", "hostRef"]],
} as const;
export const legacySquadCommands = Object.fromEntries(Object.entries(specs).map(([name, [description, properties, required]]) => [name, {
  method: `diy/squad/${name === "brief" ? "dispatch" : name}`, description,
  inputSchema: { type: "object", additionalProperties: false, properties, required },
}]));

export const squadCommands = legacySquadCommands;
