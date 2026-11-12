import type { GeneralWorkItemRecord } from "../../gateway/spine/work-context.mjs";
import type { GoalRecord } from "../../gateway/spine/work-contracts.mjs";

export const WORK_CARD_URI = "ui://mycodex/work-card-v2.html";
export const WORK_CARD_MIME = "text/html;profile=mcp-app";

/** Serialized browser entry point. The host bridge is the only data channel;
 * no gateway credentials, localhost fetches or business state in localStorage. */
export function mountConversationWorkCard() {
  type Snapshot = { goal: GoalRecord; workItem: GeneralWorkItemRecord };
  type Result = { structuredContent?: unknown; content?: Array<{ type: string; text?: string }>; isError?: boolean };
  type Legacy = { toolOutput?: unknown; toolInput?: { id?: string }; theme?: string;
    callTool?(name: string, arguments_: object): Promise<Result>;
    sendFollowUpMessage?(value: { prompt: string }): Promise<unknown> };
  const legacy = () => (window as Window & { openai?: Legacy }).openai;
  const root = document.querySelector<HTMLElement>("#work-card")!;
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  let boundId: string | null = null, snapshot: Snapshot | null = null, tab: "overview" | "basis" = "overview";
  let connected = false, disposed = false, busy = false, status = "正在接入共同工作…", failed = false;
  let initialReadStarted = false;
  let capabilities: Record<string, unknown> = {}, resize: ResizeObserver | null = null;
  let draft: { revision: number; progress: string; owner: string; description: string; kind: "discussion" | "action"; uncertain?: boolean } | null = null;
  const notify = (method: string, params: object = {}) => {
    if (!disposed && window.parent !== window) window.parent.postMessage({ jsonrpc: "2.0", method, params }, "*");
  };
  const request = (method: string, params: object) => new Promise<unknown>((resolve, reject) => {
    if (disposed || pending.size >= 8 || window.parent === window) { reject(new Error("当前对话的卡片连接不可用。")); return; }
    const id = `work-card:${crypto.randomUUID()}`;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("请求回执尚未确认，请先刷新核对；没有自动重试。")); }, 20000);
    pending.set(id, { resolve, reject, timer });
    window.parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
  });
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string) => {
    const node = document.createElement(tag); node.className = className; if (text !== undefined) node.textContent = text; return node;
  };
  const button = (text: string, action: () => void, primary = false) => {
    const node = element("button", primary ? "primary" : "", text); node.type = "button"; node.disabled = busy; node.onclick = action; return node;
  };
  const field = (parent: HTMLElement, label: string, value: string) => {
    const row = element("div", "field"); row.append(element("span", "label", label), element("div", "value", value)); parent.append(row);
  };
  const decode = (result: Result): Record<string, unknown> => {
    if (result.isError) throw new Error(result.content?.find(value => value.type === "text")?.text || "工作台操作未完成。");
    const value = result.structuredContent ?? JSON.parse(result.content?.find(value => value.type === "text")?.text || "null");
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("工作台没有返回有效记录。");
    return value as Record<string, unknown>;
  };
  const accept = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const next = value as Snapshot;
    const work = next.workItem;
    if (!work || work.kind !== "general" || typeof work.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(work.id) ||
        !Number.isSafeInteger(work.revision) || work.revision < 1 || !next.goal || !Array.isArray(work.context) || !Array.isArray(work.openQuestions)) return;
    if (boundId && work.id !== boundId) return;
    if (snapshot && work.revision < snapshot.workItem.revision) return;
    boundId = work.id; snapshot = next;
    if (draft?.uncertain && work.revision > draft.revision) {
      const step = work.nextStep;
      if (work.progress === draft.progress.trim() && (step?.owner ?? "") === draft.owner.trim() && (step?.description ?? "") === draft.description.trim() && (!step || step.kind === draft.kind)) draft = null;
    }
  };
  const call = async (name: string, args: object) => {
    const result = connected
      ? await request("tools/call", { name, arguments: args }) as Result
      : await legacy()?.callTool?.(name, args);
    if (!result) throw new Error("当前对话未提供工作台操作能力。");
    return decode(result);
  };
  const refresh = async () => {
    if (!boundId) throw new Error("尚未收到确切的工作引用。");
    const value = await call("mycodex.work_context", { id: boundId }); accept(value);
    if (!snapshot) throw new Error("工作台记录暂不可用。");
  };
  // One ordinary, authorized read also distinguishes a running app bridge
  // from a resource that was only fetched. Never send work content as telemetry.
  const initialRead = () => {
    if (!connected || !boundId || initialReadStarted || disposed) return;
    initialReadStarted = true;
    void request("tools/call", { name: "mycodex.work_context", arguments: { id: boundId },
      _meta: { "mycodex/cardPhase": "bridge-ready" } }).then(value => {
      if (disposed) return;
      accept(decode(value as Result));
      if (!snapshot) throw new Error("工作台记录暂不可用。");
      if (!busy) { failed = false; status = "与工作台共用这项工作。"; render(); }
    }).catch(() => {
      if (disposed || busy) return;
      failed = true; status = snapshot ? "已显示交回的工作；最新状态尚未确认，可点击刷新状态。" : "卡片已接入对话，工作记录尚未读回，可点击刷新状态。"; render();
    });
  };
  const context = () => {
    const work = snapshot!.workItem;
    return { structuredContent: { workId: work.id, goalId: work.goalId, revision: work.revision, userIntent: work.userIntent,
      expectedOutput: work.expectedOutput, nextStep: work.nextStep },
    content: [{ type: "text", text: `用户在共同工作卡片中选择接续「${work.title}」。工作引用：${work.id}，版本：${work.revision}。后续交流围绕这项工作；需要完整依据时读取 mycodex.work_context。选择工作本身不表示采用候选方案或授权派发。` }] };
  };
  const syncContext = async () => {
    if (connected && capabilities.updateModelContext) await request("ui/update-model-context", context());
  };
  const operation = async (action: () => Promise<void>) => {
    if (busy || disposed) return;
    busy = true; failed = false; render();
    try { await action(); }
    catch (cause) { failed = true; status = cause instanceof Error ? cause.message : "操作未完成，请先核对当前工作。"; }
    finally { busy = false; if (!disposed) render(); }
  };
  const continueWork = () => void operation(async () => {
    await refresh();
    if (connected && capabilities.updateModelContext) {
      await syncContext(); status = "已选为当前接续工作。直接在对话里继续说，原草稿保留。";
    } else {
      const work = snapshot!.workItem;
      const prompt = `继续共同工作「${work.title}」（工作引用：${work.id}）。请先读取最新工作依据，再结合下一步接续；不要自动派发或登记其他工作。`;
      if (connected && capabilities.message) await request("ui/message", { role: "user", content: [{ type: "text", text: prompt }] });
      else if (legacy()?.sendFollowUpMessage) await legacy()!.sendFollowUpMessage!({ prompt });
      else throw new Error("当前宿主尚未提供对话内接续能力。你可以直接在本对话说明要继续这项工作。");
      status = "接续请求已交给当前对话，等待小鼠头回应。";
    }
  });
  const render = () => {
    root.replaceChildren(); root.setAttribute("aria-busy", String(busy));
    const header = element("header"); header.append(element("span", "identity", "🐭 共同工作"));
    if (snapshot) {
      const work = snapshot.workItem;
      const labels: Record<string, string> = { draft: "讨论中", ready: "待推进", in_progress: "推进中", needs_attention: "需要判断", ready_for_acceptance: "待验收", done: "已完成", paused: "已暂停" };
      header.append(element("span", "state", labels[work.status] ?? "待确认")); root.append(header, element("h2", "", work.title));
      const navigation = element("nav"); navigation.setAttribute("aria-label", "工作详情");
      for (const [value, name] of [["overview", "概览"], ["basis", "成果与依据"]] as const) {
        const node = button(name, () => { tab = value; render(); }); node.setAttribute("aria-pressed", String(tab === value)); navigation.append(node);
      }
      root.append(navigation);
      const body = element("section", "body");
      if (tab === "overview") {
        field(body, "本轮交回", work.expectedOutput || "在对话里继续明确这轮要留下什么。");
        field(body, "当前进展", work.progress || "尚未记录阶段结论。");
        field(body, "下一步", work.nextStep ? `${work.nextStep.owner} · ${work.nextStep.description}` : "在对话里明确下一步与负责人。");
        if (work.decision || work.openQuestions.length) {
          const decision = element("div", "decision"); field(decision, "需要继续明确", work.decision || work.openQuestions[0]); body.append(decision);
        }
        const original = element("details"); original.append(element("summary", "", "用户原意与完成判据")); field(original, "用户原意", work.userIntent);
        if (work.doneCriteria.length) field(original, "完成判据", work.doneCriteria.join("\n")); body.append(original);
      } else {
        for (const [state, label] of [["adopted", "当前采用"], ["candidate", "候选成果"], ["reference", "参考材料"], ["superseded", "前版参考"]] as const) {
          const entries = work.context.filter(entry => entry.state === state); if (!entries.length) continue;
          const section = element("section", "basis"); section.append(element("h3", "", label));
          for (const entry of entries) {
            const article = element("article"); article.append(element("strong", "", entry.title), element("p", "", entry.summary));
            if (entry.reference) article.append(element("p", "source", `来源：${entry.reference}`));
            if (state === "candidate" && entry.reference) article.append(button("采用这份结果", () => void operation(async () => {
              await refresh();
              const current = snapshot!.workItem, candidate = current.context.find(value => value.id === entry.id);
              if (!candidate || candidate.state !== "candidate" || candidate.summary !== entry.summary || candidate.reference !== entry.reference || candidate.title !== entry.title)
                throw new Error("这份候选结果已有变化，请查看新版后再决定。");
              await call("mycodex.work_record", { id: current.id, expectedRevision: current.revision,
                context: current.context.map(value => value.id === entry.id ? { ...value, state: "adopted" } : value), changeNote: `用户在对话卡片中采用：${entry.title}` });
              await refresh(); status = "采用结果已保存，工作台共用这份依据。";
              try { await syncContext(); } catch { status += " 对话上下文尚未确认同步，可继续说明你的决定。"; }
            })));
            section.append(article);
          }
          body.append(section);
        }
        if (!work.context.length) body.append(element("p", "muted", "还没有登记依据或候选成果，可以直接和小鼠头讨论补充。"));
      }
      root.append(body);
      const actions = element("div", "actions");
      actions.append(button(connected && capabilities.updateModelContext ? "围绕这项工作继续聊" : "请小鼠头接续这项工作", continueWork, true));
      if (!draft) actions.append(button("更新进展与下一步", () => {
        draft = { revision: work.revision, progress: work.progress, owner: work.nextStep?.owner ?? "", description: work.nextStep?.description ?? "", kind: work.nextStep?.kind ?? "action" }; render();
      }));
      root.append(actions);
      if (draft) {
        const editing = draft, form = element("form", "editor");
        form.append(element("h3", "", "更新共同工作"));
        const input = (label: string, value: string, update: (value: string) => void, multiline = true, limit = 4096) => {
          const wrapper = element("label", "", label), control = document.createElement(multiline ? "textarea" : "input");
          control.value = value; control.maxLength = limit; control.disabled = busy; control.oninput = () => update(control.value); wrapper.append(control); form.append(wrapper);
        };
        input("当前进展", editing.progress, value => { editing.progress = value; });
        input("下一步", editing.description, value => { editing.description = value; });
        input("下一步负责人", editing.owner, value => { editing.owner = value; }, false, 256);
        const conflict = work.revision !== editing.revision;
        if (conflict) {
          field(form, "工作库中的新进展", work.progress || "尚无阶段结论");
          field(form, "工作库中的下一步", work.nextStep ? `${work.nextStep.owner} · ${work.nextStep.description}` : "尚未明确");
          form.append(button("已核对，保留输入继续编辑", () => { editing.revision = work.revision; editing.uncertain = false; status = "请确认输入后再保存。"; render(); }));
        }
        const save = element("button", "primary", "保存到共同工作"); save.type = "submit"; save.disabled = busy || conflict || !!editing.uncertain;
        const controls = element("div", "actions"); controls.append(save, button("取消", () => { draft = null; render(); })); form.append(controls);
        form.onsubmit = event => {
          event.preventDefault(); if (busy || conflict || editing.uncertain) return;
          void operation(async () => {
            const owner = editing.owner.trim(), description = editing.description.trim();
            if (!!owner !== !!description || (["ready", "in_progress"].includes(work.status) && !description)) throw new Error("请一起填写下一步及负责人。");
            try {
              await call("mycodex.work_record", { id: work.id, expectedRevision: editing.revision, progress: editing.progress.trim(),
                nextStep: owner && description ? { kind: editing.kind, owner, description } : null, changeNote: "用户在小鼠头对话卡片中更新进展与下一步。" });
              await refresh(); draft = null; status = "已保存，聊天卡片与工作台共用同一份进展。";
            } catch (cause) {
              const message = cause instanceof Error ? cause.message : "保存未完成。";
              if (/revision conflict/i.test(message)) { await refresh(); throw new Error("这项工作刚被更新。你的输入已保留，请对照新版后继续。"); }
              if (/回执|timed out|timeout|disconnected/i.test(message)) editing.uncertain = true;
              throw cause;
            }
            try { await syncContext(); } catch { status += " 对话上下文尚未确认同步，可继续说明这次更新。"; }
          });
        };
        root.append(form);
      }
      const footer = element("footer"); const updated = new Date(work.updatedAt);
      footer.append(element("span", "muted", Number.isNaN(updated.getTime()) ? "共用工作台记录" : `最近保存：${updated.toLocaleString(undefined, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}`),
        button("刷新状态", () => void operation(async () => { await refresh(); status = "已读取最新保存的工作。"; })));
      root.append(footer);
    } else {
      root.append(header, element("p", "muted", "等待小鼠头交回这项工作的卡片。"));
      if (boundId && connected) root.append(button("刷新状态", () => void operation(async () => { await refresh(); status = "已读取最新保存的工作。"; })));
    }
    const message = element("p", failed ? "notice error" : "notice", status); message.setAttribute("role", "status"); message.setAttribute("aria-live", "polite"); root.append(message);
  };
  const theme = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    const context = value as { theme?: string; styles?: { variables?: Record<string, string> } };
    if (context.theme === "dark" || context.theme === "light") document.documentElement.dataset.theme = context.theme;
    for (const [key, value] of Object.entries(context.styles?.variables ?? {})) {
      if (/^--(?:color|font|border|shadow)-[a-z0-9-]+$/.test(key) && typeof value === "string" && value.length < 512) document.documentElement.style.setProperty(key, value);
    }
  };
  const dispose = () => {
    disposed = true; resize?.disconnect(); window.removeEventListener("message", receive); window.removeEventListener("openai:set_globals", globals);
    for (const value of pending.values()) { clearTimeout(value.timer); value.reject(new Error("卡片连接已关闭。")); } pending.clear();
  };
  const receive = (event: MessageEvent) => {
    if (event.source !== window.parent || !event.data || typeof event.data !== "object") return;
    const message = event.data as { jsonrpc?: string; id?: string; result?: unknown; error?: { message?: string }; method?: string; params?: unknown };
    if (message.jsonrpc !== "2.0") return;
    if (message.id !== undefined && !message.method) {
      const entry = pending.get(message.id); if (!entry) return; pending.delete(message.id); clearTimeout(entry.timer);
      message.error ? entry.reject(new Error(message.error.message || "宿主未完成卡片请求。")) : entry.resolve(message.result); return;
    }
    if (message.method === "ui/notifications/tool-input") {
      const id = (message.params as { arguments?: { id?: unknown } } | undefined)?.arguments?.id;
      if (!boundId && typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(id)) boundId = id;
      initialRead();
    } else if (message.method === "ui/notifications/tool-result") {
      try { accept(decode(message.params as Result)); if (snapshot) { status = "与工作台共用这项工作。"; failed = false; } }
      catch (cause) { failed = true; status = cause instanceof Error ? cause.message : "卡片记录未能读取。"; }
      render();
      initialRead();
    } else if (message.method === "ui/notifications/host-context-changed") theme(message.params);
    else if (message.id !== undefined) {
      const teardown = message.method === "ui/resource-teardown";
      window.parent.postMessage({ jsonrpc: "2.0", id: message.id, ...(teardown || message.method === "ping" ? { result: {} } : { error: { code: -32601, message: "Method not found." } }) }, "*");
      if (teardown) dispose();
    }
  };
  const globals = () => { if (!disposed) { if (legacy()?.toolOutput) accept(legacy()!.toolOutput); theme({ theme: legacy()?.theme }); render(); } };
  window.addEventListener("message", receive); window.addEventListener("pagehide", dispose, { once: true });
  window.addEventListener("openai:set_globals", globals);
  if (legacy()?.toolOutput) accept(legacy()!.toolOutput);
  theme({ theme: legacy()?.theme }); render();
  if (window.parent !== window) {
    void request("ui/initialize", { appInfo: { name: "MyCodex shared work card", version: "0.1.0" }, appCapabilities: { availableDisplayModes: ["inline"] }, protocolVersion: "2026-01-26" })
      .then(value => {
        if (disposed) return;
        const result = value as { hostCapabilities?: Record<string, unknown>; hostContext?: unknown };
        connected = true; capabilities = result.hostCapabilities ?? {}; theme(result.hostContext); notify("ui/notifications/initialized"); initialRead();
        status = snapshot ? "与工作台共用这项工作。" : "正在读取对话交回的工作卡片…"; render();
        let lastWidth = 0, lastHeight = 0;
        resize = new ResizeObserver(() => {
          const box = root.getBoundingClientRect(), width = Math.ceil(box.width), height = Math.ceil(box.height);
          if (width !== lastWidth || height !== lastHeight) { lastWidth = width; lastHeight = height; notify("ui/notifications/size-changed", { width, height }); }
        });
        resize.observe(root);
      }).catch(() => {
        if (disposed) return;
        if (legacy()?.callTool) { status = "已接入当前对话的工作台连接。"; render(); }
        else { failed = true; status = "当前宿主尚未完成卡片连接；已保留收到的工作内容。"; render(); }
      });
  }
}

