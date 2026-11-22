import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { constants as fsConstants } from 'node:fs';
import type { HostThreadRef } from './host-thread-contracts.mjs';
import type { SquadStateRecord, SquadSlotRecord, SquadSlotLiveView, SquadStudioSnapshot, SquadEventRecord, SquadGate, SquadSessionSettings, SquadSlotRound, SquadDeliverable, SquadBriefOptions, SquadIntegrationTree } from './squad-v2-contracts.mjs';
import { atomicJson, renderState, projectBrief, parseResult, validateState, projectSlot, projectTask, deriveStage, parseSlotDeliverables, uniqueDeliverables, ROUND_LIMIT, type SquadV2Record } from './squad-v2-state.mjs';
import { safeId, isolatedWorkspace, workspaceDelta, workspaceFileDiff, integrateWorkspace, advanceWorkspaceBaseline, removeSquadWorkspace, removeScratchWorkspace,
  extractCommitToken, verifiedRepositoryDir, resolveLocalCommit, previewCommit, previewArtifactFile, resolveDeliveryHref, bindRepository, parseRepository,
  repositoryBase, repositoryDirectory, deliveryCheckScript, type SquadRepository } from './squad-v2-workspace.mjs';
export interface V2Thread extends SquadSessionSettings { id: string; cwd: string; hostRef?: HostThreadRef; status: { type?: string; activeFlags?: string[] }; turnStatus?: string; lastMessage?: string; activeSubagents?: boolean }
export interface V2Runtime {
  read(id: string, ref?: HostThreadRef, turnId?: string): Promise<V2Thread>;
  open?(thread: V2Thread, anchorThreadId: string): Promise<{ opened: boolean; reason?: string }>;
  create(slot: SquadSlotRecord, cwd: string, anchor: V2Thread): Promise<V2Thread>;
  send(thread: V2Thread, text: string, requestId: string, role?: 'supervisor' | 'worker', readOnly?: boolean): Promise<unknown>;
}
const wakeable = (thread: V2Thread) => ['idle','completed','notLoaded'].includes(thread.status.type ?? '') &&
  !thread.activeSubagents && !['inProgress','active','running','waitingOnApproval','waitingOnUserInput'].includes(thread.turnStatus ?? '') &&
  !(thread.status.activeFlags ?? []).some(flag => ['waitingOnApproval','waitingOnUserInput'].includes(flag));
