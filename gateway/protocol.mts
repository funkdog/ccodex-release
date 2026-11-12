import "../tools/typescript-runtime.mjs";
import type { ThreadStore } from "./state.mjs";
import type { EngineAdapter, GatewayModel, SelectedModel, ApprovalMode, StoredThread, AppParams, GatewayParams, GatewayConnection, Turn, ToolItem, Attachment, UserInput } from "./contracts.mjs";
import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { cliInput } from "./input.mjs";
import { MediaStore, extractToolOutput } from "./media.mjs";
import { ApprovalPreferences } from "./approval-preferences.mjs";
import type { EngineImage } from "./contracts.mjs";

export const protocolVersion = "0.165.0-alpha.1.2";
// Built-in pin section exported by the installed app-server/sidebar contract.
export const pinnedSectionId = "01984de2-8f74-7c91-a3b2-5c5e937cf318";
const invalid = (message: string) => Object.assign(new Error(message), { code: -32602 });
const now = () => Math.floor(Date.now() / 1000);
// Older callers may omit the native default, but Desktop reads it directly.
const publicInput = (input: UserInput[]) => input.map(item => item.type === "text"
  ? { ...item, text_elements: item.text_elements ?? [] } : item);
const publicTurn = (turn: Turn) => {
  const { nativeStartEventId, ...value } = structuredClone(turn);
  for (const item of value.items) if (item.type === "userMessage") item.content = publicInput(item.content);
  return value;
};
const publicThread = (thread: StoredThread) => {
  const { schemaVersion, engineId, engineAdapter, nativeSessionId, archived, sectionOrder, ...publicValue } = structuredClone(thread);
  // Populate the pinned Desktop contract even for older gateway documents.
  return { environments: [], extra: null, forkedFromId: null, parentThreadId: null,
    section: null, sectionEnteredAt: null, historyMode: "legacy", reasoningEffort: null, cliApprovalMode: "ask",
    recencyAt: thread.updatedAt, path: null, originator: "mycodex", canAcceptDirectInput: true,
    threadSource: null, agentNickname: null, agentRole: null, gitInfo: null, daybreakEnabled: null,
    ...publicValue, turns: thread.turns.map(publicTurn), name: thread.name || thread.preview || `CLI · ${thread.model}` };
};
const publicResult = (thread: StoredThread) => ({ thread: publicThread(thread), model: thread.model,
  modelProvider: thread.engineId, cwd: thread.cwd, approvalPolicy: thread.approvalPolicy ?? "on-request",
  approvalsReviewer: "user", sandbox: { type: "dangerFullAccess" },
  reasoningEffort: thread.reasoningEffort ?? null });

