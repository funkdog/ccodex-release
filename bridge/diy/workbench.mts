import type { DiyServices, HostActions, DrawerSlot } from "../desktop-diy-contracts.mjs";
import { mountDiyDrawer } from "./drawer.mjs";
import { mountRadarPanel } from "./radar-panel.mjs";
import { mountDailyPanel } from "./daily-panel.mjs";
import { mountWorkPanel } from "./work-panel.mjs";
export function mountWorkbench({ document, container, services, hostActions, rightOffset, onLayout }: { document: Document; container: HTMLElement; services: DiyServices; hostActions: HostActions; rightOffset?: number; onLayout?: (open: boolean, width: number) => void }) {
  const slots: DrawerSlot[] = [{ id: "work", label: "工作目标", mount: mountWorkPanel }, { id: "radar", label: "AI 雷达", mount: mountRadarPanel }, { id: "daily", label: "日报·蒸馏", mount: mountDailyPanel }];
  const drawer = mountDiyDrawer({ document, container, services, hostActions, slots, rightOffset, onLayout });
  let disposed = false;
  const badges = async () => { try { const result = await services.request("diy/radar/list", { highOnly: true, limit: 1 }) as { total?: number; unreadHighCount?: number; stale?: boolean }; if (!disposed) { drawer.setCount(result.unreadHighCount ?? 0, result.stale ? "warning" : "positive"); drawer.setBadge("radar", result.unreadHighCount ?? 0, "positive"); } } catch { /* Panel shows actionable source errors on demand. */ } };
  const workBadges = async () => { try {
    const [legacy, shared] = await Promise.allSettled([services.request("diy/work/list", {}), services.request("diy/work/shared_list", { limit: 20 })]);
    if (disposed || legacy.status !== "fulfilled") return;
    const result = legacy.value as { goals?: Array<{ id: string; status?: string }>; items?: Array<{ id: string; goalId: string; status?: string }> };
    const archived = new Set((result.goals ?? []).filter(goal => goal.status === "archived").map(goal => goal.id));
    const general = shared.status === "fulfilled" ? (shared.value as { items?: Array<{ id: string; goalId: string; status?: string }> })?.items ?? [] : [];
    const items = [...new Map([...(result.items ?? []), ...general].filter(item => !archived.has(item.goalId)).map(item => [item.id, item])).values()];
    const urgent = items.filter(item => item.status === "needs_attention" || item.status === "ready_for_acceptance").length;
    drawer.setBadge("work", urgent || items.length, urgent ? "warning" : "positive");
  } catch {} };
  const unsubscribe = services.subscribe?.(event => {
    if (!event || typeof event !== "object") return;
    const kind = (event as { kind?: string }).kind;
    if (kind === "radar") void badges();
    if (kind === "work") void workBadges();
  });
  void badges(); void workBadges(); return { ...drawer, dispose() { if (disposed) return; disposed = true; unsubscribe?.(); drawer.dispose(); } };
}
