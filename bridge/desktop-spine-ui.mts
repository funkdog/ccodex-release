import type { DiyServices, HostActions, HostWindow } from "./desktop-diy-contracts.mjs";
import { mountDiyDrawer } from "./diy/drawer.mjs";
import { mountWorkbench as mountDiyWorkbench } from "./diy/workbench.mjs";
import { mountRadarPanel } from "./diy/radar-panel.mjs";
import { mountDailyPanel } from "./diy/daily-panel.mjs";
import { mountWorkPanel } from "./diy/work-panel.mjs";
import { readNativeComposerRoute } from "./desktop-native-composer.mjs";
import { desktopPickerBinding } from "./desktop-model-controls.mjs";
import { currentHostContracts } from "./desktop-current-host-contract.mjs";

/** Host-only adapter. Acknowledgement reads the committed memory router and
 * editor; document.location and DOM text replacement aren't acknowledgements. */
export function createHostActions({ document, navigate, readRoute, composerSelector, active = () => true, wait = () => new Promise<void>(resolve => setTimeout(resolve, 25)) }: {
  document: Document; navigate(path: string): void; readRoute(): string | null; composerSelector: string;
  active?: () => boolean; wait?: () => Promise<void>;
}): HostActions {
  const assertActive = () => { if (!active()) throw new Error("Host action is unavailable."); };
  const text = (value: string) => { if (typeof value !== "string" || value.length > 32768 || value.includes("\0")) throw new Error("Invalid host text."); };
  const pickEditors = () => {
    const all = [...document.querySelectorAll<HTMLElement>(composerSelector)];
    const visible = all.filter(node => (node.getClientRects?.().length ?? 0) > 0);
    return visible.length ? visible : all;
  };
  const resolveOrbitRoute = (target: string): { path: string; button: HTMLElement | null } | null => {
    const button = document.querySelector<HTMLElement>('[data-sidebar-destination^="builtin:orbit:"]');
    const dest = button?.getAttribute("data-sidebar-destination") ?? "";
    const orbitId = dest.startsWith("builtin:orbit:") ? dest.slice("builtin:orbit:".length) : "";
    if (target.startsWith("/dots/")) return { path: target, button };
    if (target.startsWith("builtin:orbit:")) return { path: `/dots/${target.slice("builtin:orbit:".length)}`, button };
    if (target === "orbit" && orbitId) return { path: `/dots/${orbitId}`, button };
    return null;
  };
  const route = async (path: string) => {
    assertActive(); navigate(path);
    for (let i = 0; i < 80; i++) { assertActive(); if (readRoute() === path) return; await wait(); }
    throw new Error("Native route did not acknowledge navigation.");
  };
  const insert = async (value: string, empty = false) => {
    text(value); assertActive();
    const before = readRoute();
    const editors = pickEditors();
    if (editors.length !== 1 || !editors[0].isContentEditable || editors[0].getAttribute("aria-disabled") === "true") throw new Error("Native composer is unavailable or ambiguous.");
    const editor = editors[0];
    if (empty && editor.textContent?.trim()) throw new Error("Existing draft contains text; it was preserved.");
    editor.focus();
    const selection = document.getSelection(), range = document.createRange(); range.selectNodeContents(editor); range.collapse(false);
    selection?.removeAllRanges(); selection?.addRange(range);
    assertActive();
    if (readRoute() !== before || !editor.isConnected) throw new Error("Native chat changed before insertion.");
    if (!document.execCommand("insertText", false, value)) throw new Error("Native composer rejected text insertion.");
    await wait(); assertActive();
    if (readRoute() !== before || !editor.isConnected || !editor.textContent?.includes(value)) throw new Error("Native composer did not acknowledge insertion; no retry was performed.");
  };
  return {
    async openThread(id) {
      const orbit = resolveOrbitRoute(id);
      if (orbit) {
        assertActive();
        if (orbit.button) orbit.button.click();
        else navigate(orbit.path);
        for (let i = 0; i < 80; i++) {
          assertActive();
          const current = readRoute();
          if (current === orbit.path || (current && current.startsWith("/dots/"))) return;
          await wait();
        }
        await route(orbit.path);
        return;
      }
      if (id === "orbit") throw new Error("请先在侧栏打开小鼠头，再接续讨论；当前草稿已保留。");
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) throw new Error("Invalid thread ID.");
      await route(`/local/${encodeURIComponent(id)}`);
    },
    async prefillDraft(value) { text(value); assertActive(); const editor = pickEditors()[0] ?? null; if (editor?.textContent?.trim()) throw new Error("Current draft contains text; it was preserved."); await route("/"); await insert(value, true); },
    async injectText(value) {
      const editors = pickEditors();
      await insert(editors.length === 1 && editors[0].textContent?.trim() ? `\n\n${value}` : value);
    },
    async copyText(value) { assertActive(); if (typeof value !== "string" || value.length > 256 * 1024) throw new Error("Invalid clipboard payload."); await document.defaultView!.navigator.clipboard.writeText(value); },
  };
}