export class GatewayProtocol {
  store: ThreadStore; engines: Map<string, EngineAdapter>; defaultEngine: string | null; home: string;
  allowEmptyCatalog: boolean;
  notify: (method: string, params: unknown) => void;
  active: Map<string, { controller: AbortController; turnId: string; done?: Promise<void> }>;
  catalogPromise: Promise<GatewayModel[]> | null; catalogWarnings: string[] = [];
  operations = new Map<string, "archive" | "delete" | "fork">();
  deletions = new Map<string, Promise<void>>();
  pendingMaintenance = new Set<Promise<unknown>>();
  closing = false;
  media: MediaStore;
  approvalPreferences: ApprovalPreferences;
  constructor({ store, engines, defaultEngine, home, notify, allowEmptyCatalog = false }: { store: ThreadStore; engines: Map<string, EngineAdapter>; defaultEngine: string | null; home: string; notify: (method: string, params: unknown) => void; allowEmptyCatalog?: boolean }) {
    this.store = store; this.engines = engines; this.defaultEngine = defaultEngine; this.home = home; this.notify = notify;
    this.active = new Map();
    this.media = new MediaStore(home);
    this.approvalPreferences = new ApprovalPreferences(home);
    this.catalogPromise = null;
    this.allowEmptyCatalog = allowEmptyCatalog;
  }
  async models() {
    if (!this.catalogPromise) this.catalogPromise = (async () => {
      const models: GatewayModel[] = [];
      const errors: string[] = [];
      this.catalogWarnings = errors;
      for (const [engineId, engine] of this.engines) {
        try {
          for (const model of await engine.models()) {
            if (typeof model.id !== "string" || !model.id) throw new Error("CLI returned an invalid model ID.");
            const id = `${engineId}/${model.id}`;
            const efforts = [...new Set((model.supportedReasoningEfforts || [])
              .filter(value => typeof value === "string" && /^[a-z][a-z0-9-]{0,20}$/.test(value)))];
            const defaultEffort = model.defaultReasoningEffort != null && efforts.includes(model.defaultReasoningEffort) ? model.defaultReasoningEffort
              : efforts.includes("medium") ? "medium" : efforts[0] ?? "none";
            models.push({ id, model: id, displayName: `${engine.displayName || engineId} · ${model.name || model.id}`,
              description: model.description || `Native ${engineId} CLI`, hidden: false,
              isDefault: engineId === this.defaultEngine && !models.some(item => item.isDefault),
              inputModalities: model.inputModalities ?? (engine.supportsImages && model.capabilities?.supports?.vision ? ["text", "image"] : ["text"]),
              nativeCopilot: engine.nativeProvider === true && engine.adapter !== "codex-gemini",
              ...(engine.providerId ? { nativeProvider: engine.providerId } : {}),
              supportedReasoningEfforts: (efforts.length ? efforts : ["none"])
                .map(reasoningEffort => ({ reasoningEffort, description: reasoningEffort })), defaultReasoningEffort: defaultEffort,
              cliApprovalModes: engine.approvalModes ?? ["ask"], canSwitchModel: engine.supportsModelSwitch === true });
          }
        } catch (cause) { const error = cause instanceof Error ? cause : new Error(String(cause)); errors.push(`${engineId}: ${error.message}`); }
      }
      if (!models.length && !this.allowEmptyCatalog) throw new Error(`No CLI models are available. ${errors.join("; ")}`);
      return models;
    })().catch(error => { this.catalogPromise = null; throw error; });
    return (await this.catalogPromise).map(model => {
      const engineId = model.id.slice(0, model.id.indexOf("/")), engine = this.engines.get(engineId)!;
      return engine.nativeProvider ? model : { ...model,
        defaultCliApprovalMode: this.approvalPreferences.get(engineId, engine.adapter ?? "test", model.cliApprovalModes, engine.initialApprovalMode) };
    });
  }
  async selectModel(model?: string | null) {
    return this.selectAvailableModel(await this.models(), model);
  }
  selectAvailableModel(models: GatewayModel[], model?: string | null): SelectedModel {
    const selected = model == null ? models.find(item => item.isDefault) : models.find(item => item.id === model);
    if (!selected) throw invalid("Unknown or unavailable engine/model; no fallback was started.");
    const slash = selected.id.indexOf("/");
    return { model: selected.id, engineId: selected.id.slice(0, slash), nativeModel: selected.id.slice(slash + 1),
      efforts: selected.supportedReasoningEfforts.map(value => value.reasoningEffort),
      defaultEffort: selected.defaultReasoningEffort, approvalModes: selected.cliApprovalModes,
      inputModalities: selected.inputModalities };
  }
  effort(value: string | null | undefined, selected: SelectedModel, previous?: string | null) {
    const effort = value ?? previous ?? selected.defaultEffort;
    if (!selected.efforts.includes(effort)) throw invalid("当前 CLI 模型不支持该推理强度，请选择模型目录中的选项。");
    return effort;
  }
  approvalMode(value: ApprovalMode | undefined, selected: SelectedModel) {
    const mode = value ?? "ask";
    if (!selected.approvalModes.includes(mode)) throw invalid("该 CLI 不支持所选审批策略。");
    return mode;
  }
  saveExecution(thread: StoredThread) {
    this.store.saveExecution(thread);
  }
  async settle(threadId: string) {
    const active = this.active.get(threadId);
    if (!active) return;
    active.controller.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([active.done, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(invalid("CLI cancellation has not settled; the chat was preserved. Retry after it stops.")), 30000);
    })]); } finally { clearTimeout(timer); }
  }
  async deleteThread(threadId: string) {
    const pending = this.deletions.get(threadId);
    if (pending) return pending;
    if (this.operations.has(threadId)) throw invalid("Wait for the current chat operation to finish.");
    this.operations.set(threadId, "delete");
    const work = (async () => {
      await this.settle(threadId);
      let deleted = this.store.deleted.get(threadId);
      if (!deleted) {
        const latest = this.store.get(threadId), engine = this.engines.get(latest.engineId);
        const sameAdapter = engine && (engine.adapter ?? "test") === latest.engineAdapter;
        const cleanup = !latest.nativeSessionId ? "complete" : sameAdapter && !engine.deleteSession ? "unsupported" : "pending";
        deleted = this.store.tombstone(latest, cleanup);
        this.notify("thread/deleted", { threadId });
      }
      this.media.removeThread(threadId);
      if (deleted.cleanup !== "pending") return;
      const engine = this.engines.get(deleted.engineId);
      if (!engine?.deleteSession || (engine.adapter ?? "test") !== deleted.engineAdapter) throw invalid("The chat is deleted locally; its CLI archive cleanup is pending until the original adapter is available.");
      try { await engine.deleteSession({ nativeSessionId: deleted.nativeSessionId!, cwd: deleted.cwd! }); }
      catch { throw invalid("The chat is deleted locally, but CLI archive cleanup was not confirmed. Retry deletion; the chat will not reappear."); }
      this.store.saveTombstone({ schemaVersion: 1, id: deleted.id, engineId: deleted.engineId, engineAdapter: deleted.engineAdapter,
        deleted: true, deletedAt: deleted.deletedAt, cleanup: "complete" });
    })();
    this.deletions.set(threadId, work);
    this.pendingMaintenance.add(work);
    try { await work; } finally { this.deletions.delete(threadId); this.operations.delete(threadId); this.pendingMaintenance.delete(work); }
  }
  async forkThread(params: GatewayParams) {
    if (this.operations.has(params.threadId)) throw invalid("Wait for the current chat operation to finish.");
    if (this.active.has(params.threadId)) throw invalid("Stop the current turn before forking this CLI chat.");
    this.operations.set(params.threadId, "fork");
    const work = (async () => {
      this.validatePolicy(params);
      const source = this.store.get(params.threadId), engine = this.engines.get(source.engineId);
      if (!engine || (engine.adapter ?? "test") !== source.engineAdapter) throw invalid("The original CLI adapter is unavailable.");
      for (const field of ["path", "baseInstructions", "developerInstructions", "serviceTier", "ephemeral", "attachToSource", "deferGoalContinuation", "experimentalPredictionMode", "experimentalDisablePredictionMcp"])
        if (params[field]) throw invalid(`CLI forks do not support ${field}; no branch was created.`);
      if (params.cwd != null && params.cwd !== source.cwd) throw invalid("A CLI fork preserves the existing workspace; worktree forks are unsupported.");
      this.validateWorkspace(params, source.cwd);
      if (params.lastTurnId != null && params.beforeTurnId != null) throw invalid("Choose either lastTurnId or beforeTurnId.");
      let count = source.turns.length;
      const boundaryId = params.lastTurnId ?? params.beforeTurnId;
      if (boundaryId != null) {
        const index = source.turns.findIndex(turn => turn.id === boundaryId);
        if (index < 0 || source.turns[index].status === "inProgress") throw invalid("Unknown or unfinished CLI fork turn.");
        count = index + (params.lastTurnId != null ? 1 : 0);
      }
      const beforeEventId = source.turns[count]?.nativeStartEventId;
      if (count < source.turns.length && (!beforeEventId || !engine.supportsForkBoundary))
        throw invalid("This historical fork point has no verified CLI event boundary. Fork from the latest completed turn instead.");
      if (source.nativeSessionId && !engine.forkSession) throw invalid("This CLI runtime cannot clone independent context; no display-only branch or substitute session was created.");
      if (!source.nativeSessionId && source.turns.length) throw invalid("The original CLI context is unavailable; no substitute session was created.");
      const selected = await this.selectModel(params.model ?? source.model);
      if (selected.engineId !== source.engineId) throw invalid("A fork must retain its source CLI engine.");
      if (selected.model !== source.model && !engine.supportsModelSwitch) throw invalid("This CLI fork cannot change its source model.");
      if (params.approvalPolicy != null && params.approvalPolicy !== source.approvalPolicy)
        throw invalid("CLI forks inherit the source approval policy. Change the branch settings explicitly after forking.");
      if (params.config != null && (typeof params.config !== "object" || Array.isArray(params.config))) throw invalid("Invalid CLI fork config.");
      if (params.config && Object.keys(params.config).some(key => key !== "model_reasoning_effort")) throw invalid("This CLI fork config override is unsupported.");
      const effort = params.config?.model_reasoning_effort;
      if (effort != null && typeof effort !== "string") throw invalid("Invalid fork reasoning effort.");
      const reasoningEffort = this.effort(params.effort ?? effort as string | null | undefined, selected, source.reasoningEffort);
      const branch: StoredThread = { ...structuredClone(source), id: randomUUID(), sessionId: undefined, nativeSessionId: null,
        forkedFromId: source.id, turns: structuredClone(source.turns.slice(0, count)), createdAt: now(), updatedAt: now(), archived: false,
        status: { type: "idle" }, sectionId: null, section: null, sectionEnteredAt: null, sectionOrder: undefined,
        model: selected.model, reasoningEffort, approvalPolicy: params.approvalPolicy ?? source.approvalPolicy };
      branch.sessionId = branch.id;
      let cloned: string | null = null;
      try {
        if (source.nativeSessionId) {
          cloned = await engine.forkSession!({ nativeSessionId: source.nativeSessionId, cwd: source.cwd, beforeEventId });
          if (typeof cloned !== "string" || !cloned || cloned === source.nativeSessionId) { cloned = null; throw invalid("The CLI did not return an independent branch identity."); }
          branch.nativeSessionId = cloned;
        }
        if (this.closing) throw invalid("Gateway is closing; no branch was committed.");
        for (const turn of branch.turns) for (let i = 0; i < turn.items.length; i++) {
          const item = turn.items[i]; if (item.type === "imageGeneration") turn.items[i] = this.media.save(branch.id, item.id, { kind: "file", path: item.savedPath });
        }
        this.store.save(branch);
      } catch (error) {
        this.media.removeThread(branch.id);
        if (cloned) {
          try { await engine.deleteSession?.({ nativeSessionId: cloned, cwd: source.cwd }); }
          catch { this.store.tombstone(branch, "pending"); }
        }
        throw error;
      }
      this.notify("thread/started", { thread: publicThread(branch) });
      const result = publicResult(branch);
      if (params.excludeTurns) result.thread.turns = [];
      return result;
    })();
    this.pendingMaintenance.add(work);
    try { return await work; } finally { this.operations.delete(params.threadId); this.pendingMaintenance.delete(work); }
  }
  validatePolicy(params: GatewayParams) {
    // Desktop wraps its ordinary send in a default collaboration envelope.
    // Unwrap only the known default form; never treat plan mode as executable.
    const collaboration = params.collaborationMode;
    if (collaboration != null) {
      const settings = collaboration.settings;
      if (collaboration.mode !== "default" || !settings || typeof settings !== "object" ||
          Object.keys(settings).some(key => !["model", "reasoning_effort", "developer_instructions"].includes(key)) ||
          settings.developer_instructions != null) throw invalid("Gateway does not support this Codex collaboration mode.");
      if (settings.model != null && params.model != null && settings.model !== params.model) throw invalid("Conflicting model selections.");
      params.model ??= settings.model;
      params.effort ??= settings.reasoning_effort;
    }
    for (const name of ["outputSchema"]) {
      if (params[name] != null) throw invalid(`Gateway does not support the Codex ${name} override.`);
    }
    // Desktop now sends a named profile instead of sandboxPolicy. Only its
    // unsandboxed builtin is representable by these CLI adapters.
    if (params.permissions != null && (params.permissions !== ":danger-full-access" || params.sandboxPolicy != null || params.sandbox != null))
      throw invalid("CLI 会话只支持「完全访问」权限档位；其他 Codex 沙箱或混合权限参数无法由 CLI 保证。");
    if (params.runtimeWorkspaceRoots != null && (!Array.isArray(params.runtimeWorkspaceRoots) ||
        params.runtimeWorkspaceRoots.some(root => typeof root !== "string" || !path.isAbsolute(root))))
      throw invalid("宿主工作区目录列表无效，请使用绝对目录路径。");
    // The pinned native schema marks this field deprecated and ignored. Desktop
    // still sends its old ordinary-send default. This is not an engine policy.
    if (params.multiAgentMode != null && params.multiAgentMode !== "explicitRequestOnly") throw invalid("Gateway does not support this Codex multiAgentMode override.");
    if (params.approvalsReviewer != null && params.approvalsReviewer !== "user") throw invalid("CLI permissions must be reviewed by the user.");
    if (params.approvalPolicy != null && !["on-request", "untrusted", "never"].includes(params.approvalPolicy)) throw invalid("Unsupported host approval policy; use CLI approval controls for CLI tool permissions.");
    if (params.sandbox != null && params.sandbox !== "danger-full-access") throw invalid("This gateway has no Codex OS sandbox. Use the CLI permission flow; sandbox emulation is unsupported.");
    if (params.sandboxPolicy != null && params.sandboxPolicy.type !== "dangerFullAccess") throw invalid("Codex sandbox policies cannot be enforced by this CLI adapter.");
    if (params.effort != null && typeof params.effort !== "string") throw invalid("Invalid reasoning effort.");
  }
  validateWorkspace(params: GatewayParams, cwd: string) {
    if (params.runtimeWorkspaceRoots == null || params.runtimeWorkspaceRoots.length === 0) return;
    // The native host includes other attached projects in this context list.
    // It is not a CLI cwd override or an OS sandbox. At least one available
    // root must contain the immutable cwd; unrelated hints grant no policy.
    const canonicalCwd = fs.realpathSync(cwd);
    const containsCwd = params.runtimeWorkspaceRoots.some(root => {
      let canonicalRoot;
      try { canonicalRoot = fs.realpathSync(root); }
      catch (cause) {
        if (["ENOENT", "ENOTDIR"].includes((cause as NodeJS.ErrnoException).code ?? "")) return false;
        throw cause;
      }
      const relative = path.relative(canonicalRoot, canonicalCwd);
      return !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
    });
    if (!containsCwd)
      throw invalid("CLI 会话的工作区必须包含创建时的目录。");
  }
  page<T extends { id: string } | string>(items: T[], params: Pick<AppParams, "limit" | "cursor">) {
    const limit = params.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw invalid("Invalid page limit.");
    const id = (item: T) => typeof item === "string" ? item : item.id;
    let start = 0;
    if (params.cursor != null) {
      start = items.findIndex(item => id(item) === params.cursor) + 1;
      if (!start) throw invalid("Unknown pagination cursor.");
    }
    const data = items.slice(start, start + limit);
    return { data, nextCursor: start + limit < items.length ? id(data.at(-1)!) : null };
  }
  async handle(method: string, params: GatewayParams, connection: GatewayConnection): Promise<unknown> {
    if (this.closing) throw invalid("Gateway is closing; no new work was accepted.");
    if (this.operations.get(params.threadId) === "delete" && method !== "thread/delete" &&
        !["thread/read", "thread/turns/list", "thread/items/list"].includes(method)) throw invalid("Chat deletion is in progress; no new work was accepted.");
    if (method === "initialize") return { userAgent: "ccodex-gateway/0.1", platformFamily: "unix",
      platformOs: process.platform === "darwin" ? "macos" : process.platform, codexHome: this.home };
    if (method === "getAuthStatus") return { authMethod: null, authToken: null, requiresOpenaiAuth: false };
    if (method === "account/read") return { account: null, requiresOpenaiAuth: false };
    if (method === "configRequirements/read") return { requirements: null, supportsIndependentSpeedModes: false };
    if (method === "config/read") return { config: { model: (await this.models()).find(model => model.isDefault)?.model, model_provider: this.defaultEngine, model_reasoning_effort: "none",
      approval_policy: "on-request", sandbox_mode: "danger-full-access", analytics: { enabled: false }, features: {} }, origins: {}, layers: [] };
    if (method === "gateway/models/refresh") { this.catalogPromise = null; await this.models(); return { warnings: this.catalogWarnings }; }
    if (method === "gateway/approval/default/set") {
      if (Object.keys(params).some(key => !["model", "cliApprovalMode"].includes(key)) || params.cliApprovalMode == null || typeof params.model !== "string")
        throw invalid("Choose a CLI model and an explicit approval preference.");
      const selected = await this.selectModel(params.model), engine = this.engines.get(selected.engineId)!;
      if (engine.nativeProvider) throw invalid("Native Codex approval settings are separate from CLI preferences.");
      const mode = this.approvalMode(params.cliApprovalMode, selected);
      this.approvalPreferences.set(selected.engineId, engine.adapter ?? "test", mode);
      return { cliApprovalMode: mode };
    }
    if (method === "model/list") return { ...this.page(await this.models(), params), warnings: this.catalogWarnings };
    if (method === "thread/start") {
      this.validatePolicy(params);
      if (params.ephemeral === true || params.forkFrom != null) throw invalid("Ephemeral and forked sessions are not yet supported.");
      const selected = await this.selectModel(params.model);
      if (this.engines.get(selected.engineId)!.nativeProvider) throw invalid("Codex + Copilot must be created through the native protocol router.");
      const cwd = params.cwd;
      if (typeof cwd !== "string" || !path.isAbsolute(cwd) || !fs.statSync(cwd).isDirectory()) throw invalid("An existing absolute workspace directory is required.");
      this.validateWorkspace(params, cwd);
      const thread: StoredThread = { schemaVersion: 1, id: randomUUID(), engineId: selected.engineId,
        engineAdapter: this.engines.get(selected.engineId)!.adapter ?? "test", nativeSessionId: null, model: selected.model, modelProvider: selected.engineId,
        cliVersion: "ccodex-gateway/0.1", createdAt: now(), updatedAt: now(), cwd,
        ephemeral: false, preview: "", name: null, projectId: null, source: "appServer", threadSource: "user",
        status: { type: "idle" }, approvalPolicy: params.approvalPolicy ?? "on-request", archived: false, turns: [] };
      thread.reasoningEffort = this.effort(params.effort, selected);
      thread.cliApprovalMode = this.approvalMode(params.cliApprovalMode ?? this.approvalPreferences.get(selected.engineId,
        this.engines.get(selected.engineId)!.adapter ?? "test", selected.approvalModes, this.engines.get(selected.engineId)!.initialApprovalMode), selected);
      thread.sessionId = thread.id;
      this.store.save(thread);
      setImmediate(() => this.notify("thread/started", { thread: publicThread(thread) }));
      return publicResult(thread);
    }
    if (method === "thread/list" || method === "thread/search") {
      if (method === "thread/search" && (typeof params.searchTerm !== "string" || params.searchTerm.length > 1024)) throw invalid("A bounded title search term is required.");
      if (params.originators?.length) throw invalid("Local gateway does not support originator filtering.");
      // Desktop's native pin service lists a section by its stored position.
      // This installed sort variant belongs to thread/list, not thread/search.
      if (params.sortKey != null && !["created_at", "updated_at", "recency_at"].includes(params.sortKey) &&
          !(method === "thread/list" && params.sortKey === "section_position")) throw invalid("Invalid thread sort key.");
      if (params.sortDirection != null && !["asc", "desc"].includes(params.sortDirection)) throw invalid("Invalid thread sort direction.");
      if (params.excludedThreadIds != null && (!Array.isArray(params.excludedThreadIds) || params.excludedThreadIds.length > 100 || params.excludedThreadIds.some(id => typeof id !== "string"))) throw invalid("Invalid thread exclusions.");
      if (params.parentThreadId != null || params.ancestorThreadId != null || params.attachedToThreadId != null) return { data: [], nextCursor: null };
      const cwds = params.cwd == null ? [] : Array.isArray(params.cwd) ? params.cwd : [params.cwd];
      const key = ["updated_at", "recency_at"].includes(params.sortKey ?? "") ? "updatedAt" : "createdAt";
      const direction = params.sortDirection === "asc" ? 1 : -1;
      const threads = this.store.all().filter(thread => thread.archived === Boolean(params.archived))
        .filter(thread => !cwds.length || cwds.includes(thread.cwd))
        .filter(thread => !params.modelProviders?.length || params.modelProviders.includes(thread.engineId))
        .filter(thread => !params.sourceKinds?.length || params.sourceKinds.includes(thread.source))
        .filter(thread => !params.excludedThreadIds?.includes(thread.id))
        .filter(thread => !Object.hasOwn(params, "projectId") || params.projectId === thread.projectId)
        .filter(thread => !Object.hasOwn(params, "sectionId") || params.sectionId === (thread.sectionId ?? null))
        .filter(thread => !params.searchTerm || (thread.name || thread.preview).toLowerCase().includes(params.searchTerm.toLowerCase()))
        .sort((a, b) => params.sectionId != null ? (a.sectionOrder ?? 0) - (b.sectionOrder ?? 0) || a.id.localeCompare(b.id)
          : direction * (a[key] - b[key] || a.id.localeCompare(b.id)));
      const page = this.page(threads.map(thread => ({ ...publicThread(thread), turns: [] })), params);
      return method === "thread/search" ? { ...page, backwardsCursor: null,
        data: page.data.map(thread => ({ thread, snippet: thread.name.slice(0, 400) })) } : page;
    }
    if (method === "thread/loaded/list") return this.page([...this.active.keys()].sort(), params);
    if (method === "thread/read") return { thread: publicThread(this.store.get(params.threadId)) };
    if (method === "thread/metadata/update") {
      const thread = this.store.get(params.threadId);
      if (Object.keys(params).some(key => !["threadId", "projectId", "daybreakEnabled"].includes(key)) || params.daybreakEnabled === true)
        throw invalid("Unsupported CLI thread metadata update.");
      if (params.projectId != null && (typeof params.projectId !== "string" || params.projectId.length > 256)) throw invalid("Invalid project identity.");
      if (Object.hasOwn(params, "projectId")) thread.projectId = params.projectId || null;
      if (params.daybreakEnabled === false) thread.daybreakEnabled = false;
      this.store.save(thread);
      this.notify("thread/project/updated", { threadId: thread.id, projectId: thread.projectId });
      return { thread: publicThread(thread) };
    }
    if (method === "thread/delete") { await this.deleteThread(params.threadId); return {}; }
    if (method === "thread/fork") return this.forkThread(params);
    if (method === "thread/section/move") {
      const thread = this.store.get(params.threadId);
      if (params.sectionId !== null && params.sectionId !== pinnedSectionId) throw invalid("CLI chats currently support the native pinned section only; custom section creation is managed by the native app-server.");
      if (params.beforeThreadId === thread.id) throw invalid("A chat cannot be ordered before itself.");
      const members = this.store.all().filter(t => t.id !== thread.id && t.sectionId === params.sectionId)
        .sort((a,b) => (a.sectionOrder ?? 0) - (b.sectionOrder ?? 0));
      const before = params.beforeThreadId == null ? members.length : members.findIndex(t => t.id === params.beforeThreadId);
      if (before < 0) throw invalid("CLI pin ordering requires a known CLI chat in the same section.");
      const next = members[before]?.sectionOrder ?? (members.at(-1)?.sectionOrder ?? 0) + 2;
      const previous = members[before - 1]?.sectionOrder ?? next - 2;
      thread.sectionOrder = (previous + next) / 2;
      thread.sectionId = params.sectionId;
      thread.section = params.sectionId ? { id: params.sectionId, name: "Pinned" } : null;
      thread.sectionEnteredAt = params.sectionId ? now() : null;
      this.store.save(thread);
      return {};
    }
    if (method === "thread/settings/update") {
      const thread = this.store.get(params.threadId);
      if (Object.keys(params).some(key => !["threadId", "disabledPluginIds", "model", "reasoningEffort", "cliApprovalMode"].includes(key)) ||
          (params.disabledPluginIds != null && (!Array.isArray(params.disabledPluginIds) || params.disabledPluginIds.length)))
        throw invalid("CLI plugins/settings are configured by the CLI; this native settings override is unsupported.");
      if (Object.hasOwn(params, "model") || Object.hasOwn(params, "reasoningEffort") || Object.hasOwn(params, "cliApprovalMode")) {
        if (Object.hasOwn(params, "model") && (typeof params.model !== "string" || !params.model)) throw invalid("Choose an available CLI model.");
        const catalog = await this.models();
        // Validate and atomically save against the newest intent after discovery.
        // No await below can interleave another connection's settings update.
        const latest = this.store.get(thread.id);
        const engine = this.engines.get(latest.engineId);
        if (!engine || (engine.adapter ?? "test") !== latest.engineAdapter) throw invalid("The stored CLI engine is no longer configured or its adapter changed.");
        const selected = this.selectAvailableModel(catalog, params.model ?? latest.model);
        if (selected.engineId !== latest.engineId) throw invalid("A thread cannot change CLI engines. Start a new thread.");
        const changingModel = selected.model !== latest.model;
        if (changingModel && !engine.supportsModelSwitch) throw invalid("This CLI adapter does not support switching an existing session's model.");
        if (Object.hasOwn(params, "reasoningEffort")) latest.reasoningEffort = this.effort(params.reasoningEffort, selected);
        else if (changingModel) {
          // A sole "none" is the gateway's sentinel for a CLI with no effort
          // override, not a user's explicit no-reasoning preference.
          const previous = catalog.find(model => model.id === latest.model);
          const explicitEffort = latest.reasoningEffort !== "none" || (previous?.supportedReasoningEfforts.length ?? 0) > 1;
          latest.reasoningEffort = explicitEffort && selected.efforts.includes(latest.reasoningEffort ?? "")
            ? latest.reasoningEffort : selected.defaultEffort;
        }
        const approval = this.approvalMode(Object.hasOwn(params, "cliApprovalMode") ? params.cliApprovalMode : latest.cliApprovalMode, selected);
        if (Object.hasOwn(params, "cliApprovalMode")) latest.cliApprovalMode = approval;
        latest.model = selected.model;
        const previous = this.store.get(latest.id);
        this.store.save(latest);
        try {
          if (Object.hasOwn(params, "cliApprovalMode")) this.approvalPreferences.set(latest.engineId, engine.adapter ?? "test", approval);
        } catch (error) { this.store.save(previous); throw error; }
        this.notify("thread/settings/updated", { thread: publicThread(latest) });
        return { thread: publicThread(latest) };
      }
      return {}; // Native first-send clears its own disabled-plugin list.
    }
    if (["thread/attachment/list", "thread/queue/list", "thread/goal/get"].includes(method)) {
      this.store.get(params.threadId); // Empty supported reads, never invented attachments or goals.
      return method === "thread/goal/get" ? { goal: null } : { data: [], nextCursor: null };
    }
    if (method === "thread/resume") {
      const thread = this.store.get(params.threadId);
      this.validatePolicy(params);
      this.validateWorkspace(params, thread.cwd);
      if (params.model != null && params.model !== thread.model) throw invalid("Resume preserves the stored engine/model.");
      if (!this.engines.has(thread.engineId) || (this.engines.get(thread.engineId)!.adapter ?? "test") !== thread.engineAdapter) throw invalid("The stored CLI engine is no longer configured or its adapter changed.");
      return publicResult(thread);
    }
    if (method === "thread/turns/list" || method === "thread/items/list") {
      const thread = this.store.get(params.threadId);
      const turnsOnly = method === "thread/turns/list";
      if (params.sortDirection != null && !["asc", "desc"].includes(params.sortDirection)) throw invalid("Invalid history sort direction.");
      if (!turnsOnly && params.turnId != null && !thread.turns.some(turn => turn.id === params.turnId)) throw invalid("Unknown CLI turn.");
      const turns = !turnsOnly && params.turnId != null ? thread.turns.filter(turn => turn.id === params.turnId) : thread.turns;
      let cursor = params.cursor;
      if (cursor != null && typeof cursor !== "string") {
        if (turnsOnly || !params.turnId || cursor.type !== "item" || typeof cursor.itemId !== "string" ||
            Object.keys(cursor).some(key => !["type", "itemId"].includes(key))) throw invalid("Invalid history item anchor.");
        cursor = cursor.itemId;
      }
      if (turnsOnly) {
        const items = [...turns];
        if ((params.sortDirection ?? "desc") === "desc") items.reverse();
        const page = this.page(items, { ...params, cursor });
        const itemsView = params.itemsView ?? "summary";
        if (!["notLoaded", "summary", "full"].includes(itemsView)) throw invalid("Invalid turn items view.");
        return { ...page, data: page.data.map(turn => {
          const value = publicTurn(turn);
          return { ...value, itemsView, items: itemsView === "notLoaded" ? [] :
            itemsView === "full" ? value.items : value.items.filter(item => ["userMessage", "agentMessage", "imageGeneration"].includes(item.type)) };
        }), backwardsCursor: null };
      }
      const items = turns.map(publicTurn).flatMap(turn => turn.items.map(item => ({ id: item.id, item, turnId: turn.id })));
      if ((params.sortDirection ?? "asc") === "desc") items.reverse();
      const page = this.page(items, { ...params, cursor });
      return { ...page, data: page.data.map(({ id, ...entry }) => entry), backwardsCursor: null };
    }
    if (["thread/archive", "thread/unarchive", "thread/name/set"].includes(method)) {
      if (this.operations.has(params.threadId)) throw invalid("Wait for the current chat operation to finish.");
      if (method === "thread/archive") {
        this.operations.set(params.threadId, "archive");
        const work = (async () => { await this.settle(params.threadId);
          const current = this.store.get(params.threadId); current.archived = true; this.store.save(current);
          this.notify("thread/archived", { threadId: current.id }); return {};
        })();
        this.pendingMaintenance.add(work);
        try { return await work; } finally { this.operations.delete(params.threadId); this.pendingMaintenance.delete(work); }
      }
      const thread = this.store.get(params.threadId);
      if (method === "thread/name/set") {
        if (typeof params.name !== "string" || params.name.length > 256) throw invalid("Invalid thread name.");
        thread.name = params.name;
      } else thread.archived = method === "thread/archive";
      this.store.save(thread);
      this.notify(method === "thread/name/set" ? "thread/name/updated" : method === "thread/archive" ? "thread/archived" : "thread/unarchived",
        { threadId: thread.id, ...(method === "thread/name/set" ? { threadName: thread.name } : {}) });
      return method === "thread/unarchive" ? { thread: publicThread(thread) } : {};
    }
    if (method === "turn/start" || method === "turn/addUserMessage") {
      const result = await this.startTurn(params, connection);
      return method === "turn/addUserMessage" ? { ...result, admissionOutcome: "started" } : result;
    }
    if (method === "turn/interrupt") {
      const active = this.active.get(params.threadId);
      if (!active || active.turnId !== params.turnId) throw invalid("No matching active turn.");
      active.controller.abort();
      // Completion is emitted only once the CLI run has actually settled.
      return {};
    }
    if (["skills/list", "collaborationMode/list"].includes(method)) return { data: [] };
    if (["mcpServerStatus/list", "experimentalFeature/list", "permissionProfile/list"].includes(method)) return { data: [], nextCursor: null };
    if (method === "plugin/list") return { marketplaces: [], marketplaceLoadErrors: [], featuredPluginIds: [] };
    throw Object.assign(new Error(`Unsupported gateway method: ${method}`), { code: -32601 });
  }
  async startTurn(params: GatewayParams, connection: GatewayConnection) {
    this.validatePolicy(params);
    let thread = this.store.get(params.threadId);
    if (this.operations.has(thread.id)) throw invalid("A chat operation is pending; no new turn was started.");
    this.validateWorkspace(params, thread.cwd);
    if (!this.engines.has(thread.engineId) || (this.engines.get(thread.engineId)!.adapter ?? "test") !== thread.engineAdapter) throw invalid("The stored CLI engine is no longer configured or its adapter changed.");
    if (thread.archived) throw invalid("Unarchive the thread before sending a turn.");
    if (this.active.has(thread.id)) throw invalid("This thread already has an active turn.");
    const selected = await this.selectModel(params.model ?? thread.model);
    const { prompt, attachments } = cliInput(params.input, {
      supportsImages: selected.inputModalities.includes("image") && this.engines.get(selected.engineId)!.supportsImages === true,
    });
    // Metadata can change on a different connection during catalog discovery.
    // Admit against the latest committed document, not the earlier snapshot.
    thread = this.store.get(params.threadId);
    if (this.operations.has(thread.id)) throw invalid("A chat operation is pending; no new turn was started.");
    if (thread.archived) throw invalid("Unarchive the thread before sending a turn.");
    if (selected.engineId !== thread.engineId) throw invalid("A thread cannot change CLI engines. Start a new thread.");
    if (selected.model !== thread.model) throw invalid("The session model changed. Refresh the session or update its model settings before sending.");
    if (params.cwd != null && params.cwd !== thread.cwd) throw invalid("A thread cannot change workspaces.");
    // selectModel awaits; recheck after it so two connections cannot both admit a turn.
    if (this.active.has(thread.id)) throw invalid("This thread already has an active turn.");
    const turn: Turn = { id: randomUUID(), status: "inProgress", error: null,
      items: [{ id: randomUUID(), type: "userMessage", content: publicInput(structuredClone(params.input)) }] };
    thread.model = selected.model;
    thread.reasoningEffort = this.effort(params.effort, selected, thread.reasoningEffort);
    // Settings updates own the policy. A host's cached ordinary-send snapshot
    // cannot reset the committed choice (including a newly inherited default).
    thread.cliApprovalMode = this.approvalMode(thread.cliApprovalMode, selected);
    thread.approvalPolicy = params.approvalPolicy ?? thread.approvalPolicy ?? "on-request";
    thread.preview ||= prompt.slice(0, 200) || "[Image]";
    thread.turns.push(turn);
    thread.updatedAt = now();
    thread.status = { type: "active", activeFlags: [] };
    this.store.save(thread); // Intent must reach disk before any CLI side effect.
    const controller = new AbortController();
    const active: { controller: AbortController; turnId: string; done?: Promise<void> } = { controller, turnId: turn.id };
    this.active.set(thread.id, active);
    active.done = new Promise<void>(resolve => setImmediate(resolve)).then(() => this.execute({ thread, turn, selected, prompt, attachments, controller, connection, reasoningEffort: thread.reasoningEffort }));
    return { turn: structuredClone(turn) };
  }
  async execute({ thread, turn, selected, prompt, attachments, controller, connection, reasoningEffort }: { thread: StoredThread; turn: Turn; selected: SelectedModel; prompt: string; attachments?: Attachment[]; controller: AbortController; connection: GatewayConnection; reasoningEffort?: string | null }) {
    const context = { threadId: thread.id, turnId: turn.id };
    const item = { id: randomUUID(), type: "agentMessage" as const, text: "", phase: "final_answer" };
    const tools = new Map<string, ToolItem>();
    const image = (image: EngineImage) => {
      if (controller.signal.aborted) return;
      const saved = this.media.save(thread.id, randomUUID(), image); turn.items.push(saved);
      try { this.saveExecution(thread); } catch (error) { turn.items.pop(); try { fs.unlinkSync(saved.savedPath); } catch {} throw error; }
      this.notify("item/started", { ...context, item: saved, startedAtMs: Date.now() });
      this.notify("item/completed", { ...context, item: saved, completedAtMs: Date.now() });
    };
    this.notify("turn/started", { threadId: thread.id, turn: structuredClone(turn) });
    this.notify("thread/status/changed", { threadId: thread.id, status: thread.status });
    this.notify("item/started", { ...context, item: structuredClone(item), startedAtMs: Date.now() });
    try {
      await this.engines.get(thread.engineId)!.run({ prompt, attachments, model: selected.nativeModel,
        reasoningEffort: reasoningEffort === "none" && selected.efforts.length === 1 ? undefined : reasoningEffort,
        // Desktop's native approvalPolicy is a separate host setting. In
        // particular, its ordinary `never` envelope cannot veto a saved CLI
        // choice. Older CLI documents without a mode keep the ask default.
        getApprovalMode: () => this.store.get(thread.id).cliApprovalMode ?? "ask",
        cwd: thread.cwd, nativeSessionId: thread.nativeSessionId, signal: controller.signal,
        onSession: sessionId => {
          if (typeof sessionId !== "string" || !sessionId) throw new Error("CLI returned no session identity.");
          if (thread.nativeSessionId && thread.nativeSessionId !== sessionId) throw new Error("CLI resumed a different session.");
          thread.nativeSessionId = sessionId;
          this.saveExecution(thread);
        },
        onCheckpoint: eventId => { turn.nativeStartEventId = eventId; this.saveExecution(thread); },
        onImage: image,
        onText: delta => {
          if (typeof delta !== "string") throw new Error("Invalid CLI text event.");
          if (item.text.length + delta.length > 1024 * 1024) throw new Error("CLI response exceeds the gateway limit.");
          item.text += delta;
          this.notify("item/agentMessage/delta", { ...context, itemId: item.id, delta });
        },
        onTool: event => {
          if (event.phase === "start") {
            if (tools.has(event.id)) return;
            const tool: ToolItem = { id: randomUUID(), type: "dynamicToolCall", namespace: thread.engineId,
              tool: event.name, arguments: extractToolOutput(event.input).safe, status: "inProgress", contentItems: null,
              success: null, durationMs: null };
            tools.set(event.id, tool);
            turn.items.push(tool);
            this.notify("item/started", { ...context, item: structuredClone(tool), startedAtMs: Date.now() });
          } else if (event.phase === "end") {
            const tool = tools.get(event.id);
            if (!tool || tool.status !== "inProgress") return;
            tool.status = event.success ? "completed" : "failed";
            tool.success = Boolean(event.success);
            const result = extractToolOutput(event.output ?? "", { toolName: tool.tool, cwd: thread.cwd });
            if (event.success && !event.images?.length && !result.images.length && /view.?image|read.*image/i.test(tool.tool) && tool.arguments && typeof tool.arguments === "object") {
              const p = tool.arguments as Record<string, unknown>, file = p.path ?? p.file_path; if (typeof file === "string") result.images.push({ kind: "file", path: path.resolve(thread.cwd, file) });
            }
            tool.contentItems = [{ type: "inputText", text: result.output.slice(0, 128 * 1024) }];
            this.notify("item/completed", { ...context, item: structuredClone(tool), completedAtMs: Date.now() });
            const seen = new Set<string>();
            for (const value of [...(event.images ?? []), ...result.images]) { const key = value.kind === "file" ? value.path : value.mimeType + createHash("sha256").update(value.data).digest("hex"); if (!seen.has(key)) { seen.add(key); image(value); } }
          }
        },
        // Explicit CLI denial blocks permissions, not business questions.
        // Auto/read-only approvals and managed restrictions belong to adapters.
        ask: questions => this.store.get(thread.id).cliApprovalMode === "deny" && questions.some(question => question.id === "permission")
          ? Promise.resolve({ answers: { permission: { answers: ["Deny"] } } })
          : connection.request("item/tool/requestUserInput", {
          ...context, itemId: randomUUID(), isBlocking: true, questions,
        }, controller.signal),
      });
      turn.status = controller.signal.aborted ? "interrupted" : "completed";
    } catch (cause) { const error = cause instanceof Error ? cause : new Error(String(cause));
      turn.status = controller.signal.aborted ? "interrupted" : "failed";
      turn.error = turn.status === "failed" ? { message: error.message, codexErrorInfo: null, additionalDetails: null } : null;
    }
    turn.items.push(item);
    for (const tool of tools.values()) if (tool.status === "inProgress") {
      tool.status = "failed";
      tool.success = false;
      tool.contentItems = [{ type: "inputText", text: "CLI ended without a tool result; outcome is unknown." }];
      this.notify("item/completed", { ...context, item: tool, completedAtMs: Date.now() });
    }
    thread.updatedAt = now();
    thread.status = { type: "idle" };
    try {
      this.saveExecution(thread);
      this.notify("item/completed", { ...context, item, completedAtMs: Date.now() });
      this.notify("turn/completed", { threadId: thread.id, turn: publicTurn(turn) });
      this.notify("thread/status/changed", { threadId: thread.id, status: thread.status });
    } catch {
      // Keep the persisted intent uncertain, not falsely completed.
      this.notify("error", { ...context, willRetry: false,
        error: { message: "CLI finished but gateway state could not be saved; outcome is unknown.", codexErrorInfo: null, additionalDetails: null } });
    } finally { this.active.delete(thread.id); }
  }
  async close() {
    this.closing = true;
    for (const active of this.active.values()) active.controller.abort();
    await Promise.allSettled([...this.active.values()].map(active => active.done));
    await Promise.allSettled([...this.pendingMaintenance]);
    await Promise.allSettled([...this.engines.values()].map(engine => engine.close?.()));
  }
}
