import { compactSquadPayload } from "./squad-v2-state.mjs";
import { SquadV2Kernel, type V2Thread } from './squad-v2-kernel.mjs';
import type { GatewayProtocol } from "../protocol.mjs";
import type { GatewayConnection, GatewayParams } from "../contracts.mjs";
import { loadSquads, saveSquads, createSquad, addMember, removeMember, dissolveSquad } from "./squad-lite.mjs";
import type { SquadStore, SquadLiteRecord } from "./squad-lite.mjs";
import { writeBrief, readBrief, readResult, cleanupWorkerRelay, cleanupSquadRelay, removeBrief, formatBriefAsText } from "./squad-relay.mjs";
import type { SquadBrief, SquadResult } from "./squad-relay.mjs";
import { writeResult } from "./squad-relay.mjs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { HostThreadBroker } from "../host-threads.mjs";
import { parseHostRef, type HostThreadRef, type HostBinding } from "./host-thread-contracts.mjs";
import type { SquadNativeThread, SquadNativeRequest, SquadNativeReceipt } from "../squad-native-peer.mjs";
import { squadAction, notSent } from "./squad-actions.mjs";
import { SquadCleanup, type SquadCleanupJob } from "./squad-cleanup.mjs";
import fs from "node:fs/promises";
import { readLedger, saveLedger, ledgerPath, renderIssue, type SquadLedger, type SquadLedgerEntry, type LedgerEntryKind, type LedgerDelivery } from "./squad-ledger.mjs";
import { currentDelivery, unreportedTurn, terminalTurn, type SquadMemberObservation, type SquadTurnDiagnostic } from "./squad-observation.mjs";
import { waitForSquad, type SquadWaitSnapshot } from "./squad-wait.mjs";
import { readRoles, saveRoles, validateRoles } from "./squad-roles.mjs";

export interface SquadView extends SquadLiteRecord {
  memberStates: Record<string, "idle" | "running" | "done" | "attention" | "offline">;
  ledger: SquadLedger; missingReports: string[]; turnDiagnostics: Record<string, SquadTurnDiagnostic>; unresolvedDeliveries: LedgerDelivery[];
  briefs: SquadBrief[]; results: SquadResult[]; errors: Record<string, string>;
}
export interface SquadSnapshot {
  squads: SquadView[];
  threads: Array<{ id: string; title: string; engine: string; status: unknown; hostRef?: HostThreadRef }>;
  nativeHosts?: HostBinding[];
  preferredNativeRuntimeId?: string;
}
type Member = SquadLiteRecord["members"][number];

function value(params: Record<string, unknown>, key: string, max = 4096): string {
  const text = params[key];
  if (typeof text !== "string" || !text.trim() || text.length > max || text.includes("\0")) throw new Error(`Invalid squad ${key}.`);
  return text.trim();
}
function keys(params: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(params).some(key => !allowed.includes(key))) throw new Error("Invalid squad parameters.");
}
function squad(store: SquadStore, id: string) {
  if (!Object.hasOwn(store.squads, id)) throw new Error("Squad does not exist.");
  return store.squads[id];
}
function nativeIdentity(ref?: HostThreadRef) {
  return ref ? { hostId: ref.hostId, accountId: ref.accountId, threadId: ref.threadId } : null;
}

/** The socket-owning gateway is the only runtime writer of squads.json.
 * One queue owns read/modify/save and deletion cleanup; no WorkItem dependency. */
