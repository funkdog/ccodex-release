import type { UiServices, UiModel, UiThread, SessionController, SessionPreferences, MountedComponent } from "../desktop-diy-contracts.mjs";
import type { ApprovalMode } from "../../gateway/contracts.mjs";
import { modelExecutionIdentity } from "../desktop-execution-model.mjs";

/** One compact footer trigger. All settings live in a keyboard-accessible
 * popover; browsing engines/sources never changes a running conversation. */
export function mountNativeEnginePicker({ document, container, before = null, controller, services, currentThread }: {
  document: Document; container: HTMLElement; before?: HTMLElement | null; controller: SessionController;
  services: Pick<UiServices, "listModels" | "refreshModels" | "updateSettings" | "selectDraftModel" | "selectThreadModel" | "setApprovalDefault" | "openModelSources" | "readNativeSpeed" | "selectNativeSpeed">;
  currentThread: () => UiThread | null;
}): MountedComponent & { render(): void } {
  const host = document.createElement("span"); host.dataset.mycodexNativeEngine = "1";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>
    :host{display:inline-flex;flex:0 1 auto;min-width:0;max-width:250px;align-items:center;font:13px/1.45 system-ui;color:inherit;pointer-events:auto;-webkit-app-region:no-drag}
    :host([hidden]),[hidden]{display:none!important}*{box-sizing:border-box}button,select{font:inherit;color:inherit}button{cursor:pointer}button:disabled,select:disabled{cursor:default;opacity:.5}
    .trigger{display:inline-flex;align-items:center;gap:7px;min-width:0;max-width:100%;height:30px;padding:4px 8px;border:0;border-radius:8px;background:transparent;color:inherit;white-space:nowrap}
    .trigger:hover,.trigger[aria-expanded=true]{background:color-mix(in srgb,currentColor 7%,transparent)}.summary{min-width:0;overflow:hidden;text-overflow:ellipsis}.chevron{width:7px;height:7px;flex:none;border-right:1.3px solid currentColor;border-bottom:1.3px solid currentColor;transform:translateY(-2px) rotate(45deg);opacity:.55}
    .trigger[data-error=true]::before{content:'';width:5px;height:5px;border-radius:50%;background:#c64635;flex:none}.trigger[data-saving=true] .summary{opacity:.55}
    .panel{position:fixed;inset:auto;margin:0;width:min(340px,calc(100vw - 24px));padding:16px;border:1px solid color-mix(in srgb,CanvasText 12%,transparent);border-radius:16px;background:Canvas;color:CanvasText;box-shadow:0 8px 36px #0002;overflow:auto;outline:none;z-index:2147483600;font:13px/1.45 system-ui}
    header{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}h2{font-size:14px;font-weight:600;margin:0}button.close{border:0;background:transparent;border-radius:6px;width:25px;height:25px;font-size:19px;line-height:1;opacity:.55}
    label{display:block;color:color-mix(in srgb,CanvasText 65%,transparent);font-size:12px;margin:12px 0 5px}select{display:block;width:100%;min-width:0;height:35px;padding:6px 9px;background:color-mix(in srgb,CanvasText 3%,Canvas);border:1px solid color-mix(in srgb,CanvasText 13%,transparent);border-radius:8px;outline-offset:2px}
    .preferences{display:grid;grid-template-columns:repeat(auto-fit,minmax(125px,1fr));gap:10px}.preferences label{margin-top:12px}option{background:Canvas;color:CanvasText}.hint{font-size:11px;color:color-mix(in srgb,CanvasText 55%,transparent);margin:12px 0 0;line-height:1.5}
    .status{font-size:12px;line-height:1.5;overflow-wrap:anywhere;margin-top:12px}.status[data-error=true]{color:light-dark(#a9382b,#ff9b8e)}.actions{display:flex;justify-content:flex-end;align-items:center;gap:8px;margin-top:14px}.apply{border:0;border-radius:8px;padding:7px 13px;background:CanvasText;color:Canvas;font-size:12px;font-weight:500}
    .tools{display:flex;align-items:center;gap:12px;border-top:1px solid color-mix(in srgb,CanvasText 9%,transparent);margin-top:16px;padding-top:12px}.tools button{padding:0;border:0;background:none;font-size:12px;color:color-mix(in srgb,CanvasText 60%,transparent)}button:hover{filter:brightness(.93)}
    @media(max-width:520px){:host{max-width:190px}.trigger{padding-inline:6px;font-size:12px}}
  </style><button class="trigger" type="button" aria-label="模型与引擎设置" aria-haspopup="dialog" aria-expanded="false"><span class="summary">引擎</span><span class="chevron" aria-hidden="true"></span></button>
  <section class="panel" popover="manual" role="dialog" aria-label="模型与引擎" tabindex="-1" hidden>
    <header><h2>模型与引擎</h2><button class="close" type="button" aria-label="关闭模型设置">×</button></header>
    <label for="engine">执行引擎</label><select id="engine" aria-label="执行引擎"></select>
    <div class="source-field"><label for="source">模型来源</label><select id="source" aria-label="模型来源"></select></div>
    <label for="model">模型</label><select id="model" aria-label="模型"></select>
    <div class="preferences"><div class="effort-field"><label for="effort">推理强度</label><select id="effort" aria-label="推理强度"></select></div><div class="policy-field"><label for="policy">工具审批</label><select id="policy" aria-label="工具审批"></select></div></div>
    <div class="speed-field" hidden><label for="speed">响应速度</label><select id="speed" aria-label="响应速度"></select><p class="hint speed-hint"></p></div>
    <p class="hint">创建前可选择引擎；会话创建后引擎与模型来源固定，只能切换当前引擎支持的模型。</p>
    <div class="status" role="status" aria-live="polite" hidden></div>
    <div class="actions"><button class="apply" type="button">应用切换</button></div>
    <div class="tools"><button class="refresh" type="button">刷新模型</button><button class="sources" type="button" aria-label="模型来源与密钥">密钥与来源</button></div>
  </section>`;
  const trigger = root.querySelector<HTMLButtonElement>(".trigger")!, panel = root.querySelector<HTMLElement>(".panel")!, summary = root.querySelector<HTMLElement>(".summary")!;
  const engine = root.querySelector<HTMLSelectElement>("#engine")!, source = root.querySelector<HTMLSelectElement>("#source")!, model = root.querySelector<HTMLSelectElement>("#model")!;
  const effort = root.querySelector<HTMLSelectElement>("#effort")!, policy = root.querySelector<HTMLSelectElement>("#policy")!, status = root.querySelector<HTMLElement>(".status")!;
  const speed = root.querySelector<HTMLSelectElement>("#speed")!, speedHint = root.querySelector<HTMLElement>(".speed-hint")!;
  const apply = root.querySelector<HTMLButtonElement>(".apply")!, closeButton = root.querySelector<HTMLButtonElement>(".close")!, refresh = root.querySelector<HTMLButtonElement>(".refresh")!, sources = root.querySelector<HTMLButtonElement>(".sources")!;
  const view = document.defaultView!, effortNames: Record<string, string> = { none: "无", minimal: "最低", low: "低", medium: "中", high: "高", xhigh: "极高", max: "最高", ultra: "超高" };
  const policyNames: Record<string, string> = { ask: "逐次确认", "read-only": "读取自动", auto: "自动批准", deny: "拒绝授权" };
  const engineNames: Record<string, string> = { "": "Codex（应用默认）", "codex-copilot": "Codex · Copilot / API", "codex-gemini": "Codex · Gemini", copilot: "Copilot CLI", antigravity: "Antigravity", "claude-code": "Claude Code", "gemini-cli": "Gemini CLI" };
  let disposed = false, opened = false, loading = false, saving = false, models: UiModel[] = [], error: string | null = null, loadError: string | null = null;
  let pending: string | null = null, draftEngine = "", draftSource = "", lastRender = "", preferredApplied = false, userSelected = false, notice: string | null = null;
  let draftThreadId: string | null | undefined;
  const committed = () => currentThread()?.model ?? controller.selection() ?? "";
  const identity = (item: UiModel) => modelExecutionIdentity(item.id);
  const sourceName = (item: UiModel) => item.sourceLabel ?? (identity(item).source.startsWith("api:") ? item.label.split(" · ").slice(1, -1).join(" · ") || "API 来源" : identity(item).source === "github-copilot" ? "GitHub Copilot" : identity(item).source === "google-account" ? "Google 账号" : "CLI 登录");
  const modelName = (item: UiModel) => item.label.includes(" · ") ? item.label.split(" · ").at(-1)! : identity(item).model.replace(/^api-[a-f0-9]{12}--/, "");
  const rows = (select: HTMLSelectElement, values: [string, string][], value: string) => {
    select.replaceChildren(); for (const [id, label] of values) { const option = document.createElement("option"); option.value = id; option.textContent = label; select.append(option); } select.value = value;
  };
  const available = () => {
    const thread = currentThread(), current = committed(), owner = modelExecutionIdentity(current);
    return thread ? models.filter(item => identity(item).engine === owner.engine && identity(item).source === owner.source &&
      (item.canSwitchModel === true || item.id === current)) : models.filter(item => !item.nativeDefault);
  };
  const resetDraft = () => { pending = committed(); const item = models.find(item => item.id === pending); const value = modelExecutionIdentity(pending); draftEngine = item ? identity(item).engine : value.engine; draftSource = item ? identity(item).source : value.source; };
  const position = () => {
    if (!opened) return; const rect = trigger.getBoundingClientRect(), width = Math.min(340, view.innerWidth - 24);
    panel.style.width = `${width}px`; panel.style.left = `${Math.max(12, Math.min(rect.right - width, view.innerWidth - width - 12))}px`;
    const above = rect.top - 20, below = view.innerHeight - rect.bottom - 20;
    if (above >= Math.min(panel.scrollHeight || 420, 420) || above >= below) {
      panel.style.top = "auto"; panel.style.bottom = `${Math.max(12, view.innerHeight - rect.top + 8)}px`; panel.style.maxHeight = `${Math.max(80, above)}px`;
    } else {
      panel.style.bottom = "auto"; panel.style.top = `${Math.max(12, rect.bottom + 8)}px`; panel.style.maxHeight = `${Math.max(80, below)}px`;
    }
  };
  const close = (focus = false) => { opened = false; try { if (panel.matches(":popover-open")) panel.hidePopover(); } catch {} panel.hidden = true; if (focus) trigger.focus(); render(); };
  const open = () => { resetDraft(); opened = true; panel.hidden = false; try { panel.showPopover(); } catch {} render(); position(); panel.focus(); };
  function render() {
    if (disposed) return;
    const thread = currentThread(), current = committed(), prefs = controller.preferences(thread?.id), currentItem = models.find(item => item.id === current);
    if (draftThreadId !== (thread?.id ?? null)) { draftThreadId = thread?.id ?? null; resetDraft(); }
    const nativeSpeed = services.readNativeSpeed?.() ?? null;
    const key = JSON.stringify([thread?.id, current, prefs, nativeSpeed, loading, saving, models, error, loadError, notice, opened, pending, draftEngine, draftSource]);
    if (key === lastRender) return; lastRender = key;
    const native = !thread?.executionHandoff && Boolean(currentItem?.nativeCopilot || thread?.nativeRuntime || thread?.nativeCopilot);
    host.hidden = false;
    summary.textContent = currentItem ? `${identity(currentItem).source.startsWith("api:") ? sourceName(currentItem) : identity(currentItem).source === "github-copilot" ? "Copilot" : engineNames[identity(currentItem).engine] ?? currentItem.label.split(" · ")[0]} · ${modelName(currentItem)}`
      : current ? modelExecutionIdentity(current).model.replace(/^api-[a-f0-9]{12}--/, "") : thread ? "Codex" : "引擎";
    trigger.title = error ?? loadError ?? currentItem?.label ?? "选择执行引擎与模型";
    trigger.setAttribute("aria-expanded", String(opened)); trigger.dataset.error = String(Boolean(error || loadError)); trigger.dataset.saving = String(saving);
    const choices = available(); if (pending === null) resetDraft();
    const engineRows: [string, string][] = thread ? [[modelExecutionIdentity(current).engine, engineNames[modelExecutionIdentity(current).engine] ?? modelExecutionIdentity(current).engine]]
      : [...new Map(choices.map(item => [identity(item).engine, engineNames[identity(item).engine] ?? item.label.split(" · ")[0]])).entries()];
    if (!thread) engineRows.unshift(["", "Codex（应用默认）"]);
    rows(engine, engineRows, draftEngine);
    const engineModels = choices.filter(item => identity(item).engine === draftEngine);
    const sourceRows = [...new Map(engineModels.map(item => [identity(item).source, sourceName(item)])).entries()];
    if (!sourceRows.some(([id]) => id === draftSource)) draftSource = sourceRows[0]?.[0] ?? "";
    rows(source, sourceRows, draftSource); source.parentElement!.hidden = !draftEngine || sourceRows.length === 1 && draftSource === "cli";
    const filtered = engineModels.filter(item => identity(item).source === draftSource);
    const modelRows: [string, string][] = filtered.map(item => [item.id, modelName(item)]);
    if (!thread && !draftEngine) modelRows.push(["", "应用默认模型"]);
    if (pending && !modelRows.some(([id]) => id === pending) && pending === current) modelRows.push([pending, modelExecutionIdentity(pending).model.replace(/^api-[a-f0-9]{12}--/, "")]);
    rows(model, modelRows, pending ?? "");
    const unchanged = (pending ?? "") === current, levels = currentItem?.efforts?.filter(value => value !== "none") ?? [];
    effort.parentElement!.hidden = !unchanged || !current || !levels.length;
    rows(effort, [["", "默认"], ...levels.map(value => [value, effortNames[value] ?? value] as [string, string])], prefs.reasoningEffort === "none" ? "" : prefs.reasoningEffort ?? "");
    policy.parentElement!.hidden = !unchanged || !current || native;
    speed.parentElement!.hidden = !unchanged || !nativeSpeed;
    rows(speed, nativeSpeed?.options.map(option => [option.value ?? "", option.label]) ?? [], nativeSpeed?.value ?? "");
    speed.disabled = loading || saving || Boolean(nativeSpeed?.disabled);
    speedHint.textContent = nativeSpeed?.options.find(option => option.value === nativeSpeed.value)?.description ?? "";
    speedHint.hidden = !speedHint.textContent;
    const modes = currentItem?.approvalModes ?? ["ask"];
    rows(policy, modes.map(value => [value, policyNames[value] ?? value]), prefs.cliApprovalMode ?? "ask");
    engine.disabled = source.disabled = loading || saving || Boolean(thread);
    model.disabled = loading || saving || !modelRows.length;
    effort.disabled = loading || saving; policy.disabled = loading || saving || modes.length < 2;
    apply.disabled = loading || saving || unchanged || Boolean(thread && !pending) || Boolean(pending && !choices.some(item => item.id === pending));
    apply.textContent = saving ? "切换中…" : "应用切换"; refresh.disabled = loading || saving; sources.hidden = !services.openModelSources;
    status.textContent = error ?? loadError ?? (loading ? "读取模型…" : notice ?? ""); status.dataset.error = String(Boolean(error || loadError)); status.hidden = !status.textContent;
    position();
  }
  async function configure(settings: SessionPreferences & { model?: string }) {
    if (saving || disposed) return false;
    const thread = currentThread(), target = settings.model ?? thread?.model;
    if (thread && settings.model) controller.setModelSwitchPending(thread.id, true);
    saving = true; error = null; notice = null; render(); let success = false;
    try {
      if (thread) {
        if (settings.model && !available().some(item => item.id === settings.model)) throw new Error("会话创建后引擎与模型来源固定，请选择当前引擎支持的模型；更换引擎请新建会话。");
        const native = !thread.executionHandoff && Boolean(thread.nativeCopilot || thread.nativeRuntime || /^mycodex\/codex-(?:copilot|gemini)\//.test(thread.model ?? ""));
        let saved: UiThread | null = native && target && services.selectThreadModel
          ? await services.selectThreadModel({ threadId: thread.id, ...settings, model: target }) : null;
        if (!saved) {
          if (native) throw new Error("当前原生模型设置尚不可用，请刷新后重试。");
          saved = await services.updateSettings({ threadId: thread.id, ...settings });
        }
        if (typeof saved.model !== "string") throw new Error("执行器尚未确认模型选择，请刷新后重试。");
        if (!disposed) controller.remember({ ...saved, model: saved.model.startsWith("mycodex/") || models.some(item => item.nativeDefault && item.id === saved.model) ? saved.model : `mycodex/${saved.model}` });
      } else if (services.selectDraftModel && (Object.hasOwn(settings, "model") || Object.hasOwn(settings, "reasoningEffort"))) {
        const selected = await services.selectDraftModel(settings.model === undefined ? controller.selection() : settings.model || null, settings.reasoningEffort ?? null);
        if (!disposed) { controller.select(selected.model); controller.configure({ ...settings, reasoningEffort: selected.reasoningEffort }); }
      } else if (settings.cliApprovalMode !== undefined) {
        const selected = controller.selection(); if (!selected || !services.setApprovalDefault) throw new Error("当前引擎暂不支持保存审批偏好。");
        const saved = await services.setApprovalDefault({ model: selected, cliApprovalMode: settings.cliApprovalMode }); if (!disposed) controller.configure(saved);
      } else { if (settings.model !== undefined) controller.select(settings.model || null); controller.configure(settings); }
      if (!disposed && !thread && settings.cliApprovalMode !== undefined) {
        const selected = controller.selection(), selectedEngine = modelExecutionIdentity(selected).engine;
        models = models.map(item => identity(item).engine === selectedEngine ? { ...item, defaultCliApprovalMode: settings.cliApprovalMode } : item); controller.setApprovalDefaults(models);
      }
      success = true;
    } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
    finally { if (thread && settings.model) controller.setModelSwitchPending(thread.id, false); saving = false; render(); }
    return success;
  }
  async function load(force = false) {
    if (disposed || loading) return; loading = true; loadError = null; render();
    try {
      models = (await (force && services.refreshModels ? services.refreshModels() : services.listModels())).map(item => ({ ...item, id: item.nativeDefault || item.id.startsWith("mycodex/") ? item.id : `mycodex/${item.id}` }));
      controller.setApprovalDefaults(models); loadError = [...new Set(models.map(item => item.catalogWarning).filter(Boolean))].join("\n") || null;
      if (!opened) resetDraft();
      const preferred = models.find(item => item.preferredSource);
      if (preferred && !preferredApplied && !userSelected && !currentThread()) { preferredApplied = true; await configure({ model: preferred.id, reasoningEffort: null }); if (!opened) resetDraft(); }
    } catch (cause) { loadError = cause instanceof Error ? cause.message : String(cause); }
    finally { loading = false; render(); }
  }
  const chooseEngine = () => { if (currentThread()) return; userSelected = true; draftEngine = engine.value; const first = available().find(item => identity(item).engine === draftEngine); draftSource = first ? identity(first).source : ""; pending = first?.id ?? ""; error = null; render(); };
  const chooseSource = () => { if (currentThread()) return; userSelected = true; draftSource = source.value; pending = available().find(item => identity(item).engine === draftEngine && identity(item).source === draftSource)?.id ?? ""; error = null; render(); };
  const chooseModel = () => { userSelected = true; pending = model.value; error = null; render(); };
  const applyModel = () => { const selected = pending ?? ""; void configure({ model: selected }).then(success => { if (success && !disposed) close(true); }); };
  const changeEffort = () => { void configure({ reasoningEffort: effort.value || null }); };
  const changePolicy = () => { void configure({ cliApprovalMode: policy.value as ApprovalMode }); };
  const changeSpeed = async () => {
    if (saving || !services.selectNativeSpeed) return;
    const value = speed.value || null; saving = true; error = null; render();
    try { await services.selectNativeSpeed(value); }
    catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
    finally { saving = false; render(); }
  };
  const toggle = () => opened ? close(true) : open(), closeClick = () => close(true), reload = () => { void load(true); };
  const openSources = () => { void services.openModelSources?.().then(() => close()).catch(cause => { error = cause.message; render(); }); };
  const outside = (event: Event) => { if (opened && !event.composedPath().includes(host)) close(); };
  const keydown = (event: KeyboardEvent) => { if (event.key === "Escape" && opened) { event.preventDefault(); close(true); } };
  const isolate = (event: Event) => event.stopPropagation(), localEvents = ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick", "keydown", "keyup", "beforeinput", "input", "change", "focusin", "focusout"];
  for (const event of localEvents) root.addEventListener(event, isolate); root.addEventListener("keydown", keydown as EventListener);
  trigger.addEventListener("click", toggle); closeButton.addEventListener("click", closeClick); engine.addEventListener("change", chooseEngine); source.addEventListener("change", chooseSource); model.addEventListener("change", chooseModel);
  apply.addEventListener("click", applyModel); effort.addEventListener("change", changeEffort); policy.addEventListener("change", changePolicy); speed.addEventListener("change", changeSpeed); refresh.addEventListener("click", reload); sources.addEventListener("click", openSources);
  document.addEventListener("pointerdown", outside, true); view.addEventListener("resize", position); document.addEventListener("scroll", position, true);
  container.insertBefore(host, before); render(); void load();
  return { host, render, dispose() {
    if (disposed) return; close(); disposed = true; document.removeEventListener("pointerdown", outside, true); document.removeEventListener("scroll", position, true); view.removeEventListener("resize", position);
    for (const event of localEvents) root.removeEventListener(event, isolate); root.removeEventListener("keydown", keydown as EventListener);
    trigger.removeEventListener("click", toggle); closeButton.removeEventListener("click", closeClick); engine.removeEventListener("change", chooseEngine); source.removeEventListener("change", chooseSource); model.removeEventListener("change", chooseModel);
    apply.removeEventListener("click", applyModel); effort.removeEventListener("change", changeEffort); policy.removeEventListener("change", changePolicy); speed.removeEventListener("change", changeSpeed); refresh.removeEventListener("click", reload); sources.removeEventListener("click", openSources); host.remove();
  } };
}
