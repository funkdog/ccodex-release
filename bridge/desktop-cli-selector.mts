import "../tools/typescript-runtime.mjs";
import { currentHostContracts } from "./desktop-current-host-contract.mjs";
import type { UiServices, UiRequest, UiRpcResults, UiThread, MountedComponent, HostWindow } from "./desktop-diy-contracts.mjs";
/** Business functions shared by any UI surface. No DOM, CDP or native config. */
export function createCliSelectorServices(request: UiRequest): UiServices & Required<Pick<UiServices, "refreshModels">> {
  let creating = false;
  return {
    async listThreads({ cursor = null } = {}) {
      const result = await request("thread/list", { cursor, limit: 30, sortKey: "updated_at", archived: false });
      return { data: result.data.map(thread => ({ id: thread.id, cwd: thread.cwd, model: thread.model,
        title: thread.name || thread.preview || `CLI · ${thread.model}`, updatedAt: thread.updatedAt,
        ...(thread.reasoningEffort !== undefined ? { reasoningEffort: thread.reasoningEffort } : {}),
        ...(thread.cliApprovalMode !== undefined ? { cliApprovalMode: thread.cliApprovalMode } : {}) })), nextCursor: result.nextCursor };
    },
    async refreshModels() {
      await request("gateway/models/refresh", {});
      return this.listModels();
    },
    async listModels() {
      const models = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        if (++pages > 100) throw new Error("CLI model pagination exceeded its limit.");
        const result: UiRpcResults["model/list"] = await request("model/list", { cursor, limit: 100 });
        const warnings = result.warnings ?? [];
        for (const model of result.data) models.push({ id: model.model, label: model.displayName || model.model,
          engine: model.model.slice(0, model.model.indexOf("/")),
          ...(model.inputModalities ? { inputModalities: model.inputModalities } : {}),
          ...(model.nativeCopilot ? { nativeCopilot: true } : {}),
          ...(model.nativeProvider ? { nativeProvider: model.nativeProvider } : {}),
          ...(model.canSwitchModel ? { canSwitchModel: true } : {}),
          ...(warnings.length ? { catalogWarning: warnings.join("\n") } : {}),
          ...(model.supportedReasoningEfforts ? { efforts: model.supportedReasoningEfforts.map(value => value.reasoningEffort),
            defaultEffort: model.defaultReasoningEffort } : {}),
          ...(model.cliApprovalModes ? { approvalModes: model.cliApprovalModes } : {}),
          ...(model.defaultCliApprovalMode ? { defaultCliApprovalMode: model.defaultCliApprovalMode } : {}) });
        if (result.nextCursor === cursor && cursor !== null) throw new Error("Model pagination did not advance.");
        cursor = result.nextCursor;
        if (models.length > 2000) throw new Error("CLI model catalog exceeds the selector limit.");
      } while (cursor);
      return models.sort((a, b) => Number(Boolean(b.nativeCopilot && /^codex-copilot\/gpt-/i.test(b.id))) -
        Number(Boolean(a.nativeCopilot && /^codex-copilot\/gpt-/i.test(a.id))));
    },
    async setApprovalDefault({ model, cliApprovalMode }) {
      const target = model.startsWith("mycodex/") ? model.slice("mycodex/".length) : model;
      if (!/^[a-z][a-z0-9-]*\/.+/.test(target) || target.length > 256) throw new Error("Choose an available CLI model.");
      return request("gateway/approval/default/set", { model: target, cliApprovalMode });
    },
    async updateSettings({ threadId, model, reasoningEffort, cliApprovalMode }) {
      if (typeof threadId !== "string" || !/^[0-9a-f-]{36}$/.test(threadId)) throw new Error("Invalid CLI thread identity.");
      if (model !== undefined && typeof model !== "string") throw new Error("Choose an available CLI model.");
      const target = model?.startsWith("mycodex/") ? model.slice("mycodex/".length) : model;
      if (target !== undefined && (typeof target !== "string" || !/^[a-z][a-z0-9-]*\/.+/.test(target) || target.length > 256)) throw new Error("Choose an available CLI model.");
      const { thread } = await request("thread/settings/update", { threadId,
        ...(target !== undefined ? { model: target } : {}),
        ...(reasoningEffort !== undefined ? { reasoningEffort } : {}), ...(cliApprovalMode !== undefined ? { cliApprovalMode } : {}) });
      return thread;
    },
    async createThread({ model, cwd }) {
      if (creating) throw new Error("A CLI thread is already being created.");
      if (typeof model !== "string" || !/^[a-z][a-z0-9-]*\/.+/.test(model) || model.length > 256 ||
          typeof cwd !== "string" || !cwd.startsWith("/") || cwd.length > 4096 || cwd.includes("\0")) throw new Error("Choose a CLI model and an absolute workspace path.");
      creating = true;
      try {
        const result = await request("thread/start", { model, cwd, approvalPolicy: "on-request", sandbox: "danger-full-access" });
        return { id: result.thread.id, model: result.model, cwd: result.cwd };
      } finally { creating = false; }
    },
  };
}

