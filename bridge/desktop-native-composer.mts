import "../tools/typescript-runtime.mjs";
import type { SessionController, UiServices, UiThread, UiModel, SessionPreferences, CliSettingsUpdate, MountedComponent, HostWindow, NativeModules, NativeManager, NativeBus } from "./desktop-diy-contracts.mjs";
import type { ApprovalMode } from "../gateway/contracts.mjs";
import { createNativeSessionController, installNativeSessionHooks } from "./desktop-native-session.mjs";
import { desktopPickerBinding } from "./desktop-model-controls.mjs";
import { currentHostContracts } from "./desktop-current-host-contract.mjs";
import { mountNativeEnginePicker } from "./diy/execution-picker.mjs";
import { modelExecutionIdentity } from "./desktop-execution-model.mjs";

/** Desktop uses a memory router. Its document URL does not identify the chat.
 * Reuse the committed-Fiber resolver; read only the containing router context. */
export function readNativeComposerRoute(container: HTMLElement | null): { pathname: string; key: string | null } | null {
  type Location = { pathname?: string; key?: string | null };
  type Props = { value?: { location?: Location }; location?: Location; router?: { state?: { location?: Location } } };
  return (desktopPickerBinding as unknown as <T>(anchor: null, container: HTMLElement | null, read: (groups: unknown, props?: Props) => T) => { state: T } | null)(null, container, (_groups, props) => {
    const location = props?.value?.location ?? props?.location ?? props?.router?.state?.location;
    return typeof location?.pathname === "string" && location.pathname.startsWith("/")
      ? { pathname: location.pathname, key: location.key ?? null } : null;
  })?.state ?? null;
}

export interface NativeDraftPicker {
  model: string; reasoningEffort?: string | null; disabled?: boolean; modelOptionsDisabled?: boolean; reasoningEffortDisabled?: boolean;
  modelOptions: { model: { model: string; displayName?: string; isDefault?: boolean; defaultReasoningEffort?: string; supportedReasoningEfforts?: { reasoningEffort: string }[] }; disabledReason?: unknown }[];
  onSelectModel(model: string, effort: string | null): unknown;
  selectedServiceTier?: string | null;
  serviceTierOptions?: { value: string | null; label?: unknown; iconKind?: string; speedMultiplier?: number }[];
  serviceTierOptionsLoading?: boolean;
  onSelectServiceTier?(value: string | null): unknown;
}

/** Keep speed owned by the host, including its account/model capability gate.
 * Never replay an unacknowledged selection or apply it to a different chat. */
export async function selectHostSpeed({ value, read, current, wait = () => new Promise<void>(resolve => setTimeout(resolve, 25)) }: {
  value: string | null; read(): NativeDraftPicker | null; current(): boolean; wait?: () => Promise<void>;
}) {
  const before = read();
  if (!current() || !before || before.model.startsWith("mycodex/") || before.disabled || before.serviceTierOptionsLoading ||
      !before.onSelectServiceTier || !before.serviceTierOptions?.some(option => option.value === value))
    throw new Error("当前模型的响应速度设置暂不可用，请刷新后重试。");
  if (await before.onSelectServiceTier(value) === false) throw new Error("客户端拒绝了响应速度选择。");
  for (let attempt = 0; attempt < 400; attempt++) {
    const after = read();
    if (!current() || after?.model !== before.model) throw new Error("聊天或模型已变化，响应速度设置未应用到其他聊天。");
    if ((after.selectedServiceTier ?? null) === value) return;
    await wait();
  }
  throw new Error("客户端尚未确认响应速度，请刷新后核对。");
}
/** Use the host's own window-scoped selection action, including its prewarm
 * invalidation. An RPC-backed host does not execute renderer Manager methods.
 * A changed draft, rejected action or missing acknowledgement is never retried. */
