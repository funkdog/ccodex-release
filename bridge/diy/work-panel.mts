import type { DiyServices, HostActions, MountedComponent } from "../desktop-diy-contracts.mjs";
import type {
  GoalRecord,
  WorkItemRecord,
} from "../../gateway/spine/work-contracts.mjs";
import type { GeneralWorkItemRecord } from "../../gateway/spine/work-context.mjs";

interface WorkListPayload {
  goals: GoalRecord[];
  items: WorkItemRecord[];
  activeWorkItemId: string | null;
}

export function mountWorkPanel({ document, container, services, hostActions, signal, setStatus = () => {}, setBadge = () => {} }: {
  document: Document; container: HTMLElement; services: DiyServices; hostActions: HostActions; signal: AbortSignal; setStatus?: (message: string) => void; setBadge?: (badge: number | string, tone?: "neutral" | "positive" | "warning") => void;
}): MountedComponent {
  const WORK_PANEL_CSS = `
.mc-work-shell{display:flex;flex-direction:column;gap:12px;padding-bottom:8px}
.mc-hq-bar{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;border-radius:12px;border:1px solid rgba(245,158,11,.28);background:linear-gradient(135deg,rgba(245,158,11,.10),rgba(245,158,11,.03))}
.mc-hq-left{display:flex;align-items:center;gap:10px;min-width:0}
.mc-hq-avatar{width:34px;height:34px;border-radius:999px;background:rgba(245,158,11,.18);border:2px solid #f59e0b;display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0}
.mc-hq-meta{min-width:0;display:flex;flex-direction:column;gap:2px}
.mc-hq-title{display:flex;align-items:center;gap:6px;font-size:13px;font-weight:700;color:var(--mc-text-primary)}
.mc-hq-sub{font-size:11px;color:var(--mc-text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mc-hq-actions{display:flex;align-items:center;gap:6px;flex-shrink:0}
.mc-btn-sm{display:inline-flex;align-items:center;gap:4px;height:26px;padding:0 9px;border-radius:7px;font-size:11.5px;font-weight:600;border:1px solid var(--mc-border-strong);background:var(--mc-surface-card);color:var(--mc-text-primary);white-space:nowrap}
.mc-btn-sm:hover{background:var(--mc-surface-card-hover)}
.mc-btn-primary{background:var(--mc-accent-emerald-bg);color:var(--mc-accent-emerald-fg);border-color:rgba(16,185,129,.32)}
.mc-btn-amber{background:var(--mc-accent-amber-bg);color:var(--mc-accent-amber-fg);border-color:rgba(245,158,11,.35)}
.mc-plan-drawer{display:flex;flex-direction:column;gap:8px;padding:11px 12px;border-radius:11px;border:1px solid rgba(245,158,11,.32);background:var(--mc-surface-card)}
.mc-plan-input{width:100%;padding:6px 9px;border-radius:7px;border:1px solid var(--mc-border-strong);background:var(--mc-surface-subtle);color:inherit;font:12px/1.4 var(--mc-font-sans)}
.mc-sec-label{display:flex;align-items:center;justify-content:space-between;font-size:11px;font-weight:600;letter-spacing:.02em;color:var(--mc-text-secondary);padding:0 2px}
.mc-goal-list{display:flex;flex-direction:column;gap:10px}
.mc-goal-card{border-radius:12px;border:1px solid var(--mc-border);background:var(--mc-surface-card);overflow:hidden;transition:border-color 140ms ease,box-shadow 140ms ease}
.mc-goal-card[data-expanded=true]{border-color:var(--mc-border-strong);box-shadow:0 4px 16px rgba(0,0,0,.05)}
.mc-goal-head{width:100%;display:flex;flex-direction:column;gap:7px;padding:11px 12px;border:0;border-radius:0;background:transparent;text-align:left;cursor:pointer}
.mc-goal-head:hover{background:var(--mc-surface-subtle)}
.mc-goal-top{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%}
.mc-goal-title-row{display:flex;align-items:center;gap:7px;min-width:0;flex:1}
.mc-goal-index{font:700 10px/1 var(--mc-font-mono);padding:3px 6px;border-radius:5px;background:var(--mc-accent-amber-bg);color:var(--mc-accent-amber-fg);flex-shrink:0}
.mc-goal-name{font-size:13px;font-weight:700;color:var(--mc-text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mc-goal-right{display:flex;align-items:center;gap:6px;flex-shrink:0}
.mc-pill{display:inline-flex;align-items:center;gap:4px;font-size:10.5px;font-weight:600;padding:2px 7px;border-radius:999px;background:var(--mc-surface-subtle);color:var(--mc-text-secondary);white-space:nowrap}
.mc-pill[data-tone=positive]{background:var(--mc-accent-emerald-bg);color:var(--mc-accent-emerald-fg)}
.mc-pill[data-tone=warning]{background:var(--mc-accent-amber-bg);color:var(--mc-accent-amber-fg)}
.mc-pill[data-tone=danger]{background:var(--mc-accent-rose-bg);color:var(--mc-accent-rose-fg)}
.mc-chevron{font-size:11px;color:var(--mc-text-muted);transition:transform 140ms ease;display:inline-block}
.mc-goal-card[data-expanded=true] .mc-goal-chevron{transform:rotate(90deg)}
.mc-goal-meta-row{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;font-size:11px;color:var(--mc-text-secondary)}
.mc-progress-track{flex:1;height:5px;border-radius:999px;background:var(--mc-surface-subtle);overflow:hidden;max-width:140px}
.mc-progress-fill{height:100%;border-radius:999px;background:#10b981;transition:width 200ms ease}
.mc-goal-body{padding:0 10px 10px;border-top:1px solid var(--mc-border);display:flex;flex-direction:column;gap:8px;background:var(--mc-surface-subtle)}
.mc-goal-summary{padding:8px 4px 2px;font-size:11.5px;color:var(--mc-text-secondary);line-height:1.45}
.mc-stepper{display:flex;flex-direction:column;gap:7px;position:relative}
.mc-step-card{border-radius:10px;border:1px solid var(--mc-border);background:var(--mc-surface-card);overflow:hidden}
.mc-step-card[data-active=true]{border-color:var(--mc-border-strong)}
.mc-step-head{width:100%;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px;border:0;border-radius:0;background:transparent;text-align:left;cursor:pointer}
.mc-step-head:hover{background:var(--mc-surface-subtle)}
.mc-step-left{display:flex;align-items:center;gap:7px;min-width:0;flex:1}
.mc-step-num{width:20px;height:20px;border-radius:999px;display:inline-flex;align-items:center;justify-content:center;font:700 10.5px/1 var(--mc-font-mono);background:var(--mc-surface-subtle);color:var(--mc-text-secondary);flex-shrink:0}
.mc-step-num[data-done=true]{background:var(--mc-accent-emerald-bg);color:var(--mc-accent-emerald-fg)}
.mc-step-num[data-active=true]{background:var(--mc-accent-amber-bg);color:var(--mc-accent-amber-fg)}
.mc-step-title{font-size:12px;font-weight:600;color:var(--mc-text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mc-step-body{padding:10px;border-top:1px solid var(--mc-border);display:flex;flex-direction:column;gap:10px}
.mc-subbox{border-radius:9px;border:1px solid var(--mc-border);background:var(--mc-surface-subtle);padding:8px 10px;display:flex;flex-direction:column;gap:6px}
.mc-subbox-head{display:flex;align-items:center;justify-content:space-between;gap:6px}
.mc-subbox-title{font-size:11px;font-weight:700;color:var(--mc-text-secondary);display:flex;align-items:center;gap:5px}
.mc-check-list{display:flex;flex-direction:column;gap:4px;margin:0;padding:0;list-style:none}
.mc-check-item{display:flex;align-items:flex-start;gap:6px;font-size:11.5px;color:var(--mc-text-primary);line-height:1.4}
.mc-check-icon{color:var(--mc-accent-emerald-fg);font-weight:700;flex-shrink:0}
.mc-tag-row{display:flex;flex-wrap:wrap;gap:5px;padding-top:2px}
.mc-code-tag{font:10.5px/1.3 var(--mc-font-mono);padding:2px 6px;border-radius:5px;background:var(--mc-surface-card);border:1px solid var(--mc-border);color:var(--mc-text-secondary)}
.mc-squad-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px}
.mc-seat-card{border-radius:9px;border:1px solid var(--mc-border);background:var(--mc-surface-card);padding:8px;display:flex;flex-direction:column;gap:5px;min-width:0}
.mc-seat-top{display:flex;align-items:center;justify-content:space-between;gap:4px}
.mc-seat-id{font:700 11.5px/1.2 var(--mc-font-mono);color:var(--mc-text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mc-seat-desc{font-size:11px;color:var(--mc-text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mc-seat-tags{display:flex;flex-wrap:wrap;gap:4px}
.mc-feed-list{display:flex;flex-direction:column;gap:6px;max-height:210px;overflow:auto}
.mc-feed-item{border-radius:8px;border:1px solid var(--mc-border);background:var(--mc-surface-card);padding:7px 9px;display:flex;flex-direction:column;gap:4px}
.mc-feed-top{display:flex;align-items:center;justify-content:space-between;gap:6px}
.mc-feed-title{margin:0;font-size:11.5px;font-weight:600;color:var(--mc-text-primary)}
.mc-feed-sum{margin:0;font-size:11px;color:var(--mc-text-secondary);line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.mc-dispatch-bar{display:flex;gap:6px;align-items:center;padding-top:2px}
.mc-shared-card{padding:14px;border:1px solid var(--mc-border);border-radius:11px;background:var(--mc-surface-card);display:flex;flex-direction:column;gap:12px;font-size:13px}
.mc-shared-field{display:flex;flex-direction:column;gap:4px;overflow-wrap:anywhere}
.mc-shared-label{font-size:12px;color:var(--mc-text-secondary)}
.mc-shared-actions{display:flex;gap:8px;flex-wrap:wrap}
.mc-shared-context{border-top:1px solid var(--mc-border);padding-top:10px;display:flex;flex-direction:column;gap:5px;overflow-wrap:anywhere}
.mc-shared-note{color:var(--mc-text-secondary);font-size:12px}
.mc-companion{display:flex;flex-direction:column;gap:18px;font-size:13px;line-height:1.55}
.mc-companion h2,.mc-companion h3,.mc-companion h4{margin:0;font-weight:500;letter-spacing:-.02em}
.mc-companion h2{font-size:18px}.mc-companion h3{font-size:14px}.mc-companion p{margin:0}
.mc-companion-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding-bottom:14px;border-bottom:1px solid var(--mc-border)}
.mc-companion-identity{display:flex;align-items:center;gap:9px}.mc-companion-orbit{width:25px;height:25px;border:3px solid #e9b42c;border-radius:50%;display:grid;place-items:center;font-size:13px;flex:none}
.mc-companion .mc-btn-sm{font-weight:400;font-size:12px;border-radius:7px;padding:7px 10px;white-space:normal}
.mc-companion .mc-btn-primary{background:var(--mc-text-primary);color:var(--mc-surface-card);border-color:var(--mc-text-primary)}
.mc-companion .mc-shared-label{font-size:12px}.mc-companion .mc-shared-field{gap:4px}
.mc-companion-focus{background:var(--mc-accent-emerald-bg);color:var(--mc-accent-emerald-fg);border-radius:8px;padding:9px 11px;font-size:12px}
.mc-companion-goals{display:flex;flex-direction:column;gap:8px}.mc-companion-goal{display:flex;flex-direction:column;gap:6px;text-align:left;border:1px solid var(--mc-border);border-radius:10px;background:var(--mc-surface-card);padding:12px;font:inherit;color:inherit;width:100%}
.mc-companion-goal[aria-pressed=true]{border-color:var(--mc-accent-emerald-fg);background:var(--mc-accent-emerald-bg)}
.mc-companion-meta{font-size:12px;color:var(--mc-text-secondary);display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.mc-companion-goal-title{font-size:14px;font-weight:500}.mc-companion-section{display:flex;flex-direction:column;gap:12px;padding:15px;border:1px solid var(--mc-border);border-radius:11px;background:var(--mc-surface-card)}
.mc-companion-work-list{display:flex;flex-direction:column;gap:6px}.mc-companion-work{font:inherit;text-align:left;border:0;border-top:1px solid var(--mc-border);padding:11px 0;background:transparent;color:inherit;display:flex;flex-direction:column;gap:4px}
.mc-companion-work[aria-pressed=true]{color:var(--mc-accent-emerald-fg)}.mc-companion-tabs{display:flex;gap:5px;border-bottom:1px solid var(--mc-border);padding-bottom:10px}.mc-companion-tabs button{border:0}
.mc-companion-tabs button[aria-pressed=true]{color:var(--mc-accent-emerald-fg);background:var(--mc-accent-emerald-bg)}
.mc-companion-decision{background:var(--mc-accent-amber-bg);border-radius:8px;padding:11px;display:flex;flex-direction:column;gap:8px}.mc-companion-decision .mc-shared-label{color:var(--mc-accent-amber-fg)}
.mc-companion-sources{display:flex;flex-direction:column;gap:10px}.mc-companion-source{display:flex;flex-direction:column;gap:5px;padding:10px 0;border-top:1px solid var(--mc-border)}.mc-companion-source:first-child{border-top:0}
.mc-companion-source-head{display:flex;gap:8px;align-items:center;justify-content:space-between}.mc-companion-source-state{font-size:12px;color:var(--mc-text-secondary)}.mc-companion-source-state[data-state=adopted]{color:var(--mc-accent-emerald-fg)}
.mc-companion-empty{padding:12px 0;color:var(--mc-text-secondary)}.mc-companion-archive{border-top:1px solid var(--mc-border);padding-top:12px}.mc-companion-archive summary{color:var(--mc-text-secondary);font-size:12px;cursor:pointer}
.mc-companion-team{display:flex;flex-direction:column;gap:9px}.mc-companion-person{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:10px 0;border-top:1px solid var(--mc-border)}
.mc-companion-editor{display:flex;flex-direction:column;gap:12px;border-top:1px solid var(--mc-border);padding-top:14px}
.mc-companion-editor label{display:flex;flex-direction:column;gap:5px;font-size:12px;color:var(--mc-text-secondary)}
.mc-companion-editor textarea,.mc-companion-editor input,.mc-companion-editor select{width:100%;padding:8px 10px;border:1px solid var(--mc-border-strong);border-radius:7px;background:var(--mc-surface-card);color:var(--mc-text-primary);font:13px/1.5 var(--mc-font-sans)}
.mc-companion-editor textarea{min-height:75px;resize:vertical}.mc-companion-editor .mc-btn-sm{height:auto;min-height:30px}
.mc-companion-error{font-size:12px;color:var(--mc-accent-rose-fg);white-space:pre-wrap;overflow-wrap:anywhere}
`;
  const statusDescriptor = (status: string): { label: string; tone: "neutral" | "positive" | "warning" | "danger" } => {
    switch (status) {
      case "done":
      case "completed":
      case "settled":
        return { label: "已完成", tone: "positive" };
      case "ready_for_acceptance":
        return { label: "待你验收", tone: "positive" };
      case "in_progress":
      case "running":
      case "active":
        return { label: "执行中", tone: "warning" };
      case "cooldown_429":
        return { label: "429 冷却", tone: "warning" };
      case "needs_attention":
        return { label: "需介入", tone: "danger" };
      default:
        return { label: "待推进", tone: "neutral" };
    }
  };
  const roleBadge = (role: string): string => {
    switch (role) {
      case "implementer": return "🛠 实现";
      case "scout": return "🔍 侦察";
      case "reviewer": return "🛡 审查";
      case "integrator": return "⚡ 合流";
      case "supervisor": return "🐭 总管";
      default: return role;
    }
  };

  const root = document.createElement("div");
  root.className = "mc-work-shell";
  root.dataset.workSquadPanel = "1";
  const styleEl = document.createElement("style");
  styleEl.textContent = WORK_PANEL_CSS;
  const content = document.createElement("div");
  content.className = "mc-work-shell";
  root.append(styleEl, content);
  container.append(root);

  let disposed = false;
  let epoch = 0;
  let busy = false;
  let loading = false;
  let selectedGoalId: string | null = container.dataset.workGoal ?? null;
  let selectedWorkItemId: string | null = null;
  let showPlanDrawer = false;
  const expandedGoals = new Set<string>();
  const collapsedSteps = new Set<string>();
  let seededGoals = false;
  let sharedItems: GeneralWorkItemRecord[] = [];
  let selectedSharedId: string | null = null;
  let sharedView: "overview" | "context" = "overview";
  let showShared = true;
  let sharedNextOffset: number | null = null;
  let sharedReadError: string | null = null;
  let sharedAvailable = false;
  let selectedCompanionId: string | null = container.dataset.workSelection ?? null;
  let draftWorkId: string | null = container.dataset.workDraft ?? null;
  type ProgressDraft = { id: string; revision: number; progress: string; status: string; expectedOutput: string; criteria: string;
    nextKind: "discussion" | "action"; nextOwner: string; nextDescription: string; error: string; latest?: GeneralWorkItemRecord; uncertain?: boolean };
  let progressDraft: ProgressDraft | null = null;
  let companionTab: "overview" | "basis" | "collaboration" = container.dataset.workView === "basis" ? "basis" : container.dataset.workView === "collaboration" ? "collaboration" : "overview";
  const current = () => !disposed && !signal.aborted;

  const operation = async (trigger: HTMLButtonElement, action: () => Promise<void>) => {
    if (busy || !current()) return;
    busy = true;
    trigger.disabled = true;
    try {
      await action();
    } catch (cause) {
      if (current() && cause instanceof Error && /revision conflict/i.test(cause.message)) await load(false);
      if (current()) setStatus(cause instanceof Error ? cause.message : "操作未完成");
    } finally {
      busy = false;
      if (current()) trigger.disabled = false;
    }
  };

  const sharedButton = (label: string, action: (button: HTMLButtonElement) => void) => {
    const button = document.createElement("button"); button.type = "button"; button.className = "mc-btn-sm"; button.textContent = label;
    button.addEventListener("click", () => action(button)); return button;
  };
  const sharedText = (parent: HTMLElement, label: string, value: string) => {
    const field = document.createElement("div"); field.className = "mc-shared-field";
    const name = document.createElement("span"); name.className = "mc-shared-label"; name.textContent = label;
    const text = document.createElement("div"); text.textContent = value; field.append(name, text); parent.append(field);
  };
  const renderShared = (payload: WorkListPayload) => {
    const priorScroll = container.scrollTop;
    content.replaceChildren();
    const shell = document.createElement("section"); shell.className = "mc-companion"; shell.dataset.companionWorkbench = "1";
    const goals = (payload.goals ?? []).filter(goal => goal.status !== "archived");
    const goalIds = new Set(goals.map(goal => goal.id));
    const allWorks: Array<GeneralWorkItemRecord | WorkItemRecord> = [...sharedItems, ...payload.items].filter(item => goalIds.has(item.goalId));
    const isGeneral = (item: GeneralWorkItemRecord | WorkItemRecord): item is GeneralWorkItemRecord => "kind" in item && item.kind === "general";
    const stateLabel = (status: string) => ({ draft: "讨论中", ready: "待推进", in_progress: "推进中", running: "执行中", ready_for_acceptance: "待你验收", needs_attention: "需要判断", done: "已完成", paused: "已暂停", active: "推进中", completed: "已完成", settled: "已交回", idle: "尚未开始", cooldown_429: "等待重试" } as Record<string, string>)[status] ?? "待推进";
    if (!selectedGoalId || !goalIds.has(selectedGoalId)) selectedGoalId = goals[0]?.id ?? null;
    const goal = goals.find(value => value.id === selectedGoalId);
    const works = allWorks.filter(item => item.goalId === selectedGoalId);
    if (!selectedCompanionId || !works.some(item => item.id === selectedCompanionId)) selectedCompanionId = works[0]?.id ?? null;
    const item = works.find(value => value.id === selectedCompanionId);
    if (item && isGeneral(item)) selectedSharedId = item.id;
    container.dataset.workGoal = selectedGoalId ?? "";
    container.dataset.workSelection = selectedCompanionId ?? "";
    container.dataset.workDraft = draftWorkId ?? "";
    container.dataset.workView = companionTab;
    const head = document.createElement("header"); head.className = "mc-companion-head";
    const identity = document.createElement("div"); identity.className = "mc-companion-identity";
    const orbit = document.createElement("span"); orbit.className = "mc-companion-orbit"; orbit.textContent = "🐭";
    const heading = document.createElement("h3"); heading.textContent = "与你一起推进工作"; identity.append(orbit, heading);
    const headActions = document.createElement("div"); headActions.className = "mc-shared-actions";
    headActions.append(sharedButton("刷新", button => void operation(button, async () => { await load(false); })),
      sharedButton("回到小鼠头", button => void operation(button, async () => { await hostActions.openThread("orbit"); setStatus("已回到小鼠头，工作台浏览位置保留。"); })));
    head.append(identity, headActions);
    shell.append(head);
    const draftItem = allWorks.find(value => value.id === draftWorkId);
    const focus = document.createElement("div"); focus.className = draftItem ? "mc-companion-focus" : "mc-shared-note";
    focus.textContent = draftItem ? `讨论草稿已带入：${draftItem.title} · 待发送` : "浏览目标只查看；继续讨论时再带入工作依据。";
    shell.append(focus);
    const listHeading = document.createElement("h3"); listHeading.textContent = `工作目标 · ${goals.length}`; shell.append(listHeading);
    const navigation = document.createElement("div"); navigation.className = "mc-companion-goals";
    for (const entry of goals) {
      const associated = allWorks.filter(value => value.goalId === entry.id);
      const choice = document.createElement("button"); choice.type = "button"; choice.className = "mc-companion-goal"; choice.dataset.goal = entry.id;
      choice.setAttribute("aria-pressed", String(entry.id === selectedGoalId));
      const title = document.createElement("span"); title.className = "mc-companion-goal-title"; title.textContent = entry.title;
      const meta = document.createElement("span"); meta.className = "mc-companion-meta";
      meta.textContent = associated.length ? `${associated.length} 项工作 · ${associated.some(value => value.status === "needs_attention") ? "需要判断" : stateLabel(entry.status)}` : sharedNextOffset !== null ? "其他工作尚待读取" : "目标仍在讨论 · 下一段工作待明确";
      choice.append(title, meta);
      choice.addEventListener("click", () => { selectedGoalId = entry.id; selectedCompanionId = null; companionTab = "overview"; renderShared(payload); });
      navigation.append(choice);
    }
    shell.append(navigation);
    const continueDiscussion = async (trigger: HTMLButtonElement, question?: string) => operation(trigger, async () => {
      if (!goal) return;
      const general = item && isGeneral(item) ? item : null;
      const prompt = item ? [
        `【继续工作 · ${item.title} · rev.${item.revision}】`, `目标：${goal.title}`,
        `用户原意：${general?.userIntent ?? (item as WorkItemRecord).handoff.userVerbatimAnchor}`,
        `期望交回：${general ? general.expectedOutput || "待继续明确" : (item as WorkItemRecord).brief.goalSummary}`,
        `当前进展：${general?.progress || (general ? "尚无阶段结论" : stateLabel(item.status))}`,
        `当前采用：${general?.context.filter(entry => entry.state === "adopted").map(entry => `${entry.title}：${entry.summary} (${entry.reference ?? "来源待补"})`).join("；") || "请核对已有工作约定"}`,
        `候选成果：${general?.context.filter(entry => entry.state === "candidate").map(entry => entry.title).join("、") || "无"}`,
        `未决问题：${(general?.openQuestions ?? (item as WorkItemRecord).brief.openQuestions).join("；") || "无"}`,
        `下一步：${general?.nextStep ? `${general.nextStep.owner} · ${general.nextStep.description}` : "请结合当前工作明确下一步"}`,
        ...(question ? [`本次讨论：${question}`] : []), `工作引用：${item.id}`,
      ].join("\n") : `继续讨论目标「${goal.title}」。用户原意：${goal.summary}。请明确下一段工作、期望交回和下一步，由我确认后再登记。`;
      const target = item?.supervisorThreadId ?? goal.supervisorThreadId;
      await hostActions.openThread(target || "orbit");
      await hostActions.injectText(prompt);
      if (current()) { draftWorkId = item?.id ?? null; renderShared(payload); setStatus("当前依据已带入讨论草稿，原草稿保留，尚未发送。"); }
    });
    if (goal) {
      const body = document.createElement("article"); body.className = "mc-companion-section"; body.dataset.goalDetail = goal.id;
      const title = document.createElement("h2"); title.textContent = item?.title ?? goal.title;
      if (!item || item.title !== goal.title) body.append(title);
      if (!item) {
        sharedText(body, "用户原意", goal.summary);
        sharedText(body, "下一段工作", "这个目标还在讨论。明确期望交回和下一步后，再形成可推进的工作。");
        body.append(sharedButton("继续明确目标", button => void continueDiscussion(button)));
      } else {
        const workList = document.createElement("div"); workList.className = "mc-companion-work-list";
        for (const work of works) {
          const choice = document.createElement("button"); choice.type = "button"; choice.className = "mc-companion-work"; choice.dataset.work = work.id;
          choice.setAttribute("aria-pressed", String(work.id === item.id));
          const name = document.createElement("span"); name.textContent = work.title;
          const meta = document.createElement("span"); meta.className = "mc-companion-meta"; meta.textContent = stateLabel(work.status);
          choice.append(name, meta); choice.addEventListener("click", () => { selectedCompanionId = work.id; companionTab = "overview"; renderShared(payload); }); workList.append(choice);
        }
        if (works.length > 1) body.append(workList);
        const tabs = document.createElement("nav"); tabs.className = "mc-companion-tabs"; tabs.setAttribute("aria-label", "工作详情");
        for (const [id, label] of [["overview", "概览"], ["basis", "成果与依据"], ["collaboration", "协作"]] as const) {
          const tab = sharedButton(label, () => { companionTab = id; renderShared(payload); }); tab.setAttribute("aria-pressed", String(companionTab === id)); tabs.append(tab);
        }
        body.append(tabs);
        const general = isGeneral(item) ? item : null;
        if (companionTab === "overview") {
          sharedText(body, "用户原意", general?.userIntent ?? (item as WorkItemRecord).handoff.userVerbatimAnchor);
          sharedText(body, "期望交回", general?.outcome || general?.expectedOutput || (general ? "待继续明确" : (item as WorkItemRecord).brief.goalSummary));
          sharedText(body, "当前进展", general?.progress || (general ? "尚无阶段结论" : stateLabel(item.status)));
          sharedText(body, "下一步", general?.nextStep ? `${general.nextStep.owner} · ${general.nextStep.description}` : "结合工作约定继续明确下一步。");
          const questions = general?.openQuestions ?? (item as WorkItemRecord).brief.openQuestions;
          if (general?.decision || questions.length) {
            const decision = document.createElement("section"); decision.className = "mc-companion-decision";
            sharedText(decision, "需要你的判断", general?.decision || questions[0]);
            if (questions.length > 1) sharedText(decision, "仍待明确", questions.slice(1).join("；"));
            decision.append(sharedButton("带着问题继续聊", button => void continueDiscussion(button, general?.decision || questions.join("；")))); body.append(decision);
          }
          const actions = document.createElement("div"); actions.className = "mc-shared-actions";
          const keepTalking = sharedButton("继续讨论", button => void continueDiscussion(button)); keepTalking.classList.add("mc-btn-primary");
          actions.append(keepTalking, sharedButton("查看成果与依据", () => { companionTab = "basis"; renderShared(payload); })); body.append(actions);
          if (general) {
            const beginEdit = () => {
              if (busy) return;
              progressDraft = { id: general.id, revision: general.revision, progress: general.progress, status: general.status,
                expectedOutput: general.expectedOutput ?? "", criteria: general.doneCriteria.join("\n"), nextKind: general.nextStep?.kind ?? "action",
                nextOwner: general.nextStep?.owner ?? "", nextDescription: general.nextStep?.description ?? "", error: "" };
              renderShared(payload);
            };
            if (progressDraft?.id !== general.id) actions.append(sharedButton("更新进展与下一步", beginEdit));
            else {
              const draft = progressDraft;
              const editor = document.createElement("form"); editor.className = "mc-companion-editor"; editor.dataset.progressEditor = general.id;
              const heading = document.createElement("h3"); heading.textContent = "更新这项工作"; editor.append(heading);
              const field = (label: string, value: string, update: (value: string) => void, multiline = true, maxLength = 4096) => {
                const wrapper = document.createElement("label"); wrapper.textContent = label;
                const input = document.createElement(multiline ? "textarea" : "input"); input.value = value; input.maxLength = maxLength;
                input.addEventListener("input", () => update(input.value)); wrapper.append(input); editor.append(wrapper); return input;
              };
              const selectField = (label: string, value: string, options: string[][], update: (value: string) => void) => {
                const wrapper = document.createElement("label"); wrapper.textContent = label;
                const select = document.createElement("select");
                for (const [id, name] of options) { const option = document.createElement("option"); option.value = id; option.textContent = name; select.append(option); }
                select.value = value; select.addEventListener("change", () => update(select.value)); wrapper.append(select); editor.append(wrapper);
              };
              field("当前进展", draft.progress, value => { draft.progress = value; });
              selectField("工作状态", draft.status, [["draft", "讨论中"], ["ready", "待推进"], ["in_progress", "推进中"], ["needs_attention", "需要判断"],
                ["ready_for_acceptance", "待验收"], ["done", "已完成"], ["paused", "已暂停"]], value => { draft.status = value; });
              field("期望交回", draft.expectedOutput, value => { draft.expectedOutput = value; });
              field("完成判据（每行一条）", draft.criteria, value => { draft.criteria = value; }, true, 32768);
              selectField("下一步类型", draft.nextKind, [["discussion", "继续讨论"], ["action", "推进工作"]], value => { draft.nextKind = value as "discussion" | "action"; });
              field("下一步", draft.nextDescription, value => { draft.nextDescription = value; });
              field("下一步由谁负责", draft.nextOwner, value => { draft.nextOwner = value; }, false, 256);
              const error = document.createElement("p"); error.className = "mc-companion-error"; error.setAttribute("role", "alert"); error.textContent = draft.error; editor.append(error);
              if (draft.latest) {
                sharedText(editor, "刚保存的新进展", draft.latest.progress || "尚未记录进展");
                sharedText(editor, "刚保存的下一步", draft.latest.nextStep ? `${draft.latest.nextStep.owner} · ${draft.latest.nextStep.description}` : "尚未记录下一步");
                sharedText(editor, "刚保存的交回与判据", `${draft.latest.expectedOutput ?? "尚未明确"}\n${draft.latest.doneCriteria.join("；")}`);
                sharedText(editor, "刚保存的状态", stateLabel(draft.latest.status));
                editor.append(sharedButton("已核对，在新版基础上继续编辑", () => {
                  draft.revision = draft.latest!.revision; delete draft.latest; draft.error = ""; draft.uncertain = false; renderShared(payload);
                }));
              }
              const buttons = document.createElement("div"); buttons.className = "mc-shared-actions";
              const save = document.createElement("button"); save.type = "submit"; save.className = "mc-btn-sm mc-btn-primary"; save.textContent = "保存到工作台";
              save.disabled = busy || !!draft.latest || !!draft.uncertain;
              buttons.append(save, sharedButton("取消", () => { if (!busy) { progressDraft = null; renderShared(payload); } })); editor.append(buttons);
              editor.addEventListener("submit", event => {
                event.preventDefault();
                if (busy || draft.latest || draft.uncertain || !current()) return;
                const criteria = draft.criteria.split("\n").map(value => value.trim()).filter(Boolean);
                if (criteria.length > 32 || criteria.some(value => value.length > 1024)) { error.textContent = draft.error = "完成判据最多 32 条，每条最多 1024 字。"; return; }
                const expectedOutput = draft.expectedOutput.trim() || null;
                const nextStep = draft.nextDescription.trim() && draft.nextOwner.trim()
                  ? { kind: draft.nextKind, description: draft.nextDescription.trim(), owner: draft.nextOwner.trim() } : null;
                if (!!draft.nextDescription.trim() !== !!draft.nextOwner.trim()) { error.textContent = draft.error = "下一步和负责人需要一起填写。"; return; }
                if (["ready", "in_progress", "ready_for_acceptance", "done"].includes(draft.status) && (!expectedOutput || !criteria.length)) {
                  error.textContent = draft.error = "请先写清期望交回和完成判据，再推进这项工作。"; return;
                }
                if (["ready", "in_progress"].includes(draft.status) && !nextStep) { error.textContent = draft.error = "推进中的工作需要下一步和负责人。"; return; }
                busy = true; error.textContent = "";
                for (const control of editor.querySelectorAll<HTMLInputElement>("input, textarea, select, button")) control.disabled = true;
                void (async () => {
                  try {
                    await services.request("diy/work/record", { id: draft.id, expectedRevision: draft.revision, progress: draft.progress.trim(),
                      status: draft.status, expectedOutput, doneCriteria: criteria, nextStep, changeNote: "用户在工作台更新进展与下一步。" });
                    if (!current()) return;
                    progressDraft = null; await load(false); setStatus("进展和下一步已保存，与小鼠头共用同一份工作。");
                  } catch (cause) {
                    if (!current()) return;
                    draft.error = cause instanceof Error ? cause.message : "未能保存，你的输入已保留。";
                    if (/revision conflict/i.test(draft.error)) {
                      try {
                        const latest = await services.request("diy/work/context", { id: draft.id }) as { workItem: GeneralWorkItemRecord };
                        if (!current()) return;
                        draft.latest = latest.workItem; draft.error = "这项工作刚被更新。你的输入已保留，请对照新内容再保存。";
                      } catch { draft.error += " 请稍后刷新后核对。"; }
                    } else if (/timed out|timeout|disconnected/i.test(draft.error)) {
                      draft.uncertain = true; draft.error = "保存回执尚未确认，请先刷新核对进展。本次操作不会自动重试。";
                    }
                  } finally { busy = false; if (current() && progressDraft === draft) renderShared(payload); }
                })();
              });
              if (busy) for (const control of editor.querySelectorAll<HTMLInputElement>("input, textarea, select, button")) control.disabled = true;
              body.append(editor);
            }
          }
        } else if (companionTab === "basis") {
          const criteria = general?.doneCriteria ?? (item as WorkItemRecord).brief.doneCriteria;
          if (criteria.length) sharedText(body, "判断标准", criteria.join("；"));
          if (!general) sharedText(body, "工作约定", (item as WorkItemRecord).brief.goalSummary);
          for (const [state, label] of [["adopted", "当前采用"], ["candidate", "候选成果"], ["reference", "参考材料"], ["superseded", "前版参考"]] as const) {
            const entries = general?.context.filter(entry => entry.state === state) ?? [];
            if (!entries.length) continue;
            const section = document.createElement("section"); section.className = "mc-companion-sources";
            const heading = document.createElement("h3"); heading.textContent = label; section.append(heading);
            for (const entry of entries) {
              const source = document.createElement("article"); source.className = "mc-companion-source";
              const top = document.createElement("div"); top.className = "mc-companion-source-head";
              const name = document.createElement("h4"); name.textContent = entry.title;
              const tag = document.createElement("span"); tag.className = "mc-companion-source-state"; tag.dataset.state = entry.state; tag.textContent = state === "candidate" ? "尚未采纳" : label;
              top.append(name, tag); const copy = document.createElement("p"); copy.textContent = entry.summary; source.append(top, copy);
              if (entry.reference) sharedText(source, "来源", entry.reference);
              source.append(sharedButton("带着这份依据继续聊", button => void continueDiscussion(button, `围绕「${entry.title}」：${entry.summary}`)));
              if (state === "candidate" && entry.reference && general) source.append(sharedButton("用于当前工作", button => void operation(button, async () => {
                await services.request("diy/work/record", { id: general.id, expectedRevision: general.revision,
                  context: general.context.map(value => value.id === entry.id ? { ...value, state: "adopted" } : value), changeNote: `用户在工作台采纳：${entry.title}` }); await load(false);
              })));
              section.append(source);
            }
            body.append(section);
          }
          if (general && !general.context.length) sharedText(body, "当前依据", "还没有登记材料或成果，可继续讨论并补充真实来源。");
        } else {
          const members = general ? [] : (item as WorkItemRecord).squad;
          if (!members.length) {
            sharedText(body, "这项工作的协作", "尚未绑定小队。可以先讨论需要谁参与、共同依据和期望交回。");
            body.append(sharedButton("讨论如何协作", button => void continueDiscussion(button, "这项工作需要哪些参与者？共同依据和交回方式是什么？")));
          } else {
            const team = document.createElement("section"); team.className = "mc-companion-team";
            sharedText(team, "共同工作", item.title);
            for (const member of members) {
              const person = document.createElement("div"); person.className = "mc-companion-person";
              sharedText(person, member.label || member.memberId, `${member.role} · ${stateLabel(member.status)}`);
              const open = sharedButton("打开队员会话", button => void operation(button, async () => { if (member.threadId) await hostActions.openThread(member.threadId); })); open.disabled = !member.threadId;
              if (!member.threadId) open.title = "这位队员的真实会话尚未开启";
              person.append(open); team.append(person);
            }
            team.append(sharedButton("进入小队工作", () => { showShared = false; selectedWorkItemId = item.id; selectedGoalId = item.goalId; renderPanel(payload); })); body.append(team);
          }
        }
      }
      shell.append(body);
    } else {
      const empty = document.createElement("div"); empty.className = "mc-companion-empty"; empty.textContent = "在小鼠头聊清想持续推进的事情，再登记为目标。";
      shell.append(empty, sharedButton("去小鼠头讨论", button => void operation(button, async () => { await hostActions.openThread("orbit"); })));
    }
    if (sharedNextOffset !== null) shell.append(sharedButton("读取更多工作", button => void operation(button, async () => {
      const page = await services.request("diy/work/shared_list", { offset: sharedNextOffset, limit: 12 }) as { items: GeneralWorkItemRecord[]; nextOffset: number | null };
      sharedItems = [...new Map([...sharedItems, ...page.items].map(value => [value.id, value])).values()]; sharedNextOffset = page.nextOffset; if (current()) renderShared(payload);
    })));
    const archived = payload.goals.filter(value => value.status === "archived");
    if (archived.length) {
      const history = document.createElement("details"); history.className = "mc-companion-archive";
      const label = document.createElement("summary"); label.textContent = `已归档目标 · ${archived.length}`; history.append(label);
      for (const entry of archived) {
        const row = document.createElement("div"); row.className = "mc-companion-person"; const title = document.createElement("span"); title.textContent = entry.title;
        row.append(title, sharedButton("恢复到工作目标", button => void operation(button, async () => { await services.request("diy/goals/upsert", { id: entry.id, expectedRevision: entry.revision, status: "active" }); await load(false); }))); history.append(row);
      }
      shell.append(history);
    }
    content.append(shell);
    container.scrollTop = priorScroll;
    const urgent = allWorks.filter(value => value.status === "needs_attention" || value.status === "ready_for_acceptance" || (isGeneral(value) && value.decision)).length;
    setBadge(urgent || allWorks.length, urgent ? "warning" : "positive");
    setStatus(draftWorkId ? "工作依据已带入草稿，待你发送。" : "与讨论共用工作依据 · 浏览保持当前聊天");
  };

  const renderPanel = (payload: WorkListPayload) => {
    if (showShared && sharedAvailable) { renderShared(payload); return; }
    const originalPayload = payload;
    const visibleGoals = (payload.goals ?? []).filter(goal => goal.status !== "archived");
    const archivedIds = new Set((payload.goals ?? []).filter(goal => goal.status === "archived").map(goal => goal.id));
    payload = { ...payload, goals: visibleGoals, items: payload.items.filter(item => !archivedIds.has(item.goalId)) };
    content.replaceChildren();
    if (sharedAvailable) content.append(sharedButton("返回工作目标", () => { showShared = true; renderShared(originalPayload); }));
    const goals = payload.goals ?? [];
    const items = payload.items ?? [];

    if (!selectedWorkItemId || !items.some(item => item.id === selectedWorkItemId)) {
      selectedWorkItemId = payload.activeWorkItemId ?? items[0]?.id ?? null;
    }
    const activeItem = items.find(item => item.id === selectedWorkItemId) ?? items[0] ?? null;
    if (activeItem && !selectedGoalId) {
      selectedGoalId = activeItem.goalId;
    }
    if (!seededGoals && (selectedGoalId || goals.length > 0)) {
      seededGoals = true;
      if (selectedGoalId) expandedGoals.add(selectedGoalId);
      for (const g of goals) expandedGoals.add(g.id);
    }

    const attentionCount = items.reduce((acc, item) => {
      const itemNeeds = item.status === "needs_attention" || item.status === "ready_for_acceptance" ? 1 : 0;
      const memberNeeds = item.squad.filter(m => m.status === "needs_attention" || m.status === "cooldown_429").length;
      return acc + itemNeeds + memberNeeds;
    }, 0);
    setBadge(
      attentionCount || items.length,
      items.some(i => i.status === "needs_attention" || i.squad.some(m => m.status === "needs_attention" || m.status === "cooldown_429"))
        ? "warning"
        : "positive"
    );

    // 1. Top Supervisor Console Bar (小鼠头主控栏)
    const hqBar = document.createElement("section");
    hqBar.className = "mc-hq-bar";
    hqBar.dataset.layer = "supervisor-goal";

    const hqLeft = document.createElement("div");
    hqLeft.className = "mc-hq-left";
    const avatar = document.createElement("div");
    avatar.className = "mc-hq-avatar";
    avatar.textContent = "🐭";
    const hqMeta = document.createElement("div");
    hqMeta.className = "mc-hq-meta";
    const hqTitle = document.createElement("div");
    hqTitle.className = "mc-hq-title";
    hqTitle.textContent = "小鼠头🐭 · 主会话总管";
    const hqSub = document.createElement("div");
    hqSub.className = "mc-hq-sub";
    hqSub.textContent = `${goals.length || 1} 个目标卡片 · 共拆解 ${items.length} 个分步工作项`;
    hqMeta.append(hqTitle, hqSub);
    hqLeft.append(avatar, hqMeta);

    const hqActions = document.createElement("div");
    hqActions.className = "mc-hq-actions";

    const planToggleBtn = document.createElement("button");
    planToggleBtn.type = "button";
    planToggleBtn.className = "mc-btn-sm mc-btn-amber";
    planToggleBtn.textContent = showPlanDrawer ? "收起立项" : "+ 新目标拆活";
    planToggleBtn.addEventListener("click", () => {
      showPlanDrawer = !showPlanDrawer;
      renderPanel(payload);
    });

    const jumpOrbitBtn = document.createElement("button");
    jumpOrbitBtn.type = "button";
    jumpOrbitBtn.className = "mc-btn-sm";
    jumpOrbitBtn.textContent = "↗ 回到小鼠头";
    jumpOrbitBtn.title = "跳回左侧栏「🟡 小鼠头🐭」主聊天";
    jumpOrbitBtn.addEventListener("click", () => void operation(jumpOrbitBtn, async () => {
      const targetThread = activeItem?.integratorThreadId || activeItem?.supervisorThreadId || "orbit";
      await hostActions.openThread(targetThread === "01a19d3b-1321-7010-aa6f-f2ab6e4b87ea" ? "orbit" : targetThread);
      if (current()) setStatus("已切换至 🟡 小鼠头🐭 主聊天。");
    }));

    hqActions.append(planToggleBtn, jumpOrbitBtn);
    hqBar.append(hqLeft, hqActions);
    content.append(hqBar);

    // Optional Inline Goal Planner Drawer (由小鼠头自动拆解新目标为 3 个分步工作项)
    if (showPlanDrawer) {
      const planCard = document.createElement("section");
      planCard.className = "mc-plan-drawer";
      const planHead = document.createElement("div");
      planHead.style.cssText = "font-size:12px;font-weight:700;color:var(--mc-text-primary);display:flex;justify-content:space-between;align-items:center";
      planHead.textContent = "✨ 呼叫小鼠头🐭拆解新目标（自动生成 3 步工作项 + 独立 Git Worktree）";

      const titleInput = document.createElement("input");
      titleInput.type = "text";
      titleInput.className = "mc-plan-input";
      titleInput.placeholder = "输入新目标名称（例如：重构会话跳转与多目标卡片体系）";
      titleInput.value = "";

      const outcomeInput = document.createElement("input");
      outcomeInput.type = "text";
      outcomeInput.className = "mc-plan-input";
      outcomeInput.placeholder = "期望结果 / 完成判据（选填，小鼠头将据此生成 6 要素契约）";

      const planActionRow = document.createElement("div");
      planActionRow.style.cssText = "display:flex;justify-content:flex-end;gap:6px";

      const askInOrbitBtn = document.createElement("button");
      askInOrbitBtn.type = "button";
      askInOrbitBtn.className = "mc-btn-sm";
      askInOrbitBtn.textContent = "💬 带去小鼠头主聊讨论";
      askInOrbitBtn.addEventListener("click", () => void operation(askInOrbitBtn, async () => {
        const t = titleInput.value.trim() || "新研发目标";
        const o = outcomeInput.value.trim() || t;
        await hostActions.openThread("orbit");
        await hostActions.injectText(`小鼠头，请帮我拆解这个新目标并派给小队并行执行：\n- 目标：${t}\n- 期望结果：${o}`);
        if (current()) setStatus("已跳回小鼠头主聊并填入立项草稿。");
      }));

      const submitPlanBtn = document.createElement("button");
      submitPlanBtn.type = "button";
      submitPlanBtn.className = "mc-btn-sm mc-btn-primary";
      submitPlanBtn.textContent = "🚀 让小鼠头立即拆出 3 步工作项";
      submitPlanBtn.addEventListener("click", () => void operation(submitPlanBtn, async () => {
        const title = titleInput.value.trim() || `目标 ${goals.length + 1} · 模块并行改造与验收`;
        const desiredOutcome = outcomeInput.value.trim() || title;
        setStatus(`小鼠头🐭 正在拆解目标「${title}」并切出 Git Worktree...`);
        const res = await services.request("diy/goals/plan", {
          title,
          desiredOutcome,
          runSupervisorTurn: false,
        }) as { goal?: GoalRecord; items?: WorkItemRecord[]; activeWorkItemId?: string } | null;
        showPlanDrawer = false;
        if (res?.goal?.id) {
          selectedGoalId = res.goal.id;
          expandedGoals.add(res.goal.id);
        }
        if (res?.activeWorkItemId) selectedWorkItemId = res.activeWorkItemId;
        await load(false);
        if (current()) setStatus(`已由小鼠头拆解目标「${title}」（含 3 个分步工作项与独立 Worktree）。`);
      }));

      planActionRow.append(askInOrbitBtn, submitPlanBtn);
      planCard.append(planHead, titleInput, outcomeInput, planActionRow);
      content.append(planCard);
    }

    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "mc-goal-card";
      empty.style.padding = "18px 14px";
      empty.textContent = "当前暂无目标卡片。点击右上角「+ 新目标拆活」即可让小鼠头自动拆解多步工作项与并行小队。";
      content.append(empty);
      setStatus("就绪");
      return;
    }

    // Group items by goalId so multiple Goals render as independent expandable cards
    const effectiveGoals: GoalRecord[] = goals.length > 0 ? [...goals] : [{
      schemaVersion: 1,
      id: activeItem.goalId,
      revision: 1,
      title: activeItem.title,
      summary: activeItem.brief.goalSummary,
      status: "active",
      supervisorThreadId: activeItem.supervisorThreadId,
      repositories: [activeItem.repository],
      createdAt: activeItem.createdAt,
      updatedAt: activeItem.updatedAt,
    }];
    for (const item of items) {
      if (!effectiveGoals.some(g => g.id === item.goalId)) {
        effectiveGoals.push({
          schemaVersion: 1,
          id: item.goalId,
          revision: 1,
          title: item.title,
          summary: item.brief.goalSummary,
          status: "active",
          supervisorThreadId: item.supervisorThreadId,
          repositories: [item.repository],
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
        });
      }
    }

    const secHeader = document.createElement("div");
    secHeader.className = "mc-sec-label";
    const secLeft = document.createElement("span");
    secLeft.textContent = `🎯 目标卡片列表 (${effectiveGoals.length})`;
    const expandAllBtn = document.createElement("button");
    expandAllBtn.type = "button";
    expandAllBtn.style.cssText = "border:0;padding:0;font-size:11px;color:var(--mc-text-secondary);background:transparent";
    const allExpanded = effectiveGoals.every(g => expandedGoals.has(g.id));
    expandAllBtn.textContent = allExpanded ? "全部收起 ▴" : "全部展开 ▾";
    expandAllBtn.addEventListener("click", () => {
      if (allExpanded) expandedGoals.clear();
      else for (const g of effectiveGoals) expandedGoals.add(g.id);
      renderPanel(payload);
    });
    secHeader.append(secLeft, expandAllBtn);
    content.append(secHeader);

    const goalListEl = document.createElement("div");
    goalListEl.className = "mc-goal-list";
    goalListEl.dataset.layer = "workitem-brief";

    effectiveGoals.forEach((goal, goalIdx) => {
      const goalItems = items
        .filter(item => item.goalId === goal.id)
        .sort((a, b) => a.id.localeCompare(b.id));
      const doneSteps = goalItems.filter(i => i.status === "done" || i.status === "ready_for_acceptance").length;
      const totalSteps = Math.max(1, goalItems.length);
      const pct = Math.round((doneSteps / totalSteps) * 100);
      const isGoalExpanded = expandedGoals.has(goal.id);

      const goalCard = document.createElement("section");
      goalCard.className = "mc-goal-card";
      goalCard.dataset.goalId = goal.id;
      goalCard.dataset.expanded = String(isGoalExpanded);

      const goalHeadBtn = document.createElement("button");
      goalHeadBtn.type = "button";
      goalHeadBtn.className = "mc-goal-head";
      goalHeadBtn.setAttribute("aria-expanded", String(isGoalExpanded));
      goalHeadBtn.addEventListener("click", () => {
        if (expandedGoals.has(goal.id)) expandedGoals.delete(goal.id);
        else expandedGoals.add(goal.id);
        renderPanel(payload);
      });

      const goalTop = document.createElement("div");
      goalTop.className = "mc-goal-top";

      const titleRow = document.createElement("div");
      titleRow.className = "mc-goal-title-row";
      const idxBadge = document.createElement("span");
      idxBadge.className = "mc-goal-index";
      idxBadge.textContent = `GOAL 0${goalIdx + 1}`;
      const nameSpan = document.createElement("span");
      nameSpan.className = "mc-goal-name";
      nameSpan.textContent = goal.title;
      titleRow.append(idxBadge, nameSpan);

      const rightRow = document.createElement("div");
      rightRow.className = "mc-goal-right";
      const goalTone = goalItems.some(i => i.status === "needs_attention")
        ? { label: "需处理", tone: "danger" as const }
        : doneSteps === goalItems.length && goalItems.length > 0
          ? { label: "已就绪", tone: "positive" as const }
          : { label: `${doneSteps}/${goalItems.length} 步`, tone: "warning" as const };
      const goalPill = document.createElement("span");
      goalPill.className = "mc-pill";
      goalPill.dataset.tone = goalTone.tone;
      goalPill.textContent = goalTone.label;

      const chevron = document.createElement("span");
      chevron.className = "mc-chevron mc-goal-chevron";
      chevron.textContent = "▸";
      rightRow.append(goalPill, chevron);
      goalTop.append(titleRow, rightRow);

      const metaRow = document.createElement("div");
      metaRow.className = "mc-goal-meta-row";
      const metaText = document.createElement("span");
      const totalMembers = goalItems.reduce((sum, item) => sum + item.squad.length, 0);
      metaText.textContent = `📋 ${goalItems.length} 个分步工作项 · 👥 ${totalMembers} 名队员 · 📁 ${goal.repositories[0] || goalItems[0]?.repository || "MyCodex"}`;
      const track = document.createElement("div");
      track.className = "mc-progress-track";
      const fill = document.createElement("div");
      fill.className = "mc-progress-fill";
      fill.style.width = `${pct}%`;
      track.append(fill);
      metaRow.append(metaText, track);

      goalHeadBtn.append(goalTop, metaRow);
      goalCard.append(goalHeadBtn);

      if (isGoalExpanded) {
        const goalBody = document.createElement("div");
        goalBody.className = "mc-goal-body";

        if (goal.summary) {
          const sumEl = document.createElement("div");
          sumEl.className = "mc-goal-summary";
          sumEl.textContent = goal.summary;
          goalBody.append(sumEl);
        }

        const stepper = document.createElement("div");
        stepper.className = "mc-stepper";
        stepper.dataset.workitemSwitcher = "1";

        goalItems.forEach((stepItem, stepIdx) => {
          const isStepActive = stepItem.id === activeItem?.id && !collapsedSteps.has(stepItem.id);
          const stepDesc = statusDescriptor(stepItem.status);
          const stepCard = document.createElement("div");
          stepCard.className = "mc-step-card";
          stepCard.dataset.active = String(isStepActive);
          stepCard.dataset.workitemTab = stepItem.id;

          const stepHeadBtn = document.createElement("button");
          stepHeadBtn.type = "button";
          stepHeadBtn.className = "mc-step-head";
          stepHeadBtn.setAttribute("aria-pressed", String(isStepActive));
          stepHeadBtn.setAttribute("aria-expanded", String(isStepActive));
          stepHeadBtn.addEventListener("click", () => {
            selectedGoalId = goal.id;
            if (selectedWorkItemId === stepItem.id) {
              if (collapsedSteps.has(stepItem.id)) collapsedSteps.delete(stepItem.id);
              else collapsedSteps.add(stepItem.id);
            } else {
              selectedWorkItemId = stepItem.id;
              collapsedSteps.delete(stepItem.id);
            }
            renderPanel(payload);
            setStatus(`已切换至分步工作项：${stepItem.title}`);
          });

          const stepLeft = document.createElement("div");
          stepLeft.className = "mc-step-left";
          const stepNum = document.createElement("span");
          stepNum.className = "mc-step-num";
          const isStepDone = stepItem.status === "done" || stepItem.status === "ready_for_acceptance";
          stepNum.dataset.done = String(isStepDone);
          stepNum.dataset.active = String(isStepActive);
          stepNum.textContent = isStepDone ? "✓" : String(stepIdx + 1);

          const stepTitle = document.createElement("span");
          stepTitle.className = "mc-step-title";
          stepTitle.textContent = stepItem.title;
          stepLeft.append(stepNum, stepTitle);

          const stepRight = document.createElement("div");
          stepRight.className = "mc-goal-right";
          const squadCount = stepItem.squad.length;
          const countPill = document.createElement("span");
          countPill.className = "mc-pill";
          countPill.textContent = `👥 ${squadCount}`;
          const statusPill = document.createElement("span");
          statusPill.className = "mc-pill";
          statusPill.dataset.tone = stepDesc.tone;
          statusPill.textContent = stepDesc.label;
          const stepChev = document.createElement("span");
          stepChev.className = "mc-chevron";
          stepChev.textContent = isStepActive ? "▾" : "▸";
          stepRight.append(countPill, statusPill, stepChev);

          stepHeadBtn.append(stepLeft, stepRight);
          stepCard.append(stepHeadBtn);

          if (isStepActive) {
            const stepBody = document.createElement("div");
            stepBody.className = "mc-step-body";
            stepBody.dataset.layer = "squad-workspace";

            // Sub-box A: 验收标准与 6 要素契约
            const criteriaBox = document.createElement("div");
            criteriaBox.className = "mc-subbox";
            const criteriaHead = document.createElement("div");
            criteriaHead.className = "mc-subbox-head";
            const criteriaTitle = document.createElement("span");
            criteriaTitle.className = "mc-subbox-title";
            criteriaTitle.textContent = "✅ 本步完成判据 & 派单契约";

            const blockingAttention = stepItem.squad.filter(m => m.status === "needs_attention");
            const settledImplementers = stepItem.squad.filter(m => m.role === "implementer" && m.status === "settled");
            const integrateBtn = document.createElement("button");
            integrateBtn.type = "button";
            integrateBtn.className = "mc-btn-sm mc-btn-primary";
            integrateBtn.dataset.action = "wave2-integrate";
            integrateBtn.textContent = "🏁 Wave 2 汇总合并";
            integrateBtn.setAttribute("aria-label", "🏁 Wave 2 @integrator 汇总合并");
            if (blockingAttention.length > 0 || settledImplementers.length === 0) {
              integrateBtn.disabled = true;
              integrateBtn.title = blockingAttention.length > 0
                ? `存在待处理异常队员 (${blockingAttention.map(m => m.memberId).join(", ")})`
                : "尚无已完成回传的实现者分支";
            }
            integrateBtn.addEventListener("click", () => void operation(integrateBtn, async () => {
              setStatus("正在执行 Wave 2 @integrator 汇总合并与门禁验证...");
              await services.request("diy/work/integrate", { workItemId: stepItem.id, markDone: true });
              await load(false);
              if (current()) setStatus(`已将 ${stepItem.title} 的并行 Worktree 改动汇总合入主分支！`);
            }));
            criteriaHead.append(criteriaTitle, integrateBtn);
            criteriaBox.append(criteriaHead);

            const checkList = document.createElement("ul");
            checkList.className = "mc-check-list";
            const criteriaItems = stepItem.brief.doneCriteria.length
              ? stepItem.brief.doneCriteria
              : [stepItem.brief.goalSummary];
            for (const cText of criteriaItems) {
              const li = document.createElement("li");
              li.className = "mc-check-item";
              const icon = document.createElement("span");
              icon.className = "mc-check-icon";
              icon.textContent = "✓";
              const txt = document.createElement("span");
              txt.textContent = cText;
              li.append(icon, txt);
              checkList.append(li);
            }
            criteriaBox.append(checkList);

            const tagRow = document.createElement("div");
            tagRow.className = "mc-tag-row";
            for (const tagText of [
              `⎇ 基线 ${stepItem.handoff.baseSha}`,
              `✏️ 范围 ${stepItem.handoff.scope.modify.join(", ")}`,
              `🚫 禁碰 ${stepItem.handoff.scope.doNotTouch.join(", ") || "无"}`,
            ]) {
              const t = document.createElement("span");
              t.className = "mc-code-tag";
              t.textContent = tagText;
              tagRow.append(t);
            }
            criteriaBox.append(tagRow);
            stepBody.append(criteriaBox);

            // Sub-box B: 双列小队工位网格 (2-Column Squad Seat Grid)
            const squadBox = document.createElement("div");
            squadBox.className = "mc-subbox";
            const squadHead = document.createElement("div");
            squadHead.className = "mc-subbox-head";
            const squadTitle = document.createElement("span");
            squadTitle.className = "mc-subbox-title";
            squadTitle.textContent = `👥 本步专属小队工位 (${stepItem.squad.length} 名队员)`;
            squadHead.append(squadTitle);
            squadBox.append(squadHead);

            const squadGrid = document.createElement("div");
            squadGrid.className = "mc-squad-grid";
            squadGrid.dataset.squadRoster = stepItem.id;

            for (const member of stepItem.squad) {
              const mStatus = statusDescriptor(member.status);
              const seat = document.createElement("div");
              seat.className = "mc-seat-card";
              seat.dataset.squadMember = member.memberId;

              const seatTop = document.createElement("div");
              seatTop.className = "mc-seat-top";
              const seatId = document.createElement("span");
              seatId.className = "mc-seat-id";
              seatId.textContent = `${member.memberId}`;
              const seatPill = document.createElement("span");
              seatPill.className = "mc-pill";
              seatPill.dataset.tone = mStatus.tone;
              seatPill.textContent = mStatus.label;
              seatTop.append(seatId, seatPill);

              const seatDesc = document.createElement("div");
              seatDesc.className = "mc-seat-desc";
              seatDesc.textContent = `${roleBadge(member.role)} · ${member.label}`;

              const seatTags = document.createElement("div");
              seatTags.className = "mc-seat-tags";
              const scopeTag = document.createElement("span");
              scopeTag.className = "mc-code-tag";
              scopeTag.textContent = `📄 ${member.ownedPaths[0] || stepItem.handoff.scope.modify[0] || "只读"}`;
              const branchTag = document.createElement("span");
              branchTag.className = "mc-code-tag";
              branchTag.textContent = `⎇ ${member.headSha || member.baseSha}`;
              seatTags.append(scopeTag, branchTag);

              const seatActions = document.createElement("div");
              seatActions.style.cssText = "display:flex;gap:4px;flex-wrap:wrap;padding-top:2px";
              if (member.threadId) {
                const openBtn = document.createElement("button");
                openBtn.type = "button";
                openBtn.className = "mc-btn-sm";
                openBtn.style.cssText = "height:22px;padding:0 6px;font-size:10.5px";
                openBtn.textContent = "↗ 现场";
                openBtn.setAttribute("aria-label", "→ 进入现场");
                openBtn.addEventListener("click", () => void operation(openBtn, async () => {
                  await hostActions.openThread(member.threadId!);
                  if (current()) setStatus(`已打开队员 ${member.memberId} 的真实会话现场。`);
                }));
                seatActions.append(openBtn);
              }
              if (member.status === "cooldown_429" || member.status === "needs_attention") {
                const handoffBtn = document.createElement("button");
                handoffBtn.type = "button";
                handoffBtn.className = "mc-btn-sm mc-btn-amber";
                handoffBtn.style.cssText = "height:22px;padding:0 6px;font-size:10.5px";
                handoffBtn.textContent = "🔄 接力";
                handoffBtn.setAttribute("aria-label", "🔄 一键 Handoff 接力");
                handoffBtn.addEventListener("click", () => void operation(handoffBtn, async () => {
                  const standby = stepItem.squad.find(c =>
                    c.memberId !== member.memberId && c.role === member.role && c.status === "idle"
                  );
                  const toMemberId = standby ? standby.memberId : `${member.memberId}-relay`;
                  await services.request("diy/work/handoff", {
                    workItemId: stepItem.id,
                    fromMemberId: member.memberId,
                    toMemberId,
                    toLabel: standby?.label ?? `接力队员 (${toMemberId})`,
                    executeNow: true,
                  });
                  await load(false);
                  if (current()) setStatus(`已完成 ${member.memberId} → ${toMemberId} 跨引擎接力。`);
                }));
                seatActions.append(handoffBtn);
              }

              seat.append(seatTop, seatDesc, seatTags);
              if (seatActions.childElementCount > 0) seat.append(seatActions);
              squadGrid.append(seat);
            }
            squadBox.append(squadGrid);

            // Dispatch Bar inside Squad Box
            const dispatchBar = document.createElement("div");
            dispatchBar.className = "mc-dispatch-bar";
            const input = document.createElement("input");
            input.type = "text";
            input.className = "mc-plan-input";
            input.style.flex = "1";
            input.placeholder = "向本步小队下达指令（支持 @impl-a 指定队员）...";
            input.setAttribute("aria-label", "小队派发指令");

            const dispatchBtn = document.createElement("button");
            dispatchBtn.type = "button";
            dispatchBtn.className = "mc-btn-sm mc-btn-primary";
            dispatchBtn.dataset.action = "squad-dispatch";
            dispatchBtn.textContent = "🚀 派发小队执行";
            dispatchBtn.setAttribute("aria-label", "🚀 派发小队执行");
            dispatchBtn.addEventListener("click", () => void operation(dispatchBtn, async () => {
              const rawText = input.value.trim();
              const mentionMatches = [...rawText.matchAll(/(@[A-Za-z0-9_-]+)/g)].map(m => m[1]);
              const matchedMembers = mentionMatches.filter(id => stepItem.squad.some(m => m.memberId === id));
              setStatus("正在并行启动小队真实 CLI 会话...");
              await services.request("diy/work/dispatch", {
                workItemId: stepItem.id,
                directive: rawText || undefined,
                ...(matchedMembers.length ? { memberIds: matchedMembers } : {}),
              });
              input.value = "";
              await load(false);
              if (current()) setStatus(`已完成 ${stepItem.title} 的小队派发与回传！`);
            }));
            dispatchBar.append(input, dispatchBtn);
            squadBox.append(dispatchBar);
            stepBody.append(squadBox);

            // Sub-box C: 小队群聊浓缩动态流 (Squad Chat Feed)
            const feedBox = document.createElement("div");
            feedBox.className = "mc-subbox";
            const feedHead = document.createElement("div");
            feedHead.className = "mc-subbox-head";
            const feedTitle = document.createElement("span");
            feedTitle.className = "mc-subbox-title";
            feedTitle.textContent = `💬 小队群聊进展记录 (${stepItem.board.length})`;
            feedHead.append(feedTitle);
            feedBox.append(feedHead);

            const feedList = document.createElement("div");
            feedList.className = "mc-feed-list";
            feedList.dataset.squadBoard = stepItem.id;

            for (const entry of [...stepItem.board].reverse()) {
              const card = document.createElement("article");
              card.className = "mc-feed-item";
              card.dataset.boardEntry = entry.id;

              const top = document.createElement("div");
              top.className = "mc-feed-top";
              const author = document.createElement("span");
              author.className = "mc-pill";
              author.dataset.tone = entry.kind === "attention" ? "danger" : entry.kind === "handback" || entry.kind === "integration" ? "positive" : "neutral";
              author.textContent = `${entry.memberId} · ${roleBadge(entry.role)}`;

              const actions = document.createElement("div");
              actions.style.cssText = "display:flex;gap:4px";
              if (entry.threadId) {
                const jumpBtn = document.createElement("button");
                jumpBtn.type = "button";
                jumpBtn.className = "mc-btn-sm";
                jumpBtn.style.cssText = "height:20px;padding:0 6px;font-size:10px";
                jumpBtn.textContent = "↗ 现场";
                jumpBtn.setAttribute("aria-label", "→ 进入现场");
                jumpBtn.addEventListener("click", () => void operation(jumpBtn, async () => {
                  await hostActions.openThread(entry.threadId!);
                  if (current()) setStatus(`已进入 ${entry.memberId} 会话现场。`);
                }));
                actions.append(jumpBtn);
              }
              const discussText = entry.draftPrompt || `【小队汇报 · ${stepItem.title}】${entry.memberId}: ${entry.title} — ${entry.summary}`;
              const discussBtn = document.createElement("button");
              discussBtn.type = "button";
              discussBtn.className = "mc-btn-sm";
              discussBtn.style.cssText = "height:20px;padding:0 6px;font-size:10px";
              discussBtn.textContent = "💬 主聊";
              discussBtn.setAttribute("aria-label", "💬 带入主聊讨论");
              discussBtn.addEventListener("click", () => void operation(discussBtn, async () => {
                try {
                  await hostActions.prefillDraft(discussText);
                } catch {
                  await hostActions.injectText(discussText);
                }
                if (current()) setStatus("已带入主会话输入框。");
              }));
              actions.append(discussBtn);
              top.append(author, actions);

              const h4 = document.createElement("h4");
              h4.className = "mc-feed-title";
              h4.textContent = entry.title;

              const p = document.createElement("p");
              p.className = "mc-feed-sum";
              p.textContent = entry.summary;

              card.append(top, h4, p);
              if (entry.changedFiles.length > 0) {
                const filesRow = document.createElement("div");
                filesRow.className = "mc-seat-tags";
                for (const f of entry.changedFiles.slice(0, 4)) {
                  const ft = document.createElement("span");
                  ft.className = "mc-code-tag";
                  ft.textContent = `📄 ${f}`;
                  filesRow.append(ft);
                }
                card.append(filesRow);
              }
              feedList.append(card);
            }
            feedBox.append(feedList);
            stepBody.append(feedBox);

            stepCard.append(stepBody);
          }

          stepper.append(stepCard);
        });

        goalBody.append(stepper);
        goalCard.append(goalBody);
      }

      goalListEl.append(goalCard);
    });

    content.append(goalListEl);
    setStatus(`共 ${effectiveGoals.length} 个目标卡片，当前聚焦：${activeItem.title}`);
  };

  const load = async (announce = true) => {
    if (loading || !current()) return;
    loading = true;
    const generation = ++epoch;
    if (announce) setStatus("正在同步小鼠头目标卡片与分步工作项...");
    try {
      const [legacy, shared] = await Promise.allSettled([
        services.request("diy/work/list", {}), services.request("diy/work/shared_list", { limit: 12 }),
      ]);
      if (legacy.status !== "fulfilled") throw legacy.reason;
      const payload = legacy.value as WorkListPayload;
      if (shared.status === "fulfilled") {
        const page = shared.value as { items?: GeneralWorkItemRecord[]; nextOffset?: number | null } | null;
        sharedAvailable = Array.isArray(page?.items);
        sharedItems = Array.isArray(page?.items) ? page.items : [];
        sharedNextOffset = page?.nextOffset ?? null; sharedReadError = null;
        if (selectedSharedId && !sharedItems.some(item => item.id === selectedSharedId)) {
          const selected = await services.request("diy/work/context", { id: selectedSharedId }) as { workItem: GeneralWorkItemRecord };
          if (selected?.workItem) sharedItems.push(selected.workItem);
        }
        if (progressDraft?.uncertain) {
          const draft = progressDraft, saved = sharedItems.find(item => item.id === draft.id);
          if (saved && saved.revision > draft.revision) {
            const nextStep = draft.nextDescription.trim() && draft.nextOwner.trim()
              ? { kind: draft.nextKind, description: draft.nextDescription.trim(), owner: draft.nextOwner.trim() } : null;
            const criteria = draft.criteria.split("\n").map(value => value.trim()).filter(Boolean);
            if (saved.progress === draft.progress.trim() && saved.status === draft.status && saved.expectedOutput === (draft.expectedOutput.trim() || null) &&
                JSON.stringify(saved.doneCriteria) === JSON.stringify(criteria) && JSON.stringify(saved.nextStep) === JSON.stringify(nextStep)) progressDraft = null;
            else { draft.latest = saved; draft.error = "工作库已出现新的进展。请先核对，再继续编辑。"; }
          }
        }
      } else sharedReadError = shared.reason instanceof Error ? shared.reason.message : "通用工作读取失败";
      if (!current() || generation !== epoch) return;
      renderPanel(payload);
      if (sharedReadError && !sharedItems.length) setStatus(`代码工作已读取；通用工作暂不可用：${sharedReadError}`);
    } catch (cause) {
      if (!current() || generation !== epoch) return;
      content.replaceChildren();
      setBadge(0);
      const error = document.createElement("p"); error.className = "mc-shared-note";
      error.textContent = cause instanceof Error ? cause.message : "目标与工作项加载失败";
      content.append(error, sharedButton("重新读取工作台", button => void operation(button, async () => { await load(false); })));
      setStatus("工作台暂未同步，请重新读取。");
    } finally {
      loading = false;
    }
  };

  const unsubscribe = services.subscribe?.((event: unknown) => {
    const kind = (event as { kind?: string } | null)?.kind;
    if (kind === "work" || kind === "reactions") {
      if (!busy && !loading) void load(false);
    }
  });

  void load(true);

  return {
    host: root,
    dispose() {
      disposed = true;
      unsubscribe?.();
      root.remove();
    },
  };
}
