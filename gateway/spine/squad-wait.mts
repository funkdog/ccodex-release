import type { SquadLiteRecord } from "./squad-lite.mjs";
import type { SquadLedger, SquadLedgerEntry } from "./squad-ledger.mjs";
import { currentDelivery, unreportedTurn, type SquadMemberObservation } from "./squad-observation.mjs";
export interface SquadWaitSnapshot { record: SquadLiteRecord; ledger: SquadLedger; observations: Record<string, SquadMemberObservation>; active: Promise<unknown>[] }
export interface SquadWaitBlocker { reason: string; message: string; threadId?: string; handle?: string; seq?: number; turnId?: string }
export interface SquadWaitResult {
  squadId: string; status: "settled" | "needs_human" | "timeout" | "idle"; reason?: string;
  sinceSeq: number; latestSeq: number; ballInCourt: string | null; hopPausedForHuman: boolean;
  entries: SquadLedgerEntry[]; memberStates: Record<string, string>; blockers?: SquadWaitBlocker[];
  nextSinceSeq?: number; hasMoreEntries?: boolean; hasMoreBlockers?: boolean;
}
function evaluate(snapshot: SquadWaitSnapshot, sinceSeq: number, targetHandles?: string[]): SquadWaitResult {
  const { record, ledger, observations } = snapshot;
  const workers = record.members.filter(m => m.role === "worker"), targets = targetHandles ? workers.filter(m => targetHandles.includes(m.shortName.toLowerCase())) : workers;
  if (targetHandles?.some(handle => !workers.some(m => m.shortName.toLowerCase() === handle))) throw new Error("Unknown squad wait target handle.");
  const allNew = ledger.entries.filter(e => e.seq > sinceSeq), entries: SquadLedgerEntry[] = [];
  let bytes = 0;
  for (const entry of allNew) { const size = Buffer.byteLength(JSON.stringify(entry)); if (entries.length && bytes + size > 128 * 1024) break; entries.push(entry); bytes += size; }
  const memberStates: Record<string, string> = {}, blockers: SquadWaitBlocker[] = [];
  if (ledger.hopPausedForHuman) blockers.push({ reason: "hop_limit_paused", message: "自动接力已达上限，等待人工放行。" });
  for (const entry of allNew) if (entry.kind === "blocked" || entry.verdict === "changes_requested") blockers.push({ reason: "blocked_entry", message: entry.summary, seq: entry.seq, threadId: entry.authorThreadId, handle: entry.authorHandle });
  let busy = false;
  for (const member of workers) {
    const observed = observations[member.threadId] ?? { status: { type: "offline" } }, status = observed.status;
    const delivery = currentDelivery(ledger, member.threadId), diagnostic = unreportedTurn(ledger, member.threadId, observed);
    const entry = ledger.entries.findLast(e => e.authorThreadId === member.threadId && e.kind !== "note");
    const selected = targets.includes(member);
    const waitingApproval = status.type === "waitingOnApproval" || status.activeFlags?.includes("waitingOnApproval"), waitingInput = status.type === "waitingOnUserInput" || status.activeFlags?.includes("waitingOnUserInput");
    const failure = ["needs_attention", "error", "systemError", "failed"].includes(status.type);
    const unresolved = delivery && ["failed", "sending", "paused"].includes(delivery.state);
    const running = ["active", "running", "inProgress"].includes(status.type);
    const done = entry && ["handoff", "review", "system_fallback"].includes(entry.kind) && (!delivery || entry.seq > delivery.seq);
    memberStates[member.threadId] = waitingApproval || waitingInput || failure || diagnostic || unresolved ? "attention" : running ? "running" : status.type === "offline" ? "offline" : done ? "done" : "idle";
    if (!selected) continue;
    const add = (reason: string, message: string) => blockers.push({ reason, message, threadId: member.threadId, handle: member.shortName, ...(delivery ? { seq: delivery.seq } : {}) });
    if (waitingApproval) add("waiting_approval", "成员正在等待工具审批，请打开来源会话处理。");
    if (waitingInput) add("waiting_input", "成员正在等待用户回答，请打开来源会话处理。");
    if (failure && !diagnostic) add("turn_failed", "成员报告失败或需要人工处理。");
    if (delivery?.state === "failed") add("delivery_failed", delivery.error ?? "投递失败，请人工核实。");
    if (delivery?.state === "sending") add("delivery_unresolved", "投递结果未决，核实来源会话后再决定下一步，勿重复投递。");
    if (diagnostic) blockers.push({ reason: diagnostic.reason, message: diagnostic.message, threadId: member.threadId, handle: member.shortName, seq: diagnostic.seq, turnId: diagnostic.turnId });
    if (running || delivery?.state === "queued" || delivery?.state === "sent" && !diagnostic) busy = true;
  }
  const boundedBlockers: SquadWaitBlocker[] = []; let blockerBytes = 0;
  for (const blocker of blockers) {
    const bounded = { ...blocker, message: blocker.message.slice(0, 1000) }, size = Buffer.byteLength(JSON.stringify(bounded));
    if (blockerBytes + size > 96 * 1024) break; boundedBlockers.push(bounded); blockerBytes += size;
  }
  const newConclusion = allNew.some(e => e.nextHandle === "supervisor" || targets.some(m => m.threadId === e.authorThreadId) && ["handoff", "review", "system_fallback"].includes(e.kind));
  const status = record.status === "closed" ? "idle" : blockers.length ? "needs_human" : !busy && newConclusion ? "settled" : busy ? "timeout" : "idle";
  return { squadId: record.id, status, sinceSeq, latestSeq: ledger.entries.length, ballInCourt: ledger.ballInCourt, hopPausedForHuman: ledger.hopPausedForHuman,
    entries, memberStates, ...(status === "needs_human" ? { reason: blockers[0].reason, blockers: boundedBlockers, ...(boundedBlockers.length < blockers.length ? { hasMoreBlockers: true } : {}) } : {}),
    ...(entries.length < allNew.length ? { nextSinceSeq: entries.at(-1)?.seq ?? sinceSeq, hasMoreEntries: true } : {}) };
}
/** Snapshot reads serialize briefly; native probes and the suspended Promise
 * never own the gateway write queue. Notifications are wakeups, not state. */
