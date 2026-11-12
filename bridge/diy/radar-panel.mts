import type { DiyServices, HostActions, MountedComponent } from "../desktop-diy-contracts.mjs";
import type { RadarCard } from "../../gateway/spine/radar.mjs";
export function mountRadarPanel({ document, container, services, hostActions, signal, setStatus = () => {}, setBadge = () => {} }: {
  document: Document; container: HTMLElement; services: DiyServices; hostActions: HostActions; signal: AbortSignal; setStatus?: (message: string) => void; setBadge?: (badge: number | string, tone?: "neutral" | "positive" | "warning") => void;
}): MountedComponent {
  const host = document.createElement("section"), root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>:host{display:block;font:12.5px/1.45 var(--mc-font-sans,system-ui);color:var(--mc-text-primary)}*{box-sizing:border-box}button,a{font:inherit;color:inherit}button{border:1px solid var(--mc-border);background:transparent;border-radius:var(--mc-radius-btn,7px);padding:5px 7px;cursor:pointer}button:hover,button[aria-pressed=true]{background:var(--mc-surface-subtle)}button:focus-visible,a:focus-visible{outline:2px solid Highlight;outline-offset:2px}button:disabled{opacity:.5;cursor:default}.filters{display:flex;gap:5px;flex-wrap:wrap;align-items:center;margin-bottom:12px}.filters button{border-radius:var(--mc-radius-pill,999px);font-size:11.5px}.synced{color:var(--mc-text-muted);font-size:11px;margin-left:auto}.card{border:1px solid var(--mc-border);border-radius:var(--mc-radius-card,10px);background:var(--mc-surface-card);padding:12px;margin-bottom:10px}.card:hover{background:var(--mc-surface-card-hover)}.meta{display:flex;justify-content:space-between;gap:6px;font-size:10.5px;color:var(--mc-text-muted)}.score{border-radius:var(--mc-radius-pill);padding:2px 6px;background:var(--mc-surface-subtle)}.positive{background:var(--mc-accent-emerald-bg);color:var(--mc-accent-emerald-fg)}h3{font-size:13.5px;font-weight:600;margin:8px 0 6px}h3 a{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;text-decoration:none}p{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;color:var(--mc-text-secondary);margin:0 0 10px}.actions{display:flex;gap:5px;align-items:center;flex-wrap:wrap}.secondary{opacity:.65}.card:hover .secondary,.card:focus-within .secondary{opacity:1}.collapsed{display:flex;align-items:center;justify-content:space-between;gap:8px;color:var(--mc-text-muted)}.empty{padding:24px 8px;color:var(--mc-text-secondary)}[hidden]{display:none!important}</style><div class="filters"></div><div class="cards"></div>`;
  const filters = root.querySelector<HTMLElement>(".filters")!, cards = root.querySelector<HTMLElement>(".cards")!;
  let disposed = false, loading = false, highOnly = true, defaultChoice = true, topic = "", offset = 0;
  let data: { items: RadarCard[]; topics: string[]; configured: boolean; collectedThrough?: string; syncedAt?: string; refreshMode?: string; availableTotal?: number; highCount?: number; nextOffset?: number | null; total?: number; sourceError?: string | null; refresh?: { state: string; error?: string } } = { items: [], topics: [], configured: false };
  const current = () => !disposed && !signal.aborted;
  const button = (text: string, action: () => void, parent: HTMLElement, secondary = false) => { const b = document.createElement("button"); b.type = "button"; b.textContent = text; if (secondary) b.className = "secondary"; b.onclick = action; parent.append(b); return b; };
  const operation = async (b: HTMLButtonElement, action: () => Promise<unknown>) => { if (b.disabled) return; b.disabled = true; try { await action(); } catch (cause) { if (current()) setStatus(cause instanceof Error ? cause.message : "操作失败"); } finally { if (current() && !b.dataset.saved) b.disabled = false; } };
  function render() {
    if (!current()) return; filters.replaceChildren(); cards.replaceChildren();
    const all = button("全部", () => { defaultChoice = false; highOnly = false; topic = ""; offset = 0; void load(); }, filters); all.setAttribute("aria-pressed", String(!highOnly && !topic));
    const high = button("🔥 高契合", () => { defaultChoice = false; highOnly = true; topic = ""; offset = 0; void load(); }, filters); high.setAttribute("aria-pressed", String(highOnly));
    const names: Record<string, string> = { models: "大模型", infra: "AI Infra", agents: "Agent" };
    for (const value of data.topics ?? []) { const b = button(names[value] ?? value, () => { defaultChoice = false; topic = value; highOnly = false; offset = 0; void load(); }, filters); b.setAttribute("aria-pressed", String(topic === value)); }
    const synced = document.createElement("span"); synced.className = "synced"; const time = (value: string) => new Date(value).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
    synced.textContent = data.syncedAt ? `${data.collectedThrough ? `采集截至 ${time(data.collectedThrough)} · ` : ""}${time(data.syncedAt)} 已同步` : "尚未同步"; filters.append(synced);
    const refresh = button(data.refresh?.state === "running" ? "同步中…" : "↻", () => void operation(refresh, async () => { await services.request("diy/radar/refresh", {}); await load(); }), filters); refresh.setAttribute("aria-label", data.refreshMode === "collector" ? "采集并同步" : "同步最新归档"); refresh.title = data.refreshMode === "collector" ? "运行已配置的增量采集并同步" : "同步最新归档；新报告由既有采集任务产生"; refresh.disabled = data.refresh?.state === "running";
    if (!data.items?.length) { const empty = document.createElement("div"); empty.className = "empty"; empty.textContent = data.configured ? "当前筛选暂无条目。" : "尚未配置雷达报告来源。"; cards.append(empty); }
    for (const card of data.items ?? []) {
      const article = document.createElement("article"); article.className = "card"; article.dataset.id = card.id; cards.append(article);
      if (card.feedback < 0) { article.classList.add("collapsed"); const text = document.createElement("span"); text.textContent = "已降权此类主题"; article.append(text); const undo = button("撤销", () => void operation(undo, async () => { await services.request("diy/radar/feedback", { id: card.id, value: 0 }); await load(); }), article); continue; }
      const meta = document.createElement("div"); meta.className = "meta"; const score = document.createElement("span"); score.className = `score ${(card.score ?? 0) >= 85 ? "positive" : ""}`; score.textContent = card.score === null ? "未评分" : `契合度 ${card.score}`; score.title = card.scoreReason; meta.append(score);
      const source = document.createElement("span"); try { source.textContent = new URL(card.sources[0].url).hostname; } catch { source.textContent = "来源"; } meta.append(source); article.append(meta);
      const h = document.createElement("h3"), link = document.createElement("a"); link.textContent = card.title; try { const url = new URL(card.sources[0].url); if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password) link.href = url.href; } catch {} link.target = "_blank"; link.rel = "noopener noreferrer"; h.append(link); article.append(h);
      const summary = document.createElement("p"); summary.textContent = card.summary; article.append(summary);
      const actions = document.createElement("div"); actions.className = "actions"; article.append(actions);
      const assess = button("⚡ 结合本仓评估", () => void operation(assess, async () => {
        try { await hostActions.prefillDraft(`雷达条目：${card.title}\n来源：${card.sources[0].url}\n核心摘要：${card.summary}\n\n请结合当前工作区架构评估引入价值与落地方案，先查证兼容性、成本和可逆试验方案。`); if (current()) setStatus("评估草稿已预填，请检查后发送。"); }
        catch (cause) { if (current()) setStatus(cause instanceof Error && /draft.*text|草稿非空/i.test(cause.message) ? "当前草稿非空，已保留原内容；请清空或发送后再试" : cause instanceof Error ? cause.message : "草稿操作失败"); }
      }), actions);
      const save = button(card.saved ? "✓ 已存卡" : "📥 存知识卡", () => void operation(save, async () => { await services.request("diy/radar/save_card", { id: card.id }); if (current()) { save.textContent = "✓ 已存卡"; save.dataset.saved = "1"; setStatus("候选已写入 MyCodex 知识库，来源保留供后续蒸馏。"); } }), actions, true); save.disabled = card.saved;
      for (const [label, value] of [["👍", 1], ["👎", -1]] as const) { const b = button(label, () => void operation(b, async () => { await services.request("diy/radar/feedback", { id: card.id, value }); await load(); }), actions, true); b.setAttribute("aria-label", value > 0 ? "提高此类主题权重" : "降低此类主题权重"); }
    }
    if (data.nextOffset != null) button("更多条目", () => { offset = data.nextOffset!; void load(); }, cards);
    setBadge(data.total ?? data.items?.length ?? 0, "positive");
    if (data.refresh?.error) setStatus(data.refresh.error);
    else if (data.sourceError) setStatus(`读取的是上次有效报告：${data.sourceError}`);
  }
  async function load() { if (!current() || loading) return; loading = true; try {
    let next = await services.request("diy/radar/list", { highOnly, ...(topic ? { topic } : {}), offset, limit: 20 }) as typeof data;
    // Editorial priority 4/5 is useful without claiming a personal score >=85.
    // Only the initial default may fall back; explicit human filters remain.
    if (current() && defaultChoice && highOnly && !topic && (next.availableTotal ?? 0) > 0 && next.highCount === 0) { highOnly = false; next = await services.request("diy/radar/list", { highOnly: false, offset: 0, limit: 20 }) as typeof data; }
    if (current()) { defaultChoice = false; data = next; render(); if (data.items?.length) await services.request("diy/radar/seen", { ids: data.items.map(card => card.id) }); }
  } catch (cause) { if (current()) setStatus(cause instanceof Error ? cause.message : "雷达读取失败"); } finally { loading = false; } }
  const unsubscribe = services.subscribe?.(event => { if (event && typeof event === "object" && (event as { kind?: string }).kind === "radar") void load(); });
  const isolate = (e: Event) => e.stopPropagation(); const events = ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick", "keydown", "keyup", "beforeinput", "input", "change", "focusin", "focusout"]; events.forEach(type => root.addEventListener(type, isolate));
  const dispose = () => { if (disposed) return; disposed = true; unsubscribe?.(); events.forEach(type => root.removeEventListener(type, isolate)); host.remove(); signal.removeEventListener("abort", dispose); };
  container.append(host); signal.addEventListener("abort", dispose, { once: true }); void load(); return { host, dispose };
}