export class SquadService {
  private v2: SquadV2Kernel;
  private tail: Promise<unknown> = Promise.resolve();
  private home: string;
  private protocol: GatewayProtocol;
  private changed: () => void;
  private waitListeners = new Set<() => void>();
  private waits = new Set<AbortController>();
  private closed = false;
  private nativeObservations = new Map<string, { deliveryId: string | null; observed: SquadMemberObservation }>();
  private nativeHost: () => HostThreadBroker | undefined;
  private cleanup: SquadCleanup;
  clientFile?: string;
  constructor(home: string, protocol: GatewayProtocol, changed: () => void = () => {}, nativeHost: () => HostThreadBroker | undefined = () => undefined, openDesktop?: (thread: V2Thread, anchorThreadId: string) => Promise<{ opened: boolean; reason?: string }>) {
    this.home = home; this.protocol = protocol; this.changed = () => { changed(); for (const notify of this.waitListeners) notify(); };
    this.nativeHost = nativeHost;
    this.v2 = new SquadV2Kernel(home, {
      open: openDesktop,
      read: async (id, ref, turnId) => {
        const nativeTurn = ref && turnId ? await this.nativeThread(id, ref, undefined, { turnId, includeText: true }) : undefined;
        const t = nativeTurn?.thread ?? await this.thread(id, ref);
        const cli = !ref ? this.protocol.store.get(id) : undefined;
        const turn = cli?.turns.at(-1);
        return { id: t.id, cwd: t.cwd, model: cli?.model ?? t.model, reasoningEffort: cli ? cli.reasoningEffort : (t as SquadNativeThread).reasoningEffort, ...(ref ? { hostRef: (t as SquadNativeThread).hostRef } : {}),
          status: t.status as V2Thread['status'], turnStatus: turn?.status ?? nativeTurn?.status,
          ...((t as SquadNativeThread).activeSubagents ? { activeSubagents: true } : {}),
          ...(nativeTurn ? { lastMessage: nativeTurn.error?.message || nativeTurn.text } : {}),
          ...(turn ? { lastMessage: turn.items.filter(i => i.type === 'agentMessage').map(i => String((i as { text?: string }).text ?? '')).at(-1) } : {}) };
      },
      create: async (slot, cwd, anchor) => {
        if (slot.engine === 'native') {
          if (!anchor.hostRef) throw new Error('Native slots require a native anchor.');
          const response = await this.nativeMutation(anchor.hostRef, { operation: 'create', requestId: randomUUID(), cwd,
            model: slot.model, ...(slot.reasoningEffort ? { reasoningEffort: slot.reasoningEffort } : {}), anchorThreadId: anchor.id, trusted: true, stripSquadTools: true,
            ...(slot.readOnly ? { sandbox: 'read-only' } : {}) });
          if (!response.thread) throw new Error('Native create receipt is incomplete.');
          return { ...response.thread, status: response.thread.status as V2Thread['status'] };
        }
        const connection: GatewayConnection = { initialized: true, send() {}, request: async () => { throw new Error('Worker creation needs interactive input.'); } };
        const result = await this.protocol.handle('thread/start', { model: slot.model, cwd,
          ...(slot.reasoningEffort ? { effort: slot.reasoningEffort } : {}), ...(slot.readOnly ? { sandbox: 'read-only' } : {}) } as GatewayParams, connection) as { thread: { id: string } };
        return { id: result.thread.id, cwd, status: { type: 'idle' } };
      },
      send: (thread, text, requestId, role = 'worker', readOnly = false) => this.send({ threadId: thread.id, hostRef: thread.hostRef, role, shortName: 'slot', engine: 'codex', joinedAt: Date.now() } as Member, text, requestId, undefined, role === 'worker', readOnly),
    }, this.changed);

    this.cleanup = new SquadCleanup(home, job => this.cleanupSettled(job), job => this.serial(async store => {
      const current = store.squads[job.squadId], member = current?.members.find(m => m.threadId === job.workerId);
      const latest = await readBrief(home, job.squadId, job.workerId);
      // If removal did not commit, or the same worker was added back without
      // a new brief, do not erase its current work. New dispatches have their
      // own files, so retiring an old turn cannot erase the new result.
      if (member && latest && latest.dispatchId === job.dispatchId) return;
      await cleanupWorkerRelay(home, job.squadId, job.workerId, member ? job.dispatchId : undefined);
      const directory = path.join(home, ".mycodex", "squad-relay", job.squadId);
      try { await fs.rmdir(directory); } catch (cause) { if (!["ENOENT", "ENOTEMPTY"].includes((cause as NodeJS.ErrnoException).code ?? "")) throw cause; }
    }));
  }
  private relayTimer?: ReturnType<typeof setInterval>;
  private ticking = false;
  start() { this.cleanup.start(); this.relayTimer = setInterval(() => { if (this.ticking) return; this.ticking = true; void this.tick().catch(() => {}).finally(() => { this.ticking = false; }); }, 5000); this.relayTimer.unref(); }
  async close() { this.closed = true; for (const controller of this.waits) controller.abort(); clearInterval(this.relayTimer); await this.tail; await this.v2.shutdown(); return this.cleanup.close(); }
  private async cleanupSettled(job: SquadCleanupJob) {
    const host = this.nativeHost(); if (!host) return false;
    let turnId = job.turnId;
    if (!turnId && job.dispatchId) turnId = (await this.nativeReceipt(job.ref, job.dispatchId)).turnId;
    if (job.dispatchId && !turnId) return false;
    if (turnId) {
      const turn = await host.resolveSquadTurn(job.ref, turnId, false);
      return ["completed", "failed", "interrupted"].includes(turn.status);
    }
    const target = await host.resolveSquad(job.ref);
    return (target.status as { type?: string })?.type === "idle";
  }
  private async trackNativeCleanup(record: SquadLiteRecord, workerId?: string) {
    for (const member of record.members.filter(m => m.role === "worker" && m.hostRef && (!workerId || m.threadId === workerId))) {
      const brief = await readBrief(this.home, record.id, member.threadId);
      if (brief) this.cleanup.add({ squadId: record.id, workerId: member.threadId, ref: brief.execution?.ref ?? member.hostRef!,
        ...(brief.dispatchId ? { dispatchId: brief.dispatchId } : {}), ...(brief.execution ? { turnId: brief.execution.turnId } : {}) });
    }
  }
  private serial<T>(run: (store: SquadStore) => Promise<T>): Promise<T> {
    const task = this.tail.then(async () => run(await loadSquads(this.home)));
    this.tail = task.catch(() => {});
    return task;
  }
  private async nativeThread(id: string, hostRef: HostThreadRef, signal?: AbortSignal, turn?: { turnId: string; includeText: boolean }) {
    const ref = parseHostRef(hostRef);
    if (ref.threadId !== id || this.protocol.store.threads.has(id) || this.protocol.store.deleted.has(id)) throw new Error("Squad native identity conflicts with CLI ownership.");
    const host = this.nativeHost(); if (!host) throw new Error("Native Squad runtime is unavailable.");
    const observed = turn ? await host.resolveSquadTurn(ref, turn.turnId, turn.includeText, signal) : undefined;
    const thread = observed?.thread ?? await host.resolveSquad(ref, signal);
    if (thread.archived) throw new Error("Native chat is archived; unarchive it before using the squad.");
    return { status: observed?.status, text: observed?.text, error: observed?.error, thread: { ...thread, engineId: "codex", archived: false } };
  }
  private async thread(id: string, hostRef?: HostThreadRef, signal?: AbortSignal) {
    if (hostRef) return (await this.nativeThread(id, hostRef, signal)).thread;
    let thread;
    try { thread = this.protocol.store.get(id); }
    catch { throw new Error("会话不在此 CLI profile 中；原生 Codex 会话需选择明确的原生运行时。" ); }
    if (thread.archived || this.protocol.operations.has(id)) throw new Error("Chat is archived or busy with a session operation.");
    return thread;
  }
  private native(ref: HostThreadRef, command: SquadNativeRequest, signal?: AbortSignal) {
    const host = this.nativeHost(); if (!host) throw new Error("Native Squad runtime is unavailable.");
    return host.squad(ref, command, signal);
  }
  private async nativeReceipt(ref: HostThreadRef, requestId: string) {
    const receipt = await this.native(ref, { operation: "receipt", requestId }) as SquadNativeReceipt;
    if (receipt.state !== "accepted" || !receipt.result) throw new Error("Original native acceptance is not confirmed.");
    return receipt.result;
  }
  private async nativeMutation(ref: HostThreadRef, command: SquadNativeRequest) {
    const receipt = await this.native(ref, command) as SquadNativeReceipt;
    if (receipt.state === "not_sent") throw notSent(receipt.reason || "Native action was not sent.");
    if (receipt.state !== "accepted" || !receipt.result) throw new Error("Native outcome is unknown; inspect the original request receipt before retrying.");
    return receipt.result;
  }
  private async save(store: SquadStore) { await saveSquads(this.home, store); this.changed(); }
  private cleanupAfterRun(record: SquadLiteRecord, workerId?: string) {
    const ids = workerId ? [workerId] : record.members.filter(m => m.role === "worker").map(m => m.threadId);
    const running = ids.map(id => this.protocol.active.get(id)?.done).filter(Boolean);
    if (!running.length) return;
    // Dissolving a group does not cancel its independently owned chats. A
    // worker finishing later may write files again; sweep those once it exits.
    const pending = Promise.allSettled(running).then(() => this.serial(async store => {
      const current = store.squads[record.id];
      if (workerId) {
        if (!current?.members.some(m => m.threadId === workerId)) await cleanupWorkerRelay(this.home, record.id, workerId);
      } else if (!current) await cleanupSquadRelay(this.home, record.id);
    })).catch(() => { console.error("Squad relay cleanup after a running worker failed; retry cleanup before reusing its files."); })
      .finally(() => this.protocol.pendingMaintenance.delete(pending));
    this.protocol.pendingMaintenance.add(pending);
  }
  private async view(record: SquadLiteRecord): Promise<SquadView> {
    const briefs: SquadBrief[] = [], results: SquadResult[] = [], errors: Record<string, string> = {};
    for (const member of record.members.filter(m => m.role === "worker")) {
      try {
        const brief = await readBrief(this.home, record.id, member.threadId);
        if (brief) briefs.push(brief);
        const result = await readResult(this.home, record.id, member.threadId, brief?.dispatchId);
        if (brief && result && result.dispatchId === brief.dispatchId && result.completedAt >= brief.issuedAt) results.push(result);
      } catch { errors[member.threadId] = "简报或结果文件暂不可读，请检查后重新读取。"; }
    }
    const ledger = readLedger(this.home, record.id), entries = ledger.entries.slice(-20);
    while (entries.length > 1 && Buffer.byteLength(JSON.stringify(entries)) > 64 * 1024) entries.shift();
    const diagnostics = await this.turnDiagnostics(record, ledger);
    const unresolvedDeliveries = record.members.flatMap(m => { const d = currentDelivery(ledger, m.threadId); return d && ["failed", "sending", "queued", "paused"].includes(d.state) ? [d] : []; });
    const memberStates: SquadView["memberStates"] = {};
    for (const member of record.members) {
      const entry = ledger.entries.findLast(e => e.authorThreadId === member.threadId && e.kind !== "note"), delivery = currentDelivery(ledger, member.threadId);
      memberStates[member.threadId] = (entry?.kind === "blocked" || entry?.verdict === "changes_requested") && (!delivery || entry!.seq > delivery.seq) || delivery && ["failed", "sending", "paused"].includes(delivery.state) ? "attention" : entry && ["handoff", "review", "system_fallback"].includes(entry.kind) && (!delivery || entry.seq > delivery.seq) ? "done" : "idle";
    }
    return { ...record, memberStates, turnDiagnostics: diagnostics, unresolvedDeliveries, briefs, results, errors, ledger: { ...ledger, entries, deliveries: ledger.deliveries.filter(d => d.state !== "sent" || entries.some(e => e.seq === d.seq)), totalEntries: ledger.entries.length }, missingReports: Object.keys(diagnostics) };
  }
  list(params: Record<string, unknown>) {
    if (params.v2 === true) return this.v2.status(params).then(result => params._compact === true ? compactSquadPayload(result) : result);
    keys(params, ["threadId", "squadId"]);
    const currentThreadId = params.threadId === undefined ? undefined : value(params, "threadId", 36);
    return this.serial(async store => {
      const squads = await Promise.all(Object.values(store.squads).filter(s => !params.squadId || s.id === value(params, "squadId")).map(record => this.view(record)));
      const members = new Set(squads.flatMap(s => s.members.map(m => m.threadId)));
      const threads = this.protocol.store.all().filter(t => !t.archived).sort((a, b) => b.updatedAt - a.updatedAt);
      const result: SquadSnapshot = { squads, threads: threads.filter((t, i) => params.squadId ? members.has(t.id) : i < 100 || members.has(t.id) || t.id === currentThreadId).map(t => ({ id: t.id,
        title: t.name || t.preview || t.id, engine: t.engineId, status: t.status })) };
      const hosts = this.nativeHost()?.status().bindings.filter(binding => binding.squad) ?? [];
      if (hosts.length) result.nativeHosts = hosts;
      for (const binding of params.squadId ? [] : hosts) {
        const ref = { hostId: binding.hostId, accountId: binding.accountId, runtimeId: binding.runtimeId, threadId: "00000000-0000-0000-0000-000000000000" };
        try {
          const page = await this.native(ref, { operation: "list" }) as { threads: SquadNativeThread[] };
          result.threads.push(...page.threads.map(t => ({ ...t, engine: "codex" })));
        } catch { /* An offline host must not erase its squads or CLI sessions. */ }
      }
      for (const record of squads) for (const member of record.members) if (member.hostRef) {
        try {
          const t = await this.thread(member.threadId, member.hostRef), hostRef = (t as SquadNativeThread).hostRef;
          member.hostRef = hostRef;
          const existing = result.threads.find(thread => thread.id === t.id && thread.hostRef?.runtimeId === hostRef.runtimeId);
          if (existing) existing.status = t.status;
          else result.threads.push({ id: t.id, title: member.shortName, engine: member.engine, status: t.status, hostRef });
        } catch { result.threads.push({ id: member.threadId, title: member.shortName, engine: member.engine, status: { type: "offline" }, hostRef: member.hostRef }); }
      }
      for (const record of squads) for (const member of record.members) {
        const status = result.threads.find(t => t.id === member.threadId && t.hostRef?.runtimeId === member.hostRef?.runtimeId)?.status as { type?: string; activeFlags?: string[] } | undefined;
        if (record.missingReports.includes(member.threadId) || ["needs_attention", "error", "systemError", "failed"].includes(status?.type ?? "") || status?.activeFlags?.some(flag => ["waitingOnApproval", "waitingOnUserInput"].includes(flag))) record.memberStates[member.threadId] = "attention";
        else if (["active", "running", "inProgress"].includes(status?.type ?? "")) record.memberStates[member.threadId] = "running";
        else if (status?.type === "offline") record.memberStates[member.threadId] = "offline";
      }
      if (!params.squadId) {
        const v2Squads = await this.v2.listAll();
        for (const s of v2Squads) {
          if (squads.some(existing => existing.id === s.squadId)) continue;
          const memberStates: SquadView["memberStates"] = { [s.anchorThreadId]: "idle" };
          const members: SquadLiteRecord["members"] = [{ threadId: s.anchorThreadId, role: "supervisor", shortName: "main", engine: "codex", ...(s.anchorHostRef ? { hostRef: s.anchorHostRef } : {}) }];
          for (const slot of s.slots) if (slot.threadId) {
            // The live V2 observation is fresher than the native recent-page
            // listing, which can omit an active hidden approval conversation.
            const systemFlags = slot.activity === 'waiting' ? slot.waitsOn?.split(', ').filter(flag => ['waitingOnApproval','waitingOnUserInput'].includes(flag)) ?? [] : [];
            const observation = { id: slot.threadId, title: slot.handle, engine: slot.engine, status: { type: slot.activity === 'quiescent' ? 'idle' : slot.activity, activeFlags: systemFlags }, ...(slot.hostRef ? { hostRef: slot.hostRef } : {}) };
            const existing = result.threads.findIndex(thread => thread.id === slot.threadId && thread.hostRef?.hostId === slot.hostRef?.hostId && thread.hostRef?.accountId === slot.hostRef?.accountId);
            if (existing >= 0) result.threads[existing] = observation; else result.threads.push(observation);
            members.push({ threadId: slot.threadId, role: "worker", shortName: slot.handle, engine: slot.engine, model: slot.model, sidebarHidden: slot.sidebarHidden, ...(slot.hostRef ? { hostRef: slot.hostRef } : {}) });
            const slotBlocked = !slot.result?.autoSynthesized && slot.result?.status === "blocked";
            memberStates[slot.threadId] = slot.activity === "offline" ? "offline" : slot.activity === "active" ? "running" : slot.activity === "waiting" || slot.activity === "failed" || slot.result?.status === "escalate" || slotBlocked ? "attention" : slot.activity === "quiescent" ? "done" : "idle";
          }
          squads.push({ id: s.squadId, anchorThreadId: s.anchorThreadId, label: s.state.title, goal: s.state.intent, status: s.status, createdAt: s.state.updatedAt, updatedAt: s.state.updatedAt, members, memberStates, ledger: { schemaVersion: 1, squadId: s.squadId, entries: [], deliveries: [], autoHopsUsed: 0, hopPausedForHuman: s.needsYou.length > 0, ballInCourt: null, totalEntries: 0 }, missingReports: [], turnDiagnostics: {}, unresolvedDeliveries: [], briefs: [], results: [], errors: {}, ...(s.studioUrl ? { studioUrl: s.studioUrl } : {}) } as SquadView);
        }
      }
      return result;
    });
  }
  create(params: Record<string, unknown>) {
    if (params.v2 === true) return this.v2.init(params).then(result => params._compact === true ? compactSquadPayload(result) : result);
    keys(params, ["anchorThreadId", "anchorHostRef", "label"]);
    const id = value(params, "anchorThreadId", 36), label = value(params, "label", 120);
    return this.serial(async store => {
      const ref = params.anchorHostRef === undefined ? undefined : parseHostRef(params.anchorHostRef);
      const anchor = await this.thread(id, ref), record = createSquad(store, anchor.id, label, anchor.engineId);
      if (ref) record.members[0].hostRef = ref;
      await this.save(store); return record;
    });
  }
  add(params: Record<string, unknown>) {
    keys(params, ["squadId", "threadId", "shortName", "hostRef"]);
    const id = value(params, "squadId"), threadId = value(params, "threadId", 36), name = value(params, "shortName", 60);
    return this.serial(async store => {
      const record = squad(store, id); await this.thread(record.anchorThreadId, record.members[0].hostRef);
      const ref = params.hostRef === undefined ? undefined : parseHostRef(params.hostRef);
      const member = await this.thread(threadId, ref);
      addMember(store, id, member.id, name, member.engineId);
      if (ref) record.members.at(-1)!.hostRef = ref;
      await this.save(store); return record;
    });
  }
  remove(params: Record<string, unknown>) {
    keys(params, ["squadId", "threadId"]);
    const id = value(params, "squadId"), threadId = value(params, "threadId", 36);
    return this.serial(async store => {
      const record = squad(store, id);
      await this.trackNativeCleanup(record, threadId);
      removeMember(store, id, threadId);
      await cleanupWorkerRelay(this.home, id, threadId); await this.save(store);
      this.cleanupAfterRun(record, threadId); return {};
    });
  }
  dissolve(params: Record<string, unknown>) {
    if (params.v2 === true) return this.v2.close(params).then(result => params._compact === true ? compactSquadPayload(result) : result);
    keys(params, ["squadId"]); const id = value(params, "squadId");
    return this.serial(async store => {
      const record = squad(store, id); record.status = "closed"; record.updatedAt = Date.now();
      await this.save(store); saveLedger(this.home, record, readLedger(this.home, id)); return record;
    });
  }
  private async send(member: Member, text: string, requestId: string, nativeTarget?: SquadNativeThread, stripSquadTools = false, readOnly = false) {
    if (member.hostRef) {
      const thread = nativeTarget ?? await this.thread(member.threadId, member.hostRef) as SquadNativeThread;
      const receipt = await this.nativeMutation(thread.hostRef, { operation: "send", requestId, message: text, cwd: thread.cwd,
        ...(stripSquadTools ? { stripSquadTools: true } : {}), ...(readOnly ? { readOnly: true } : {}) });
      // Until a fresh native observation proves otherwise, an accepted turn is
      // still running, even if its member posts a note/handoff immediately.
      if (receipt.turnId) this.nativeObservations.set(member.threadId, { deliveryId: requestId, observed: { status: { type: "active" }, turn: { turnId: receipt.turnId, status: "inProgress" } } });
      return receipt;
    }
    await this.thread(member.threadId);
    const connection: GatewayConnection = { initialized: true, role: "default", send() {},
      request: async () => { throw new Error("小队后台派发无法回答交互审批；请在 worker 会话中处理后重试。"); } };
    try { return await this.protocol.handle("turn/start", { threadId: member.threadId, input: [{ type: "text", text }], ...(readOnly ? { sandbox: "read-only" } : {}) }, connection); }
    catch (cause) { throw notSent(cause instanceof Error ? cause.message : "CLI turn was not admitted."); }
  }
  dispatch(params: Record<string, unknown>) {
    if (params.v2 === true) return this.v2.dispatch(params).then(result => params._compact === true ? compactSquadPayload(result) : result);
    keys(params, ["squadId", "workerId", "squadGoal", "task", "exclusions", "requestId"]);
    const id = value(params, "squadId"), workerId = value(params, "workerId", 36);
    const squadGoal = value(params, "squadGoal"), task = value(params, "task", 12000);
    if (params.exclusions !== undefined && (!Array.isArray(params.exclusions) || params.exclusions.length > 50 ||
        params.exclusions.some(item => typeof item !== "string" || item.length > 512))) throw new Error("Invalid squad exclusions.");
    return this.serial(async store => {
      const record = squad(store, id); await this.thread(record.anchorThreadId, record.members[0].hostRef);
      const member = record.members.find(m => m.role === "worker" && m.threadId === workerId);
      if (!member) throw new Error("Worker does not belong to this squad.");
      const target = await this.thread(workerId, member.hostRef);
      const nativeTarget = member.hostRef ? target as SquadNativeThread : undefined;
      const requestId = params.requestId === undefined ? randomUUID() : value(params, "requestId", 36);
      const run = async () => {
        if (record.status === "closed") throw notSent("Squad is closed.");
        if (this.protocol.active.has(workerId)) throw notSent("Worker already has an active turn.");
        const previous = await readBrief(this.home, id, workerId);
        const brief: SquadBrief = { squadId: id, workerId, dispatchId: requestId, squadGoal, task, exclusions: params.exclusions as string[] ?? [],
          issuedAt: Math.max(Date.now(), (previous?.issuedAt ?? 0) + 1) };
        await writeBrief(this.home, brief);
        const role = readRoles(this.home).roles.find(r => r.handle.toLowerCase() === member.shortName.toLowerCase());
        const prefix = role?.defaultPromptPrefix ? role.defaultPromptPrefix + "\n\n" : "";
        const client = this.clientFile ? `\nLocal Squad command argv: ${JSON.stringify([process.execPath, path.join(import.meta.dirname, "squad-cli.mjs"), this.clientFile])}. Append describe for schemas or report with the result JSON on stdin. The same command exposes catalog, create_member and brief for explicitly requested cross-engine collaboration.\n` : "";
        const text = prefix + formatBriefAsText(brief, this.home) + "\n\nUse the absolute paths above, regardless of your working directory. " +
          "You may use mycodex.squad_report to write your result file through MCP, especially when your filesystem sandbox cannot access the relay directory. " + client +
          "Write the result as JSON with these fields; set completedAt to Unix milliseconds at completion and status to completed or failed:\n" +
          JSON.stringify({ squadId: id, workerId, dispatchId: requestId, summary: "Your result summary", completedAt: brief.issuedAt, status: "completed" });
        let accepted: unknown;
        try { accepted = await this.send(member, text, requestId, nativeTarget); }
        catch (cause) {
          if (!member.hostRef || (cause as { notSent?: boolean }).notSent) {
            if (previous) await writeBrief(this.home, previous); else await removeBrief(this.home, id, workerId);
          }
          throw cause;
        }
        if (nativeTarget) {
          brief.execution = { ref: nativeTarget.hostRef, turnId: (accepted as { turnId: string }).turnId };
          await writeBrief(this.home, brief);
        }
        const ledger = readLedger(this.home, id);
        if (!ledger.entries.some(e => e.entryId === requestId)) {
          const entry: SquadLedgerEntry = { seq: ledger.entries.length + 1, entryId: requestId, createdAt: Date.now(), authorThreadId: record.anchorThreadId, authorHandle: "supervisor", authorEngine: record.members[0].engine, kind: "assign", summary: task.slice(0, 4000), nextHandle: member.shortName };
          ledger.entries.push(entry); ledger.ballInCourt = member.shortName; ledger.autoHopsUsed = 0; ledger.hopPausedForHuman = false;
          const receipt = accepted as { turnId?: string; turn?: { id: string } };
          ledger.deliveries.push({ seq: entry.seq, workerId, requestId, state: "sent", turnId: receipt.turnId ?? receipt.turn?.id });
          saveLedger(this.home, record, ledger);
        }
        this.changed(); return { brief, accepted };
      };
      return params.requestId !== undefined || member.hostRef ? squadAction(this.home, requestId,
        { operation: "dispatch", id, workerId, squadGoal, task, exclusions: params.exclusions ?? [], native: nativeIdentity(member.hostRef) }, run,
        member.hostRef ? async context => {
          const ref = parseHostRef((context as { ref?: HostThreadRef } | undefined)?.ref ?? member.hostRef);
          const accepted = await this.nativeReceipt(ref, requestId), brief = await readBrief(this.home, id, workerId);
          if (!brief || brief.dispatchId !== requestId || !accepted.turnId) throw new Error("Original dispatch brief is no longer current.");
          brief.execution = { ref, turnId: accepted.turnId }; await writeBrief(this.home, brief);
          return { brief, accepted };
        } : undefined, nativeTarget ? { ref: nativeTarget.hostRef } : undefined) : run();
    });
  }
  summarize(params: Record<string, unknown>) {
    if (params.v2 === true) return this.v2.integrate(params).then(result => params._compact === true ? compactSquadPayload(result) : result);
    keys(params, ["squadId", "requestId", "closeSquad", "draftOnly"]); const id = value(params, "squadId");
    if (["closeSquad", "draftOnly"].some(k => params[k] !== undefined && typeof params[k] !== "boolean")) throw new Error("Invalid summary options.");
    return this.serial(async store => {
      const record = await this.view(squad(store, id));
      if (!record.ledger.entries.length && !record.results.length) throw new Error("No current worker results are available.");
      record.ledger = readLedger(this.home, id);
      const latest = new Map(record.ledger.entries.map(e => [e.authorHandle, e]));
      const files = [...new Set(record.ledger.entries.flatMap(e => e.files ?? []))];
      const text = `# 小队收束：${record.label}\n\n` + [...latest.values()].map(e => `## @${e.authorHandle} · ${e.kind}\n${e.summary}\n${e.verification ?? "验证范围未提供"}\n来源：codex://threads/${e.authorThreadId}`).join("\n\n") +
        (files.length ? "\n\n涉及文件：\n" + files.join("\n") : "") +
        (record.results.length ? "\n\n兼容回报：\n" + record.results.map(r => `@${record.members.find(m => m.threadId === r.workerId)?.shortName}: ${r.summary}${r.error ? "\n" + r.error : ""}${r.artifactPath ? "\n" + r.artifactPath : ""}`).join("\n\n") : "");
      if (params.closeSquad === true) { store.squads[id].status = "closed"; await this.save(store); saveLedger(this.home, store.squads[id], record.ledger); }
      if (params.draftOnly === true) return { text, anchorThreadId: record.anchorThreadId };
      const member = record.members.find(m => m.role === "supervisor")!, requestId = params.requestId === undefined ? randomUUID() : value(params, "requestId", 36);
      const target = member.hostRef ? await this.thread(member.threadId, member.hostRef) as SquadNativeThread : undefined;
      return squadAction(this.home, requestId, { operation: "summarize", id, text }, () => this.send(member, text, requestId, target),
        member.hostRef ? context => this.nativeReceipt(parseHostRef((context as { ref?: HostThreadRef } | undefined)?.ref ?? member.hostRef), requestId) : undefined,
        target ? { ref: target.hostRef } : undefined);
    });
  }
  catalog(params: Record<string, unknown>) {
    keys(params, []);
    return (async () => {
      const models: Array<{ kind: "cli" | "native"; model: string; label: string; efforts?: string[]; hostRef?: HostThreadRef }> = [];
      try { for (const model of await this.protocol.models()) if (!this.protocol.engines.get(model.id.split("/")[0])?.nativeProvider)
        models.push({ kind: "cli", model: model.id, label: model.displayName, efforts: model.supportedReasoningEfforts.map(e => e.reasoningEffort) }); } catch { /* Native is independently available. */ }
      for (const binding of this.nativeHost()?.status().bindings.filter(b => b.squad) ?? []) {
        const hostRef = { hostId: binding.hostId, accountId: binding.accountId, runtimeId: binding.runtimeId, threadId: "00000000-0000-0000-0000-000000000000" };
        try { const page = await this.native(hostRef, { operation: "models" }) as { models: Array<{ id: string; label: string; efforts?: string[] }> };
          for (const model of page.models) models.push({ kind: "native", model: model.id, label: `Codex · ${model.label}`, efforts: model.efforts ?? [], hostRef });
        } catch { /* Other bindings remain usable. */ }
      }
      return { models };
    })();
  }
  create_member(params: Record<string, unknown>) {
    keys(params, ["squadId", "shortName", "kind", "model", "reasoningEffort", "cwd", "hostRef", "requestId"]);
    const id = value(params, "squadId"), shortName = value(params, "shortName", 60), requestId = value(params, "requestId", 36);
    if (!["cli", "native"].includes(String(params.kind))) throw new Error("Choose CLI or native Codex.");
    return this.serial(async store => {
      const record = squad(store, id);
      if (record.status === "closed") throw new Error("Squad is closed or handle already exists.");
      const supervisor = record.members.find(m => m.role === "supervisor")!;
      const anchor = await this.thread(record.anchorThreadId, supervisor.hostRef), cwd = params.cwd === undefined ? anchor.cwd : value(params, "cwd");
      const ref = params.kind === "native" ? parseHostRef(params.hostRef) : undefined;
      const join = async (target: { id: string; engineId: string; model?: string | null; hostRef?: HostThreadRef }) => {
        const existing = record.members.find(m => m.threadId === target.id);
        if (existing) return existing;
        addMember(store, id, target.id, shortName, target.engineId);
        const member = record.members.at(-1)!; member.model = typeof params.model === "string" ? params.model : target.model ?? null; if (target.hostRef) member.hostRef = target.hostRef;
        await this.save(store); return member;
      };
      return squadAction(this.home, requestId, { operation: "create_member", id, shortName, kind: params.kind, model: params.model ?? null, reasoningEffort: params.reasoningEffort ?? null, cwd, ref: ref ?? null }, async () => {
        if (record.members.some(m => m.shortName.toLowerCase() === shortName.toLowerCase())) throw notSent("Duplicate squad handle.");
        if (ref) {
          const sameHostAnchor = supervisor.hostRef && supervisor.hostRef.hostId === ref.hostId && supervisor.hostRef.accountId === ref.accountId ? record.anchorThreadId : undefined;
          const response = await this.nativeMutation(ref, { operation: "create", requestId, cwd, ...(sameHostAnchor ? { anchorThreadId: sameHostAnchor } : {}), ...(params.model ? { model: value(params, "model") } : {}), ...(params.reasoningEffort ? { reasoningEffort: value(params, "reasoningEffort", 60) } : {}) });
          if (!response.thread) throw new Error("Native creation receipt is incomplete.");
          return join({ ...response.thread, engineId: "codex" });
        }
        const model = value(params, "model");
        const connection: GatewayConnection = { initialized: true, send() {}, request: async () => { throw notSent("No interactive response during worker creation."); } };
        let response;
        try { response = await this.protocol.handle("thread/start", { model, cwd, ...(params.reasoningEffort ? { effort: value(params, "reasoningEffort", 60) } : {}) } as GatewayParams, connection) as { thread: { id: string } }; }
        catch (cause) { throw notSent(cause instanceof Error ? cause.message : "CLI worker was not created."); }
        return join({ id: response.thread.id, engineId: this.protocol.store.get(response.thread.id).engineId });
      }, ref ? async () => { const response = await this.nativeReceipt(ref, requestId); if (!response.thread) throw new Error("No native create receipt."); return join({ ...response.thread, engineId: "codex" }); } : undefined);
    });
  }
  report(params: Record<string, unknown>) {
    keys(params, ["squadId", "workerId", "dispatchId", "summary", "status", "completedAt", "artifactPath", "error"]);
    const id = value(params, "squadId"), workerId = value(params, "workerId", 36);
    value(params, "summary", 16000);
    return this.serial(async store => {
      if (!squad(store, id).members.some(m => m.role === "worker" && m.threadId === workerId)) throw new Error("Worker does not belong to the squad.");
      const brief = await readBrief(this.home, id, workerId); if (!brief) throw new Error("No brief is pending for this worker.");
      if (params.dispatchId !== brief.dispatchId) throw new Error("Result dispatchId does not match the current brief; include the ID from the received brief.");
      const result = { ...params, squadId: id, workerId, completedAt: params.completedAt ?? Date.now() } as unknown as SquadResult;
      if (result.completedAt < brief.issuedAt) throw new Error("Result belongs to an older brief.");
      const previousEntry = readLedger(this.home, id).entries.find(e => e.entryId === `report:${brief.dispatchId}`);
      if (previousEntry && previousEntry.summary !== result.summary.slice(0, 4000)) throw new Error("Report conflicts with original ledger entry.");
      await writeResult(this.home, result);
      const record = squad(store, id), ledger = readLedger(this.home, id), member = record.members.find(m => m.threadId === workerId)!;
      const entryId = `report:${brief.dispatchId}`;
      if (!ledger.entries.some(e => e.entryId === entryId)) {
        ledger.entries.push({ seq: ledger.entries.length + 1, entryId, createdAt: Date.now(), authorThreadId: workerId, authorHandle: member.shortName, authorEngine: member.engine, kind: result.status === "failed" ? "blocked" : "handoff", summary: result.summary.slice(0, 4000), nextHandle: "supervisor", ...(result.artifactPath ? { files: [result.artifactPath] } : {}) });
        ledger.ballInCourt = "supervisor"; saveLedger(this.home, record, ledger);
      }
      this.changed(); return result;
    });
  }
  roles(params: Record<string, unknown>) {
    if (params.v2 === true) return this.v2.state(params).then(result => params._compact === true ? compactSquadPayload(result) : result);
    keys(params, ["roles"]);
    return this.serial(async () => {
      if (params.roles !== undefined) {
        if (!Array.isArray(params.roles)) throw new Error("Invalid roles.");
        const data = { schemaVersion: 1, roles: params.roles.map(r => ({ ...r, updatedAt: Date.now() })) };
        validateRoles(data);
        const catalog = await this.catalog({});
        if (data.roles.some(role => !catalog.models.some(m => m.kind === role.kind && m.model === role.model))) throw new Error("Role model is not in the configured catalog.");
        if (data.roles.some(role => role.reasoningEffort && !catalog.models.some(m => m.kind === role.kind && m.model === role.model && m.efforts?.includes(role.reasoningEffort!)))) throw new Error("Role reasoning effort is not supported by this model.");
        saveRoles(this.home, data); this.changed();
      }
      return readRoles(this.home);
    });
  }
  ledger(params: Record<string, unknown>) {
    keys(params, ["squadId", "offset", "limit"]); const id = value(params, "squadId");
    const offset = params.offset ?? 0, limit = params.limit ?? 20;
    if (!Number.isSafeInteger(offset) || (offset as number) < 0 || !Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 20) throw new Error("Invalid ledger range.");
    return this.serial(async store => {
      const record = squad(store, id), ledger = readLedger(this.home, id); saveLedger(this.home, record, ledger);
      const entries = ledger.entries.slice(offset as number, (offset as number) + (limit as number));
      while (entries.length > 1 && Buffer.byteLength(JSON.stringify(entries)) + Buffer.byteLength(renderIssue(record, { ...ledger, entries })) > 180 * 1024) entries.pop();
      const end = (offset as number) + entries.length;
      const page = { ...ledger, entries, deliveries: ledger.deliveries.filter(d => entries.some(e => e.seq === d.seq)) };
      return { ...page, totalEntries: ledger.entries.length, nextOffset: end < ledger.entries.length ? end : null, issuePath: ledgerPath(this.home, id).replace(/ledger.json$/, "ISSUE.md"), markdown: renderIssue(record, page) };
    });
  }
  post(params: Record<string, unknown>) {
    keys(params, ["squadId", "authorThreadId", "requestId", "kind", "summary", "next", "files", "verification", "verdict"]);
    return this.serial(async store => {
      const record = squad(store, value(params, "squadId"));
      return this.postEntry(record, params);
    });
  }
  private async postEntry(record: SquadLiteRecord, params: Record<string, unknown>, fallback = false) {
    if (record.status === "closed") throw new Error("Squad is closed.");
    const author = record.members.find(m => m.threadId === value(params, "authorThreadId", 36));
    if (!author) throw new Error("Author does not belong to squad.");
    const entryId = value(params, "requestId", 128), summary = value(params, "summary", 4000);
    const kind = String(params.kind) as LedgerEntryKind;
    if (!["assign", "handoff", "review", "blocked", "note", ...(fallback ? ["system_fallback"] : [])].includes(kind)) throw new Error("Invalid ledger kind.");
    if (params.next !== null && typeof params.next !== "string") throw new Error("Explicit next handle or null is required.");
    const next = params.next === null ? null : record.members.find(m => m.shortName.toLowerCase() === String(params.next).replace(/^@/, "").toLowerCase());
    if (params.next !== null && !next) throw new Error("Unknown next handle.");
    if (kind === "note" && next) throw new Error("A note cannot transfer responsibility.");
    if (params.files !== undefined && (!Array.isArray(params.files) || params.files.length > 50 || params.files.some(f => typeof f !== "string" || f.length > 512 || /[\0\r\n]/.test(f)))) throw new Error("Invalid evidence files.");
    if (params.verification != null) value(params, "verification", 4000);
    if (params.verdict != null && (kind !== "review" || !["approved", "changes_requested", "commented"].includes(String(params.verdict)))) throw new Error("Invalid review verdict.");
    const ledger = readLedger(this.home, record.id), existing = ledger.entries.find(e => e.entryId === entryId);
    if (existing) {
      if (existing.authorThreadId !== author.threadId || existing.kind !== kind || existing.summary !== summary || existing.nextHandle !== (next?.shortName ?? null) || JSON.stringify(existing.files ?? []) !== JSON.stringify(params.files ?? []) || (existing.verification ?? null) !== (params.verification ?? null) || (existing.verdict ?? null) !== (params.verdict ?? null)) throw new Error("requestId conflicts with original ledger entry.");
      saveLedger(this.home, record, ledger); return existing;
    }
    const entry: SquadLedgerEntry = { seq: ledger.entries.length + 1, entryId, createdAt: Date.now(), authorThreadId: author.threadId,
      authorHandle: author.shortName, authorEngine: author.engine, kind, summary, nextHandle: next?.shortName ?? null,
      ...(params.files ? { files: params.files as string[] } : {}), ...(params.verification ? { verification: String(params.verification) } : {}), ...(params.verdict ? { verdict: params.verdict as SquadLedgerEntry["verdict"] } : {}) };
    ledger.entries.push(entry);
    if (kind !== "note") ledger.ballInCourt = kind === "blocked" && !next ? "supervisor" : next?.shortName ?? null;
    if (next?.role === "worker") {
      const human = author.role === "supervisor";
      if (human) { ledger.autoHopsUsed = 0; ledger.hopPausedForHuman = false; }
      const paused = !human && ledger.autoHopsUsed >= (record.maxAutoHops ?? 3);
      if (!human && !paused) ledger.autoHopsUsed++;
      if (paused) ledger.hopPausedForHuman = true;
      ledger.deliveries.push({ seq: entry.seq, workerId: next.threadId, requestId: randomUUID(), state: paused ? "paused" : "queued" });
    }
    saveLedger(this.home, record, ledger); this.changed();
    await this.drain(record, ledger); return entry;
  }
  private async drain(record: SquadLiteRecord, ledger: SquadLedger) {
    if (record.status === "closed") return;
    for (const delivery of ledger.deliveries.filter(d => d.state === "queued")) {
      const member = record.members.find(m => m.threadId === delivery.workerId);
      if (!member) { delivery.state = "failed"; delivery.error = "Member left squad."; continue; }
      try {
        const target = await this.thread(member.threadId, member.hostRef);
        const status = (target.status as { type?: string })?.type;
        if (this.protocol.active.has(member.threadId) || ["active", "running", "inProgress"].includes(status ?? "")) continue;
        if (status !== "idle" && status !== "completed") continue;
        const entry = ledger.entries[delivery.seq - 1];
        const role = readRoles(this.home).roles.find(r => r.handle.toLowerCase() === member.shortName.toLowerCase());
        const command = this.clientFile ? `Local CLI argv: ${JSON.stringify([process.execPath, path.join(import.meta.dirname, "squad-cli.mjs"), this.clientFile, "post"])}; pass the JSON object on stdin.` : "";
        const text = `${role?.defaultPromptPrefix ?? ""}\n[Squad #${entry.seq}] @${entry.authorHandle} → @${member.shortName}\n${entry.summary}\nFiles: ${(entry.files ?? []).join(", ")}\nVerification: ${entry.verification ?? "not supplied"}\nRead shared ISSUE: ${ledgerPath(this.home, record.id).replace(/ledger.json$/, "ISSUE.md")}\nKeep summaries concise: conclusion + scope/evidence + verified/unverified + one next action. Do not paste diffs.\nAt completion call mycodex.squad_post with a fresh requestId and: ${JSON.stringify({ squadId: record.id, authorThreadId: member.threadId, kind: "handoff", summary: "Conclusion and next action", next: "@supervisor", files: [], verification: "Checks and gaps" })}\n${command}`;
        // Persist intent before crossing the process boundary. A crash here is
        // visibly uncertain; never replay a CLI turn with unknown acceptance.
        delivery.state = "sending"; saveLedger(this.home, record, ledger);
        const response = await this.send(member, text, delivery.requestId, member.hostRef ? target as SquadNativeThread : undefined) as { turnId?: string; turn?: { id: string } };
        delivery.turnId = response.turnId ?? response.turn?.id; delivery.state = "sent";
      } catch (error) { delivery.state = "failed"; delivery.error = error instanceof Error ? error.message : String(error); }
      saveLedger(this.home, record, ledger); this.changed();
    }
  }
  resume_hops(params: Record<string, unknown>) {
    keys(params, ["squadId"]);
    return this.serial(async store => {
      const record = squad(store, value(params, "squadId")), ledger = readLedger(this.home, record.id);
      ledger.autoHopsUsed = 0; ledger.hopPausedForHuman = false;
      for (const delivery of ledger.deliveries) if (delivery.state === "paused") delivery.state = "queued";
      saveLedger(this.home, record, ledger); await this.drain(record, ledger); this.changed(); return ledger;
    });
  }
  promote_member(params: Record<string, unknown>) {
    keys(params, ["squadId", "threadId", "closeSquad"]);
    return this.serial(async store => {
      const record = squad(store, value(params, "squadId")), member = record.members.find(m => m.role === "worker" && m.threadId === value(params, "threadId", 36));
      if (!member) throw new Error("Worker does not belong to squad."); member.sidebarHidden = false;
      if (params.closeSquad === true) record.status = "closed";
      await this.save(store); saveLedger(this.home, record, readLedger(this.home, record.id)); return member;
    });
  }
  private quickObservation(member: Member, ledger: SquadLedger): SquadMemberObservation {
    const delivery = currentDelivery(ledger, member.threadId);
    if (member.hostRef) {
      const cached = this.nativeObservations.get(member.threadId);
      if (cached && cached.deliveryId === (delivery?.requestId ?? null)) return cached.observed;
      return { status: delivery?.state === "sent" ? { type: "active" } : cached?.observed.status ?? { type: "idle" } };
    }
    const thread = this.protocol.store.get(member.threadId), turn = delivery?.turnId ? thread.turns.find(t => t.id === delivery.turnId) : undefined;
    return { status: structuredClone(thread.status), ...(turn ? { turn: { turnId: turn.id, status: turn.status,
      ...(turn.error?.message ? { message: turn.error.message.slice(0, 4000) } : {}), text: turn.items.filter(i => i.type === "agentMessage").map(i => String((i as { text?: string }).text ?? "")).filter(Boolean).at(-1) ?? "" } } : {}) };
  }
  private async observeMember(member: Member, ledger: SquadLedger, signal?: AbortSignal, includeText = false): Promise<SquadMemberObservation> {
    if (!member.hostRef) return this.quickObservation(member, ledger);
    const delivery = currentDelivery(ledger, member.threadId), turnId = delivery?.state === "sent" ? delivery.turnId : undefined;
    const native = await this.nativeThread(member.threadId, member.hostRef, signal, turnId ? { turnId, includeText } : undefined);
    const observed: SquadMemberObservation = { status: native.thread.status as SquadMemberObservation["status"] };
    if (turnId && native.status) {
      observed.turn = { turnId, status: native.status, ...(native.text !== undefined ? { text: native.text } : {}), ...(native.error?.message ? { message: native.error.message } : {}) };
    }
    this.nativeObservations.set(member.threadId, { deliveryId: delivery?.requestId ?? null, observed }); return observed;
  }
  private async turnDiagnostics(record: SquadLiteRecord, ledger: SquadLedger) {
    const diagnostics: Record<string, SquadTurnDiagnostic> = {};
    for (const member of record.members.filter(m => m.role === "worker")) {
      const delivery = currentDelivery(ledger, member.threadId); if (delivery?.state !== "sent" || !delivery.turnId) continue;
      try { const diagnostic = unreportedTurn(ledger, member.threadId, await this.observeMember(member, ledger)); if (diagnostic) diagnostics[member.threadId] = diagnostic; }
      catch { /* Offline is not evidence of terminal execution. */ }
    }
    return diagnostics;
  }
  private async missingReports(record: SquadLiteRecord, ledger: SquadLedger) { return Object.keys(await this.turnDiagnostics(record, ledger)); }
  fallback(params: Record<string, unknown>) {
    keys(params, ["squadId", "workerId", "requestId"]);
    return this.serial(async store => {
      const record = squad(store, value(params, "squadId")), workerId = value(params, "workerId", 36), ledger = readLedger(this.home, record.id);
      const existing = ledger.entries.find(e => e.entryId === params.requestId); if (existing?.kind === "system_fallback" && existing.authorThreadId === workerId) return existing;
      const member = record.members.find(m => m.role === "worker" && m.threadId === workerId), delivery = currentDelivery(ledger, workerId);
      if (!member || delivery?.state !== "sent" || !delivery.turnId) throw new Error("No completed unreported turn.");
      const observed = await this.observeMember(member, ledger, undefined, true), diagnostic = unreportedTurn(ledger, workerId, observed);
      if (!diagnostic || !observed.turn || !terminalTurn(observed.turn.status)) throw new Error("No completed unreported terminal turn.");
      // Both transports use the same exact delivery and terminal predicate.
      const failed = observed.turn.status !== "completed";
      const text = observed.turn.text?.trim() || (failed ? diagnostic.message : "");
      if (!text) throw new Error("No assistant text in this completed turn.");
      const summary = failed ? `[系统代记 · 回合${observed.turn.status === "interrupted" ? "中断" : "失败"}]\n${diagnostic.message}\n${observed.turn.text ?? ""}` : "[系统代记 · 未显式点名下一棒]\n" + text;
      return this.postEntry(record, { squadId: record.id, authorThreadId: workerId, requestId: value(params, "requestId", 128), kind: "system_fallback", summary: summary.slice(0, 4000), next: "@supervisor" }, true);
    });
  }
  wait(params: Record<string, unknown>, signal?: AbortSignal) {
    if (this.closed) return Promise.reject(new Error("Squad service is closed."));
    const controller = new AbortController(); this.waits.add(controller);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    return waitForSquad(params, {
      signal: combined,
      subscribe: notify => { this.waitListeners.add(notify); return () => this.waitListeners.delete(notify); },
      snapshot: () => this.serial(async store => {
        combined.throwIfAborted(); const record = squad(store, value(params, "squadId")), ledger = readLedger(this.home, record.id);
        const observations: SquadWaitSnapshot["observations"] = {};
        for (const member of record.members.filter(m => m.role === "worker")) {
          try { observations[member.threadId] = this.quickObservation(member, ledger); } catch { observations[member.threadId] = { status: { type: "offline" } }; }
        }
        return { record, ledger, observations, active: record.members.flatMap(m => { const done = this.protocol.active.get(m.threadId)?.done; return done ? [done] : []; }) };
      }),
      probe: async snapshot => {
        await Promise.all(snapshot.record.members.filter(m => m.role === "worker" && m.hostRef).map(async member => {
          try { await this.observeMember(member, snapshot.ledger, combined); } catch { /* No terminal inference on unavailable native reads. */ }
        }));
      },
    }).finally(() => { controller.abort(); this.waits.delete(controller); });
  }
  private relaySignature = "";
  private async tick() {
    await this.v2.tick();
    return this.serial(async store => {
      const states: unknown[] = [];
      for (const record of Object.values(store.squads)) if (record.status !== "closed") {
        const ledger = readLedger(this.home, record.id); await this.drain(record, ledger);
        const statuses = await Promise.all(record.members.map(async m => { try { return (await this.thread(m.threadId, m.hostRef)).status; } catch { return "offline"; } }));
        states.push([record.id, await this.missingReports(record, ledger), statuses]);
      }
      const signature = JSON.stringify(states); if (signature !== this.relaySignature) { this.relaySignature = signature; this.changed(); }
    });
  }