export function waitForSquad(params: Record<string, unknown>, deps: {
  signal: AbortSignal; snapshot(): Promise<SquadWaitSnapshot>; probe(snapshot: SquadWaitSnapshot): Promise<void>; subscribe(notify: () => void): () => void;
}): Promise<SquadWaitResult> {
  if (Object.keys(params).some(k => !["squadId", "sinceSeq", "targetHandles", "timeoutMs"].includes(k)) || typeof params.squadId !== "string" || !/^sq-[a-f0-9]{8}$/.test(params.squadId)) return Promise.reject(new Error("Invalid squad wait parameters."));
  const timeoutMs = params.timeoutMs ?? 30000;
  if (!Number.isSafeInteger(timeoutMs) || Number(timeoutMs) < 0 || Number(timeoutMs) > 120000 || params.sinceSeq !== undefined && (!Number.isSafeInteger(params.sinceSeq) || Number(params.sinceSeq) < 0) || params.targetHandles !== undefined && (!Array.isArray(params.targetHandles) || params.targetHandles.length > 20 || params.targetHandles.some(h => typeof h !== "string" || !h.replace(/^@/, "").trim() || h.length > 61))) return Promise.reject(new Error("Invalid squad wait range or targets."));
  const targets = params.targetHandles === undefined ? undefined : [...new Set((params.targetHandles as string[]).map(h => h.replace(/^@/, "").trim().toLowerCase()))];
  return new Promise((resolve, reject) => {
    let expired = false, done = false, checking = false, dirty = false, probing = false, lastProbe = 0, baseline = params.sinceSeq as number | undefined;
    let latest: SquadWaitResult | undefined, unsubscribe: (() => void) | undefined;
    const active = new WeakSet<Promise<unknown>>();
    const cleanup = () => { clearTimeout(deadline); clearInterval(interval); unsubscribe?.(); deps.signal.removeEventListener("abort", abort); };
    const finish = (result?: SquadWaitResult, error?: unknown) => { if (done) return; done = true; cleanup(); error ? reject(error) : resolve(result!); };
    const abort = () => finish(undefined, new Error("Squad wait cancelled."));
    const check = async () => {
      if (done) return;
      if (checking) { dirty = true; return; }
      checking = true;
      try {
        deps.signal.throwIfAborted(); const snapshot = await deps.snapshot(); if (done) return;
        baseline ??= snapshot.ledger.entries.length; latest = evaluate(snapshot, baseline, targets);
        for (const promise of snapshot.active) if (!active.has(promise)) { active.add(promise); void promise.then(() => { void check(); }, () => { void check(); }); }
        if (latest.status !== "timeout" || timeoutMs === 0 || expired) { finish(latest); return; }
        if (!probing && Date.now() - lastProbe >= 900) {
          probing = true; lastProbe = Date.now();
          void deps.probe(snapshot).then(() => { probing = false; void check(); }, error => { probing = false; if (deps.signal.aborted) abort(); else finish(undefined, error); });
        }
      } catch (error) { finish(undefined, error); }
      finally { checking = false; if (dirty && !done) { dirty = false; void check(); } }
    };
    const deadline = setTimeout(() => { expired = true; if (latest) finish(latest); else void check(); }, Math.max(1, Number(timeoutMs)));
    const interval = setInterval(() => { void check(); }, 1000);
    unsubscribe = deps.subscribe(() => { void check(); }); deps.signal.addEventListener("abort", abort, { once: true });
    if (deps.signal.aborted) abort(); else void check();
  });
}
