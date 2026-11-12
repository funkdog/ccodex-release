import "../tools/typescript-runtime.mjs";
import type { AppParams, AppPayload, AppRow, AppListRow, SearchHit, RpcMessage, RpcId, ProviderConfig, GoogleConfig, Page, Model } from "./contracts.mjs";
import type { RpcPeer } from "./rpc-peer.mjs";
import type { NativeTraceEvent } from "./spine/contracts.mjs";
type NativeProvider = { prefix: string; id: string; name: string; settings?: ProviderConfig | GoogleConfig; config: () => object; models: () => Promise<Model[]> };
interface NativeSelection {
  model?: string | null; provider: NativeProvider; effort?: string | null; cwd?: string;
  approvalPolicy?: unknown; approvalsReviewer?: unknown; sandbox?: unknown;
  permissions?: string; runtimeWorkspaceRoots?: string[];
}
interface RouterOptions {
  native: RpcPeer; connectGateway: () => Promise<RpcPeer>; connectProvider?: (id: string) => Promise<RpcPeer>; ownsThread: (id: string) => unknown;
  cursorSecret: string; send: (message: RpcMessage) => void; warn?: (message: string) => void;
  onNativeClose?: () => void; discoveryTimeoutMs?: number; modelDiscoveryTimeoutMs?: number; copilotProvider?: ProviderConfig; googleProvider?: GoogleConfig;
  onNativeEvent?: (event: NativeTraceEvent) => void | Promise<void>;
  onNativeInitialized?: () => void;
}
import { randomUUID } from "node:crypto";
import path from "node:path";
import { MergedPages } from "./merged-page.mjs";
import { RpcFailure } from "./rpc-peer.mjs";
import { codexCopilotPrefix, copilotProviderId, copilotProviderConfig, codexCopilotCatalog } from "./copilot-provider.mjs";
import { codexGooglePrefix, googleProviderId, googleProviderConfig, codexGoogleEngine } from "./google-provider.mjs";

export const modelPrefix = "mycodex/";
export const providerPrefix = "mycodex:";
const externalModel = (value: unknown): boolean => typeof value === "string" && value.startsWith(modelPrefix);
const invalid = (message: string) => new RpcFailure({ code: -32602, message });
const refs = (params: AppParams): string[] => [params.threadId, params.conversationId, params.parentThreadId,
  params.ancestorThreadId, params.attachedToThreadId, params.sourceThreadId,
  ...(Array.isArray(params.threadIds) ? params.threadIds : [])].filter(value => typeof value === "string");
const isSearchHit = (row: AppListRow): row is SearchHit => typeof row === "object" && row != null &&
  "thread" in row && row.thread != null && typeof row.thread === "object";
const threadRow = (row: AppListRow): AppRow | null => typeof row === "string" ? null : isSearchHit(row) ? row.thread : row;
const gatewayThread = (thread: AppRow): AppRow => ({ ...thread,
  ...(typeof thread.model === "string" ? { model: modelPrefix + thread.model } : {}),
  ...(typeof thread.modelProvider === "string" ? { modelProvider: providerPrefix + thread.modelProvider } : {}) });

function fromGateway<T>(method: string | undefined, value: T): T {
  if (value == null || typeof value !== "object") return value;
  const result: AppPayload = { ...(value as AppPayload) };
  if (result.thread) result.thread = gatewayThread(result.thread);
  if (typeof result.model === "string") result.model = modelPrefix + result.model;
  if (typeof result.modelProvider === "string") result.modelProvider = providerPrefix + result.modelProvider;
  if (method === "thread/list") result.data = result.data!.map(row => typeof row === "string" ? row : gatewayThread(row as AppRow));
  if (method === "thread/search") result.data = result.data!.map(row => {
    if (!isSearchHit(row)) throw new Error("Gateway returned an invalid title search result.");
    return { ...row, thread: gatewayThread(row.thread) };
  });
  if (method === "model/list") result.data = result.data!.map(row => { const model = row as AppRow; return ({ ...model,
    id: modelPrefix + model.id, model: modelPrefix + model.model, isDefault: false }); });
  return result as T;
}
function toGateway(message: RpcMessage) {
  const params = structuredClone(message.params || {});
  for (const target of [params, params.collaborationMode?.settings].filter((value): value is NonNullable<typeof value> => Boolean(value))) {
    if (typeof target.model === "string" && externalModel(target.model)) target.model = target.model.slice(modelPrefix.length);
  }
  if (typeof params.modelProvider === "string" && params.modelProvider.startsWith(providerPrefix)) params.modelProvider = params.modelProvider.slice(providerPrefix.length);
  return { ...message, params };
}
const hasExternalSetting = (value: unknown): boolean => typeof value === "string" ? externalModel(value) || value.startsWith(providerPrefix) || [copilotProviderId, googleProviderId].includes(value)
  : value && typeof value === "object" ? Object.values(value).some(hasExternalSetting) : false;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