export function installSpineUi({ window, binding, responseEvent, contracts, mountWorkbench, hostActionsFactory, routeReader, rightOffset = 16 }: {
  window: HostWindow & { __mycodexSpine?: { key?: string; dispose(): void }; [key: string]: unknown }; binding: string; responseEvent: string;
  contracts: ReadonlyArray<{ version: string; ui?: { composer: string; stage?: string } }>;
  mountWorkbench: typeof mountDiyWorkbench; hostActionsFactory: typeof createHostActions; routeReader: typeof readNativeComposerRoute; rightOffset?: number;
}) {
  const contract = contracts.find(item => item.version === window.electronBridge?.getSentryInitOptions?.().appVersion);
  if (!contract?.ui || window.codexWindowType !== "electron") return "unsupported";
  if (window.__mycodexSpine?.key === binding) return "active";
  window.__mycodexSpine?.dispose();
  const document = window.document; if (!document.body) return "pending";
  let disposed = false, sequence = 0;
  const epoch = window.crypto.randomUUID();
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const subscribers = new Set<(value: unknown) => void>(), activityEvent = responseEvent + "_activity";
  const activity = (event: Event) => { if (!disposed) for (const receive of subscribers) receive((event as CustomEvent).detail); };
  window.addEventListener(activityEvent, activity);
  const response = (event: Event) => {
    const data: unknown = (event as CustomEvent).detail;
    if (!data || typeof data !== "object") return;
    const result = data as { id?: string; result?: unknown; error?: string };
    if (typeof result.id !== "string") return;
    const entry = pending.get(result.id); if (!entry) return; pending.delete(result.id); clearTimeout(entry.timer);
    result.error ? entry.reject(new Error(result.error)) : entry.resolve(result.result);
  };
  window.addEventListener(responseEvent, response);
  const services: DiyServices = { subscribe(receive) { subscribers.add(receive); return () => subscribers.delete(receive); }, request: (method, params) => new Promise((resolve, reject) => {
    if (disposed || !/^diy\/[a-z][a-z0-9_-]*\/[a-z][a-z0-9_-]*$/.test(method) || pending.size >= 8) { reject(new Error("DIY request is unavailable.")); return; }
    const id = `spine:${epoch}:${++sequence}`;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("DIY request timed out; not retried.")); }, /^diy\/(?:work\/(?:dispatch|handoff|integrate)|goals\/plan)$/.test(method) ? 120000 : 15000);
    pending.set(id, { resolve, reject, timer });
    try {
      const send = window[binding]; if (typeof send !== "function") throw new Error("DIY binding is unavailable.");
      send(JSON.stringify({ id, method, params }));
    } catch (cause) { pending.delete(id); clearTimeout(timer); reject(cause); }
  }) };
  const activeRouteElement = () => {
    const composers = [...document.querySelectorAll<HTMLElement>(contract.ui!.composer)];
    const visibleComposer = composers.find(node => (node.getClientRects?.().length ?? 0) > 0);
    if (visibleComposer) return visibleComposer;
    if (composers.length === 1) return composers[0];
    const fallback = document.querySelector<HTMLElement>('[data-sidebar-destination^="builtin:orbit:"], main, [role="main"]');
    return fallback ?? composers.at(-1) ?? null;
  };
  const hostActions = hostActionsFactory({ document, composerSelector: contract.ui.composer, active: () => !disposed,
    readRoute: () => routeReader(activeRouteElement())?.pathname ?? null,
    navigate: path => window.dispatchEvent(new window.MessageEvent("message", { data: { type: "navigate-to-route", path } })),
  });
  const stage = contract.ui.stage ? document.querySelector<HTMLElement>(contract.ui.stage) : null;
  const priorMargin = stage?.style.getPropertyValue("margin-inline-end") ?? "", priorPriority = stage?.style.getPropertyPriority("margin-inline-end") ?? "";
  let ownsMargin = false;
  const layout = (open: boolean, width: number) => { if (!stage) return; if (open && width >= 1120) { stage.style.setProperty("margin-inline-end", "484px"); ownsMargin = true; } else if (ownsMargin) { if (stage.style.getPropertyValue("margin-inline-end") === "484px") { if (priorMargin) stage.style.setProperty("margin-inline-end", priorMargin, priorPriority); else stage.style.removeProperty("margin-inline-end"); } ownsMargin = false; } };
  const drawer = mountWorkbench({ document, container: document.body, services, hostActions, rightOffset, onLayout: layout });
  const theme = () => { const root = document.documentElement, explicit = window.getComputedStyle(root).colorScheme; drawer.setTheme(root.classList.contains("dark") || root.dataset.theme === "dark" || explicit === "dark" ? "dark" : root.dataset.theme === "light" || explicit === "light" ? "light" : "auto"); };
  const observer = new MutationObserver(theme); observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme", "style"] }); theme();
  window.__mycodexSpine = { key: binding, dispose() {
    if (disposed) return; disposed = true; drawer.dispose(); layout(false, 0); observer.disconnect(); window.removeEventListener(responseEvent, response); window.removeEventListener(activityEvent, activity); subscribers.clear();
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error("DIY UI disposed.")); } pending.clear(); delete window.__mycodexSpine;
  } };
  return "active";
}
export function buildSpinePatch(binding: string, responseEvent: string, rightOffset = 16) {
  return `(()=>{const desktopPickerBinding=${desktopPickerBinding.toString()};const routeReader=${readNativeComposerRoute.toString()};const mountDiyDrawer=${mountDiyDrawer.toString()};const mountRadarPanel=${mountRadarPanel.toString()};const mountDailyPanel=${mountDailyPanel.toString()};const mountWorkPanel=${mountWorkPanel.toString()};const mountWorkbench=${mountDiyWorkbench.toString()};return (${installSpineUi.toString()})({window:globalThis,binding:${JSON.stringify(binding)},responseEvent:${JSON.stringify(responseEvent)},contracts:${JSON.stringify(currentHostContracts)},mountWorkbench,hostActionsFactory:${createHostActions.toString()},routeReader,rightOffset:${JSON.stringify(rightOffset)}});})()`;
}