/** Serializable UI. Services are injected; the component knows no backend or
 * renderer internals and can also mount in an ordinary test/preview page. */
export function mountCliSelector({ document, container, services, openThread, preferences = { read: () => ({}), write: () => {} } }: { document: Document; container: HTMLElement; services: UiServices; openThread: (id: string) => Promise<void>; preferences?: { read(): { cwd?: string; model?: string }; write(value: { cwd?: string; model?: string }): void } }): MountedComponent {
  const host = document.createElement("section");
  host.setAttribute("data-mycodex-cli-selector", "1");
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>
    :host{position:fixed;right:20px;bottom:22px;z-index:2147483600;font:13px system-ui;color:#eee}
    button,input,select{font:inherit;box-sizing:border-box} button{cursor:pointer;background:#373b45;color:inherit;border:1px solid #626875;border-radius:7px;padding:7px 12px}
    button:disabled{opacity:.5;cursor:default} [hidden]{display:none!important}
    form{width:min(360px,calc(100vw - 40px));max-height:calc(100vh - 100px);overflow:auto;padding:16px;margin-bottom:8px;background:#20232a;border:1px solid #606673;border-radius:12px;box-shadow:0 6px 28px #0006}
    h2{font-size:15px;margin:0 0 13px} label{display:block;margin-top:12px} input,select{display:block;width:100%;margin-top:6px;padding:8px;background:#15171c;color:#eee;border:1px solid #626875;border-radius:6px}
    p{line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere} .actions{display:flex;gap:8px;margin-top:14px}
    header{display:flex;justify-content:space-between;align-items:start} [data-close]{border:0;background:none;padding:0 4px;font-size:18px}
    small{display:block;color:#aeb5c2;line-height:1.4;margin-top:5px} .history{border-top:1px solid #414651;margin-top:16px;padding-top:12px}
    .history h3{font-size:13px;margin:0} .threads{max-height:180px;overflow:auto;margin-top:8px;display:grid;gap:6px}
    .threads button{text-align:left;width:100%;background:#292d35;overflow-wrap:anywhere}.threads small{font-size:11px}
  </style><form hidden aria-label="CLI 新会话"><header><h2>CLI 会话</h2><button type="button" data-close aria-label="关闭 CLI 面板">×</button></header>
    <label>引擎与模型<select aria-label="引擎与模型"></select></label>
    <label>工作目录<input aria-label="工作目录" list="mycodex-workspaces" placeholder="选择最近目录，或填写绝对路径" required></label><datalist id="mycodex-workspaces"></datalist>
    <small>会记住最近使用的目录。创建空会话不会调用模型。</small>
    <p role="status" aria-live="polite"></p><div class="actions"><button type="submit">创建会话</button><button type="button" data-refresh>刷新模型</button><button type="button" data-open hidden>打开会话</button></div>
    <small>新 CLI 会话继承该引擎保存的审批偏好；已有会话保留各自设置。CLI 使用自身权限流程，无 Codex 沙箱。</small>
    <section class="history" aria-label="最近 CLI 会话"><header><h3>最近 CLI 会话</h3><button type="button" data-history-refresh>刷新会话</button></header>
      <small data-history-status></small><div class="threads"></div><button type="button" data-more hidden>更多会话</button></section>
  </form><button type="button" data-toggle aria-expanded="false">MyCodex · CLI 会话</button>`;
  const form = root.querySelector<HTMLFormElement>("form")!, select = root.querySelector<HTMLSelectElement>("select")!, input = root.querySelector<HTMLInputElement>("input")!;
  const status = root.querySelector<HTMLElement>('[role="status"]')!, create = root.querySelector<HTMLButtonElement>('[type="submit"]')!;
  const refresh = root.querySelector<HTMLButtonElement>("[data-refresh]")!, open = root.querySelector<HTMLButtonElement>("[data-open]")!, toggle = root.querySelector<HTMLButtonElement>("[data-toggle]")!;
  const close = root.querySelector<HTMLButtonElement>("[data-close]")!, threads = root.querySelector<HTMLElement>(".threads")!, historyStatus = root.querySelector<HTMLElement>("[data-history-status]")!;
  const historyRefresh = root.querySelector<HTMLButtonElement>("[data-history-refresh]")!, more = root.querySelector<HTMLButtonElement>("[data-more]")!, directories = root.querySelector<HTMLDataListElement>("datalist")!;
  let saved: { cwd?: string; model?: string } = {}; try { saved = preferences.read() || {}; } catch {}
  if (typeof saved.cwd === "string") input.value = saved.cwd;
  let disposed = false, loading = false, busy = false, created: UiThread | null = null;
  let listing = false, cursor: string | null = null, recent: UiThread[] = [];
  const render = () => { create.disabled = loading || busy || Boolean(created) || !select.value; refresh.disabled = loading || busy;
    select.disabled = busy || Boolean(created); input.disabled = busy || Boolean(created); open.hidden = !created; open.disabled = busy; };
  const load = async (force = false) => {
    if (loading || busy || disposed) return;
    loading = true; status.textContent = "正在读取 CLI 模型…"; render();
    try {
      const models = await (force && services.refreshModels ? services.refreshModels() : services.listModels());
      if (disposed) return;
      const previous = select.value || saved.model; select.replaceChildren();
      for (const model of models) { const option = document.createElement("option"); option.value = model.id; option.textContent = model.label; select.appendChild(option); }
      if (models.some(model => model.id === previous)) select.value = previous!;
      status.textContent = models.length ? "创建后自动打开；也可从下方找回已有会话。" : "没有可用 CLI 模型，请先完成登录。";
    } catch (cause) { const error = cause instanceof Error ? cause : new Error(String(cause)); if (!disposed) status.textContent = error.message; }
    finally { loading = false; if (!disposed) render(); }
  };
  const list = async (append = false) => {
    if (listing || disposed || !services.listThreads) return;
    listing = true; historyRefresh.disabled = more.disabled = true; historyStatus.textContent = "正在读取会话…";
    try {
      const result = await services.listThreads({ cursor: append ? cursor : null });
      if (disposed) return;
      recent = [...new Map([...(append ? recent : []), ...result.data].map(thread => [thread.id, thread])).values()];
      cursor = result.nextCursor; more.hidden = !cursor; threads.replaceChildren(); directories.replaceChildren();
      for (const cwd of new Set(recent.map(thread => thread.cwd).filter((cwd): cwd is string => Boolean(cwd)))) {
        const option = document.createElement("option"); option.value = cwd; directories.appendChild(option);
      }
      if (!input.value && recent[0]?.cwd && !busy && !created) input.value = recent[0].cwd;
      for (const thread of recent) {
        const button = document.createElement("button"); button.type = "button"; button.textContent = thread.title ?? "";
        button.dataset.threadId = thread.id;
        const detail = document.createElement("small"); detail.textContent = `${thread.model} · ${thread.cwd}`; button.appendChild(detail);
        button.addEventListener("click", () => { if (busy || disposed) return; created = thread; navigate(); });
        threads.appendChild(button);
      }
      historyStatus.textContent = recent.length ? "点击会话继续；刷新页面或重启后仍可找回。" : "还没有 CLI 会话。";
    } catch (cause) { const error = cause instanceof Error ? cause : new Error(String(cause)); if (!disposed) historyStatus.textContent = `会话读取失败：${error.message}`; }
    finally { listing = false; if (!disposed) historyRefresh.disabled = more.disabled = false; }
  };
  const navigate = async () => {
    if (!created || busy || disposed) return;
    busy = true; render();
    try { await openThread(created.id); if (!disposed) { status.textContent = "会话已打开。"; created = null; form.hidden = true; toggle.setAttribute("aria-expanded", "false"); } }
    catch (cause) { const error = cause instanceof Error ? cause : new Error(String(cause)); if (!disposed) status.textContent = `会话已创建：${created?.id}\n打开失败：${error.message}\n可重试打开，不会重复创建。`; }
    finally { busy = false; if (!disposed) render(); }
  };
  const submit = async (event: Event) => {
    event.preventDefault();
    if (busy || loading || created || disposed) return;
    busy = true; render(); status.textContent = "正在创建会话…";
    try {
      created = await services.createThread({ model: select.value, cwd: input.value.trim() });
      if (disposed) return;
      try { saved = { cwd: input.value.trim(), model: select.value }; preferences.write(saved); } catch {}
      list();
      busy = false; render(); await navigate();
    } catch (cause) { const error = cause instanceof Error ? cause : new Error(String(cause)); if (!disposed) status.textContent = `${error.message}\n没有自动重试；如结果不确定，请先检查会话列表。`; }
    finally { busy = false; if (!disposed) render(); }
  };
  const hide = () => { form.hidden = true; toggle.setAttribute("aria-expanded", "false"); };
  const show = () => { form.hidden = !form.hidden; toggle.setAttribute("aria-expanded", String(!form.hidden));
    if (!form.hidden) { if (!select.options.length) load(); list(); } };
  const refreshHistory = () => list(), loadMore = () => list(true);
  const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { hide(); event.stopPropagation(); } };
  const reload = () => load(true);
  toggle.addEventListener("click", show); refresh.addEventListener("click", reload); open.addEventListener("click", navigate); form.addEventListener("submit", submit);
  close.addEventListener("click", hide); historyRefresh.addEventListener("click", refreshHistory); more.addEventListener("click", loadMore); host.addEventListener("keydown", escape);
  container.appendChild(host); render();
  return { host, dispose() { disposed = true; toggle.removeEventListener("click", show); refresh.removeEventListener("click", reload);
    open.removeEventListener("click", navigate); form.removeEventListener("submit", submit); close.removeEventListener("click", hide);
    historyRefresh.removeEventListener("click", refreshHistory); more.removeEventListener("click", loadMore); host.removeEventListener("keydown", escape); host.remove(); } };
}

/** Version-pinned navigation shape observed in the installed app's preload and
 * renderer. Page navigation is separate from creation and never replays it. */
export async function openCurrentHostThread(id: string, window: HostWindow) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id)) throw new Error("Invalid CLI thread identity.");
  const version = window.electronBridge?.getSentryInitOptions?.().appVersion;
  if (!currentHostContracts.some(item => item.version === version)) throw new Error("This renderer version has not been verified.");
  const route = `/local/${id}`;
  window.dispatchEvent(new window.MessageEvent("message", { data: { type: "navigate-to-route", path: route } }));
  for (let count = 0; count < 20; count++) {
    if (window.location.pathname === route) return;
    await new Promise(resolve => window.setTimeout(resolve, 100));
  }
  throw new Error("Desktop did not acknowledge navigation; the created thread was retained.");
}

export function buildCliSelectorPatch(binding: string, responseEvent: string) {
  return `(() => {
    const key = ${JSON.stringify(binding)}, event = ${JSON.stringify(responseEvent)};
    const currentHostContracts = ${JSON.stringify(currentHostContracts)};
    const previous = globalThis.__mycodexCliSelector;
    if (previous?.key === key && previous.host.isConnected) return 'active';
    previous?.dispose();
    if (!document.body || typeof globalThis[key] !== 'function' || !currentHostContracts.some(item=>item.version===globalThis.electronBridge?.getSentryInitOptions?.().appVersion)) return 'unsupported';
    const pending = new Map();
    const receive = event => { const value = event.detail; const call = pending.get(value?.id); if (!call) return;
      pending.delete(value.id); clearTimeout(call.timer); value.error ? call.reject(new Error(value.error)) : call.resolve(value.result); };
    globalThis.addEventListener(event, receive);
    const request = (method, params = {}) => new Promise((resolve, reject) => {
      const id = crypto.randomUUID(); const timer = setTimeout(() => { pending.delete(id); reject(new Error('CLI request timed out; no automatic retry.')); }, ['listModels', 'refreshModels'].includes(method) ? 50000 : 20000);
      pending.set(id, { resolve, reject, timer });
      try { globalThis[key](JSON.stringify({id, method, params})); } catch (cause) { const error = cause instanceof Error ? cause : new Error(String(cause)); clearTimeout(timer); pending.delete(id); reject(error); }
    });
    const ui = (${mountCliSelector.toString()})({ document, container: document.body,
      services: { listModels: () => request('listModels'), refreshModels: () => request('refreshModels'), listThreads: params => request('listThreads', params), createThread: params => request('createThread', params) },
      preferences: { read: () => JSON.parse(localStorage.getItem('mycodex.cli-selector.v1') || '{}'),
        write: value => localStorage.setItem('mycodex.cli-selector.v1', JSON.stringify(value)) },
      openThread: id => (${openCurrentHostThread.toString()})(id, globalThis) });
    globalThis.__mycodexCliSelector = { key, host: ui.host, dispose() { ui.dispose(); globalThis.removeEventListener(event, receive);
      for (const call of pending.values()) { clearTimeout(call.timer); call.reject(new Error('Selector disconnected; no automatic retry.')); }
      pending.clear(); delete globalThis.__mycodexCliSelector; } };
    return 'active';
  })()`;
}