  async nativeDeleted(ref: HostThreadRef) {
    // The member may already have left its squad. An authoritative deletion
    // still retires its pending cleanup records without reading a deleted turn.
    await this.cleanup.deleted(ref);
    return this.serial(async store => {
      const records = Object.values(store.squads).filter(s => s.members.some(m => m.threadId === ref.threadId && m.hostRef?.accountId === ref.accountId && m.hostRef.hostId === ref.hostId));
      if (!records.length) return;
      for (const record of records) {
      if (record.anchorThreadId === ref.threadId) { await this.trackNativeCleanup(record); await cleanupSquadRelay(this.home, record.id); dissolveSquad(store, record.id); }
      else { await cleanupWorkerRelay(this.home, record.id, ref.threadId); removeMember(store, record.id, ref.threadId); }
      }
      await this.save(store);
    });
  }
  rebind(params: Record<string, unknown>) {
    keys(params, ["squadId", "threadId", "hostRef"]);
    const id = value(params, "squadId"), threadId = value(params, "threadId", 36), ref = parseHostRef(params.hostRef);
    return this.serial(async store => {
      const member = squad(store, id).members.find(m => m.threadId === threadId);
      if (!member?.hostRef || member.hostRef.hostId !== ref.hostId || member.hostRef.accountId !== ref.accountId) throw new Error("Rebinding must retain the native host, account and thread.");
      await this.thread(threadId, ref); member.hostRef = ref; await this.save(store); return member;
    });
  }
  reconcileDeleted(ids: Iterable<string>) {
    const deleted = new Set(ids);
    return this.serial(async store => {
      let dirty = false;
      const cleanup: Array<{ record: SquadLiteRecord; workerId?: string }> = [];
      for (const record of Object.values(store.squads)) {
        if (deleted.has(record.anchorThreadId)) {
          await this.trackNativeCleanup(record);
          await cleanupSquadRelay(this.home, record.id); dissolveSquad(store, record.id); dirty = true;
          cleanup.push({ record });
        } else for (const member of [...record.members]) if (deleted.has(member.threadId)) {
          await this.trackNativeCleanup(record, member.threadId);
          await cleanupWorkerRelay(this.home, record.id, member.threadId);
          removeMember(store, record.id, member.threadId); dirty = true;
          cleanup.push({ record, workerId: member.threadId });
        }
      }
      if (dirty) { await this.save(store); for (const item of cleanup) this.cleanupAfterRun(item.record, item.workerId); }
    });
  }
}