export async function selectHostDraftModel({ model, effort, read, current, wait = () => new Promise<void>(resolve => setTimeout(resolve, 25)) }: {
  model: string | null; effort: string | null; read(): NativeDraftPicker | null; current(): boolean; wait?: () => Promise<void>;
}): Promise<SessionPreferences & { model: string | null }> {
  const before = read();
  if (!current() || !before || before.disabled || before.modelOptionsDisabled)
    throw new Error("当前模型入口暂不可用；选择未应用，请稍后重试。");
  const native = (value: string) => !value.startsWith("mycodex/");
  const options = before.modelOptions.filter(option => option.disabledReason == null);
  const target = options.find(option => option.model.model === (model ?? (native(before.model) ? before.model :
    options.find(option => option.model.isDefault && native(option.model.model))?.model.model)));
  if (!target) throw new Error("该模型未出现在当前目录，请刷新模型后重试。");
  const levels = target.model.supportedReasoningEfforts?.map(value => value.reasoningEffort) ?? [];
  const desired = effort ?? target.model.defaultReasoningEffort ?? levels[0] ?? null;
  const chosen = !levels.length && desired === "none" ? null : desired;
  const actualEffort = (value: string | null | undefined) => !levels.length && value === "none" ? null : value ?? null;
  if (chosen != null && !levels.includes(chosen)) throw new Error("该模型不支持所选推理强度；选择未应用。");
  if (target.model.model === before.model && before.reasoningEffortDisabled && actualEffort(before.reasoningEffort) !== chosen)
    throw new Error("当前模型的推理设置不可调整。");
  const accepted = await before.onSelectModel(target.model.model, chosen);
  if (accepted === false) throw new Error("客户端拒绝了模型选择，当前模型保持不变。");
  for (let attempt = 0; attempt < 400; attempt++) {
    if (!current()) throw new Error("选择上下文已变化；模型设置未应用到其他聊天。");
    const after = read();
    if (after?.model === target.model.model && actualEffort(after.reasoningEffort) === chosen)
      return { model: native(after.model) ? null : after.model, reasoningEffort: chosen };
    await wait();
  }
  throw new Error("客户端尚未确认模型选择，请刷新后核对。");
}

/** Only model/effort choices within the existing native credential source
 * can reuse the host's session. A different owner requires a new chat. */
export function sameNativeModelSource(current: string | null | undefined, target: string) {
  if (!current) return false;
  const before = modelExecutionIdentity(current), after = modelExecutionIdentity(target);
  return (!before.engine || /^codex-(?:copilot|gemini)$/.test(before.engine)) && before.engine === after.engine && before.source === after.source;
}

export { mountNativeEnginePicker } from "./diy/execution-picker.mjs";

/** Pinned native integration: runtime import of already-loaded vendor modules,
 * no source rewriting or renderer-wide platform/prototype interception. */
