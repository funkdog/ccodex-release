import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SquadStateRecord, SquadSlotRecord, SquadEventRecord, SquadSlotResult, SquadDeliverable, SquadSlotLiveView, SquadSlotRound, SquadSlotStage, SquadTaskNode, SquadWorkspaceDelta, SquadDeltaSummary, SquadIntegrationTree, SquadBriefOptions } from './squad-v2-contracts.mjs';
import type { HostThreadRef } from './host-thread-contracts.mjs';
export interface SquadV2Record {
  state: SquadStateRecord; anchorThreadId: string; anchorHostRef?: HostThreadRef; cwd: string;
  updatedAt?: number;
  status: 'active' | 'closed'; slots: SquadSlotRecord[]; integrationBranch?: string; integrationWorktree?: string;
  integrations?: Record<string, SquadIntegrationTree>;
  cleanedWorktrees?: string[];
  turnIds?: Record<string, string>;
  pendingNotices: SquadEventRecord[]; activities: Record<string, string>; dispatched: Record<string, string>;
}
export async function atomicJson(file: string, data: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try { await fs.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); await fs.rename(tmp, file); }
  finally { await fs.rm(tmp, { force: true }); }
}
export const isCriterionVerified = (c: { verifiedAt?: number | null; verifiedBy?: string | null }) =>
  c.verifiedAt != null || Boolean(c.verifiedBy);

export function renderState(s: SquadStateRecord) {
  return `# ${s.title} (rev.${s.revision})\n\n## Intent\n${s.intent}\n\n## Done Criteria\n` +
    s.criteria.map(c => `- [${isCriterionVerified(c) ? 'x' : ' '}] ${c.id}: ${c.text}${c.detail != null ? `\n  Detail: ${c.detail}` : ''}`).join('\n') +
    `\n\n## Invariants\n${s.invariants.map(x => '- ' + x).join('\n')}\n\n## Shared Contracts\n${s.contracts.map(x => '- ' + x).join('\n')}\n\n## Live Task Graph\n` +
    s.tasks.map(t => `- ${t.slotId} · ${t.status}: ${t.goal}\n  touches: ${t.touches.join(', ')}; depends on: ${t.dependsOn.join(', ')}`).join('\n') +
    `\n\n## Blockers\n${s.openBlockers.map(b => '- ' + b.summary).join('\n')}\n\n## Gate\n${s.activeGate ? `${s.activeGate.title}: ${s.activeGate.status}\n${s.activeGate.question}\n${s.activeGate.resolutionText ?? ''}` : 'None'}\n`;
}
export function projectBrief(state: SquadStateRecord, slot: SquadSlotRecord, task: string, artifacts: string[], options?: SquadBriefOptions) {
  const section = (title: string, content: string) => content.trim() ? `## ${title}\n${content}\n\n` : '';
  const bullets = (items: string[]) => items.map(item => '- ' + item).join('\n');
  const scope = options?.criteriaIds?.length ? new Set(options.criteriaIds) : null;
  const criteria = state.criteria.filter(c => !scope || scope.has(c.id))
    .map(c => `- ${c.id}: ${c.text}${c.detail != null ? `\n  Detail: ${c.detail}` : ''}`).join('\n');
  const references = [...new Set([...(options?.inputs ?? []), ...artifacts])];
  const clean = slot.continuity === 'clean';
  const incremental = !clean && options?.promptOnly === true && options.incrementalFromRevision === state.revision;
  const repo = options?.repo === undefined ? slot.repo : options.repo;
  const readOnly = options?.readOnly ?? slot.readOnly;
  const forbid = options?.forbid ?? slot.forbid;
  const boundaries: string[] = [];
  if (repo) {
    const binding = [repo.source, repo.baseRef && `baseRef ${repo.baseRef}`, repo.branch && `branch ${repo.branch}`,
      repo.submodules !== undefined && `submodules ${repo.submodules}`].filter(Boolean);
    boundaries.push(`repo: ${binding.join(' · ')}`);
  }
  if (readOnly !== undefined) boundaries.push(`readOnly: ${readOnly}`);
  if (forbid?.length) boundaries.push('forbid:\n' + bullets(forbid));
  const touches = slot.touches.length ? bullets(slot.touches) : '';
  const peers = clean ? [] : (options?.peerWorktrees ?? []).filter(peer => peer.slotId !== slot.slotId).map(peer =>
    `@${peer.handle} -> ${peer.path}${peer.branch ? ` [${peer.branch}]` : ''}`);
  const checkPath = options?.checkScriptPath;
  const deliveryCheck = checkPath ? `\nBefore stopping, run node ${quoteCheckPath(checkPath)} to check the delivery.` : '';

  return `# Role Brief: ${slot.handle}\n\n` +
    (incremental ? `Shared STATE unchanged (rev.${state.revision}); full brief at .mycodex/brief.md.\n\n` : '') +
    (clean ? '' : section('Objective / What & Why', task)) +
    (!clean && !incremental ? section('Shared Purpose', state.intent) : '') +
    section('Acceptance Criteria', criteria) +
    (!clean && !incremental ? section('Architecture Red Lines', bullets(state.invariants)) + section('Shared Contracts', bullets(state.contracts)) : '') +
    section(options ? 'Inputs & References' : 'Artifacts / Diff References', bullets(references)) +
    section('Peer Read-Only Worktrees', bullets(peers)) +
    (!clean && !incremental
      ? section('Execution Ownership', 'Main defines the outcome, criteria and boundaries; you choose How. Verify against the contract and report evidence or blockers.')
      : '') +
    section('Workspace Boundaries', boundaries.join('\n')) +
    section('Write Boundary / Touches', touches) +
    section('Delivery', 'Write .mycodex/result.md with status: done | blocked | escalate, summary, Changes & Verification, and Assumptions & Trade-offs. Use the optional ## Deliverables heading for typed MR, issue, report or attachment references (for example, - [report] review.md | ./review.md). The kernel automatically collects Git commits, branches and changed files.' + deliveryCheck + ' Stop after delivery.');
}