export function conversationWorkCardResource() {
  const script = `(${mountConversationWorkCard.toString()})()`.replace(/<\/script/gi, "<\\/script");
  const css = `:root{color-scheme:light dark;--bg:light-dark(#fff,#242426);--fg:light-dark(#17201b,#eceeed);--muted:light-dark(#647069,#a8b3ac);--line:light-dark(#e4e9e5,#414643);--subtle:light-dark(#f5f8f6,#2b302d);--accent:light-dark(#08785a,#7cdbb1)}
:root[data-theme=light]{color-scheme:light}:root[data-theme=dark]{color-scheme:dark}*{box-sizing:border-box}body{margin:0;color:var(--color-text-primary,var(--fg));font:14px/1.6 var(--font-sans,-apple-system,BlinkMacSystemFont,system-ui,sans-serif);background:transparent}#work-card{padding:18px;background:var(--color-background-primary,var(--bg));border:1px solid var(--color-border-primary,var(--line));border-radius:14px;overflow-wrap:anywhere}header,footer,.actions,nav{display:flex;align-items:center;gap:8px;flex-wrap:wrap}header,footer{justify-content:space-between}.identity,.label,.muted,.source{font-size:12px;color:var(--color-text-secondary,var(--muted))}.state{font-size:12px;border-radius:20px;padding:3px 9px;color:var(--accent);background:var(--subtle)}h2{font-size:19px;line-height:1.4;margin:12px 0 16px;font-weight:600}h3{font-size:14px;margin:0 0 8px}p{margin:7px 0}.body,.basis,.editor{display:flex;flex-direction:column;gap:13px}.field{display:flex;flex-direction:column;gap:3px}.value{white-space:pre-wrap}.decision{padding:10px 12px;border-radius:8px;background:var(--subtle)}nav{margin-bottom:16px;border-bottom:1px solid var(--line);padding-bottom:8px}button{font:inherit;font-size:12px;padding:7px 11px;border:1px solid var(--line);border-radius:8px;background:transparent;color:inherit;cursor:pointer}button:disabled{opacity:.5;cursor:default}button:focus-visible,input:focus-visible,textarea:focus-visible{outline:2px solid var(--accent);outline-offset:2px}button.primary{background:var(--fg);color:var(--bg);border-color:var(--fg)}nav button{border:0}nav button[aria-pressed=true]{color:var(--accent);background:var(--subtle)}.actions{margin-top:16px}article{padding:10px 0;border-bottom:1px solid var(--line)}.source{white-space:pre-wrap}summary{cursor:pointer;color:var(--muted);font-size:12px}details[open] .field{margin-top:10px}.editor{border-top:1px solid var(--line);margin-top:16px;padding-top:16px}.editor label{display:flex;flex-direction:column;gap:5px;font-size:12px}.editor textarea,.editor input{font:inherit;font-size:13px;width:100%;border:1px solid var(--line);border-radius:7px;padding:8px;background:var(--bg);color:inherit}.editor textarea{min-height:72px;resize:vertical}footer{margin-top:16px;padding-top:12px;border-top:1px solid var(--line)}.notice{font-size:12px;color:var(--muted);margin:10px 0 0}.error{color:light-dark(#b43a35,#ffaba5)}@media(max-width:420px){#work-card{padding:14px}.actions button.primary{width:100%}}`;
  return { uri: WORK_CARD_URI, mimeType: WORK_CARD_MIME,
    text: `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>共同工作</title><style>${css}</style></head><body><main id="work-card" aria-label="共同工作卡片"></main><script type="module">${script}</script></body></html>`,
    _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [], frameDomains: [] } },
      "openai/ui": { availableDisplayModes: ["inline"], preferredDisplayMode: "inline" },
      // The pinned Desktop host otherwise makes custom resources collapsible.
      // This is a presentation hint, never a change to execution permissions.
      "openai/widgetShowCodexWidgetInline": true,
      "openai/widgetDescription": "共同工作卡片。查看当前交回、进展和下一步，在本对话接续、采用候选或更新同一工作；工作台共用该记录。", "openai/widgetPrefersBorder": true } };
}
