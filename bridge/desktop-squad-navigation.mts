import type { HostWindow, MountedComponent } from "./desktop-diy-contracts.mjs";
import type { SquadSnapshot } from "../gateway/spine/squad-service.mjs";
import type { readNativeComposerRoute } from "./desktop-native-composer.mjs";

/** Serialized alongside the sidebar. It consumes that sidebar's snapshot;
 * it has no RPC client, drawer, shortcuts or composer-writing actions. */
export function mountSquadReturnAnchor({ window, contracts, routeReader }: {
  window: HostWindow;
  contracts: ReadonlyArray<{ version: string; ui?: { composer: string } }>;
  routeReader: typeof readNativeComposerRoute;
}): (MountedComponent & { update(snapshot: SquadSnapshot): void }) | null {
  const contract = contracts.find(item => item.version === window.electronBridge?.getSentryInitOptions?.().appVersion);
  const document = window.document;
  if (!contract?.ui || window.codexWindowType !== "electron" || !document.body) return null;
  const host = document.createElement("div"); host.dataset.mycodexReturnAnchor = "1"; host.hidden = true;
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>
    :host{color-scheme:light dark;position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:989;max-width:calc(100vw - 220px);-webkit-app-region:no-drag;font:12px/1.4 -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif}
    :host([hidden]){display:none!important}:host([data-theme=light]){color-scheme:light}:host([data-theme=dark]){color-scheme:dark}
    .bar{display:inline-flex;align-items:center;gap:8px;max-width:100%;height:28px;padding:0 6px 0 10px;border-radius:999px;background:light-dark(rgba(235,242,249,.94),rgba(24,33,45,.92));border:1px solid light-dark(#b7d1ea,rgba(99,169,229,.38));color:light-dark(#184d7d,#7cb8ec);box-shadow:0 2px 10px light-dark(rgba(20,24,30,.08),rgba(0,0,0,.36));backdrop-filter:blur(10px)}
    .meta{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;font-weight:500}
    button{font:600 11.5px/1 inherit;height:20px;padding:0 8px;border-radius:999px;border:1px solid light-dark(#8fb8df,rgba(99,169,229,.45));background:light-dark(#ffffff,#1b1f27);color:inherit;cursor:pointer;white-space:nowrap;flex-shrink:0}
    button:hover:not(:disabled){background:light-dark(#1b5488,#63a9e5);border-color:light-dark(#1b5488,#63a9e5);color:light-dark(#ffffff,#0c1117)}button:disabled{opacity:.5;cursor:default}button:focus-visible{outline:2px solid Highlight;outline-offset:2px}
  </style><div class="bar" role="region" aria-label="子会话返回主会话导航"><span class="meta"></span><button type="button">★ 返回主会话</button></div>`;
  const meta = root.querySelector<HTMLElement>(".meta")!, button = root.querySelector<HTMLButtonElement>("button")!;
  let disposed = false, navigating = false, destination: string | null = null;
  let snapshot: SquadSnapshot = { squads: [], threads: [] };
  const currentThreadId = () => {
    const composers = [...document.querySelectorAll<HTMLElement>(contract.ui!.composer)];
    const composer = composers.find(node => node.getClientRects().length > 0) ?? (composers.length === 1 ? composers[0] : null);
    const markers = [...document.querySelectorAll<HTMLElement>("[data-above-composer-conversation-id]")];
    const marker = markers.find(node => node.getClientRects().length > 0) ?? (markers.length === 1 ? markers[0] : null);
    const element = composer ?? marker ?? document.querySelector<HTMLElement>('main, [role="main"]') ?? document.body;
    return routeReader(element)?.pathname.match(/^\/local\/([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i)?.[1].toLowerCase() ?? null;
  };
  const render = () => {
    if (disposed) return;
    const current = currentThreadId();
    const squad = current ? snapshot.squads.find(s => s.status !== "closed" && s.anchorThreadId.toLowerCase() !== current &&
      s.members.some(m => m.role === "worker" && m.threadId.toLowerCase() === current)) : undefined;
    const worker = squad?.members.find(m => m.threadId.toLowerCase() === current);
    const nextDestination = squad && worker ? squad.anchorThreadId : null;
    if (destination !== nextDestination) { destination = nextDestination; button.removeAttribute("title"); }
    const label = squad && worker ? `${worker.shortName} · ${squad.label}` : "";
    if (meta.textContent !== label) meta.textContent = label;
    if (host.hidden !== !destination) host.hidden = !destination;
    const element = document.documentElement, scheme = window.getComputedStyle(element).colorScheme;
    const theme = element.classList.contains("dark") || element.dataset.theme === "dark" || scheme === "dark" ? "dark"
      : element.dataset.theme === "light" || scheme === "light" ? "light" : "auto";
    if (host.dataset.theme !== theme) host.dataset.theme = theme;
  };
  const navigate = async () => {
    if (disposed || navigating || !destination) return;
    const target = destination.toLowerCase();
    navigating = true; button.disabled = true;
    try {
      window.dispatchEvent(new window.MessageEvent("message", { data: { type: "navigate-to-route", path: `/local/${encodeURIComponent(target)}` } }));
      for (let attempt = 0; attempt < 80; attempt++) {
        if (disposed) return;
        if (currentThreadId() === target) { render(); return; }
        await new Promise<void>(resolve => window.setTimeout(resolve, 25));
      }
      throw new Error("Native route did not acknowledge navigation.");
    } catch (cause) {
      if (!disposed) button.title = cause instanceof Error ? cause.message : "返回主会话未完成";
    } finally {
      navigating = false;
      if (!disposed) button.disabled = false;
    }
  };
  const click = () => { void navigate(); };
  const isolate = (event: Event) => event.stopPropagation();
  const events = ["pointerdown", "pointerup", "mousedown", "mouseup", "click"];
  for (const event of events) root.addEventListener(event, isolate);
  button.addEventListener("click", click);
  document.body.append(host);
  const timer = window.setInterval(render, 500);
  return { host, update(value) { if (!disposed) { snapshot = value; render(); } }, dispose() {
    if (disposed) return;
    disposed = true; window.clearInterval(timer); button.removeEventListener("click", click);
    for (const event of events) root.removeEventListener(event, isolate);
    host.remove();
  } };
}