function quoteCheckPath(value: string): string {
  if (/^[a-z0-9_./-]+$/i.test(value)) return value;
  return "'" + value.replaceAll("'", process.platform === 'win32' ? "''" : "'\\''") + "'";
}

export function parseResult(body: string, reportedAt: number): SquadSlotResult {
  let fence = '';
  const markdown = body.replace(/\r\n?/g, '\n').split('\n').map(line => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = '';
      return '';
    }
    if (!marker) return line;
    fence = marker[1];
    return '';
  }).join('\n');
  const status = markdown.match(/^[ \t]*(?:[-*+][ \t]+)?(?:status|\*\*status\*\*)[ \t]*:[ \t]*(['"]?)(done|blocked|escalate)\1[ \t]*$/im)?.[2]
    .toLowerCase() as SquadSlotResult['status'] | undefined;
  if (!status) throw new Error('Result requires status: done, blocked, or escalate.');
  const headings = [...markdown.matchAll(/^ {0,3}(#{1,6})[ \t]+(.+)$/gm)];
  const start = headings.findIndex(heading => /^(?:Assumptions\s*&\s*Trade-offs|关键假设与取舍|假设与取舍)/i.test(heading[2]));
  const assumptions = start < 0 ? [] : markdown.slice(
    headings[start].index + headings[start][0].length,
    headings.slice(start + 1).find(heading => heading[1].length <= headings[start][1].length)?.index,
  ).trim().split('\n').filter(line => Boolean(line.trim()));
  const summary = markdown.match(/^[ \t]*(?:[-*+][ \t]+)?(?:summary|\*\*summary\*\*)[ \t]*:[ \t]*(.+)$/im)?.[1].trim();
  return { status, summary: summary || body.slice(0, 300), assumptions, body, reportedAt, deliverables: extractDeliverables(body) };
}
const mutableStateKeys = ['title','intent','invariants','contracts','criteria','openBlockers','activeGate'];

function validateKeys(value: unknown, allowed: readonly string[], location: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid Squad V2 state at ${location}.`);
  for (const key of Object.keys(value)) {
    if (allowed.includes(key)) continue;
    const guidance = location.startsWith('criteria[') ? ' Use verifyCriteria with criterion IDs to mark verification.' : '';
    throw new Error(`Invalid Squad V2 state: unknown field ${location}.${key}.${guidance}`);
  }
}

function validateNestedStateKeys(state: Partial<SquadStateRecord>) {
  if (Array.isArray(state.criteria)) state.criteria.forEach((c, i) =>
    validateKeys(c, ['id','text','detail','verifiedBy','verifiedAt'], `criteria[${i}]`));
  if (Array.isArray(state.openBlockers)) state.openBlockers.forEach((blocker, i) =>
    validateKeys(blocker, ['id','slotId','summary','createdAt'], `openBlockers[${i}]`));
  if (state.activeGate != null) {
    validateKeys(state.activeGate, ['id','kind','title','question','recommendedOptionId','options','status','resolutionText','openedAt','resolvedAt','stateRevision'], 'activeGate');
    if (Array.isArray(state.activeGate.options)) state.activeGate.options.forEach((option, i) =>
      validateKeys(option, ['id','label','summary'], `activeGate.options[${i}]`));
  }
}

/** Public writes describe shared intent. The kernel alone projects slot tasks. */
export function validatePublicStateKeys(value: unknown) {
  validateKeys(value, mutableStateKeys, 'STATE');
  validateNestedStateKeys(value as Partial<SquadStateRecord>);
}

export function validateState(s: SquadStateRecord) {
  validateKeys(s, [...mutableStateKeys, 'schemaVersion','squadId','revision','tasks','updatedAt'], 'STATE');
  validateNestedStateKeys(s);
  if (Array.isArray(s.tasks)) s.tasks.forEach((task, i) =>
    validateKeys(task, ['slotId','goal','touches','dependsOn','status'], `tasks[${i}]`));
  if (!s || s.schemaVersion !== 2 || typeof s.title !== 'string' || typeof s.intent !== 'string' ||
      !Array.isArray(s.invariants) || !Array.isArray(s.contracts) || !Array.isArray(s.criteria) || !Array.isArray(s.tasks) || !Array.isArray(s.openBlockers) ||
      [...s.invariants, ...s.contracts].some(x => typeof x !== 'string') ||
      s.criteria.some(c => !c || typeof c.id !== 'string' || typeof c.text !== 'string' || (c.detail !== undefined && c.detail !== null && (typeof c.detail !== 'string' || !c.detail.trim())) || (c.verifiedBy !== undefined && c.verifiedBy !== null && (typeof c.verifiedBy !== 'string' || !c.verifiedBy.trim())) || (c.verifiedAt !== undefined && c.verifiedAt !== null && (!Number.isSafeInteger(c.verifiedAt) || c.verifiedAt < 0))) ||
      s.tasks.some(t => !t || typeof t.slotId !== 'string' || typeof t.goal !== 'string' || !['todo','running','review','done','blocked'].includes(t.status) || !Array.isArray(t.touches) || !Array.isArray(t.dependsOn) || [...t.touches, ...t.dependsOn].some(x => typeof x !== 'string')) ||
      s.openBlockers.some(b => !b || typeof b.id !== 'string' || typeof b.summary !== 'string') ||
      s.activeGate && (!['open','approved','changes_requested'].includes(s.activeGate.status) || typeof s.activeGate.id !== 'string' || typeof s.activeGate.question !== 'string')) throw new Error('Invalid Squad V2 state.');
  if (new Set(s.tasks.map(t => t.slotId)).size !== s.tasks.length || new Set(s.criteria.map(c => c.id)).size !== s.criteria.length) throw new Error('Duplicate state identity.');
}


const deliverableKinds = ['mr','issue','commit','branch','report','artifact'];
export const safeHttpHref = (value: string | undefined) => {
  if (!value || !/^https?:\/\//i.test(value) || /[\u0000-\u001f\u007f\\]/.test(value)) return undefined;
  try {
    const url = new URL(value);
    if (url.hostname && !url.username && !url.password) return url.href;
  } catch { /* Invalid links remain plain delivery text. */ }
  return undefined;
};
export function parseSlotDeliverables(value: unknown): Map<string, SquadDeliverable[]> {
  const result = new Map<string, SquadDeliverable[]>();
  if (value === undefined) return result;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 20) throw new Error('Invalid slotDeliverables.');
  for (const [slotId, items] of Object.entries(value)) {
    if (!Array.isArray(items) || items.length > 24) throw new Error('Invalid slotDeliverables list.');
    const text = (s: unknown, max: number) => typeof s === 'string' && s.length <= max && Boolean(s.trim()) && !s.includes('\0');
    result.set(slotId, items.map((item: SquadDeliverable) => {
      if (!item || typeof item !== 'object' || Array.isArray(item) ||
          Object.keys(item).some(key => !['kind','label','target','detail','href','previewKind','previewRef'].includes(key)) ||
          !deliverableKinds.includes(item.kind) || !text(item.label, 240) ||
          item.target !== undefined && !text(item.target, 2048) || item.detail !== undefined && !text(item.detail, 1000) ||
          item.href !== undefined && (!text(item.href, 2048) || !safeHttpHref(item.href)) ||
          item.previewKind !== undefined && !['commit','markdown','text'].includes(item.previewKind) ||
          item.previewRef !== undefined && !text(item.previewRef, 2055)) throw new Error('Invalid slotDeliverables entry.');
      // Preview authorization is always derived from the registered target.
      const { kind, label, target, detail, href } = item;
      return { kind, label, target, detail, href };
    }));
  }
  return result;
}
export const ROUND_LIMIT = 20;
export function uniqueDeliverables(items: SquadDeliverable[]): SquadDeliverable[] {
  const seen = new Set<string>();
  return items.filter(item => {
    const key = `${item.kind}:${item.target || item.label}`;
    if (seen.has(key)) return false; seen.add(key); return true;
  }).slice(0, 24);
}
export function extractDeliverables(body: string): SquadDeliverable[] {
  const items: SquadDeliverable[] = [];
  const explicit = body.match(/^##?\s+Deliverables\s*\n([\s\S]*?)(?=^##?\s|$(?![\s\S]))/mi)?.[1] ?? '';
  for (const line of explicit.split('\n')) {
    const match = line.match(/^\s*[-*]\s+\[(\w+)\]\s+(.+)$/);
    if (!match || !deliverableKinds.includes(match[1])) continue;
    const [label, target, ...detail] = match[2].split(/\s*\|\s*/).map(s => s.trim());
    if (!label) continue;
    const href = safeHttpHref(target);
    items.push({ kind: match[1] as SquadDeliverable['kind'], label: label.slice(0, 240), ...(target ? { target: target.slice(0, 2048) } : {}), ...(href ? { href } : {}), ...(detail.length ? { detail: detail.join(' | ').slice(0, 1000) } : {}) });
  }
  // Fallback intentionally recognizes only concrete outputs, never arbitrary
  // prose links. Targets remain data; the view separately allowlists http(s).
  for (const match of body.matchAll(/\[([^\]\n]+)\]\(<?([^\n)]+?)>?\)/g)) {
    const label = match[1].trim(), target = match[2].trim();
    let kind: SquadDeliverable['kind'] | undefined;
    if (/^https?:\/\//i.test(target)) {
      try {
        const url = new URL(target);
        if (/\/(?:merge_requests|pull)\//.test(url.pathname)) kind = 'mr';
        else if (/\/issues\//.test(url.pathname)) kind = 'issue';
      } catch { continue; }
    } else if (/^(?:[\w.-]+\/)*[\w.-]*![1-9]\d*$/.test(target)) kind = 'mr';
    else if (/^(?:[\w.-]+\/)*[\w.-]*#[1-9]\d*$/.test(target)) kind = 'issue';
    else if (/^(?:\/|\.\/|[A-Za-z]:[\\/])/.test(target) && /\.(?:md|markdown|txt|jsonl?|log|html|pdf|png)$/i.test(target)) kind = /\.(?:md|markdown|pdf)$/i.test(target) ? 'report' : 'artifact';
    const href = safeHttpHref(target);
    if (kind) items.push({ kind, label: label.slice(0, 240), target: target.slice(0, 2048), ...(href ? { href } : {}) });
  }
  const prose = body.replace(explicit, '').replace(/\[[^\]\n]+\]\([^\n)]*\)/g, '');
  for (const match of prose.matchAll(/(?:^|[\s(])((?:[\w.-]+(?:\/[\w.-]+)*)?([!#])[1-9]\d*)(?![\w/-])/g)) {
    const [, target, marker] = match;
    if (target.length <= 240 && !items.some(item => item.target === target || item.label === target)) {
      items.push({ kind: marker === '!' ? 'mr' : 'issue', label: target, target });
    }
  }
  return uniqueDeliverables(items);
}
export function summarizeDelta(delta: SquadWorkspaceDelta): SquadDeltaSummary {
  return { baseSha: delta.baseSha, headSha: delta.headSha, commitCount: delta.commits.length, changedCount: delta.changed.length,
    files: delta.changed.slice(0, 40).map(f => ({ ...f })), outsideTouches: delta.outsideTouches.slice(0, 40),
    ...(delta.dirtyCount !== undefined ? { dirtyCount: delta.dirtyCount } : {}),
    ...(delta.forbidViolations !== undefined ? { forbidViolations: [...delta.forbidViolations] } : {}) };
}
export function deriveStage(activity: SquadSlotLiveView['activity'], result?: SquadSlotResult | null, accepted = false, retired = false): SquadSlotStage {
  if (retired) return 'superseded';
  if (activity === 'closed' && result && !result.autoSynthesized) return accepted ? 'accepted' : deriveStage('quiescent', result);
  if (activity === 'active') return 'running';
  if (activity === 'waiting') return 'waiting';
  if (accepted) return 'accepted';
  if (activity === 'failed') return 'failed';
  if (activity === 'offline') return 'offline';
  if (activity === 'quiescent' && result && !result.autoSynthesized) return result.status === 'done' ? 'delivered' : result.status === 'blocked' ? 'blocked' : 'escalated';
  return 'planned';
}
/** One projection owns the stage, current round and outputs. Old records are
 * adapted in memory; normal reads never perform a destructive migration. */
export function projectSlot(view: SquadSlotLiveView, task?: SquadTaskNode): SquadSlotLiveView {
  const legacy = !view.rounds?.length;
  const rounds: SquadSlotRound[] = structuredClone(view.rounds?.length ? view.rounds : [{ round: 1, goal: task?.goal || view.briefMarkdown?.match(/## Objective \/ What & Why\n([\s\S]*?)(?=\n## |$)/)?.[1]?.trim() || view.handle,
    touches: view.touches, dispatchedAt: view.dispatchedAt ?? view.updatedAt, stage: 'planned', deliverables: [] }]);
  const current = rounds.at(-1)!;
  if ((!view.result || view.result.autoSynthesized) && !['active','waiting'].includes(view.activity) && current.result) view.result = current.result;
  const result = view.result && !view.result.autoSynthesized ? view.result : undefined;
  const gitOutputs: SquadDeliverable[] = view.delta ? view.delta.commits.slice(0, 3).map(c => ({ kind: 'commit', label: c.subject.slice(0, 240), target: c.sha })) : [];
  if (view.delta?.changed.length) gitOutputs.push({ kind: 'artifact', label: `${view.delta.changed.length} 个工作树变更文件`, ...(view.worktreePath ? { target: view.worktreePath } : {}) });
  const deliverables = uniqueDeliverables([...current.deliverables, ...(result?.deliverables ?? (result ? extractDeliverables(result.body) : [])), ...gitOutputs]).map(item => {
    const { href, ...rest } = item;
    const safe = safeHttpHref(href) ?? safeHttpHref(item.target);
    return safe ? { ...rest, href: safe } : rest;
  });
  if (legacy && task?.status === 'done') current.acceptedAt = current.completedAt ?? result?.reportedAt ?? view.updatedAt;
  const derived = deriveStage(view.activity, view.result, current.acceptedAt != null, view.retired);
  const stage = view.activity === 'closed' && !legacy && !view.retired && current.acceptedAt == null ? current.stage : derived;
  current.stage = stage; current.briefMarkdown = view.briefMarkdown ?? current.briefMarkdown;
  if (result) current.result = structuredClone(result);
  if (['quiescent','failed'].includes(view.activity)) current.completedAt ??= result?.reportedAt ?? Date.now();
  current.deliverables = deliverables;
  if (view.delta) current.deltaSummary = summarizeDelta(view.delta);
  return { ...view, stage, deliverables, rounds: rounds.slice(-ROUND_LIMIT) };
}
export function projectTask(slot: SquadSlotLiveView, task?: SquadTaskNode): SquadTaskNode {
  const stage = slot.stage ?? deriveStage(slot.activity, slot.result, false, slot.retired);
  const status: SquadTaskNode['status'] = stage === 'accepted' || stage === 'superseded' && slot.rounds?.at(-1)?.acceptedAt != null ? 'done' : stage === 'running' ? 'running' : stage === 'delivered' ? 'review' :
    ['waiting','failed','blocked','escalated'].includes(stage) ? 'blocked' : stage === 'offline' ? task?.status ?? 'todo' : 'todo';
  return { slotId: slot.slotId, touches: slot.touches, dependsOn: slot.dependsOn, ...task, goal: slot.rounds?.at(-1)?.goal ?? task?.goal ?? slot.handle, status };
}

/** Control-plane projection only; Studio keeps the full delivery and file detail. */
export function compactSquadPayload(raw: unknown): unknown {
  const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const delta = (value: unknown, slot = false): unknown => {
    if (!record(value)) return value;
    return {
      ...(slot && value.baseSha !== undefined ? { baseSha: value.baseSha } : {}),
      ...(value.headSha !== undefined ? { headSha: value.headSha } : {}),
      commitCount: Array.isArray(value.commits) ? value.commits.length : value.commitCount ?? 0,
      changedCount: Array.isArray(value.changed) ? value.changed.length : value.changedCount ?? 0,
      outsideTouches: value.outsideTouches ?? [],
      ...(value.dirtyCount !== undefined ? { dirtyCount: value.dirtyCount } : {}),
      ...(value.forbidViolations !== undefined ? { forbidViolations: value.forbidViolations } : {}),
    };
  };
  if (!record(raw)) return raw;
  if (record(raw.snapshot)) return {
    ...raw,
    snapshot: compactSquadPayload(raw.snapshot),
    ...(Object.hasOwn(raw, "delta") ? { delta: delta(raw.delta) } : {}),
  };
  const { anchorHostRef: _anchor, events, ...snapshot } = raw;
  if (Array.isArray(events)) snapshot.eventCount = events.length;
  if (Array.isArray(raw.slots)) snapshot.slots = raw.slots.map(value => {
    if (!record(value)) return value;
    const { briefMarkdown: _brief, hostRef: _host, lastOutputSnippet, ...slot } = value;
    if (typeof lastOutputSnippet === "string" && (slot.activity === "failed" || !slot.result)) slot.lastOutputSnippet = lastOutputSnippet.slice(0, 240);
    if (record(slot.result)) {
      const result = slot.result;
      slot.result = {
        ...(Object.hasOwn(result, "status") ? { status: result.status } : {}),
        ...(Object.hasOwn(result, "summary") ? { summary: result.summary } : {}),
        ...(Object.hasOwn(result, "assumptions") ? { assumptions: result.assumptions } : {}),
        ...(result.criteriaMet ? { criteriaMet: result.criteriaMet } : {}),
        ...(result.autoSynthesized ? { autoSynthesized: true } : {}),
      };
    }
    if (Array.isArray(slot.rounds)) slot.rounds = slot.rounds.slice(-20).filter(record).map(round => ({
      round: round.round, goal: typeof round.goal === "string" ? round.goal.slice(0, 240) : round.goal,
      stage: round.stage, dispatchedAt: round.dispatchedAt,
      ...(round.criteriaIds !== undefined ? { criteriaIds: round.criteriaIds } : {}),
      ...(round.repo !== undefined ? { repo: round.repo } : {}),
      ...(round.completedAt !== undefined ? { completedAt: round.completedAt } : {}),
      ...(round.acceptedAt !== undefined ? { acceptedAt: round.acceptedAt } : {}),
      ...(record(round.result) ? { result: { status: round.result.status, summary: typeof round.result.summary === "string" ? round.result.summary.slice(0, 240) : round.result.summary,
        assumptions: Array.isArray(round.result.assumptions) ? round.result.assumptions.slice(0, 3).map(a => String(a).slice(0, 160)) : [] } } : {}),
      ...(Array.isArray(round.deliverables) ? { deliverables: round.deliverables.slice(0, 3).filter(record).map(d => ({
        kind: d.kind, label: String(d.label).slice(0, 120),
        ...(typeof d.href === "string" && safeHttpHref(d.href) ? { href: d.href } : {}),
        ...(d.previewKind && d.previewRef ? { previewKind: d.previewKind, previewRef: d.previewRef } : {}),
      })) } : {}),
      ...(record(round.deltaSummary) ? { deltaSummary: delta(round.deltaSummary, true) } : {}),
    }));
    if (Object.hasOwn(slot, "delta")) slot.delta = delta(slot.delta, true);
    return slot;
  });
  return snapshot;
}
