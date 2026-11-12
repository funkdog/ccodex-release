import type { DiyServices, HostActions, MountedComponent } from "../desktop-diy-contracts.mjs";
import type { DailyDigest } from "../../gateway/spine/daily.mjs";
export function mountDailyPanel({ document, container, services, hostActions, signal, setStatus = () => {}, setBadge = () => {} }: {
  document: Document; container: HTMLElement; services: DiyServices; hostActions: HostActions; signal: AbortSignal; setStatus?: (message: string) => void; setBadge?: (badge: number | string, tone?: "neutral" | "positive" | "warning") => void;
}): MountedComponent {
  const host = document.createElement("section"), root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>:host{display:block;color:var(--mc-text-primary);font:12.5px/1.5 var(--mc-font-sans,system-ui)}*{box-sizing:border-box}button,input{font:inherit;color:inherit}button{border:1px solid var(--mc-border);border-radius:var(--mc-radius-btn,7px);padding:5px 8px;background:transparent;cursor:pointer}button:hover,button[aria-pressed=true]{background:var(--mc-surface-subtle)}button:disabled{opacity:.5;cursor:default}button:focus-visible,input:focus-visible{outline:2px solid Highlight;outline-offset:2px}.segments{display:flex;gap:3px;padding:3px;border-radius:var(--mc-radius-pill,999px);background:var(--mc-surface-subtle);margin-bottom:12px}.segments button{border:0;border-radius:var(--mc-radius-pill,999px);font-size:11.5px;flex:1}.segments button[aria-pressed=true]{background:var(--mc-surface-card);font-weight:600}.card{border:1px solid var(--mc-border);border-radius:var(--mc-radius-card,10px);background:var(--mc-surface-card);padding:12px;margin:10px 0}.meta{color:var(--mc-text-muted);font-size:11px}h3{font-size:13.5px;margin:6px 0}p{color:var(--mc-text-secondary);margin:7px 0;white-space:pre-wrap}.toolbar{display:flex;gap:6px;justify-content:flex-end;margin-bottom:10px}pre{font:12px/1.6 var(--mc-font-mono,monospace);white-space:pre-wrap;overflow-wrap:anywhere;background:var(--mc-surface-card);border:1px solid var(--mc-border);border-radius:var(--mc-radius-card);padding:12px}input{display:block;width:100%;background:var(--mc-surface-subtle);border:1px solid var(--mc-border);border-radius:var(--mc-radius-btn);padding:6px;margin:6px 0}.coverage{font-size:11px;color:var(--mc-text-muted);padding:8px 0}</style><div class="segments" role="group" aria-label="日报视图"></div><div class="content"></div><div class="coverage"></div>`;
  const segments = root.querySelector<HTMLElement>(".segments")!, content = root.querySelector<HTMLElement>(".content")!, coverage = root.querySelector<HTMLElement>(".coverage")!;
  let disposed = false, loading = false, view = "handoff", timer: ReturnType<typeof setTimeout> | undefined;
  let data: DailyDigest | null = null;
  const current = () => !disposed && !signal.aborted;
  const button = (text: string, action: () => void, parent: HTMLElement) => { const b = document.createElement("button"); b.type = "button"; b.textContent = text; b.onclick = action; parent.append(b); return b; };
  const operation = async (b: HTMLButtonElement, action: () => Promise<void>) => { b.disabled = true; try { await action(); } catch (cause) { if (current()) setStatus(cause instanceof Error ? cause.message : "操作失败"); } finally { if (current() && !b.dataset.saved) b.disabled = false; } };
  function render() {
    if (!current()) return; segments.replaceChildren(); content.replaceChildren();
    for (const [id, text] of [["handoff", "🌅 早间续接"], ["digest", "📝 团队日报"], ["vault", "💎 候选知识卡"]]) { const b = button(text, () => { view = id; render(); }, segments); b.setAttribute("aria-pressed", String(view === id)); }
    if (!data) { content.textContent = "读取摘要…"; return; }
    coverage.textContent = data.coverage.degraded.join(" ");
    if (view === "handoff") {
      for (const row of data.handoff) {
        const card = document.createElement("article"); card.className = "card";
        const meta = document.createElement("div"); meta.className = "meta"; meta.textContent = `${row.repository} · ${row.engine}`; card.append(meta);
        const title = document.createElement("h3"); title.textContent = row.title; card.append(title);
        const p = document.createElement("p"); p.textContent = `最近活动：${new Date(row.updatedAt).toLocaleString("zh-CN", { timeZone: data.timezone })} · ${row.status}`; card.append(p);
        const jump = button("→ 跳回会话", () => void operation(jump, async () => { await hostActions.openThread(row.threadId); if (current()) setStatus("已跳回原会话。"); }), card); content.append(card);
      }
      if (!data.handoff.length) content.textContent = "暂无近期可续接会话。";
    } else if (view === "digest") {
      const toolbar = document.createElement("div"); toolbar.className = "toolbar";
      const copy = button("📋 复制 Markdown", () => void operation(copy, async () => { if (!hostActions.copyText) throw new Error("宿主剪贴板动作尚不可用。"); await hostActions.copyText!(data!.markdown); if (current()) { copy.textContent = "✓ 已复制"; clearTimeout(timer); timer = setTimeout(() => { if (current()) copy.textContent = "📋 复制 Markdown"; }, 1500); } }), toolbar);
      const refresh = button("↻ 重新汇总", () => void operation(refresh, async () => { await services.request("diy/daily/refresh", {}); if (current()) setStatus("后台汇总已启动，完成后自动更新。"); }), toolbar);
      const markdown = document.createElement("pre"); markdown.textContent = data.markdown; content.append(toolbar, markdown);
    } else {
      for (const candidate of data.cards) {
        const card = document.createElement("article"); card.className = "card";
        const title = document.createElement("input"); title.value = candidate.title; title.maxLength = 300; title.setAttribute("aria-label", "知识卡标题"); card.append(title);
        const tags = document.createElement("input"); tags.value = candidate.tags.join(" "); tags.setAttribute("aria-label", "知识卡标签"); tags.maxLength = 384; card.append(tags);
        const body = document.createElement("p"); body.textContent = candidate.body; card.append(body);
        const provenance = document.createElement("div"); provenance.className = "meta"; provenance.textContent = `MyCodex 候选 · ${candidate.sources.length} 个来源 · 待复核`; card.append(provenance);
        const save = button("✓ 写入知识库", () => void operation(save, async () => { await services.request("diy/daily/save_card", { id: candidate.id, date: data!.date, title: title.value, tags: tags.value.split(/\s+/).filter(Boolean) }); if (current()) { save.dataset.saved = "1"; save.textContent = "✓ 已写入"; setStatus("候选已写入 MyCodex 知识库，原始来源与候选状态保留。"); } }), card); content.append(card);
      }
      if (!data.cards.length) content.textContent = "当日暂无候选知识卡。";
    }
    setBadge(data.cards.length, "neutral");
  }
  async function load() { if (!current() || loading) return; loading = true; try { const next = await services.request("diy/daily/digest", {}); if (current()) { data = next as DailyDigest; render(); } } catch (cause) { if (current()) setStatus(cause instanceof Error ? cause.message : "日报读取失败"); } finally { loading = false; } }
  const unsubscribe = services.subscribe?.(event => { if (event && typeof event === "object" && (event as { kind?: string }).kind === "daily") void load(); });
  const isolate = (e: Event) => e.stopPropagation(), events = ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick", "keydown", "keyup", "beforeinput", "input", "change", "focusin", "focusout"]; events.forEach(type => root.addEventListener(type, isolate));
  const dispose = () => { if (disposed) return; disposed = true; clearTimeout(timer); unsubscribe?.(); events.forEach(type => root.removeEventListener(type, isolate)); host.remove(); signal.removeEventListener("abort", dispose); };
  container.append(host); signal.addEventListener("abort", dispose, { once: true }); render(); void load(); return { host, dispose };
}