const studioModule = new URL('../../bridge/diy/squad-studio.mjs', import.meta.url);
const mainRepository = (cwd: string): SquadRepository => ({ key: 'main', source: cwd, directory: cwd, remote: false });
const relayFiles = ['brief.md', 'result.md', 'check-delivery.mjs'];
export class SquadV2Kernel {
  private tail: Promise<unknown> = Promise.resolve();
  private server?: http.Server;
  private url?: string;
  private token = randomUUID();
  private stopped = false;
  private renderer?: { mtimeMs: number; load: Promise<typeof import('../../bridge/diy/squad-studio.mjs')> };
  private stationary = new Map<string, { stamp: string; expires: number; view: SquadSlotLiveView }>();
  private home: string;
  private runtime: V2Runtime;
  private changed: () => void;
  constructor(home: string, runtime: V2Runtime, changed: () => void) {
    this.home = home; this.runtime = runtime; this.changed = changed;
    // Restore an existing listener before any fresh anchor tool call. Startup
    // errors remain retryable/visible through status; they cannot reject unhandled.
    void this.serial(async () => {
      try { await fs.access(path.join(home, '.mycodex', 'squads-v2', 'studio.json')); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
      await this.studio();
    }).catch(() => {});
  }
  private directory(id: string) { return path.join(this.home, '.mycodex', 'squads-v2', safeId(id)); }
  private serial<T>(run: () => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new Error('Squad kernel is closed.'));
    const result = this.tail.then(run); this.tail = result.catch(() => {}); return result;
  }
  private async read(id: string): Promise<SquadV2Record> { return JSON.parse(await fs.readFile(path.join(this.directory(id), 'state.json'), 'utf8')); }
  private async ids(): Promise<string[]> {
    try { return (await fs.readdir(path.join(this.home, '.mycodex', 'squads-v2'), { withFileTypes: true })).filter(e => e.isDirectory() && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(e.name)).map(e => e.name); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
  }
  private async byAnchor(anchorThreadId: string): Promise<SquadV2Record | undefined> {
    const records: SquadV2Record[] = [];
    for (const id of await this.ids()) {
      try { const r = await this.read(id); if (r.anchorThreadId === anchorThreadId) records.push(r); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    }
    return records.sort((a, b) => Number(b.status === 'active') - Number(a.status === 'active') ||
      (b.updatedAt ?? b.state.updatedAt) - (a.updatedAt ?? a.state.updatedAt) || b.state.squadId.localeCompare(a.state.squadId))[0];
  }
  private async events(id: string): Promise<SquadEventRecord[]> {
    try { return (await fs.readFile(path.join(this.directory(id), 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
  }
  private async save(r: SquadV2Record, kind?: SquadEventRecord['kind'], summary = '', slotId?: string) {
    const directory = this.directory(r.state.squadId); await fs.mkdir(directory, { recursive: true });
    if (kind) {
      const events = await this.events(r.state.squadId), event = { seq: (events.at(-1)?.seq ?? 0) + 1, at: Date.now(), kind, summary, ...(slotId ? { slotId } : {}) };
      await fs.appendFile(path.join(directory, 'events.jsonl'), JSON.stringify(event) + '\n', { mode: 0o600 });
      if (['quiescent','waiting','human_stepped_in'].includes(kind)) r.pendingNotices.push(event);
    }
    r.updatedAt = Date.now();
    await atomicJson(path.join(directory, 'state.json'), r);
    const temp = path.join(directory, `STATE.${randomUUID()}.tmp`);
    try { await fs.writeFile(temp, renderState(r.state), { mode: 0o600 }); await fs.rename(temp, path.join(directory, 'STATE.md')); }
    finally { await fs.rm(temp, { force: true }); }
    this.changed();
  }
  private async renderStudio(snapshot: SquadStudioSnapshot) {
    const { mtimeMs } = await fs.stat(studioModule);
    if (this.renderer?.mtimeMs !== mtimeMs) {
      const version = new URL(studioModule);
      version.searchParams.set('mtime', String(mtimeMs));
      this.renderer = { mtimeMs, load: import(version.href) };
    }
    return (await this.renderer.load).renderSquadStudioHtml(snapshot);
  }
  private async studio() {
    if (this.url) return this.url;
    const file = path.join(this.home, '.mycodex', 'squads-v2', 'studio.json');
    let port = 0;
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error('Invalid private Studio metadata.');
      const saved = JSON.parse(await fs.readFile(file, 'utf8'));
      if (saved.schemaVersion !== 1 || !Number.isSafeInteger(saved.port) || saved.port < 1 || saved.port > 65535 || typeof saved.token !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(saved.token)) throw new Error('Invalid private Studio metadata.');
      port = saved.port; this.token = saved.token;
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    this.server = http.createServer((req, res) => { void (async () => {
      res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options','nosniff');
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const match = url.pathname.match(/^\/squads\/([a-zA-Z0-9_-]+)(\/(?:snapshot|diff|artifact|gate|promote|open-thread))?$/);
      if (url.searchParams.get('token') !== this.token) {
        if (match?.[2] === '/artifact') {
          res.setHeader('Content-Type', 'application/json');
          throw new Error('Invalid Studio token.');
        }
        res.writeHead(403).end('{}'); return;
      }
      if (!match) { res.writeHead(404).end('{}'); return; }
      const squadId = match[1], subroute = match[2] ?? '';
      if (req.method === 'GET' && (!subroute || subroute === '/snapshot')) {
        const snapshot = await this.status({ squadId }, true);
        if (!subroute && url.searchParams.get('format') !== 'json' && String(req.headers.accept ?? '').includes('text/html')) {
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.end(await this.renderStudio(snapshot)); return;
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(snapshot)); return;
      }
      if (req.method === 'GET' && subroute === '/diff') {
        res.setHeader('Content-Type', 'application/json');
        const diff = await this.diff({ squadId, slotId: url.searchParams.get('slotId') ?? '', path: url.searchParams.get('path') ?? '' });
        res.end(JSON.stringify({ diff })); return;
      }
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'GET' && subroute === '/artifact') {
        const preview = await this.artifact(squadId, url.searchParams.get('slotId') ?? '', url.searchParams.get('ref') ?? '');
        res.end(JSON.stringify(preview)); return;
      }
      if (req.method !== 'POST' || (subroute !== '/gate' && subroute !== '/promote' && subroute !== '/open-thread')) { res.writeHead(405).end('{}'); return; }
      // No CORS, and reject cross-origin browser writes even with a leaked URL.
      if (req.headers.origin && req.headers.origin !== this.url) { res.writeHead(403).end('{}'); return; }
      let body = ''; for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 65536) throw new Error('Request too large.'); }
      const params = JSON.parse(body);
      if (subroute === '/open-thread') {
        if (!params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).some(key => key !== 'slotId') || typeof params.slotId !== 'string') throw new Error('Invalid open-thread parameters.');
        res.end(JSON.stringify(await this.openSlot({ squadId, slotId: params.slotId }))); return;
      }
      if (subroute === '/promote') { res.end(JSON.stringify(await this.promote({ squadId, slotId: params.slotId }))); return; }
      res.end(JSON.stringify(await this.state({ squadId, expectedRevision: params.expectedRevision, resolveGate: params.resolveGate })));
    })().catch(e => { if (!res.headersSent) res.writeHead(409); res.end(JSON.stringify({ error: String(e.message) })); }); });
    const listen = (port: number) => new Promise<void>((resolve, reject) => {
      const failed = (e: Error) => { this.server!.off('listening', ready); reject(e); };
      const ready = () => { this.server!.off('error', failed); resolve(); };
      this.server!.once('error', failed); this.server!.once('listening', ready); this.server!.listen(port, '127.0.0.1');
    });
    try { await listen(port); }
    catch (e) { if (!port || (e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e; await listen(0); }
    this.server.unref(); const address = this.server.address() as { port: number };
    try { await atomicJson(file, { schemaVersion: 1, port: address.port, token: this.token }); }
    catch (e) { await new Promise<void>(resolve => this.server!.close(() => resolve())); throw e; }
    this.url = `http://127.0.0.1:${address.port}`; return this.url;
  }
  init(p: Record<string, unknown>) { return this.serial(async () => {
    if (typeof p.anchorThreadId !== 'string' || !p.anchorThreadId.trim() ||
        p.forceNew !== undefined && typeof p.forceNew !== 'boolean' ||
        p.workspace !== undefined && !['shared','worktree'].includes(String(p.workspace)) ||
        p.title !== undefined && typeof p.title !== 'string' || p.intent !== undefined && typeof p.intent !== 'string' ||
        p.state !== undefined && (!p.state || typeof p.state !== 'object' || Array.isArray(p.state))) throw new Error('Invalid Squad initialization.');
    const existing = p.forceNew === true ? undefined : await this.byAnchor(p.anchorThreadId);
    if (existing?.status === 'active') {
      const patch = { ...(p.state as Partial<SquadStateRecord> ?? {}), ...(p.title !== undefined ? { title: p.title } : {}), ...(p.intent !== undefined ? { intent: p.intent } : {}) };
      const update = this.prepareState(existing, { expectedRevision: existing.state.revision, patch });
      const stateChanged = Object.entries(patch).some(([key, value]) => JSON.stringify(existing.state[key as keyof SquadStateRecord]) !== JSON.stringify(value));
      const needsWorkspace = p.workspace === 'worktree' && !existing.integrationWorktree;
      if (!stateChanged && !needsWorkspace) return this.snapshot(existing);
      if (['open','changes_requested'].includes(existing.state.activeGate?.status ?? '')) throw new Error('Resolve the active Gate before evolving Squad initialization.');
      existing.state = update.state; await this.prepareClosure(existing, { patch });
      if (needsWorkspace) {
        await this.ensureIntegration(existing, mainRepository(existing.cwd), 'HEAD');
      }
      await this.save(existing, update.kind, 'Standing Squad updated'); return this.snapshot(existing);
    }
    const anchor = await this.runtime.read(p.anchorThreadId, p.anchorHostRef as HostThreadRef | undefined);
    const id = randomUUID(), now = Date.now();
    const state: SquadStateRecord = { schemaVersion: 2, squadId: id, revision: 1, title: String(p.title ?? 'Squad'), intent: String(p.intent ?? ''), invariants: [], contracts: [], criteria: [], tasks: [], openBlockers: [], ...(p.state as Partial<SquadStateRecord> ?? {}), updatedAt: now };
    state.squadId = id; state.schemaVersion = 2; state.revision = 1; validateState(state);
    const r: SquadV2Record = { state, anchorThreadId: anchor.id, anchorHostRef: anchor.hostRef, cwd: anchor.cwd, status: 'active', slots: [], pendingNotices: [], activities: {}, dispatched: {} };
    if (p.workspace === 'worktree') {
      await this.ensureIntegration(r, mainRepository(anchor.cwd), 'HEAD');
    }
    await this.save(r, 'initialized', state.title); return this.snapshot(r);
  }); }
  private integrations(r: SquadV2Record): Record<string, SquadIntegrationTree> {
    const legacy: Record<string, SquadIntegrationTree> = r.integrationBranch && r.integrationWorktree ? {
      main: { repoKey: 'main', source: r.cwd, branch: r.integrationBranch, worktreePath: r.integrationWorktree },
    } : {};
    return { ...legacy, ...r.integrations };
  }
  private async ensureIntegration(r: SquadV2Record, repo: SquadRepository, base: string) {
    const known = this.integrations(r), existing = known[repo.key];
    if (existing) return existing;
    const id = r.state.squadId, root = this.directory(id), main = repo.key === 'main';
    const directory = main ? path.join(root, 'integration') : path.join(root, 'integrations', repo.key);
    const branch = main ? `squad/${id}` : `squad/${id}/${repo.key}`;
    const tree = await isolatedWorkspace(repo.directory, directory, branch, base, { managedIgnores: main });
    const integration = { repoKey: repo.key, source: repo.source, branch: tree.branch, worktreePath: tree.worktreePath };
    r.integrations = { ...known, [repo.key]: integration };
    if (main) { r.integrationBranch = tree.branch; r.integrationWorktree = tree.worktreePath; }
    return integration;
  }
  private slotRepository(r: SquadV2Record, slot: SquadSlotRecord) {
    const source = this.integrations(r)[slot.repoKey ?? 'main']?.source ?? slot.repo?.source ?? r.cwd;
    return repositoryDirectory(this.home, source);
  }
  private boundaries(value: unknown, field: string) {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some(p => typeof p !== 'string' || !p.trim() || p.includes('\0') ||
        path.isAbsolute(p) || /^[A-Za-z]:/.test(p) || p.includes('\\') || p.split('/').includes('..'))) throw new Error(`Invalid slot dispatch: invalid ${field} paths.`);
    return value as string[];
  }
  private async prepareSlotWorkspace(r: SquadV2Record, slot: SquadSlotRecord, repo: SquadRepository, localBase?: string) {
    const root = this.directory(r.state.squadId);
    if (slot.workspace === 'scratch' && !slot.worktreePath) {
      const scratch = path.join(root, 'scratch', slot.slotId);
      await fs.mkdir(path.dirname(scratch), { recursive: true });
      await fs.mkdir(scratch, { mode: 0o700 });
      slot.worktreePath = scratch;
    }
    if (slot.workspace !== 'worktree') return;
    const base = localBase ?? await repositoryBase(repo, slot.repo?.baseRef);
    const alreadyIntegrated = Boolean(this.integrations(r)[repo.key]);
    const integration = await this.ensureIntegration(r, repo, base);
    if (!alreadyIntegrated) await this.save(r);
    if (!slot.worktreePath) {
      if (alreadyIntegrated && !slot.repo?.baseRef) await advanceWorkspaceBaseline(repo.directory, integration.worktreePath, undefined, base);
      const tree = await isolatedWorkspace(repo.directory, path.join(root, 'roles', slot.slotId),
        slot.repo?.branch ?? `role/${r.state.squadId}/${slot.slotId}`, slot.repo?.baseRef ? base : integration.branch,
        { managedIgnores: repo.key === 'main', submodules: slot.repo?.submodules });
      Object.assign(slot, tree);
    } else {
      slot.baseSha = await advanceWorkspaceBaseline(repo.directory, integration.worktreePath, slot.worktreePath, base) ?? slot.baseSha;
    }
  }
  private prepareState(r: SquadV2Record, p: Record<string, unknown>) {
    if (!Number.isSafeInteger(p.expectedRevision) || p.expectedRevision !== r.state.revision) throw new Error(`Revision conflict; current revision ${r.state.revision}.`);
    if (Object.hasOwn(p, 'patch') && (!p.patch || typeof p.patch !== 'object' || Array.isArray(p.patch))) throw new Error('Invalid state patch.');
    const patch = (p.patch ?? {}) as Partial<SquadStateRecord>;
    const allowed = ['title','intent','invariants','contracts','criteria','tasks','openBlockers','activeGate'];
    if (Object.keys(patch).some(k => !allowed.includes(k))) throw new Error('Invalid state patch.');
    const state = structuredClone({ ...r.state, ...patch, revision: r.state.revision + 1, updatedAt: Date.now() });
    let kind: SquadEventRecord['kind'] = 'state_updated';
    if (patch.activeGate) { state.activeGate = { ...patch.activeGate, stateRevision: state.revision, openedAt: Date.now() }; kind = 'gate_opened'; }
    if (Object.hasOwn(p, 'resolveGate')) {
      if (!p.resolveGate || typeof p.resolveGate !== 'object' || Array.isArray(p.resolveGate)) throw new Error('Invalid gate resolution.');
      const resolution = p.resolveGate as { id: string; status: SquadGate['status']; resolutionText: string };
      if (!state.activeGate || state.activeGate.id !== resolution.id || state.activeGate.status !== 'open' || !['approved','changes_requested'].includes(resolution.status) || typeof resolution.resolutionText !== 'string') throw new Error('Invalid gate resolution.');
      state.activeGate = { ...state.activeGate, status: resolution.status, resolutionText: resolution.resolutionText, resolvedAt: Date.now(), stateRevision: state.revision }; kind = 'gate_resolved';
    }
    validateState(state); return { state, kind };
  }
  private idsInput(value: unknown, label: string, maximum = 256): string[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > maximum || value.some(id => typeof id !== 'string' || !id.trim()) || new Set(value).size !== value.length) throw new Error(`Invalid ${label}.`);
    return value as string[];
  }
  /** Validate all adoption IDs before committing anything. Physical projections
   * and explicit human acceptance feed the same round/task/criterion model. */
  private async prepareClosure(r: SquadV2Record, p: Record<string, unknown>) {
    const explicit = this.idsInput(p.acceptSlots, 'acceptSlots', 20);
    const retired = new Set(this.idsInput(p.retireSlots, 'retireSlots', 20));
    const deliveries = parseSlotDeliverables(p.slotDeliverables);
    for (const id of [...explicit, ...retired, ...deliveries.keys()]) {
      if (!r.slots.some(s => s.slotId === id)) throw new Error(`Unknown slot identity: ${id}.`);
    }
    const verify = new Set(this.idsInput(p.verifyCriteria, 'verifyCriteria'));
    const patch = p.patch as Partial<SquadStateRecord> | undefined;
    const legacyAccepted = Array.isArray(patch?.tasks) ? patch.tasks.filter(t => t.status === 'done' && r.slots.some(s => s.slotId === t.slotId)).map(t => t.slotId) : [];
    const accepted = new Set([...explicit, ...legacyAccepted]);
    for (const id of new Set([...accepted, ...retired, ...deliveries.keys()])) {
      const slot = r.slots.find(s => s.slotId === id)!;
      const live = await this.live(r, slot);
      if (explicit.includes(id) && ['active','waiting','offline'].includes(live.activity)) throw new Error('Acceptance requires a stationary observable slot.');
      slot.rounds = live.rounds;
      const round = slot.rounds!.at(-1)!;
      if (deliveries.has(id)) round.deliverables = uniqueDeliverables([...deliveries.get(id)!, ...round.deliverables]);
      if (retired.has(id)) slot.retired = true;
      if (accepted.has(id)) {
        round.acceptedAt ??= Date.now();
        round.completedAt ??= round.acceptedAt;
        for (const criterion of round.criteriaIds ?? []) verify.add(criterion);
      }
      round.stage = deriveStage(live.activity, live.result, round.acceptedAt != null, slot.retired);
      slot.updatedAt = Date.now();
      if (accepted.has(id) || retired.has(id)) {
        const stage = slot.retired ? 'superseded' : 'accepted';
        const task = projectTask({ ...live, stage, rounds: slot.rounds }, r.state.tasks.find(t => t.slotId === id));
        r.state.tasks = [...r.state.tasks.filter(t => t.slotId !== id), task];
      }
      if (explicit.includes(id) || retired.has(id)) r.pendingNotices = r.pendingNotices.filter(notice => notice.slotId !== id);
    }
    for (const id of verify) {
      const criterion = r.state.criteria.find(c => c.id === id);
      if (!criterion) throw new Error(`Unknown criterion: ${id}.`);
      criterion.verifiedAt ??= Date.now(); criterion.verifiedBy ??= 'supervisor';
    }
  }
  state(p: Record<string, unknown>) { return this.serial(async () => {
    const r = await this.read(String(p.squadId)); this.active(r);
    const update = this.prepareState(r, p);
    r.state = update.state; await this.prepareClosure(r, p);
    await this.save(r, update.kind, r.state.activeGate?.title ?? 'Shared state updated'); return this.snapshot(r);
  }); }
  private active(r: SquadV2Record) { if (r.status !== 'active') throw new Error('Squad is closed.'); }
  dispatch(p: Record<string, unknown>) { return this.serial(async () => {
    const r = await this.read(String(p.squadId)); this.active(r);
    // Prepare without persistence: invalid updates or unresolved Gates leave no trace.
    const update = ['patch','resolveGate','acceptSlots','verifyCriteria','retireSlots','slotDeliverables'].some(key => Object.hasOwn(p, key)) ? this.prepareState(r, p) : undefined;
    if (!update && Object.hasOwn(p, 'expectedRevision') && (!Number.isSafeInteger(p.expectedRevision) || p.expectedRevision !== r.state.revision)) throw new Error(`Revision conflict; current revision ${r.state.revision}.`);
    if (update) { r.state = update.state; await this.prepareClosure(r, p); }
    if (r.state.activeGate?.status === 'open' || r.state.activeGate?.status === 'changes_requested') throw new Error('Resolve the active Gate before dispatch.');
    if (!Array.isArray(p.slots) || !p.slots.length || p.slots.length > 20) throw new Error('Supply 1..20 slots.');
    const plans: Array<{ raw: Record<string, unknown>; slot: SquadSlotRecord; repo: SquadRepository; criteriaIds: string[]; inputs: string[]; localBase?: string;
      prior?: SquadSlotRecord; previous?: SquadSlotLiveView; reuse?: V2Thread }> = [];
    const ids = new Set<string>();
    for (const raw of p.slots as Array<Record<string, unknown>>) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid slot dispatch.');
      const id = safeId(raw.slotId), prior = r.slots.find(s => s.slotId === id);
      if (ids.has(id)) throw new Error('Duplicate slot identity.');
      ids.add(id);
      const declaredRepo = raw.repo === undefined ? undefined : parseRepository(raw.repo);
      const continuity = raw.continuity ?? prior?.continuity ?? 'stateful';
      const workspace = raw.workspace ?? prior?.workspace ?? (declaredRepo ? 'worktree' : 'shared');
      if (continuity !== 'stateful' && continuity !== 'clean' || workspace !== 'shared' && workspace !== 'worktree' && workspace !== 'scratch' ||
          typeof raw.task !== 'string' || raw.freshSession !== undefined && typeof raw.freshSession !== 'boolean' ||
          raw.readOnly !== undefined && typeof raw.readOnly !== 'boolean') throw new Error('Invalid slot dispatch.');
      if (prior && prior.workspace !== workspace) throw new Error('Slot workspace is immutable.');
      const binding = declaredRepo ?? prior?.repo;
      if (binding && workspace !== 'worktree') throw new Error('A slot repo requires workspace "worktree".');
      const repo = binding ? await bindRepository(this.home, r.cwd, binding.source) : mainRepository(r.cwd);
      const normalizedRepo = binding ? { ...binding, source: repo.source } : undefined;
      if (prior && declaredRepo && JSON.stringify(normalizedRepo) !== JSON.stringify(prior.repo)) throw new Error('Slot repository binding is immutable.');
      const touches = this.boundaries(raw.touches, 'touches');
      const forbid = raw.forbid === undefined ? [...(prior?.forbid ?? [])] : this.boundaries(raw.forbid, 'forbid');
      const readOnly = raw.readOnly ?? ((prior && prior.continuity === continuity ? prior.readOnly : undefined) ?? continuity === 'clean');
      let reuse: V2Thread | undefined;
      if (prior?.threadId) {
        const tracked = r.turnIds?.[id];
        const t = await this.runtime.read(prior.threadId, prior.hostRef ?? undefined, tracked);
        const turnStarting = Boolean(tracked) && (['inProgress','active','running'].includes(t.turnStatus ?? '') || (t.turnStatus === 'unknown' && Date.now() - (prior.dispatchedAt ?? 0) < 15000));
        if (!wakeable(t) || turnStarting) throw new Error('Slot is busy.');
        if (continuity === 'stateful' && prior.continuity === 'stateful' && raw.freshSession !== true) {
          if (readOnly !== (prior.readOnly ?? false)) throw new Error('Changing readOnly requires freshSession for an existing stateful session.');
          if ((raw.engine !== undefined && String(raw.engine) !== prior.engine) ||
              (raw.model !== undefined && String(raw.model) !== prior.model) ||
              (raw.reasoningEffort !== undefined && (raw.reasoningEffort ?? null) !== (prior.reasoningEffort ?? null))) {
            throw new Error('Stateful slot retains its bound engine, model and reasoningEffort; use freshSession to replace it.');
          }
          reuse = t;
        }
      }
      const dependencies = raw.dependsOn ?? prior?.dependsOn ?? [];
      if (!Array.isArray(dependencies) || dependencies.some(d => typeof d !== 'string' || !r.state.tasks.some(t => t.slotId === d && t.status === 'done'))) throw new Error('Slot dependencies are not done.');
      const slot: SquadSlotRecord = { ...prior, slotId: id, handle: String(raw.handle ?? prior?.handle ?? id), continuity, workspace,
        engine: String(raw.engine ?? prior?.engine ?? 'cli'), model: String(raw.model ?? prior?.model ?? ''),
        reasoningEffort: raw.reasoningEffort === undefined ? prior?.reasoningEffort : raw.reasoningEffort as string | null,
        ...(normalizedRepo ? { repo: normalizedRepo } : {}), ...(workspace === 'worktree' ? { repoKey: repo.key } : {}),
        touches, forbid, readOnly, dependsOn: dependencies as string[], sidebarHidden: prior?.sidebarHidden ?? true, updatedAt: Date.now() };
      delete slot.retired;
      delete slot.supersededBy;
      if (raw.goal !== undefined && (typeof raw.goal !== 'string' || !raw.goal.trim())) throw new Error('Invalid slot goal.');
      const criteriaIds = this.idsInput(raw.criteriaIds, 'criteriaIds');
      if (criteriaIds.some(id => !r.state.criteria.some(c => c.id === id))) throw new Error('Unknown slot criterion.');
      const references = [raw.inputs ?? [], raw.artifacts ?? []];
      if (references.some(list => !Array.isArray(list) || list.some(item => typeof item !== 'string' || !item.trim()))) throw new Error('Invalid slot input references.');
      const inputs = [...new Set((references as string[][]).flat())];
      const localBase = workspace === 'worktree' && !repo.remote ? await repositoryBase(repo, normalizedRepo?.baseRef) : undefined;
      plans.push({ raw, slot, repo, prior, reuse, criteriaIds, inputs, localBase,
        ...(prior && (prior.threadId || prior.rounds?.length) ? { previous: await this.live(r, prior) } : {}) });
    }
    // Preflight the whole batch before committing STATE or creating any runtime/worktree.
    if (update) await this.save(r, update.kind, r.state.activeGate?.title ?? 'Shared state updated');
    for (const { slot, repo, prior, localBase } of plans) {
      if (slot.worktreePath) continue;
      await this.prepareSlotWorkspace(r, slot, repo, localBase);
      if (!prior && slot.worktreePath) {
        // Own the new physical workspace even if session creation fails.
        r.slots.push({ ...slot }); await this.save(r);
      }
    }
    for (const { raw, slot, repo, prior, previous, reuse, criteriaIds, inputs, localBase } of plans) {
      const id = slot.slotId;
      const history = structuredClone(previous?.rounds ?? []);
      const priorRound = history.at(-1);
      if (priorRound) {
        priorRound.completedAt ??= Date.now();
        if (priorRound.stage !== 'superseded') { priorRound.acceptedAt ??= Date.now(); priorRound.stage = 'accepted'; }
        // Seal before advancing a Git baseline, removing the relay receipt, or
        // creating a replacement clean session. A failure cannot erase R(n-1).
        prior!.rounds = history; await this.save(r);
      }
      if (prior?.worktreePath) await this.prepareSlotWorkspace(r, slot, repo, localBase);
      const round: SquadSlotRound = { round: (priorRound?.round ?? 0) + 1, goal: String(raw.goal ?? raw.task),
        ...(raw.criteriaIds !== undefined ? { criteriaIds } : {}), touches: slot.touches, forbid: slot.forbid,
        readOnly: slot.readOnly, inputs, ...(slot.repo ? { repo: slot.repo } : {}), stateRevisionSent: r.state.revision,
        dispatchedAt: Date.now(), stage: 'running', deliverables: [] };
      slot.rounds = [...history, round].slice(-ROUND_LIMIT);
      const cwd = slot.worktreePath ?? r.cwd, relay = this.relayRoot(r, slot);
      await fs.mkdir(relay, { recursive: true, mode: 0o700 });
      if (!(await fs.lstat(relay)).isDirectory()) throw new Error('Slot relay must be a private directory.');
      for (const name of relayFiles) {
        const file = await fs.lstat(path.join(relay, name)).catch(error => { if (error.code === 'ENOENT') return; throw error; });
        if (file && (!file.isFile() || !prior?.threadId)) throw new Error(`Refusing to overwrite an existing slot relay entry: ${name}.`);
      }
      const anchor = reuse ? undefined : await this.runtime.read(r.anchorThreadId, r.anchorHostRef);
      const thread = reuse ?? await this.runtime.create(slot, cwd, anchor!);
      const checkScriptPath = path.join(relay, 'check-delivery.mjs');
      const peerWorktrees = [...new Map([...r.slots, ...plans.map(plan => plan.slot)].map(peer => [peer.slotId, peer])).values()]
        .flatMap(peer => peer.slotId !== id && peer.worktreePath ? [{ slotId: peer.slotId, handle: peer.handle, path: peer.worktreePath,
          branch: peer.branch, repoSource: peer.repo?.source ?? (peer.workspace === 'worktree' ? r.cwd : null) }] : []);
      const briefOptions: SquadBriefOptions = {
        ...(raw.criteriaIds !== undefined ? { criteriaIds } : {}), inputs, forbid: slot.forbid, readOnly: slot.readOnly,
        repo: slot.repo, peerWorktrees, checkScriptPath,
      };
      const brief = projectBrief(r.state, slot, String(raw.task), inputs, briefOptions);
      const prompt = reuse ? projectBrief(r.state, slot, String(raw.task), inputs, {
        ...briefOptions, promptOnly: true, incrementalFromRevision: priorRound?.stateRevisionSent ?? null,
      }) : brief;
      await fs.rm(path.join(relay, 'result.md'), { force: true });
      await fs.writeFile(path.join(relay, 'brief.md'), brief, { mode: 0o600 });
      await fs.writeFile(checkScriptPath, deliveryCheckScript(cwd, slot.baseSha, slot.touches, slot.forbid), { mode: 0o700 });
      if (!(p.patch as Partial<SquadStateRecord> | undefined)?.tasks) {
        r.state.tasks = [...r.state.tasks.filter(t => t.slotId !== id), { slotId: id, goal: round.goal, touches: slot.touches, dependsOn: slot.dependsOn, status: 'running' }];
      }
      slot.threadId = thread.id; slot.hostRef = thread.hostRef; slot.dispatchedAt = round.dispatchedAt;
      round.briefMarkdown = brief;
      r.slots = [...r.slots.filter(s => s.slotId !== id), slot]; r.activities[id] = 'active'; r.dispatched[id] = randomUUID();
      if (r.turnIds) delete r.turnIds[id];
      // A committed redispatch supersedes this slot's deferred edges, not their audit history.
      r.pendingNotices = r.pendingNotices.filter(notice => notice.slotId !== id);
      // Persist before crossing the runtime boundary. Unknown acceptance is never replayed.
      await this.save(r, 'dispatched', `@${slot.handle}`, id);
      try {
        const receipt = await this.runtime.send(thread, `${prompt}\nPrivate brief: ${path.join(relay, 'brief.md')}\nWrite result to: ${path.join(relay, 'result.md')}\nCheck delivery: ${checkScriptPath}`, r.dispatched[id], 'worker', slot.readOnly) as { turnId?: string; turn?: { id: string } } | undefined;
        const turnId = receipt?.turnId ?? receipt?.turn?.id;
        if (turnId) { (r.turnIds ??= {})[id] = turnId; await this.save(r); }
      }
      catch (e) { r.activities[id] = 'failed'; await this.save(r, 'waiting', `Dispatch outcome requires inspection: ${String(e)}`, id); throw e; }
    }
    return this.snapshot(r);
  }); }
  private healHostRef(r: SquadV2Record, thread: V2Thread, slot?: SquadSlotRecord): boolean {
    const bound = slot ? slot.hostRef : r.anchorHostRef, observed = thread.hostRef;
    if (!bound || !observed) return false;
    const id = slot ? slot.threadId : r.anchorThreadId;
    if (thread.id !== id || observed.threadId !== id || bound.threadId !== id || observed.hostId !== bound.hostId || observed.accountId !== bound.accountId) throw new Error('Reconnected native identity mismatch.');
    if (bound.runtimeId === observed.runtimeId) return false;
    if (slot) slot.hostRef = { ...observed }; else r.anchorHostRef = { ...observed };
    return true;
  }
  private relayRoot(r: SquadV2Record, slot: SquadSlotRecord) {
    return slot.worktreePath ? path.join(slot.worktreePath, '.mycodex') : path.join(this.directory(r.state.squadId), 'slots', slot.slotId, '.mycodex');
  }
  private async readResult(r: SquadV2Record, slot: SquadSlotRecord) {
    const relay = this.relayRoot(r, slot);
    try {
      if (!(await fs.lstat(relay)).isDirectory()) return;
      const result = await fs.open(path.join(relay, 'result.md'), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
      try {
        const stat = await result.stat();
        if (stat.isFile() && stat.mtimeMs >= (slot.dispatchedAt ?? 0)) return parseResult(await result.readFile('utf8'), stat.mtimeMs);
      } finally { await result.close(); }
    } catch { /* A missing, stale or malformed receipt is not a delivery. */ }
  }
  private async projectDeliverables(r: SquadV2Record, slot: SquadSlotRecord, items: SquadDeliverable[]) {
    const cwd = slot.worktreePath ?? r.cwd;
    const repository = slot.workspace === 'scratch' ? undefined : this.slotRepository(r, slot);
    return Promise.all(items.map(async item => {
      const { previewKind: _kind, previewRef: _ref, ...projected } = item;
      if (!projected.href && (item.kind === 'mr' || item.kind === 'issue')) {
        const href = await resolveDeliveryHref(cwd, repository ?? cwd, item.kind, item.label, item.target);
        if (href) projected.href = href;
      }
      try {
        if (item.kind === 'commit') {
          const token = extractCommitToken(item.label, item.target);
          if (token) {
            const repoDir = token.repoTarget ? await verifiedRepositoryDir(cwd, token.repoTarget) : repository;
            if (!repoDir) return projected;
            const sha = await resolveLocalCommit(repoDir, token.shaRef);
            return { ...projected, previewKind: 'commit' as const, previewRef: token.repoTarget ? `commit:${sha}@${token.repoTarget}` : `commit:${sha}` };
          }
        }
        if ((item.kind === 'report' || item.kind === 'artifact') && item.target && !projected.href) {
          const preview = await previewArtifactFile(cwd, item.target, false);
          return { ...projected, previewKind: preview.kind, previewRef: `file:${item.target}` };
        }
      } catch { /* Keep the delivery visible if its local source is unavailable. */ }
      return projected;
    }));
  }
  private async live(r: SquadV2Record, s: SquadSlotRecord): Promise<SquadSlotLiveView> {
    const view: SquadSlotLiveView = { ...s, activity: 'planned' };
    const relay = this.relayRoot(r, s);
    try { view.briefMarkdown = await fs.readFile(path.join(relay, 'brief.md'), 'utf8'); } catch {}
    if (s.workspace === 'worktree' && s.worktreePath && s.baseSha && !r.cleanedWorktrees?.includes(s.worktreePath)) {
      view.delta = await workspaceDelta(s.worktreePath, s.baseSha, s.touches, s.forbid);
    }
    if (s.threadId) {
      try {
        const trackedTurnId = r.turnIds?.[s.slotId];
        const thread = await this.runtime.read(s.threadId, s.hostRef ?? undefined, trackedTurnId), status = thread.status;
        this.healHostRef(r, thread, s); view.hostRef = s.hostRef;
        // Projection only: measured defaults must not become immutable dispatch overrides.
        if (!s.model) view.model = thread.model ?? '';
        if (s.reasoningEffort === undefined) view.reasoningEffort = thread.reasoningEffort;
        const turnPending = Boolean(trackedTurnId) && (['inProgress','active','running'].includes(thread.turnStatus ?? '') || (thread.turnStatus === 'unknown' && Date.now() - (s.dispatchedAt ?? 0) < 15000 && !['error','failed','systemError'].includes(status.type ?? '')));
        const systemWait = [status.type, ...(status.activeFlags ?? []), thread.turnStatus].filter(x => ['waitingOnApproval','waitingOnUserInput'].includes(x ?? ''));
        view.activity = systemWait.length || status.type === 'needs_attention' ? 'waiting' : thread.activeSubagents ? 'active' :
          ['active','running','inProgress'].includes(status.type ?? '') || turnPending ? 'active' :
          (['failed','interrupted'].includes(thread.turnStatus ?? '') || ['error','failed','systemError'].includes(status.type ?? '')) ? 'failed' : ['idle','completed','notLoaded'].includes(status.type ?? '') ? 'quiescent' : 'waiting';
        view.lastOutputSnippet = thread.lastMessage?.slice(-4000); view.elapsedMs = Date.now() - (s.dispatchedAt ?? s.updatedAt);
        if (view.activity === 'waiting') view.waitsOn = systemWait.length ? [...new Set(systemWait)].join(', ') : status.activeFlags?.join(', ') || status.type;
      } catch { view.activity = 'offline'; view.waitsOn = '运行时暂未连接；当前执行状态暂不可观测，请等待重连。'; }
      if (['quiescent','waiting','failed','offline'].includes(view.activity)) {
        view.result = await this.readResult(r, s);
        if (view.activity !== 'offline') view.result ??= { status: view.activity === 'quiescent' ? 'done' : 'blocked', summary: `Physical snapshot: ${view.activity}; business acceptance pending.`, assumptions: [], body: view.lastOutputSnippet ?? '', reportedAt: Date.now(), autoSynthesized: true };
      }
    }
    const projected = projectSlot(view, r.state.tasks.find(t => t.slotId === s.slotId));
    projected.deliverables = await this.projectDeliverables(r, s, projected.deliverables ?? []);
    const round = projected.rounds!.at(-1)!;
    round.deliverables = projected.deliverables;
    if (round.deltaSummary && view.delta) Object.assign(round.deltaSummary, {
      dirtyCount: view.delta.dirtyCount, forbidViolations: view.delta.forbidViolations?.slice(0, 40),
    });
    return projected;
  }
  private async pollSlot(r: SquadV2Record, slot: SquadSlotRecord, fresh = false) {
    const key = `${r.state.squadId}/${slot.slotId}`, round = slot.rounds?.at(-1);
    const stamp = JSON.stringify([r.state.revision, slot.updatedAt, slot.dispatchedAt, slot.sidebarHidden, slot.retired, round?.round, round?.acceptedAt]);
    const cached = this.stationary.get(key);
    if (!fresh && cached?.stamp === stamp && cached.expires > Date.now()) return cached.view;
    const live = await this.live(r, slot);
    this.stationary.delete(key);
    if (slot.sidebarHidden !== false && ['accepted','superseded'].includes(live.stage ?? '') && ['quiescent','failed','planned'].includes(live.activity)) {
      // Hidden conversations may still be opened directly in Desktop. A
      // slow recheck discovers out-of-band turns even without a STATE write.
      this.stationary.set(key, { stamp, expires: Date.now() + 15_000, view: live });
      if (this.stationary.size > 512) this.stationary.delete(this.stationary.keys().next().value!);
    }
    return live;
  }
  private async snapshot(r: SquadV2Record, fresh = false): Promise<SquadStudioSnapshot> {
    const studioUrl = `${await this.studio()}/squads/${r.state.squadId}?token=${this.token}`;
    const closed = r.status === 'closed';
    const bindingsBefore = JSON.stringify([r.anchorHostRef, r.slots.map(s => s.hostRef)]);
    const slots = closed ? r.slots.map(slot => projectSlot({ ...slot, activity: 'closed' }, r.state.tasks.find(t => t.slotId === slot.slotId))) :
      await Promise.all(r.slots.map(s => this.pollSlot(r, s, fresh)));
    let anchorSettings: SquadSessionSettings | undefined;
    if (!closed) try {
      const anchor = await this.runtime.read(r.anchorThreadId, r.anchorHostRef ?? undefined);
      this.healHostRef(r, anchor);
      if (anchor.model || anchor.reasoningEffort !== undefined) anchorSettings = { ...(anchor.model ? { model: anchor.model } : {}), ...(anchor.reasoningEffort !== undefined ? { reasoningEffort: anchor.reasoningEffort } : {}) };
    } catch { /* Optional root metadata must not hide otherwise available slots. */ }
    if (JSON.stringify([r.anchorHostRef, r.slots.map(s => s.hostRef)]) !== bindingsBefore) await this.save(r);
    const needsYou: SquadStudioSnapshot['needsYou'] = [];
    if (!closed && r.state.activeGate?.status === 'open') needsYou.push({ kind: 'gate', title: r.state.activeGate.title, detail: r.state.activeGate.question });
    for (const s of slots) {
      if (!closed && !s.retired && s.delta?.forbidViolations?.length) {
        needsYou.push({ kind: 'slot_failed', slotId: s.slotId, title: s.handle, detail: `Forbidden paths: ${s.delta.forbidViolations.join(', ')}` });
        continue;
      }
      if (closed || !['waiting','failed','blocked','escalated'].includes(s.stage ?? '')) continue;
      {
        needsYou.push({ kind: s.stage === 'escalated' ? 'slot_escalated' : s.stage === 'failed' ? 'slot_failed' : 'slot_waiting', slotId: s.slotId, title: s.handle, detail: s.waitsOn ?? s.result?.summary ?? '' });
      }
    }
    return JSON.parse(JSON.stringify({ squadId: r.state.squadId, anchorThreadId: r.anchorThreadId, anchorHostRef: r.anchorHostRef, ...(anchorSettings ? { anchorSettings } : {}), integrationBranch: r.integrationBranch, integrationWorktree: r.integrationWorktree, integrations: this.integrations(r), status: r.status, studioUrl, state: { ...r.state, tasks: [...r.state.tasks.filter(t => !slots.some(s => s.slotId === t.slotId)), ...slots.map(s => projectTask(s, r.state.tasks.find(t => t.slotId === s.slotId)))] }, slots, needsYou, events: (await this.events(r.state.squadId)).slice(-100) }));
  }
  status(p: Record<string, unknown>, polling = false) { return this.serial(async () => {
    if (p.squadId !== undefined && (typeof p.squadId !== 'string' || !p.squadId.trim()) ||
        p.anchorThreadId !== undefined && (typeof p.anchorThreadId !== 'string' || !p.anchorThreadId.trim()) ||
        p.squadId === undefined && p.anchorThreadId === undefined) throw new Error('Supply squadId or anchorThreadId.');
    const r = p.squadId !== undefined ? await this.read(p.squadId as string) : await this.byAnchor(p.anchorThreadId as string);
    if (!r) throw new Error('No matching Squad for anchorThreadId.');
    if (p.anchorThreadId !== undefined && r.anchorThreadId !== p.anchorThreadId) throw new Error('Squad anchor does not match anchorThreadId.');
    return this.snapshot(r, !polling);
  }); }
  diff(p: { squadId: string; slotId: string; path: string }) { return this.serial(async () => {
    const r = await this.read(String(p.squadId)), slot = r.slots.find(s => s.slotId === p.slotId);
    if (slot?.workspace !== 'worktree' || !slot.worktreePath || !slot.baseSha || r.cleanedWorktrees?.includes(slot.worktreePath)) throw new Error('Diff requires an isolated worktree slot.');
    return workspaceFileDiff(slot.worktreePath, slot.baseSha, String(p.path));
  }); }
  private async artifact(squadId: string, slotId: string, ref: string) {
    safeId(slotId);
    const record = await this.read(squadId).catch(() => { throw new Error('Squad is unavailable.'); });
    const slot = record.slots.find(s => s.slotId === slotId);
    if (!slot) throw new Error('Artifact slot is unavailable.');
    const registered = async (predicate: (item: SquadDeliverable) => boolean) => {
      const persisted = slot.rounds?.flatMap(round => round.deliverables.filter(predicate)) ?? [];
      if (persisted.length || record.status === 'closed') return persisted;
      const receipt = await this.readResult(record, slot);
      return receipt?.deliverables?.filter(predicate) ?? [];
    };
    if (ref.startsWith('commit:')) {
      const body = ref.slice(7), at = body.indexOf('@');
      // Resolve through the bound object database even after the checkout is
      // cleaned up. Scratch has no implicit commit capability.
      if (at === -1) {
        if (slot.workspace === 'scratch') throw new Error('Scratch slot has no bound Git repository.');
        return previewCommit(this.slotRepository(record, slot), body);
      }
      const sha = body.slice(0, at), repoTarget = body.slice(at + 1);
      const matches = await registered(item => {
        const token = item.kind === 'commit' && item.target === repoTarget ? extractCommitToken(item.label, item.target) : undefined;
        return Boolean(token?.repoTarget && sha.toLowerCase().startsWith(token.shaRef.toLowerCase()));
      });
      if (matches.length) {
        const repository = await verifiedRepositoryDir(slot.worktreePath ?? record.cwd, repoTarget);
        for (const item of matches) {
          const token = extractCommitToken(item.label, item.target)!;
          const registeredSha = await resolveLocalCommit(repository, token.shaRef).catch(() => undefined);
          if (registeredSha === sha.toLowerCase()) return previewCommit(repository, registeredSha);
        }
      }
      throw new Error('Commit repository and identity are not registered for this slot.');
    }
    if (!ref.startsWith('file:')) throw new Error('Invalid artifact reference.');
    const target = ref.slice(5);
    if (!(await registered(item => (item.kind === 'report' || item.kind === 'artifact') && item.target === target)).length) {
      throw new Error('Artifact is not registered for this slot.');
    }
    return previewArtifactFile(slot.worktreePath ?? record.cwd, target);
  }
  openSlot(p: { squadId: string; slotId: string }) { return this.serial(async () => {
    const r = await this.read(p.squadId), slot = r.slots.find(s => s.slotId === p.slotId);
    if (!slot?.threadId || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(slot.threadId)) throw new Error('A real local thread is required.');
    // Authorize against a fresh physical observation, never a browser snapshot.
    const priorRuntime = slot.hostRef?.runtimeId;
    const live = await this.live(r, slot);
    if (priorRuntime !== slot.hostRef?.runtimeId) await this.save(r);
    const systemWait = live.activity === 'waiting' && live.waitsOn?.split(', ').some(flag => ['waitingOnApproval','waitingOnUserInput'].includes(flag));
    if (slot.continuity !== 'stateful' && !systemWait) throw new Error('Clean slots may only open for system approval or input waits.');
    let result: { opened: boolean; reason?: string } = { opened: false };
    try {
      result = await this.runtime.open?.({ id: slot.threadId, cwd: slot.worktreePath ?? r.cwd, hostRef: slot.hostRef ?? undefined, status: { type: live.activity } }, r.anchorThreadId) ?? result;
    } catch (cause) { result.reason = cause instanceof Error ? cause.message : 'Desktop navigation unavailable.'; }
    // Opening a conversation never changes its durable sidebar visibility.
    const message = result.opened ? '已打开原会话，请在会话中处理审批或输入。' :
      `未连接可用的 Desktop 窗口或跳转未完成。请连接对应窗口后重试。${systemWait ? '系统审批或输入等待期间，侧栏会临时显示该会话。' : ''}${result.reason ? ` ${result.reason}` : ''}`;
    return { opened: result.opened, message, snapshot: await this.snapshot(r) };
  }); }
  promote(p: { squadId: string; slotId: unknown }) { return this.serial(async () => {
    const r = await this.read(String(p.squadId)), slot = r.slots.find(s => s.slotId === String(p.slotId));
    if (!slot || slot.continuity !== 'stateful') throw new Error('Only stateful slots may be promoted.');
    slot.sidebarHidden = false; slot.updatedAt = Date.now();
    await this.save(r, 'promoted', `Promoted @${slot.handle}`, slot.slotId); return this.snapshot(r);
  }); }
  listAll(): Promise<SquadStudioSnapshot[]> { return this.serial(async () => {
    const ids = await this.ids();
    const out: SquadStudioSnapshot[] = [];
    for (const id of ids) { try { out.push(await this.snapshot(await this.read(id))); } catch {} }
    return out;
  }); }
  integrate(p: Record<string, unknown>) { return this.serial(async () => {
    const r = await this.read(String(p.squadId)); this.active(r);
    if (p.expectedRevision !== r.state.revision) throw new Error('Revision conflict.');
    const slot = r.slots.find(s => s.slotId === p.slotId);
    const integration = this.integrations(r)[slot?.repoKey ?? 'main'];
    if (slot?.workspace !== 'worktree' || !slot.worktreePath || !slot.baseSha || !integration) throw new Error('Integrate requires a worktree slot.');
    const live = await this.live(r, slot); if (live.activity !== 'quiescent') throw new Error('Slot must be quiescent.');
    const wasAccepted = r.state.tasks.some(t => t.slotId === slot.slotId && t.status === 'done');
    const before = JSON.stringify(r.state.criteria);
    await this.prepareClosure(r, { acceptSlots: [slot.slotId], verifyCriteria: p.verifyCriteria });
    if (!wasAccepted || JSON.stringify(r.state.criteria) !== before) { r.state.revision++; r.state.updatedAt = Date.now(); }
    const delta = await integrateWorkspace(integration.worktreePath, slot.worktreePath, slot.baseSha, slot.touches, slot.forbid);
    r.pendingNotices = r.pendingNotices.filter(notice => notice.slotId !== slot.slotId);
    await this.save(r, 'integrated', `Integrated ${slot.handle}`, slot.slotId); return { delta, snapshot: await this.snapshot(r) };
  }); }
  close(p: Record<string, unknown>) { return this.serial(async () => {
    const r = await this.read(String(p.squadId));
    for (const id of (p.promoteSlots ?? []) as string[]) { const slot = r.slots.find(s => s.slotId === id); if (!slot || slot.continuity !== 'stateful') throw new Error('Only stateful slots may be promoted.'); slot.sidebarHidden = false; }
    const live = await Promise.all(r.slots.map(async slot => {
      if (r.status === 'closed' && (!slot.worktreePath || r.cleanedWorktrees?.includes(slot.worktreePath))) return;
      if (slot.worktreePath && !(await fs.lstat(slot.worktreePath).catch(() => undefined))?.isDirectory()) return;
      const view = await this.live(r, slot);
      slot.rounds = view.rounds;
      this.stationary.delete(`${r.state.squadId}/${slot.slotId}`);
      return view;
    }));
    r.pendingNotices = [];
    const firstClose = r.status !== 'closed';
    r.status = 'closed';
    await this.save(r, firstClose ? 'closed' : undefined, 'Closed; all real chats preserved.');
    const candidates: Array<{ directory: string; branch?: string; repository?: string; relay: Record<string, string | undefined> }> = [];
    for (const view of live) {
      if (!view?.worktreePath || !['quiescent','failed','planned'].includes(view.activity)) continue;
      const cwd = view.worktreePath;
      candidates.push({ directory: cwd, branch: view.branch ?? undefined, repository: view.workspace === 'worktree' ? this.slotRepository(r, view) : undefined,
        relay: { 'brief.md': view.rounds?.at(-1)?.briefMarkdown, 'result.md': view.rounds?.at(-1)?.result?.body,
          'check-delivery.mjs': deliveryCheckScript(cwd, view.baseSha, view.touches, view.forbid) } });
    }
    for (const tree of Object.values(this.integrations(r))) candidates.push({ directory: tree.worktreePath, branch: tree.branch,
      repository: repositoryDirectory(this.home, tree.source), relay: {} });
    const cleaned = new Set(r.cleanedWorktrees);
    for (const { directory, branch, repository, relay } of candidates) {
      if (cleaned.has(directory)) continue;
      const removed = repository ? branch && await removeSquadWorkspace(repository, directory, branch, relay) : await removeScratchWorkspace(directory, relay);
      if (removed) {
        cleaned.add(directory);
        // Persist each successful removal before touching another worktree.
        r.cleanedWorktrees = [...cleaned];
        await this.save(r);
      }
    }
    return this.snapshot(r);
  }); }
  private noticeSummary(r: SquadV2Record, slot: SquadSlotLiveView) {
    const summary = {
      activity: slot.activity, result: slot.result?.summary, assumptions: slot.result?.assumptions, outsideTouches: slot.delta?.outsideTouches,
      repoSource: slot.repo?.source ?? (slot.workspace === 'worktree' ? r.cwd : null), branch: slot.branch ?? null, headSha: slot.delta?.headSha ?? null,
      commitCount: slot.delta?.commits.length ?? 0, changedCount: slot.delta?.changed.length ?? 0, dirtyCount: slot.delta?.dirtyCount ?? 0,
      forbidViolations: slot.delta?.forbidViolations ?? [], deliverables: slot.deliverables ?? [],
    };
    const encoded = JSON.stringify(summary);
    if (Buffer.byteLength(JSON.stringify(encoded)) <= 18_000) return encoded;
    const shortList = (items?: string[]) => items?.slice(0, 8).map(item => item.slice(0, 128));
    return JSON.stringify({ ...summary, truncated: true, result: summary.result?.slice(0, 512), repoSource: summary.repoSource?.slice(0, 512) ?? null,
      assumptions: shortList(summary.assumptions), outsideTouches: shortList(summary.outsideTouches), forbidViolations: shortList(summary.forbidViolations),
      deliverables: summary.deliverables.slice(0, 8).map(({ kind, label, target }) => ({ kind, label: label.slice(0, 128), target: target?.slice(0, 256) })),
    });
  }
  async tick() { return this.serial(async () => {
    const ids = await this.ids();
    for (const id of ids) {
      const r = await this.read(id); if (r.status === 'closed') continue;
      for (const s of r.slots) {
        const priorRuntime = s.hostRef?.runtimeId;
        const live = await this.pollSlot(r, s), previous = r.activities[s.slotId];
        if (priorRuntime !== s.hostRef?.runtimeId) await this.save(r);
        // An observation gap is not a business edge. Preserve the last known
        // activity so an idle -> offline -> idle bounce sends no new notice.
        if (live.stage === 'accepted' || live.stage === 'superseded') {
          if (live.stage === 'superseded' && previous !== live.activity) s.rounds = live.rounds;
          r.activities[s.slotId] = live.activity;
          const before = r.pendingNotices.length;
          r.pendingNotices = r.pendingNotices.filter(notice => notice.slotId !== s.slotId);
          if (before !== r.pendingNotices.length || live.stage === 'superseded' && previous !== live.activity) await this.save(r);
          continue;
        }
        if (live.activity === 'offline') continue;
        if (previous === live.activity) continue;
        r.activities[s.slotId] = live.activity;
        s.rounds = live.rounds;
        r.state.tasks = [...r.state.tasks.filter(t => t.slotId !== s.slotId), projectTask(live, r.state.tasks.find(t => t.slotId === s.slotId))];
        if (live.activity === 'active' && previous !== 'active') { if (r.dispatched[s.slotId] === 'observed') { s.dispatchedAt = Date.now(); s.updatedAt = Date.now(); if (r.turnIds) delete r.turnIds[s.slotId]; } await this.save(r); continue; }
        const human = s.continuity === 'stateful' && previous === 'active' && r.dispatched[s.slotId] === 'observed';
        if (['quiescent','waiting','failed'].includes(live.activity)) {
          await this.save(r, human ? 'human_stepped_in' : live.activity === 'quiescent' ? 'quiescent' : 'waiting', this.noticeSummary(r, live), s.slotId);
          r.dispatched[s.slotId] = 'observed'; await this.save(r);
        }
      }
      if (r.pendingNotices.length) {
        let anchor: V2Thread;
        try { anchor = await this.runtime.read(r.anchorThreadId, r.anchorHostRef); this.healHostRef(r, anchor); } catch { continue; }
        if (!wakeable(anchor)) continue;
        const message = (events: SquadEventRecord[]) => '[Squad Notice] ' + JSON.stringify({ squadId: id, events });
        const batch = [r.pendingNotices[0]];
        for (const event of r.pendingNotices.slice(1)) {
          if (Buffer.byteLength(message([...batch, event])) > 24_000) break;
          batch.push(event);
        }
        r.pendingNotices.splice(0, batch.length);
        const request = randomUUID();
        // At-most-once send on uncertain transport, with durable notice history.
        await this.save(r);
        try { await this.runtime.send(anchor, message(batch), request, 'supervisor'); }
        catch { await this.save(r, 'state_updated', `Notice delivery outcome unknown; inspect request ${request}; no automatic replay.`); }
      }
    }
  }); }
  async shutdown() { this.stopped = true; await this.tail; if (this.server?.listening) {
    const closed = new Promise<void>((resolve, reject) => this.server!.close(e => e ? reject(e) : resolve()));
    this.server.closeIdleConnections(); this.server.closeAllConnections();
    await closed;
  } }
}
