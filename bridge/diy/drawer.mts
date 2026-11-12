import type { DiyServices, DrawerSlot, HostActions, MountedComponent } from "../desktop-diy-contracts.mjs";

/** Pure, self-contained view; safe to serialize or import in an ordinary
 * browser. Native routing and all business capabilities are injected. */
export function mountDiyDrawer({ document, container, services, hostActions, slots = [], rightOffset = 16, onLayout }: {
  document: Document; container: HTMLElement; services: DiyServices; hostActions: HostActions; slots?: DrawerSlot[]; rightOffset?: number; onLayout?: (open: boolean, width: number) => void;
}): MountedComponent & { open(): void; close(): void; select(id: string): void; setBadge(id: string, badge: number | string, tone?: "neutral" | "positive" | "warning"): void; setCount(count: number, tone?: "neutral" | "positive" | "warning"): void; setTheme(theme: "light" | "dark" | "auto"): void } {
  if (new Set(slots.map(slot => slot.id)).size !== slots.length || slots.some(slot => !/^[a-z][a-z0-9_-]{0,63}$/.test(slot.id))) throw new Error("Invalid drawer slots.");
  const host = document.createElement("div"); host.dataset.mycodexDrawer = "1";
  const root = host.attachShadow({ mode: "open" });
  host.style.setProperty("--mc-pill-right", `${Math.max(12, Math.min(300, rightOffset))}px`);
  root.innerHTML = `<style>
    :host{color-scheme:light dark;--mc-font-sans:-apple-system,BlinkMacSystemFont,"SF Pro Text",Inter,system-ui,sans-serif;--mc-font-mono:ui-monospace,"SF Mono",Menlo,Monaco,monospace;
    --mc-surface-glass:light-dark(rgba(250,250,250,.86),rgba(28,28,30,.84));--mc-surface-card:light-dark(#ffffff,#242426);--mc-surface-card-hover:light-dark(#f5f5f7,#2c2c2f);--mc-surface-subtle:light-dark(rgba(0,0,0,.04),rgba(255,255,255,.06));
    --mc-border:light-dark(rgba(0,0,0,.08),rgba(255,255,255,.09));--mc-border-strong:light-dark(rgba(0,0,0,.16),rgba(255,255,255,.18));--mc-shadow-color:light-dark(rgba(0,0,0,.12),rgba(0,0,0,.48));--mc-shadow-drawer:0 12px 40px var(--mc-shadow-color);
    --mc-text-primary:light-dark(#171717,#ececec);--mc-text-secondary:light-dark(#52525b,#a1a1aa);--mc-text-muted:light-dark(#71717a,#71717a);
    --mc-accent-emerald-fg:light-dark(#047857,#34d399);--mc-accent-emerald-bg:light-dark(rgba(16,185,129,.12),rgba(52,211,153,.14));--mc-accent-amber-fg:light-dark(#b45309,#fbbf24);--mc-accent-amber-bg:light-dark(rgba(245,158,11,.12),rgba(251,191,36,.14));--mc-accent-rose-fg:light-dark(#be123c,#fb7185);--mc-accent-rose-bg:light-dark(rgba(244,63,94,.1),rgba(251,113,133,.14));
    --mc-radius-drawer:14px;--mc-radius-card:10px;--mc-radius-pill:999px;--mc-radius-btn:7px;font:13px/1.5 var(--mc-font-sans);color:var(--mc-text-primary);position:fixed;top:10px;right:var(--mc-pill-right,16px);z-index:990;-webkit-app-region:no-drag}
    :host([data-theme=light]){color-scheme:light}:host([data-theme=dark]){color-scheme:dark}
    *{box-sizing:border-box}[hidden]{display:none!important}button{font:inherit;color:inherit;cursor:pointer;border:1px solid var(--mc-border);border-radius:var(--mc-radius-btn);background:transparent;padding:5px 9px}button:hover{background:var(--mc-surface-subtle)}
    button:focus-visible{outline:2px solid Highlight;outline-offset:2px}button:disabled{opacity:.45;cursor:default}.toggle{height:28px;padding:0 10px;border-radius:var(--mc-radius-pill);font-size:12px;font-weight:500;background:var(--mc-surface-glass);backdrop-filter:blur(12px)}
    .badge,.count{font-size:11px;border-radius:var(--mc-radius-pill);padding:1px 5px;margin-left:5px;background:var(--mc-surface-subtle);color:var(--mc-text-secondary)}[data-tone=positive]{background:var(--mc-accent-emerald-bg);color:var(--mc-accent-emerald-fg)}[data-tone=warning]{background:var(--mc-accent-amber-bg);color:var(--mc-accent-amber-fg)}
    aside{position:fixed;right:12px;top:44px;bottom:12px;width:min(460px,calc(100vw - 24px));border:1px solid var(--mc-border);border-radius:var(--mc-radius-drawer);background:light-dark(#f8f8f7,#222326);box-shadow:var(--mc-shadow-drawer);display:flex;flex-direction:column;transform:translateX(18px);opacity:0;pointer-events:none;transition:transform 160ms cubic-bezier(.2,.8,.2,1),opacity 160ms cubic-bezier(.2,.8,.2,1)}
    aside[data-open=true]{transform:translateX(0);opacity:1;pointer-events:auto}header{height:46px;flex-shrink:0;display:flex;align-items:center;justify-content:space-between;padding:0 12px;border-bottom:1px solid var(--mc-border)}header strong{font-weight:600}.close{width:28px;height:28px;padding:0;border:0;font-size:18px}
    nav{display:flex;gap:4px;flex-wrap:wrap;padding:10px;border-bottom:1px solid var(--mc-border)}nav button{font-size:12px;border:0;border-radius:var(--mc-radius-pill)}button[aria-pressed=true]{background:var(--mc-surface-subtle);font-weight:600}.panel{overflow:auto;overflow-anchor:none;min-height:0;flex:1;padding:12px;overflow-wrap:anywhere}.status{border-top:1px solid var(--mc-border);padding:7px 12px;font-size:11.5px;color:var(--mc-text-secondary);min-height:30px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.skeleton{height:70px;background:var(--mc-surface-subtle);border-radius:var(--mc-radius-card);margin-bottom:10px}
    @media(prefers-reduced-motion:reduce){aside{transition:none}}
  </style><button type="button" class="toggle" title="MyCodex 工作台 (⌘⇧M)" aria-expanded="false" aria-controls="workbench">✦ MyCodex<span class="count" hidden></span></button>
  <aside id="workbench" aria-label="MyCodex 工作台" hidden><header><strong>MyCodex 工作台</strong><button type="button" class="close" aria-label="关闭工作台">×</button></header><nav aria-label="工作台模块"></nav><section class="panel"></section><div class="status" role="status" aria-live="polite"></div></aside>`;
  const toggle = root.querySelector<HTMLButtonElement>(".toggle")!, closeButton = root.querySelector<HTMLButtonElement>(".close")!, aside = root.querySelector<HTMLElement>("aside")!;
  const nav = root.querySelector<HTMLElement>("nav")!, panel = root.querySelector<HTMLElement>(".panel")!, status = root.querySelector<HTMLElement>(".status")!;
  let disposed = false, selected: string | null = null, generation = 0, mounted: MountedComponent | null = null, controller: AbortController | null = null;
  let isOpen = false, closeTimer: ReturnType<typeof setTimeout> | undefined;
  const view = document.defaultView!;
  const previousFocus = () => { let element = document.activeElement; while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement; return element instanceof HTMLElement ? element : null; };
  let pointerFocus: HTMLElement | null | undefined;
  const rememberFocus = () => { pointerFocus = previousFocus(); };
  const layout = () => onLayout?.(isOpen, view.innerWidth);
  let returnFocus: HTMLElement | null = null;
  const cleanup = () => {
    generation++; controller?.abort(); controller = null;
    const component = mounted; mounted = null;
    try { component?.dispose(); } catch (cause) { status.textContent = cause instanceof Error ? cause.message : "模块卸载失败"; }
    finally { panel.replaceChildren(); }
  };
  const select = (id: string) => {
    if (disposed) return;
    const slot = slots.find(item => item.id === id); if (!slot) throw new Error("Unknown drawer slot.");
    cleanup(); selected = id; const epoch = generation; controller = new AbortController();
    const skeleton = document.createElement("div"); skeleton.className = "skeleton"; skeleton.setAttribute("aria-busy", "true"); panel.append(skeleton);
    for (const button of nav.querySelectorAll<HTMLButtonElement>("button")) button.setAttribute("aria-pressed", String(button.dataset.slot === id));
    status.textContent = "";
    Promise.resolve().then(() => {
      if (disposed || generation !== epoch) return null;
      return slot.mount({ document, container: panel, services, hostActions, signal: controller!.signal,
        setStatus: message => { if (!disposed && generation === epoch) { status.textContent = message; status.title = message; } },
        setBadge: (badge, tone) => setBadge(id, badge, tone),
      });
    }).then(component => {
      if (!component) return;
      if (disposed || generation !== epoch) { component.dispose(); return; }
      mounted = component; skeleton.remove();
    }, cause => { if (!disposed && generation === epoch) { panel.replaceChildren(); status.textContent = cause instanceof Error ? cause.message : "模块加载失败"; } });
  };
  for (const slot of slots) {
    const button = document.createElement("button"); button.type = "button"; button.dataset.slot = slot.id;
    button.textContent = slot.label; button.disabled = !!slot.disabled; button.setAttribute("aria-pressed", "false"); const badge = document.createElement("span"); badge.className = "badge"; badge.hidden = !slot.badge; badge.textContent = String(slot.badge ?? ""); badge.dataset.tone = slot.tone ?? "neutral"; button.append(badge); nav.append(button);
  }
  const setBadge = (id: string, value: number | string, tone: "neutral" | "positive" | "warning" = "neutral") => { if (disposed) return; const button = [...nav.querySelectorAll<HTMLButtonElement>("button")].find(button => button.dataset.slot === id); const badge = button?.querySelector<HTMLElement>(".badge"); if (badge) { badge.textContent = String(value).slice(0, 16); badge.hidden = !value; badge.dataset.tone = tone; } };
  const setCount = (count: number, tone: "neutral" | "positive" | "warning" = "positive") => { if (disposed) return; const badge = root.querySelector<HTMLElement>(".count")!; badge.textContent = `· ${Math.max(0, Math.floor(count))}`; badge.hidden = !count; badge.dataset.tone = tone; };
  const clickSlot = (event: Event) => { const target = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>("button[data-slot]") : null; if (target?.dataset.slot && !(target as HTMLButtonElement).disabled) select(target.dataset.slot); };
  const open = () => { if (disposed || isOpen) return; clearTimeout(closeTimer); isOpen = true; returnFocus = pointerFocus ?? previousFocus(); pointerFocus = undefined; aside.hidden = false; aside.dataset.open = "true"; toggle.setAttribute("aria-expanded", "true"); closeButton.focus(); const first = slots.find(slot => !slot.disabled); if (first) select(selected ?? first.id); else panel.textContent = "工作台已就绪。"; layout(); };
  const close = () => { if (disposed || !isOpen) return; isOpen = false; cleanup(); aside.dataset.open = "false"; closeTimer = setTimeout(() => { if (!isOpen) aside.hidden = true; }, view.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 160); toggle.setAttribute("aria-expanded", "false"); returnFocus?.focus(); status.textContent = ""; layout(); };
  const toggleOpen = () => isOpen ? close() : open();
  const key = (event: Event) => { const e = event as KeyboardEvent; if (e.metaKey && e.shiftKey && e.code === "KeyM") { e.preventDefault(); e.stopPropagation(); toggleOpen(); } else if (e.key === "Escape" && isOpen) { e.preventDefault(); e.stopPropagation(); close(); } };
  const isolate = (event: Event) => event.stopPropagation();
  const localEvents = ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick", "keydown", "keyup", "beforeinput", "input", "change", "focusin", "focusout"];
  for (const type of localEvents) root.addEventListener(type, isolate);
  // Capture our two shell shortcuts before a nested panel isolates its keys.
  root.addEventListener("keydown", key, true); document.addEventListener("keydown", key); view.addEventListener("resize", layout); nav.addEventListener("click", clickSlot); toggle.addEventListener("click", toggleOpen); closeButton.addEventListener("click", close);
  toggle.addEventListener("pointerdown", rememberFocus);
  container.append(host);
  return { host, open, close, select, setBadge, setCount, setTheme(theme) { host.dataset.theme = theme; }, dispose() {
    if (disposed) return; close(); disposed = true; cleanup();
    clearTimeout(closeTimer); document.removeEventListener("keydown", key); view.removeEventListener("resize", layout);
    toggle.removeEventListener("pointerdown", rememberFocus);
    for (const type of localEvents) root.removeEventListener(type, isolate);
    root.removeEventListener("keydown", key, true); nav.removeEventListener("click", clickSlot); toggle.removeEventListener("click", toggleOpen); closeButton.removeEventListener("click", close); host.remove();
  } };
}