export async function mountCurrentNativeSessions({ window, services, importModule = url => import(url) }: { window: HostWindow; services: UiServices; importModule?: (url: string) => Promise<NativeModules> }) {
  const contract = currentHostContracts.find(item => item.version === window.electronBridge?.getSentryInitOptions?.().appVersion);
  if (!contract) return null;
  if (window.codexWindowType && window.codexWindowType !== "electron") return null;
  const draftRoute = (route: string | undefined) => ["/", "/index.html", "/hotkey-window/new-thread"].includes(route ?? "") ||
    /^\/local\/client-new-thread(?::|%3A)[0-9a-f-]{36}$/i.test(route ?? "");
  let [shared, initial] = await Promise.all([importModule(contract.sharedModule), importModule(contract.initialModule)]);
  const managerExport = "managerExport" in contract ? contract.managerExport : "VUn";
  const busExport = "busExport" in contract ? contract.busExport : "eLt";
  if ("moduleFormat" in contract && contract.moduleFormat === "rspack-cache") {
    const runtime = shared.__webpack_require__ as ((id: string) => unknown) & { c?: Record<string, { exports?: NativeModules; error?: unknown }> };
    const factories = initial.__webpack_modules__ as Record<string, unknown> | undefined;
    if (typeof runtime !== "function" || !runtime.c || typeof runtime.c !== "object" ||
        !factories || !Object.hasOwn(factories, contract.managerModuleId))
      throw new Error("Native page runtime differs from the verified adapter; backend routing remains available.");
    // Observe the existing page's module cache only. Calling require or a
    // factory here would initialize vendor services outside their lifecycle.
    const cached = (id: string, field: string): NativeModules => {
      const entry = runtime.c![id];
      if (!entry) return { [field]: undefined };
      if (entry.error || !entry.exports || typeof entry.exports !== "object")
        throw new Error("Native page runtime cache is unavailable; backend routing remains available.");
      return entry.exports;
    };
    initial = cached(contract.managerModuleId, managerExport);
    shared = cached(contract.busModuleId, busExport);
  }
  const Manager = initial[managerExport] as (new (...args: never[]) => NativeManager) | undefined;
  const bus = shared[busExport] as NativeBus | undefined;
  const managerDeclared = Object.hasOwn(initial, managerExport), busDeclared = Object.hasOwn(shared, busExport);
  const managerReady = managerDeclared && typeof Manager === "function" && typeof Manager.prototype?.startConversation === "function" &&
    typeof Manager.prototype.setDefaultModelConfig === "function";
  const busReady = busDeclared && typeof bus?.dispatchMessage === "function" && typeof bus?.dispatchHostMessage === "function" && typeof bus?.subscribe === "function";
  const managerPending = managerDeclared && Manager === undefined, busPending = busDeclared && bus === undefined;
  if (!(managerReady || managerPending) || !(busReady || busPending))
    throw new Error(`Native page capabilities differ from the verified adapter; backend routing remains available. ${JSON.stringify({
      managerExport, managerDeclared, managerType: typeof Manager, managerReady, busExport, busDeclared, busType: typeof bus, busReady })}`);
  // The installed bundles publish live bindings before their lazy module
  // initializers run. Let the host initialize them through its normal lifecycle;
  // the existing watcher polls again without touching the page or sending RPCs.
  if (managerPending || busPending) return "pending" as const;
  const controller = createNativeSessionController();
  const hostRpc = "sessionTransport" in contract && contract.sessionTransport === "host-rpc";
  const nativeControlSelector = "modelControl" in contract.ui ? contract.ui.modelControl : '[data-codex-intelligence-trigger][data-composer-navigation-target="reasoning"]';
  let catalog: Promise<UiModel[]> | null;
  const modelServices: Pick<UiServices, "listModels" | "refreshModels" | "updateSettings" | "selectDraftModel" | "selectThreadModel" | "setApprovalDefault" | "openModelSources" | "readNativeSpeed" | "selectNativeSpeed"> = { listModels: () => withNativeModels(catalog ??= services.listModels().catch(error => { catalog = null; throw error; })),
    ...(services.openModelSources ? { openModelSources: () => services.openModelSources!() } : {}),
    refreshModels: () => { catalog = null; return withNativeModels(catalog = (services.refreshModels ? services.refreshModels() : services.listModels())
      .catch(error => { catalog = null; throw error; })); },
    updateSettings: async (settings: CliSettingsUpdate) => { const saved = await services.updateSettings(settings); catalog = null; return saved; },
    setApprovalDefault: async settings => {
      if (!services.setApprovalDefault) throw new Error("CLI approval preference service is unavailable.");
      const saved = await services.setApprovalDefault(settings); catalog = null; return saved;
    } };
  const document = window.document;
  let picker: (MountedComponent & { render(): void }) | null = null, disposed = false, route: { pathname: string; key: string | null } | null = null, nativeControl: HTMLElement | null = null, originalDisplay: { value: string; priority: string } | undefined;
  const restoreNative = () => {
    if (nativeControl?.dataset.mycodexNativeSuppressed === "1") {
      if (nativeControl.style.getPropertyValue("display") === "none") {
        if (originalDisplay?.value) nativeControl.style.setProperty("display", originalDisplay.value, originalDisplay.priority);
        else nativeControl.style.removeProperty("display");
      }
      delete nativeControl.dataset.mycodexNativeSuppressed;
    }
  };
  const localId = () => /^\/local\/([0-9a-f-]{36})$/.exec(route?.pathname ?? "")?.[1] ?? null;
  const editorContainer = () => {
    const containers = [...document.querySelectorAll<HTMLElement>('[data-composer-input]')]
      .filter(node => node.getClientRects().length && node.querySelector('[contenteditable]'));
    return containers.length === 1 ? containers[0] : null;
  };
  const syncRoute = () => {
    const next = readNativeComposerRoute(editorContainer());
    if (!next) return route;
    if (route && (next.pathname !== route.pathname || next.key !== route.key)) {
      // First send creates a client draft and navigates before async manager
      // creation. Carry this draft's choice across that one handoff.
      const handoff = ["/", "/index.html", "/hotkey-window/new-thread"].includes(route.pathname) &&
        /^\/local\/client-new-thread(?::|%3A)/i.test(next.pathname);
      if (!handoff) controller.select(null);
    }
    route = next; return route;
  };
  // Generic ChatGPT also uses the shared editor. The version-pinned native
  // workspace control is required before offering a CLI choice on home.
  const eligible = () => !localId() && draftRoute(route?.pathname) && Boolean(editorContainer()) &&
    [...document.querySelectorAll('[data-composer-navigation-target="workspace-project"]')].some(node => node.getClientRects().length);
  const readDraftPicker = (): NativeDraftPicker | null => (desktopPickerBinding as unknown as <T>(groups: null, element: HTMLElement | null,
    read: (groups: unknown, props?: Partial<NativeDraftPicker>) => T | null) => { state: T } | null)(null, nativeControl, (_groups, props) =>
    typeof props?.model === "string" && Array.isArray(props.modelOptions) && typeof props.onSelectModel === "function" ? props as NativeDraftPicker : null)?.state ?? null;
  if (hostRpc) {
    modelServices.readNativeSpeed = () => {
      const picker = readDraftPicker();
      if (!picker || picker.model.startsWith("mycodex/") || !picker.onSelectServiceTier || !picker.serviceTierOptions?.length) return null;
      return { value: picker.selectedServiceTier ?? null, disabled: Boolean(picker.disabled || picker.serviceTierOptionsLoading),
        options: picker.serviceTierOptions.map(option => ({ value: option.value,
          label: option.iconKind === "fast" ? "快速模式" : option.value === null ? "标准模式" : typeof option.label === "string" ? option.label : option.value,
          ...(option.iconKind === "fast" ? { description: `${option.speedMultiplier ? `${option.speedMultiplier} 倍速度，` : ""}消耗更多额度` } : {}) })) };
    };
    modelServices.selectNativeSpeed = async value => {
      syncRoute(); const location = JSON.stringify(route);
      await selectHostSpeed({ value, read: readDraftPicker,
        current: () => { syncRoute(); return !disposed && location === JSON.stringify(route); } });
    };
  }
  const nativeModels = (items: UiModel[]): UiModel[] => [...items, ...(readDraftPicker()?.modelOptions ?? [])
    .filter(option => option.disabledReason == null && !option.model.model.startsWith("mycodex/"))
    .map(({ model }) => ({ id: model.model, label: model.displayName ?? model.model, nativeDefault: true, canSwitchModel: true,
      efforts: model.supportedReasoningEfforts?.map(level => level.reasoningEffort) ?? [], defaultEffort: model.defaultReasoningEffort }))];
  async function withNativeModels(discovery: Promise<UiModel[]>): Promise<UiModel[]> {
    try { return nativeModels(await discovery); }
    catch (cause) {
      const local = nativeModels([]); if (!local.length) throw cause;
      return local.map(model => ({ ...model, catalogWarning: `其他引擎目录暂不可用：${cause instanceof Error ? cause.message : String(cause)}` }));
    }
  }
  if (hostRpc) modelServices.selectDraftModel = async (model, effort) => {
    syncRoute(); const draft = JSON.stringify(route);
    return selectHostDraftModel({ model, effort, read: readDraftPicker,
      current: () => { syncRoute(); return !disposed && eligible() && draft === JSON.stringify(route); } });
  };
  if (hostRpc) modelServices.selectThreadModel = async settings => {
    syncRoute();
    const thread = controller.thread(settings.threadId);
    if (!thread || thread.executionHandoff || !sameNativeModelSource(thread.model, settings.model)) return null;
    if (localId() !== settings.threadId) throw new Error("当前聊天已变化，模型选择未应用。");
    const location = JSON.stringify(route), picker = readDraftPicker();
    const target = picker?.modelOptions.find(option => option.model.model === settings.model)?.model;
    const levels = target?.supportedReasoningEfforts?.map(value => value.reasoningEffort) ?? [];
    const previous = thread.reasoningEffort ?? picker?.reasoningEffort;
    const effort = Object.hasOwn(settings, "reasoningEffort") ? settings.reasoningEffort ?? null : previous && levels.includes(previous) ? previous : null;
    const selected = await selectHostDraftModel({ model: settings.model, effort, read: readDraftPicker,
      current: () => { syncRoute(); return !disposed && localId() === settings.threadId && location === JSON.stringify(route); } });
    if (selected.model !== settings.model && !(selected.model === null && !settings.model.startsWith("mycodex/"))) throw new Error("原生模型选择尚未确认，请刷新后重试。");
    return { ...thread, model: settings.model, reasoningEffort: selected.reasoningEffort };
  };
  let draftRevision = 0;
  const hooks = installNativeSessionHooks({ Manager: Manager!, bus: bus!, controller,
    eligible: () => {
      // The composer may be inert or temporarily absent by the time the RPC
      // manager starts. Selection was already gated by its visible workspace.
      const current = syncRoute();
      if (!current || !draftRoute(current.pathname)) throw new Error("CLI 草稿上下文已变化，尚未发送。请返回新建会话后重新选择引擎。");
      return true;
    }, configureDraftModel: async (model, effort) => {
      syncRoute();
      if (disposed || !eligible()) return false;
      const revision = ++draftRevision;
      if (!/^mycodex\/[a-z][a-z0-9-]*\/.+/.test(model)) { controller.select(null); return false; }
      const intent = JSON.stringify([route, controller.selection(), controller.preferences()]);
      const available = await modelServices.listModels();
      syncRoute();
      if (disposed || revision !== draftRevision || !eligible() ||
          intent !== JSON.stringify([route, controller.selection(), controller.preferences()]))
        throw new Error("草稿已变化，模型设置未应用；请在当前草稿重新选择。");
      const item = available.find(item => `mycodex/${item.id}` === model);
      if (!item) throw new Error("该引擎模型当前不可用，草稿设置未修改。");
      if (effort != null && !item.efforts?.includes(effort)) throw new Error("该模型不支持所选推理强度，草稿设置未修改。");
      controller.select(model); controller.configure({ reasoningEffort: effort });
      return true;
    }, changed: () => picker?.render() });
  async function update() {
    if (disposed) return;
    syncRoute();
    const container = editorContainer();
    const supported = Boolean(localId()) || eligible();
    if (!container || !supported) { picker?.dispose(); picker = null; restoreNative(); return; }
    const surface = container.closest<HTMLElement>('[data-composer-surface-variant]');
    if (!nativeControl?.isConnected || !surface?.contains(nativeControl)) {
      restoreNative(); nativeControl = null;
      const candidates = [...(surface?.querySelectorAll<HTMLElement>(nativeControlSelector) ?? [])]
        .filter(node => node.getClientRects().length);
      if (candidates.length === 1) {
        nativeControl = candidates[0];
        originalDisplay = { value: nativeControl.style.getPropertyValue("display"), priority: nativeControl.style.getPropertyPriority("display") };
      }
    }
    const hostPicker = hostRpc ? readDraftPicker() : null;
    if (localId() && !controller.thread(localId()) && hostPicker &&
        (!hostPicker.model.startsWith("mycodex/") || /^mycodex\/codex-(?:copilot|gemini)\//.test(hostPicker.model)))
      controller.remember({ id: localId()!, model: hostPicker.model, nativeRuntime: true, reasoningEffort: hostPicker.reasoningEffort ?? null });
    const currentThread = localId() ? controller.thread(localId()) : null;
    const draftPicker = !localId() && hostRpc ? readDraftPicker() : null;
    if (draftPicker) {
      controller.select(draftPicker.model.startsWith("mycodex/") ? draftPicker.model : null);
      controller.configure({ reasoningEffort: draftPicker.reasoningEffort ?? null });
    }
    const model = localId() ? currentThread?.model : controller.selection();
    if (nativeControl) {
      if (currentThread || model) { nativeControl.dataset.mycodexNativeSuppressed = "1"; nativeControl.style.setProperty("display", "none", "important"); }
      else restoreNative();
    }
    const mount = nativeControl?.parentElement ?? container;
    if (!picker || !picker.host.isConnected || picker.host.parentNode !== mount) {
      picker?.dispose(); picker = mountNativeEnginePicker({ document, container: mount, before: nativeControl,
        controller: { ...controller, select(model) { syncRoute(); controller.select(model); } }, services: modelServices,
        currentThread: () => { syncRoute(); return localId() ? controller.thread(localId()) ?? { id: localId()!, model: null } : null; } });
    } else picker.render();
  }
  // Durable ownership comes from gateway history, not browser storage. Reading
  // history works even when the CLI model catalog/login is unavailable.
  try {
    let cursor = null;
    let pages = 0;
    do {
      if (++pages > 1000) throw new Error("CLI history exceeds the initial hydration bound.");
      const page = await services.listThreads({ cursor });
      for (const thread of page.data) controller.remember({ ...thread, model: `mycodex/${thread.model}` });
      if (cursor && cursor === page.nextCursor) throw new Error("CLI history pagination did not advance.");
      cursor = page.nextCursor;
    } while (cursor && !disposed);
  } catch { /* Native response observation also hydrates resumed CLI threads. */ }
  const timer = window.setInterval(update, 500); update();
  return { controller, dispose() { disposed = true; window.clearInterval(timer); hooks.dispose(); picker?.dispose(); restoreNative(); controller.dispose(); } };
}

export function buildNativeSessionsPatch(binding: string, responseEvent: string) {
  return `(async () => {
    const key=${JSON.stringify(binding)}, event=${JSON.stringify(responseEvent)};
    const currentHostContracts=${JSON.stringify(currentHostContracts)};
    if (globalThis.__mycodexNativeSessions?.key===key) return 'active';
    if (!currentHostContracts.some(item=>item.version===globalThis.electronBridge?.getSentryInitOptions?.().appVersion)) return 'unsupported';
    globalThis.__mycodexCliSelector?.dispose();
    globalThis.__mycodexNativeSessions?.dispose();
    const pending=new Map();
    const receive=e=>{const value=e.detail,call=pending.get(value?.id);if(!call)return;pending.delete(value.id);clearTimeout(call.timer);value.error?call.reject(new Error(value.error)):call.resolve(value.result);};
    globalThis.addEventListener(event,receive);
    const request=(method,params={})=>new Promise((resolve,reject)=>{const id=crypto.randomUUID();const timer=setTimeout(()=>{pending.delete(id);reject(new Error('CLI request timed out; no automatic retry.'));},['listModels','refreshModels'].includes(method)?50000:20000);pending.set(id,{resolve,reject,timer});globalThis[key](JSON.stringify({id,method,params}));});
    const createNativeSessionController=${createNativeSessionController.toString()};
    const installNativeSessionHooks=${installNativeSessionHooks.toString()};
    const desktopPickerBinding=${desktopPickerBinding.toString()};
    const readNativeComposerRoute=${readNativeComposerRoute.toString()};
    const selectHostDraftModel=${selectHostDraftModel.toString()};
    const selectHostSpeed=${selectHostSpeed.toString()};
    const modelExecutionIdentity=${modelExecutionIdentity.toString()};
    const sameNativeModelSource=${sameNativeModelSource.toString()};
    const mountNativeEnginePicker=${mountNativeEnginePicker.toString()};
    try {
      const ui=await (${mountCurrentNativeSessions.toString()})({window:globalThis,services:{listModels:()=>request('listModels'),refreshModels:()=>request('refreshModels'),listThreads:params=>request('listThreads',params),updateSettings:params=>request('updateSettings',params),setApprovalDefault:params=>request('setApprovalDefault',params)}});
      if(ui==='pending'){globalThis.removeEventListener(event,receive);return 'pending';}
      if(!ui){globalThis.removeEventListener(event,receive);return 'unsupported';}
      globalThis.__mycodexNativeSessions={key,dispose(){ui.dispose();globalThis.removeEventListener(event,receive);for(const call of pending.values()){clearTimeout(call.timer);call.reject(new Error('Native selector disconnected.'));}pending.clear();delete globalThis.__mycodexNativeSessions;}};
      return 'active';
    } catch(error){globalThis.removeEventListener(event,receive);throw error;}
  })()`;
}