async function discoveryWithin<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer;
  try { return await Promise.race([promise, new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Optional gateway discovery exceeded its latency budget.")), milliseconds);
  })]); } finally { clearTimeout(timer); }
}

/** Transport routing only: no tools, prompts, inference, account mutation or CDP. */
export class AppServerRouter {
  native: RpcPeer; connectGateway: RouterOptions["connectGateway"]; connectProvider?: RouterOptions["connectProvider"]; ownsThread: RouterOptions["ownsThread"];
  send: RouterOptions["send"]; warn: (message: string) => void; onNativeClose: () => void;
  providerThreads = new Map<string, NativeSelection>();
  nativeProviders: NativeProvider[]; pages: MergedPages; reverse = new Map<RpcId, { peer: RpcPeer; originalId?: RpcId }>();
  incoming = new Set<RpcId>(); initialization: RpcMessage | null = null;
  gatewayPromise: Promise<RpcPeer> | null = null; gateway: RpcPeer | null = null; closed = false; discoveryTimeoutMs: number; modelDiscoveryTimeoutMs: number;
  providerPromises = new Map<string, Promise<RpcPeer>>(); providerPeers = new Map<string, RpcPeer>();
  providerLoaded = new Map<RpcPeer, Set<string>>();
  private onNativeEvent?: RouterOptions["onNativeEvent"];
  private onNativeInitialized?: RouterOptions["onNativeInitialized"];
  private nativeMutations = new Map<string, number>();
  private backgroundMutations = new Map<string, Promise<void>>();
  /** Coordinate only mutations crossing this frontend. Other native runtimes
   * remain external actors and must still be checked by the dispatcher. */
  async withNativeThread<T>(threadId: string, operation: () => Promise<T>): Promise<T> {
    if (this.closed || !this.initialization || this.ownsThread(threadId)) throw new Error("Native thread binding is unavailable.");
    if (this.nativeMutations.has(threadId) || this.backgroundMutations.has(threadId)) throw Object.assign(new Error("Native thread is busy."), { code: "MYCODEX_THREAD_BUSY" });
    let release!: () => void;
    this.backgroundMutations.set(threadId, new Promise<void>(resolve => { release = resolve; }));
    try { return await operation(); }
    finally { this.backgroundMutations.delete(threadId); release(); }
  }
  constructor({ native, connectGateway, connectProvider, ownsThread, cursorSecret, send, warn = () => {}, onNativeClose = () => {}, discoveryTimeoutMs = 1500, modelDiscoveryTimeoutMs = 45000, copilotProvider, googleProvider, onNativeEvent, onNativeInitialized }: RouterOptions) {
    this.onNativeEvent = onNativeEvent;
    this.onNativeInitialized = onNativeInitialized;
    this.native = native; this.connectGateway = connectGateway; this.connectProvider = connectProvider; this.ownsThread = ownsThread;
    this.send = send; this.warn = warn; this.onNativeClose = onNativeClose;
    this.nativeProviders = [
      { prefix: codexCopilotPrefix, id: copilotProviderId, name: "Codex + Copilot", settings: copilotProvider,
        config: () => copilotProviderConfig(copilotProvider!), models: () => codexCopilotCatalog(copilotProvider!).models() },
      { prefix: codexGooglePrefix, id: googleProviderId, name: "Codex + Gemini", settings: googleProvider,
        config: () => googleProviderConfig(googleProvider!), models: () => codexGoogleEngine(googleProvider!).models() },
    ];
    this.pages = new MergedPages(cursorSecret);
    this.initialization = null;
    this.gatewayPromise = null;
    this.gateway = null;
    this.closed = false;
    this.discoveryTimeoutMs = discoveryTimeoutMs;
    this.modelDiscoveryTimeoutMs = modelDiscoveryTimeoutMs;
    this.attach(native, "native");
  }
  private tap(method: string, params: unknown, result?: unknown) {
    if (!this.onNativeEvent) return;
    queueMicrotask(async () => {
      try {
        const { nativeTraceSummary } = await import("./spine/trace.mjs");
        const event = nativeTraceSummary(method, params, result);
        if (event && !this.ownsThread(event.threadId)) await this.onNativeEvent?.(event);
      } catch { this.warn("Native event tap failed; protocol unaffected."); }
    });
  }
  nativeResult<T>(value: T): T {
    if (!value || typeof value !== "object") return value;
    const payload = value as AppPayload;
    const thread = payload.thread;
    const remember = (row: AppListRow): AppListRow => {
      if (typeof row === "string") return row;
      if (isSearchHit(row)) return { ...row, thread: remember(row.thread) as AppRow };
      const provider = this.nativeProviders.find(p => row?.modelProvider === p.id);
      if (!provider) return row;
      const previous = this.providerThreads.get(row.id);
      const supplied = row === thread ? payload.model ?? row.model ?? previous?.model : previous?.model ?? row.model;
      const model = supplied?.startsWith(provider.prefix) ? supplied.slice(provider.prefix.length) : supplied;
      const rawEffort = row === thread && Object.hasOwn(payload, "reasoningEffort") ? payload.reasoningEffort : row.reasoningEffort;
      const effort = typeof rawEffort === "string" || (row === thread && rawEffort === null) ? rawEffort : previous?.effort;
      const cwd = row === thread ? payload.cwd ?? row.cwd : row.cwd;
      const selection: NativeSelection = { ...previous, model, provider, effort, ...(typeof cwd === "string" ? { cwd } : {}) };
      if (row === thread) for (const field of ["approvalPolicy", "approvalsReviewer", "sandbox"] as const)
        if (Object.hasOwn(payload, field)) selection[field] = payload[field];
      if (row === thread) {
        const profile = payload.activePermissionProfile;
        if (profile && typeof profile === "object" && "id" in profile && typeof profile.id === "string") selection.permissions = profile.id;
        else if (Object.hasOwn(payload, "activePermissionProfile")) selection.permissions = undefined;
        if (Array.isArray(payload.runtimeWorkspaceRoots) && payload.runtimeWorkspaceRoots.every(root => typeof root === "string"))
          selection.runtimeWorkspaceRoots = payload.runtimeWorkspaceRoots;
      }
      this.providerThreads.set(row.id, selection);
      return { ...row, ...(model ? { model: provider.prefix + model } : {}), nativeProvider: provider.id,
        ...(provider.id === copilotProviderId ? { nativeCopilot: true } : {}) };
    };
    const settings = payload.threadSettings;
    const providerId = settings?.modelProvider ?? payload.modelProvider ?? thread?.modelProvider;
    const provider = this.nativeProviders.find(p => p.id === providerId) ??
      (providerId == null ? this.providerThreads.get(payload.threadId ?? "")?.provider : undefined);
    const qualify = (model: string) => model.startsWith(provider!.prefix) ? model : provider!.prefix + model;
    const collaboration = (mode: AppParams["collaborationMode"]) => mode?.settings?.model && provider
      ? { ...mode, settings: { ...mode.settings, model: qualify(mode.settings.model) } } : mode;
    if (provider && settings?.model && payload.threadId) {
      const previous = this.providerThreads.get(payload.threadId);
      const rawEffort = Object.hasOwn(settings, "effort") ? settings.effort : settings.collaborationMode?.settings.reasoning_effort;
      this.providerThreads.set(payload.threadId, { ...previous, provider,
        model: settings.model.startsWith(provider.prefix) ? settings.model.slice(provider.prefix.length) : settings.model,
        effort: typeof rawEffort === "string" || rawEffort === null ? rawEffort : previous?.effort });
    }
    return { ...payload, ...(thread ? { thread: remember(thread) } : {}),
      ...(Array.isArray(payload.data) ? { data: payload.data.map(remember) } : {}),
      ...(provider && payload.model ? { model: qualify(payload.model) } : {}),
      ...(provider && payload.collaborationMode ? { collaborationMode: collaboration(payload.collaborationMode) } : {}),
      ...(provider && settings ? { threadSettings: { ...settings,
        ...(settings.model ? { model: qualify(settings.model) } : {}),
        ...(settings.collaborationMode ? { collaborationMode: collaboration(settings.collaborationMode) } : {}) } } : {}) } as T;
  }
  attach(peer: RpcPeer, origin: "native" | "gateway" | "provider", providerId?: string) {
    peer.onNotification = message => {
      if (this.closed) return;
      if (origin !== "gateway") {
        const id = message.params?.threadId ?? message.params?.thread?.id;
        if (id && this.ownsThread(id)) { this.warn("Native/gateway thread identity collision; notification withheld."); return; }
        this.tap(message.method ?? "", message.params);
      }
      this.send(origin === "gateway" ? { ...message, params: fromGateway(message.method, message.params) }
        : { ...message, params: this.nativeResult(message.params) });
    };
    peer.onRequest = message => {
      if (this.closed) {
        peer.notify({ id: message.id, error: { code: -32000, message: "Desktop connection closed; no answer was supplied." } }); return;
      }
      if (this.reverse.size >= 1024) {
        peer.notify({ id: message.id, error: { code: -32000, message: "Too many pending client requests." } }); return;
      }
      const id = `mycodex-${origin}:${randomUUID()}`;
      this.reverse.set(id, { peer, originalId: message.id });
      this.send({ ...message, id, ...(origin === "gateway" ? { params: fromGateway(message.method, message.params) } : {}) });
    };
    peer.onClose = () => {
      for (const [id, entry] of this.reverse) if (entry.peer === peer) this.reverse.delete(id);
      if (origin === "gateway" && this.gateway === peer) { this.gatewayPromise = null; this.gateway = null; }
      if (origin === "provider" && providerId && this.providerPeers.get(providerId) === peer) {
        this.providerPeers.delete(providerId); this.providerPromises.delete(providerId); this.providerLoaded.delete(peer);
      }
      if (origin === "native" && !this.closed) this.onNativeClose();
    };
  }
  async providerPeer(provider: NativeProvider) {
    if (!this.connectProvider) return this.native;
    if (this.closed || !this.initialization) throw new Error("Native provider connection is unavailable.");
    let pending = this.providerPromises.get(provider.id);
    if (!pending) {
      pending = (async () => {
        const peer = await this.connectProvider!(provider.id);
        if (this.closed) { peer.close(); await peer.dispose?.(); throw new Error("Native provider connection closed during startup."); }
        this.providerPeers.set(provider.id, peer);
        this.providerLoaded.set(peer, new Set());
        this.attach(peer, "provider", provider.id);
        try {
          const response = await peer.call({ ...this.initialization!, id: `mycodex-provider-init:${randomUUID()}` }, { timeoutMs: 10000 });
          if (response.error) throw new RpcFailure(response.error);
          if (this.closed || peer.closed) throw new Error("Native provider connection closed during initialization.");
          peer.notify({ method: "initialized" });
          return peer;
        } catch (cause) { peer.close(); await peer.dispose?.(); throw cause; }
      })().catch(error => { this.providerPromises.delete(provider.id); throw error; });
      this.providerPromises.set(provider.id, pending);
    }
    return pending;
  }
  async gatewayPeer() {
    if (this.closed) throw new Error("Desktop routing connection is closed.");
    if (!this.initialization) throw invalid("Initialize the native connection first.");
    if (!this.gatewayPromise) {
      const pending = (async () => {
        const peer = await this.connectGateway();
        if (this.closed) { peer.close(); await peer.dispose?.(); throw new Error("Desktop routing connection closed during gateway startup."); }
        this.gateway = peer; // Also own peers that are still initializing.
        this.attach(peer, "gateway");
        try {
          const result = await peer.call({ ...this.initialization, id: `mycodex-init:${randomUUID()}` }, { timeoutMs: 10000 });
          if (result.error) throw new RpcFailure(result.error);
          if (this.closed || peer.closed) throw new Error("Desktop routing connection closed during gateway initialization.");
          peer.notify({ method: "initialized" });
          return peer;
        } catch (cause) { const error = cause instanceof Error ? cause : new Error(String(cause)); peer.close(); await peer.dispose?.(); throw error; }
      })().catch(error => { if (this.gatewayPromise === pending) this.gatewayPromise = null; throw error; });
      this.gatewayPromise = pending;
    }
    return this.gatewayPromise;
  }
  async receive(message: RpcMessage) {
    if (this.closed) return;
    if (!message || typeof message !== "object" || Array.isArray(message)) throw invalid("Invalid client message.");
    if (!Object.hasOwn(message, "method")) {
      const entry = this.reverse.get(message.id!);
      if (!entry) return; // No guessed IDs or answers from an earlier connection.
      this.reverse.delete(message.id!);
      entry.peer.notify({ ...message, id: entry.originalId });
      return;
    }
    if (!Object.hasOwn(message, "id")) {
      const ids = refs(message.params || {});
      const owner = ids.some(id => this.ownsThread(id));
      const providers = [...new Set(ids.map(id => this.providerThreads.get(id)?.provider).filter((value): value is NativeProvider => Boolean(value)))];
      if (providers.length > 1 || owner && providers.length) throw invalid("One notification cannot mix thread providers.");
      const peer = owner ? await this.gatewayPeer() : providers.length ? await this.providerPeer(providers[0]) : this.native;
      peer.notify(owner ? toGateway(message) : message);
      if (message.method === "initialized" && this.initialization && this.onNativeInitialized) {
        const callback = this.onNativeInitialized; this.onNativeInitialized = undefined;
        try { callback(); } catch { this.warn("Optional native host channel failed; protocol unaffected."); }
      }
      return;
    }
    if (!(typeof message.id === "string" || Number.isSafeInteger(message.id)) || this.incoming.has(message.id!)) throw invalid("Duplicate or invalid client request ID.");
    this.incoming.add(message.id!);
    const mutations: string[] = [];
    try {
      if (/^(?:turn\/|thread\/(?:resume|fork|archive|unarchive|delete|settings\/|name\/|metadata\/))/.test(message.method!)) {
        for (const id of new Set(refs(message.params || {}))) if (!this.ownsThread(id)) {
          mutations.push(id); this.nativeMutations.set(id, (this.nativeMutations.get(id) ?? 0) + 1);
        }
        await Promise.all(mutations.map(id => this.backgroundMutations.get(id)));
      }
      const response = await this.route(message); if (!response.error) this.tap(message.method!, message.params, response.result); if (!this.closed) this.send(response);
    }
    catch (cause) { const error = cause instanceof Error ? cause : new Error(String(cause)); if (!this.closed) this.send({ id: message.id, ...(message.jsonrpc ? { jsonrpc: message.jsonrpc } : {}),
      error: error instanceof RpcFailure ? error.rpc : { code: -32000, message: error.message } }); }
    finally {
      for (const id of mutations) { const count = this.nativeMutations.get(id)! - 1; if (count) this.nativeMutations.set(id, count); else this.nativeMutations.delete(id); }
      this.incoming.delete(message.id!);
    }
  }
  async route(message: RpcMessage): Promise<RpcMessage> {
    const method = message.method!;
    const params = message.params || {};
    if (method === "initialize") {
      if (this.initialization) throw invalid("Already initialized.");
      const response = await this.native.call(message);
      if (!response.error) this.initialization = structuredClone(message);
      return response; // Native identity, auth and home are never synthesized.
    }
    if (!this.initialization) throw invalid("Initialize the native connection first.");
    if (["model/list", "thread/list", "thread/search", "thread/loaded/list"].includes(method)) return this.list(message);
    if (method.startsWith("config/") && method !== "config/read" && hasExternalSetting(params)) {
      const draft = method === "config/batchWrite" ? await this.draftModelSettings(message) : null;
      if (draft) return draft;
      const shape = method === "config/batchWrite" ? ` Request shape: ${JSON.stringify({
        fields: Object.keys(params).slice(0, 8), editCount: Array.isArray(params.edits) ? params.edits.length : null,
        explicitFile: params.filePath != null, explicitVersion: params.expectedVersion != null,
        reloadUserConfig: typeof params.reloadUserConfig === "boolean" ? params.reloadUserConfig : null,
      })}` : "";
      throw invalid(`Third-party model preferences cannot be written into native Codex configuration.${shape}`);
    }
    const ids = refs(params);
    const owners = ids.map(id => Boolean(this.ownsThread(id)));
    if (owners.some(Boolean) && owners.some(owner => !owner)) throw invalid("One operation cannot mix native and third-party threads.");
    const model = params.model ?? params.collaborationMode?.settings?.model;
    const external = externalModel(model);
    const own = owners.some(Boolean);
    // A resumed native-provider turn can arrive without a model. Recover its
    // saved provider from thread metadata, never from the process default.
    if ((method.startsWith("thread/") || method.startsWith("turn/")) &&
        !own && params.threadId && (method === "thread/resume" || !this.providerThreads.has(params.threadId)) &&
        (this.connectProvider || method === "thread/fork") &&
        (!external || this.nativeProviders.some(provider => typeof model === "string" && model.startsWith(provider.prefix)))) {
      try {
        const source = await this.native.request("thread/read", { threadId: params.threadId, includeTurns: false });
        this.nativeResult(source);
      } catch (error) { if (method === "thread/fork" || external || this.providerThreads.has(params.threadId)) throw error; }
    }
    const sourceProvider = this.providerThreads.get(params.threadId ?? "");
    const modeModel = params.collaborationMode?.settings?.model;
    const nativeProvider = this.nativeProviders.find(p => (typeof model === "string" && model.startsWith(p.prefix)) ||
      (typeof modeModel === "string" && modeModel.startsWith(p.prefix))) ??
      (method === "thread/fork" || ids.length && (model == null || model === sourceProvider?.model)
        ? sourceProvider?.provider : undefined);
    if (nativeProvider) {
      if (externalModel(model) && typeof model === "string" && !model.startsWith(nativeProvider.prefix))
        throw invalid("A native provider request cannot mix a CLI engine model with its collaboration mode.");
      if ([model, modeModel].some(value => typeof value === "string" && this.nativeProviders.some(p =>
        p.id !== nativeProvider.id && value.startsWith(p.prefix)))) throw invalid("A request cannot mix native model providers.");
      if (!nativeProvider.settings) throw invalid(`${nativeProvider.name} is not configured for this instance.`);
      if (own) throw invalid("An existing CLI thread cannot change to the Codex runtime.");
      if (method !== "thread/start" && (!ids.length || !ids.every(id => this.providerThreads.get(id)?.provider.id === nativeProvider.id)))
        throw invalid("An existing native thread cannot switch providers; start a new Codex + Copilot thread.");
      if (method === "thread/fork" && params.path) throw invalid("Provider forks must use their resolved source thread, not a rollout path.");
      if (method === "thread/fork" && params.modelProvider != null && params.modelProvider !== nativeProvider.id)
        throw invalid("A fork must retain its source model provider.");
      const query = structuredClone(params);
      const modelMethod = ["thread/start", "thread/resume", "thread/fork", "thread/settings/update", "turn/start", "turn/addUserMessage"].includes(method);
      if (modelMethod) {
        const qualified = [model, modeModel].find(value => typeof value === "string" && value.startsWith(nativeProvider.prefix));
        query.model = qualified?.slice(nativeProvider.prefix.length) ?? sourceProvider?.model ?? null;
        if (!query.model) throw invalid("Choose a provider model.");
        if (query.collaborationMode?.settings) query.collaborationMode.settings.model = query.model;
      }
      if (["thread/start", "thread/resume", "thread/fork"].includes(method)) {
        query.modelProvider = nativeProvider.id;
        query.config = { ...query.config, ...nativeProvider.config() };
      }
      if (method === "thread/resume" && sourceProvider?.effort != null && !Object.hasOwn(query.config!, "model_reasoning_effort"))
        query.config!.model_reasoning_effort = sourceProvider.effort;
      if (method === "thread/fork" && sourceProvider) {
        if (sourceProvider.effort != null && !Object.hasOwn(query.config!, "model_reasoning_effort"))
          query.config!.model_reasoning_effort = sourceProvider.effort;
        query.cwd ??= sourceProvider.cwd;
        query.approvalPolicy ??= sourceProvider.approvalPolicy;
        query.approvalsReviewer ??= sourceProvider.approvalsReviewer;
        query.runtimeWorkspaceRoots ??= sourceProvider.runtimeWorkspaceRoots;
        if (query.permissions == null && query.sandbox == null && sourceProvider.permissions) query.permissions = sourceProvider.permissions;
        const sandbox = sourceProvider.sandbox;
        if (query.permissions == null && query.sandbox == null && sandbox && typeof sandbox === "object" && "type" in sandbox) {
          const modes: Record<string, string> = { readOnly: "read-only", workspaceWrite: "workspace-write", dangerFullAccess: "danger-full-access" };
          if (Object.entries(sandbox).some(([field, value]) => field !== "type" && !(field === "networkAccess" && value === false)))
            throw invalid("The source has detailed permissions. Open it with a named permission profile or supply explicit fork permissions; no weaker default was substituted.");
          if (typeof sandbox.type === "string" && modes[sandbox.type]) query.sandbox = modes[sandbox.type];
        }
      }
      const peer = await this.providerPeer(nativeProvider);
      const loaded = this.providerLoaded.get(peer);
      if (loaded && method === "turn/start" && params.threadId && !loaded.has(params.threadId)) {
        const resumed = await peer.request("thread/resume", { threadId: params.threadId, model: sourceProvider?.model,
          modelProvider: nativeProvider.id, config: { ...nativeProvider.config(),
            ...(sourceProvider?.effort != null ? { model_reasoning_effort: sourceProvider.effort } : {}) } }, { timeoutMs: 15000 });
        this.nativeResult(resumed); loaded.add(params.threadId);
      }
      const response = await peer.call({ ...message, params: query });
      if (!response.error && loaded && ["thread/start", "thread/resume", "thread/fork"].includes(method) && response.result?.thread?.id)
        loaded.add(response.result.thread.id);
      return response.error ? response : { ...response, result: this.nativeResult(response.result) };
    }
    if (ids.length && !own && external) throw invalid("An existing native thread cannot switch CLI engines; start a new thread.");
    if (own && model != null && !external) throw invalid("An existing CLI thread cannot switch to a native model.");
    if (own || (method === "thread/start" && external)) {
      const peer = await this.gatewayPeer();
      const response = await peer.call(toGateway(message));
      return response.error ? response : { ...response, result: fromGateway(method, response.result) };
    }
    if (external) throw invalid("This third-party model operation is not supported.");
    const storedProvider = this.providerThreads.get(params.threadId ?? "")?.provider;
    if (method === "thread/resume" && storedProvider && !storedProvider.settings) throw invalid(`${storedProvider.name} is not configured for this instance.`);
    // Ordinary OpenAI resumes stay on the default native peer. Provider
    // resumes above use their own peer and restore saved model/effort there.
    const response = await this.native.call(message);
    if (response.result?.thread?.id && this.ownsThread(response.result.thread.id)) throw invalid("Native/gateway thread identity collision; no thread was reassigned.");
    return response.error ? response : { ...response, result: this.nativeResult(response.result) };
  }
  /** The Desktop's host-RPC manager bypasses renderer prototype hooks. Its
   * exact default-model write shape has a native okOverridden response branch
   * that retains this choice in the window. Never forward this as a write or
   * retain a process-global model; subsequent creates carry the UI override. */
  private async draftModelSettings(message: RpcMessage): Promise<RpcMessage | null> {
    const params = message.params!;
    if (Object.keys(params).length !== 4 || !["edits", "filePath", "expectedVersion", "reloadUserConfig"].every(key => Object.hasOwn(params, key)) ||
        params.filePath !== null || params.expectedVersion !== null || params.reloadUserConfig !== true ||
        !Array.isArray(params.edits) || params.edits.length !== 2 || !params.edits.every(edit => record(edit) &&
          Object.keys(edit).length === 3 && Object.hasOwn(edit, "value") && edit.mergeStrategy === "upsert" && typeof edit.keyPath === "string")) return null;
    const modelEdit = params.edits.find(edit => /^(?:profiles\.[A-Za-z0-9_-]{1,128}\.)?model$/.test(edit.keyPath));
    if (!modelEdit || typeof modelEdit.value !== "string" || !externalModel(modelEdit.value)) return null;
    const prefix = modelEdit.keyPath.slice(0, -"model".length);
    const effortEdit = params.edits.find(edit => edit.keyPath === prefix + "model_reasoning_effort");
    if (!effortEdit || !(effortEdit.value === null || typeof effortEdit.value === "string")) return null;
    let efforts: unknown[] | null = null;
    const provider = this.nativeProviders.find(provider => modelEdit.value.startsWith(provider.prefix));
    if (provider) {
      if (!provider.settings) throw invalid(`${provider.name} is not configured for this instance.`);
      const model = (await provider.models()).find(model => model.id === modelEdit.value.slice(provider.prefix.length));
      if (model) efforts = model.supportedReasoningEfforts ?? [];
    } else {
      const catalog = await this.list({ id: `mycodex-draft-models:${randomUUID()}`, method: "model/list", params: { limit: 1000 } });
      if (catalog.error) throw new RpcFailure(catalog.error);
      const model = catalog.result?.data?.map(threadRow).find(row => row?.model === modelEdit.value);
      if (model) efforts = Array.isArray(model.supportedReasoningEfforts)
        ? model.supportedReasoningEfforts.map(value => record(value) ? value.reasoningEffort : undefined) : [];
    }
    if (efforts === null) throw invalid("The third-party draft model is not advertised; no native configuration was written.");
    if (effortEdit.value !== null && !efforts.includes(effortEdit.value))
      throw invalid("The third-party draft reasoning effort is unsupported; no native configuration was written.");
    // Read actual native metadata rather than inventing a path or revision.
    // The unchanged revision and explicit message distinguish this response
    // from a persisted settings update, including across subsequent windows.
    const snapshot = await this.native.request("config/read", { includeLayers: true });
    const layer = Array.isArray(snapshot.layers) ? snapshot.layers.find(value => record(value) && record(value.name) &&
      value.name.type === "user" && typeof value.name.file === "string" && path.isAbsolute(value.name.file) && typeof value.version === "string") : null;
    if (!record(layer) || !record(layer.name)) throw invalid("Native config metadata is unavailable; the draft override was not acknowledged.");
    const config = record(snapshot.config) ? snapshot.config : {};
    return { id: message.id, ...(message.jsonrpc ? { jsonrpc: message.jsonrpc } : {}), result: {
      status: "okOverridden", filePath: layer.name.file, version: layer.version,
      overriddenMetadata: { message: "MyCodex keeps this model selection in the current window; native configuration was not written.",
        overridingLayer: { name: layer.name, version: layer.version },
        effectiveValue: { model: config.model ?? null, model_reasoning_effort: config.model_reasoning_effort ?? null } },
    } };
  }
  async list(message: RpcMessage): Promise<RpcMessage> {
    const params = message.params || {};
    const method = message.method!;
    // The pinned CLI interprets null/omitted providers as its default provider,
    // while the Desktop sidebar's unfiltered list must include native provider
    // chats too. Its schema specifies [] as the explicit all-provider query.
    const nativeQuery = (query: AppParams) => method === "thread/list" && query.modelProviders == null &&
      this.nativeProviders.some(provider => provider.settings) ? { ...query, modelProviders: [] } : query;
    const nativeMessage = { ...message, params: nativeQuery(params) };
    // Desktop caches a model/list result for five minutes and does not follow
    // its cursor in the picker. Cold engine discovery must not share history's
    // short optional latency budget and become a successful incomplete catalog.
    const budget = method === "model/list" ? this.modelDiscoveryTimeoutMs : this.discoveryTimeoutMs;
    // An unwrapped cursor belongs entirely to the native protocol, including
    // refreshes that began while the optional gateway was unavailable.
    if (params.cursor && !this.pages.owns(params.cursor)) return this.native.call(nativeMessage);
    const validateNativePage = (result: AppPayload | undefined): Page<AppListRow> => {
      if (!Array.isArray(result?.data)) throw new Error("Native catalog returned no data array.");
      if (method === "model/list" && result.data.some(model => externalModel(threadRow(model)?.model) || externalModel(threadRow(model)?.id))) throw invalid("A native model uses the reserved mycodex/ namespace.");
      const ids = method === "model/list" ? [] : result.data.map(row => typeof row === "string" ? row : threadRow(row)!.id);
      if (ids.some(id => this.ownsThread(id))) throw invalid("Native/gateway thread identity collision in history.");
      return this.nativeResult(result) as Page<AppListRow>;
    };
    const nativeFetch = (next: AppParams) => this.native.request(method, nativeQuery(next), { timeoutMs: 15000 }).then(validateNativePage);
    const gatewayFetch = async (next: AppParams): Promise<Page<AppListRow>> => {
      const peer = await this.gatewayPeer();
      let query = { ...next };
      if (method === "thread/list" && query.modelProviders?.length) {
        const providers = query.modelProviders.filter(value => value.startsWith(providerPrefix)).map(value => value.slice(providerPrefix.length));
        if (!providers.length) return { data: [], nextCursor: null };
        query.modelProviders = providers;
      }
      const result = await peer.request(method, query, { timeoutMs: Math.max(15000, budget) });
      return fromGateway(method, result) as Page<AppListRow>;
    };
    let initialNative, initialGateway;
    if (!params.cursor) {
      const responses = await Promise.allSettled([this.native.call(nativeMessage), discoveryWithin(gatewayFetch(params), budget)]);
      if (responses[0].status === "rejected") throw responses[0].reason;
      const native = responses[0].value;
      if (native.error) return native;
      validateNativePage(native.result);
      if (responses[1].status === "rejected") {
        this.warn("Optional CLI gateway is unavailable; native catalog remains unchanged.");
        return native;
      }
      initialNative = validateNativePage(native.result);
      initialGateway = responses[1].value;
      const ids = method === "model/list" ? [] : initialNative.data.map(row => typeof row === "string" ? row : threadRow(row)!.id);
      if (ids.some(id => this.ownsThread(id))) throw invalid("Native/gateway thread identity collision in history.");
      if (!initialGateway.data.length && !initialGateway.nextCursor) return native;
    }
    const key = params.sortKey === "recency_at" ? "recencyAt" : params.sortKey === "updated_at" ? "updatedAt" : "createdAt";
    const timestamp = (row: AppListRow) => { const thread = threadRow(row); return thread?.[key] ?? thread?.updatedAt ?? thread?.createdAt ?? 0; };
    const ascending = params.sortDirection === "asc";
    const result = await this.pages.page({ method, params, native: nativeFetch, gateway: gatewayFetch,
      initialNative, initialGateway, preferNative: (n, g) => params.sectionId != null || !["thread/list", "thread/search"].includes(method) ||
        (ascending ? timestamp(n) <= timestamp(g) : timestamp(n) >= timestamp(g)) });
    // Signed cursors can carry old page tails across a frontend restart. A
    // durable gateway tombstone still wins over such a cached summary.
    result.data = result.data.filter(row => {
      const id = typeof row === "string" ? row : threadRow(row)!.id;
      const owner = this.ownsThread(id);
      return !(owner && typeof owner === "object" && "deleted" in owner && owner.deleted === true);
    });
    return { id: message.id, ...(message.jsonrpc ? { jsonrpc: message.jsonrpc } : {}), result };
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.reverse.values()) {
      try { entry.peer.notify({ id: entry.originalId, error: { code: -32000, message: "Desktop connection closed; no answer was supplied." } }); } catch {}
    }
    this.reverse.clear();
    await Promise.allSettled([...new Set([this.native, this.gateway, ...this.providerPeers.values()].filter((peer): peer is RpcPeer => Boolean(peer)))].map(async peer => { peer.close(); await peer.dispose?.(); }));
  }
}
