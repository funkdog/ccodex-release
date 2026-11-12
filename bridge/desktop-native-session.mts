import "../tools/typescript-runtime.mjs";
import type { SessionController, SessionIntent, UiThread, NativeOptions, NativeManager, NativeBus, NativeEnvelope, RequestClient } from "./desktop-diy-contracts.mjs";
import type { ApprovalMode } from "../gateway/contracts.mjs";
/** Session intent only. No DOM, transport, credentials or native configuration.
 * Serializable so the pinned renderer adapter can use the same tested logic. */
export function createNativeSessionController(): SessionController {
  const threads = new Map<string, UiThread>(), intents = new Map<string, SessionIntent>();
  const modelSwitches = new Set<string>();
  let selected: string | null = null, reasoningEffort: string | null = null, cliApprovalMode: ApprovalMode | undefined;
  const approvalDefaults = new Map<string, ApprovalMode>();
  const engineKey = (model: string | null) => model?.replace(/^mycodex\//, "").split("/")[0] ?? "";
  const foreign = (model: unknown): model is string => typeof model === "string" && /^mycodex\/[a-z][a-z0-9-]*\/.+/.test(model);
  const nativeModel = (model: unknown) => typeof model === "string" && /^mycodex\/codex-(?:copilot|gemini)\//.test(model);
  const normalize = (params: NativeOptions, model: string | null | undefined, settings: SessionIntent, method?: string): NativeOptions => {
    const effort = settings.reasoningEffort ?? null;
    if (nativeModel(model) || settings.nativeCopilot || settings.nativeRuntime) {
      if (settings.id) return { ...params, ...(method === "thread/resume" ? { model: null } : {}) };
      const next = { ...params, model, effort };
      if (next.collaborationMode) next.collaborationMode = { ...next.collaborationMode,
        settings: { ...next.collaborationMode.settings, model, reasoning_effort: effort } };
      return next;
    }
    const next = { ...params, model, effort, cliApprovalMode: settings.cliApprovalMode,
      approvalPolicy: "on-request", approvalsReviewer: "user" };
    if (settings.cliApprovalMode === undefined) delete next.cliApprovalMode;
    delete next.sandbox; delete next.sandboxPolicy;
    next.permissions = ":danger-full-access";
    // Native new-chat/resume envelopes can explicitly contain no workspace
    // hints. This means the CLI's selected cwd, not an additional workspace.
    // Keep nonempty roots intact so the gateway can validate their scope.
    if (Array.isArray(next.runtimeWorkspaceRoots) && next.runtimeWorkspaceRoots.length === 0) delete next.runtimeWorkspaceRoots;
    if (next.collaborationMode != null) next.collaborationMode = { ...next.collaborationMode,
      settings: { ...next.collaborationMode.settings, model, reasoning_effort: effort } };
    return next;
  };
  return {
    select(model) {
      if (model !== null && !foreign(model)) throw new Error("Invalid CLI model selection.");
      if (engineKey(model) !== engineKey(selected)) cliApprovalMode = undefined;
      selected = model;
      if (!model) { reasoningEffort = null; cliApprovalMode = undefined; }
    },
    selection: () => selected,
    preferences(threadId) { return threadId ? threads.get(threadId) ?? { reasoningEffort: null, cliApprovalMode: "ask" }
      : { reasoningEffort, cliApprovalMode: cliApprovalMode ?? approvalDefaults.get(engineKey(selected)) ?? "ask" }; },
    setApprovalDefaults(models) {
      approvalDefaults.clear();
      for (const model of models) if (model.defaultCliApprovalMode) approvalDefaults.set(engineKey(model.id), model.defaultCliApprovalMode);
    },
    configure(settings) {
      if (Object.hasOwn(settings, "reasoningEffort")) reasoningEffort = settings.reasoningEffort ?? null;
      if (Object.hasOwn(settings, "cliApprovalMode")) cliApprovalMode = settings.cliApprovalMode ?? "ask";
    },
    setModelSwitchPending(threadId, pending) { if (pending) modelSwitches.add(threadId); else modelSwitches.delete(threadId); },
    remember(thread) {
      if (thread?.id) threads.set(thread.id, { id: thread.id, model: typeof thread.model === "string" ? thread.model : null, cwd: thread.cwd,
        ...(thread.executionHandoff ? { executionHandoff: true } : {}),
        reasoningEffort: thread.reasoningEffort ?? null, cliApprovalMode: thread.cliApprovalMode ?? "ask",
        nativeCopilot: thread.nativeCopilot === true || thread.modelProvider === "mycodex-copilot",
        nativeRuntime: Boolean(thread.nativeRuntime || thread.nativeProvider || thread.model && !foreign(thread.model)) || ["mycodex-copilot", "mycodex-google"].includes(thread.modelProvider ?? "") });
    },
    thread: id => threads.get(id ?? "") ?? null,
    begin(options) {
      if (!selected) return null;
      const nativeCopilot = nativeModel(selected);
      if (typeof options.clientUserMessageId !== "string" || !options.clientUserMessageId ||
          !Array.isArray(options.input) || !options.input.length || options.input.some(item => !["text", "image", "localImage"].includes(item.type ?? "")) ||
          options.sideConversation || options.parentTurnId || options.toolOutput ||
          (!nativeCopilot && ((options.mode != null && options.mode !== "default") ||
          (options.collaborationMode != null && options.collaborationMode.mode !== "default") ||
          [options.attachments, options.commentAttachments, options.responseItems].some(value => value?.length))))
        throw new Error("CLI 会话支持文本与图片；其他附件、侧聊及执行模式暂不可用。草稿已保留。");
      const id = options.clientUserMessageId;
      if (intents.has(id)) throw new Error("This draft is already being submitted; no duplicate thread was created.");
      const model = selected;
      intents.set(id, { model, reasoningEffort, cliApprovalMode });
      return { options: { ...options, skipAutoTitleGeneration: true,
        ...(!nativeCopilot ? { useAppServerPermissionDefault: true, permissionSelection: undefined, permissionsConfig: null } : {}),
        collaborationMode: { mode: nativeCopilot ? options.collaborationMode?.mode ?? options.mode ?? "default" : "default",
          settings: { ...options.collaborationMode?.settings, model, reasoning_effort: reasoningEffort, developer_instructions: options.collaborationMode?.settings?.developer_instructions ?? null } } },
        finish: () => intents.delete(id) };
    },
    outgoing(type, payload) {
      if (type !== "mcp-request" || payload?.hostId !== "local") return payload;
      const request = payload.request!, params = request?.params;
      if (!params) return payload;
      if (["turn/start", "turn/addUserMessage", "thread/fork"].includes(request.method ?? "") && modelSwitches.has(params.threadId ?? ""))
        throw new Error("模型切换尚未完成，请稍候再发送；没有向 CLI 发送消息。");
      let model: string | null | undefined, settings: SessionIntent | undefined;
      if (request.method === "thread/start" && !params.ephemeral && (params.threadSource == null || params.threadSource === "user")) {
        const explicit = params.model ?? params.collaborationMode?.settings?.model;
        settings = [...intents.values()].find(value => value.model === explicit);
        if (foreign(explicit) && settings) model = explicit;
      }
      else if (["turn/start", "turn/addUserMessage", "thread/resume", "thread/fork"].includes(request.method ?? ""))
        { settings = threads.get(params.threadId ?? ""); model = settings?.model; }
      if (settings?.nativeRuntime && model && !foreign(model)) return payload;
      if (!model && !settings?.nativeCopilot && !settings?.nativeRuntime) return payload;
      if (!settings?.nativeCopilot && !settings?.nativeRuntime && !nativeModel(model) && params.collaborationMode != null && params.collaborationMode.mode !== "default")
        throw new Error("CLI 会话暂不支持该协作模式。");
      return { ...payload, request: { ...request, params: normalize(params, model, settings!, request.method) } };
    },
    observe(message) {
      if (message?.hostId !== "local") return;
      if (message.type === "mcp-response") {
        const value = message.message?.result;
        if (value?.thread) this.remember({ ...value.thread,
          ...(!value.thread.model && foreign(value.model) ? { model: value.model } : {}) });
        if (Array.isArray(value?.data)) for (const entry of value.data)
          if (entry && typeof entry === "object") this.remember("thread" in entry ? entry.thread : entry);
      } else if (message.type === "mcp-notification") this.remember(message.params?.thread);
    },
    dispose() { intents.clear(); threads.clear(); modelSwitches.clear(); selected = null; },
  };
}

/** Version-specific host seam; injected classes/bus make it testable without
 * importing or running vendor code. Restores only methods it still owns. */
export function installNativeSessionHooks({ Manager, bus, controller, eligible, configureDraftModel, changed = () => {} }: {
  Manager: { prototype: NativeManager }; bus: NativeBus; controller: SessionController; eligible: () => boolean;
  configureDraftModel?: (model: string, effort: string | null) => Promise<boolean>; changed?: () => void;
}) {
  const prototype = Manager?.prototype;
  if (typeof prototype?.startConversation !== "function" || typeof bus?.dispatchMessage !== "function" ||
      typeof bus?.subscribe !== "function") throw new Error("Unsupported native session contract.");
  const start = prototype.startConversation, dispatch = bus.dispatchMessage, defaults = prototype.setDefaultModelConfig;
  const foreign = (model: unknown): model is string => typeof model === "string" && /^mycodex\/[a-z][a-z0-9-]*\/.+/.test(model);
  const policies = new Map<RequestClient, { original: RequestClient["getThreadPrewarmPolicy"]; wrapped: RequestClient["getThreadPrewarmPolicy"] }>(), active = new Map<RequestClient, number>();
  let disposed = false;
  function wrappedStart(this: NativeManager, options: NativeOptions, ...rest: unknown[]) {
    if (disposed || this.hostId !== "local") return start.call(this, options, ...rest);
    if (options.sideConversation || options.parentTurnId || (options.threadSource != null && options.threadSource !== "user"))
      return start.call(this, options, ...rest);
    // The native workspace may retain its local, non-persisted model override
    // on a subsequent draft. Admit its explicit selection through the same
    // first-send intent as our component, never through global configuration.
    const inherited = options.collaborationMode?.settings?.model ?? options.model;
    if (!controller.selection() && foreign(inherited)) {
      if (!eligible()) throw new Error("CLI 草稿接入不可用，尚未发送。");
      controller.select(inherited);
      controller.configure({ reasoningEffort: options.collaborationMode?.settings?.reasoning_effort ?? options.effort ?? null });
    }
    if (!controller.selection()) return start.call(this, options, ...rest);
    if (!eligible()) throw new Error("CLI 草稿接入不可用，尚未发送。请返回新建会话后重新选择引擎。");
    const client = this.requestClient;
    if (typeof client?.getThreadPrewarmPolicy !== "function") throw new Error("Native draft prewarm contract is unavailable; no CLI message was sent.");
    const intent = controller.begin(options);
    if (!intent) return start.call(this, options, ...rest);
    if (!policies.has(client)) {
      const original = client.getThreadPrewarmPolicy;
      const wrapped = function(this: RequestClient, ...args: unknown[]) { return active.get(client) ? Promise.resolve("disabled") : original.apply(this, args); };
      client.getThreadPrewarmPolicy = wrapped; policies.set(client, { original, wrapped });
    }
    active.set(client, (active.get(client) || 0) + 1); changed();
    // The pinned UI's onFirstTurnReady callback only generates a title with
    // the native model. CLI threads use their first-message preview instead.
    const lifecycle = { ...(rest[0] as object), onFirstTurnReady() {} };
    return Promise.resolve().then(() => start.call(this, intent.options, lifecycle, ...rest.slice(1))).finally(() => {
      active.set(client, (active.get(client) ?? 1) - 1); intent.finish(); changed();
    });
  }
  function wrappedDispatch(this: NativeBus, type: string, payload: NativeEnvelope) {
    let outgoing;
    try { outgoing = controller.outgoing(type, payload); }
    catch (cause) { const error = cause instanceof Error ? cause : new Error(String(cause));
      // Complete the original pending request with an explicit rejection. Never
      // retry an uncertain send or send it to a different backend.
      bus.dispatchHostMessage({ type: "mcp-response", hostId: payload.hostId,
        message: { id: payload.request!.id, error: { code: -32602, message: error.message } } }); return;
    }
    return dispatch.call(this, type, outgoing);
  }
  async function wrappedDefaults(this: NativeManager, model: string, effort: string | null, ...rest: unknown[]) {
    if (disposed || this.hostId !== "local" || !configureDraftModel) return defaults!.call(this, model, effort, ...rest);
    if (foreign(model) && await configureDraftModel(model, effort)) {
      changed();
      // The pinned native UI understands this as an in-memory override. It
      // keeps its displayed selection without expecting config.toml to change.
      return { status: "okOverridden" };
    }
    const result = await defaults!.call(this, model, effort, ...rest);
    if (!foreign(model)) { await configureDraftModel(model, effort); changed(); }
    return result;
  }
  prototype.startConversation = wrappedStart; bus.dispatchMessage = wrappedDispatch;
  if (typeof defaults === "function" && configureDraftModel) prototype.setDefaultModelConfig = wrappedDefaults;
  const receive = (message: NativeEnvelope) => { controller.observe(message); changed(); };
  const unsubscribers = [bus.subscribe("mcp-response", receive), bus.subscribe("mcp-notification", receive)];
  return { dispose() {
    disposed = true;
    if (prototype.startConversation === wrappedStart) prototype.startConversation = start;
    if (prototype.setDefaultModelConfig === wrappedDefaults) prototype.setDefaultModelConfig = defaults;
    if (bus.dispatchMessage === wrappedDispatch) bus.dispatchMessage = dispatch;
    for (const [client, { original, wrapped }] of policies) if (client.getThreadPrewarmPolicy === wrapped) client.getThreadPrewarmPolicy = original;
    for (const unsubscribe of unsubscribers) unsubscribe();
  } };
}
