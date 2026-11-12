import fs from "node:fs";
import path from "node:path";
import type { HostThreadRef } from "./host-thread-contracts.mjs";
import { parseHostRef } from "./host-thread-contracts.mjs";

export type GoalStatus = "active" | "paused" | "completed" | "archived";
export interface GoalRecord {
  schemaVersion: 1;
  id: string;
  revision: number;
  title: string;
  summary: string;
  status: GoalStatus;
  supervisorThreadId: string | null;
  repositories: string[];
  createdAt: string;
  updatedAt: string;
}

export interface WorkItemBrief {
  revision: number;
  goalSummary: string;
  scope: string[];
  doNotTouch: string[];
  doneCriteria: string[];
  ruledOut: string[];
  constraints: string[];
  openQuestions: string[];
}

export interface HandoffContract {
  userVerbatimAnchor: string;
  hqJudgment: {
    desiredOutcome: string;
    doneCriteria: string[];
    ruledOut: string[];
  };
  scope: {
    modify: string[];
    doNotTouch: string[];
  };
  investigatedRefs: string[];
  referenceImpl: string[];
  baseSha: string;
  verificationRequired: string[];
}

export type SquadRole = "supervisor" | "integrator" | "implementer" | "scout" | "reviewer";
export type SquadWritePolicy = "read_only" | "worktree_isolated" | "integration_merge";
export type SquadMemberStatus = "idle" | "running" | "settled" | "cooldown_429" | "needs_attention";

export interface SquadMemberRecord {
  memberId: string;
  role: SquadRole;
  label: string;
  engine: string;
  model: string;
  writePolicy: SquadWritePolicy;
  worktreePath: string;
  branch: string;
  baseSha: string;
  headSha: string | null;
  threadId: string | null;
  hostRef: HostThreadRef | null;
  subtaskId: string;
  ownedPaths: string[];
  status: SquadMemberStatus;
  reason: string | null;
  failureStreak: number;
  lastErrorSignature: string | null;
  cooldownUntil: string | null;
  updatedAt: string;
}

export type SquadBoardEntryKind = "dispatch" | "progress" | "handback" | "handoff" | "integration" | "attention";
export interface SquadBoardEntry {
  id: string;
  at: string;
  kind: SquadBoardEntryKind;
  memberId: string;
  role: SquadRole;
  title: string;
  summary: string;
  threadId: string | null;
  turnId: string | null;
  subtaskId: string | null;
  worktreePath: string | null;
  branch: string | null;
  baseSha: string | null;
  headSha: string | null;
  changedFiles: string[];
  verificationPassed: boolean | null;
  spilloverId: string | null;
  draftPrompt: string | null;
}

export type WorkItemStatus = "draft" | "ready" | "in_progress" | "ready_for_acceptance" | "needs_attention" | "done" | "paused";
export interface WorkItemPolicy {
  revision: number;
  enabled: boolean;
  paused: boolean;
  takeover: boolean;
  maxInputBytes: number;
  maxAttempts: number;
}

export interface WorkItemRecord {
  schemaVersion: 1;
  id: string;
  revision: number;
  goalId: string;
  title: string;
  repository: string;
  workspace: string;
  status: WorkItemStatus;
  reason: string | null;
  supervisorThreadId: string | null;
  integratorThreadId: string | null;
  responsibleHostRef: HostThreadRef | null;
  brief: WorkItemBrief;
  handoff: HandoffContract;
  policy: WorkItemPolicy;
  squad: SquadMemberRecord[];
  board: SquadBoardEntry[];
  createdAt: string;
  updatedAt: string;
}

const validIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/;
const shaPattern = /^[0-9a-f]{7,40}$/i;
const refAnchorPattern = /^[^:\s]+:\d+(?:-\d+)?$/;
const tmpPathPattern = /(?:^|[\s"'`])(?:\/private)?\/tmp(?:\/|$)/i;

function assertNonEmptyString(value: unknown, field: string, maxLength = 4096): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength || value.includes("\0")) {
    throw new Error(`Invalid ${field}: expected a bounded non-empty string.`);
  }
  return value.trim();
}

function assertStringList(value: unknown, field: string, { minLength = 0, maxItems = 64, maxItemLength = 1024 } = {}): string[] {
  if (!Array.isArray(value) || value.length < minLength || value.length > maxItems) {
    throw new Error(`Invalid ${field}: expected between ${minLength} and ${maxItems} items.`);
  }
  return value.map((entry, index) => assertNonEmptyString(entry, `${field}[${index}]`, maxItemLength));
}

function assertNoTmpReference(value: string, field: string) {
  if (tmpPathPattern.test(value)) {
    throw new Error(`Handoff contract cannot reference /tmp scratch files in ${field}.`);
  }
}

export function validateHandoffContract(value: unknown): HandoffContract {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Handoff contract is required.");
  }
  const candidate = value as Record<string, unknown>;
  const userVerbatimAnchor = assertNonEmptyString(candidate.userVerbatimAnchor, "handoff.userVerbatimAnchor", 4096);
  assertNoTmpReference(userVerbatimAnchor, "handoff.userVerbatimAnchor");

  if (!candidate.hqJudgment || typeof candidate.hqJudgment !== "object" || Array.isArray(candidate.hqJudgment)) {
    throw new Error("Invalid handoff.hqJudgment: expected desiredOutcome, doneCriteria and ruledOut.");
  }
  const judgment = candidate.hqJudgment as Record<string, unknown>;
  const desiredOutcome = assertNonEmptyString(judgment.desiredOutcome, "handoff.hqJudgment.desiredOutcome", 4096);
  const doneCriteria = assertStringList(judgment.doneCriteria, "handoff.hqJudgment.doneCriteria", { minLength: 1 });
  const ruledOut = assertStringList(judgment.ruledOut ?? [], "handoff.hqJudgment.ruledOut", { minLength: 0 });

  if (!candidate.scope || typeof candidate.scope !== "object" || Array.isArray(candidate.scope)) {
    throw new Error("Invalid handoff.scope: expected modify and doNotTouch lists.");
  }
  const scopeObj = candidate.scope as Record<string, unknown>;
  const modify = assertStringList(scopeObj.modify, "handoff.scope.modify", { minLength: 1 });
  const doNotTouch = assertStringList(scopeObj.doNotTouch ?? [], "handoff.scope.doNotTouch", { minLength: 0 });
  for (const item of [...modify, ...doNotTouch]) assertNoTmpReference(item, "handoff.scope");

  const investigatedRefs = assertStringList(candidate.investigatedRefs, "handoff.investigatedRefs", { minLength: 1 });
  for (const ref of investigatedRefs) {
    assertNoTmpReference(ref, "handoff.investigatedRefs");
    if (ref !== "none_checked" && !refAnchorPattern.test(ref)) {
      throw new Error(`Invalid handoff.investigatedRefs entry "${ref}": must be "none_checked" or "path:line".`);
    }
  }

  const referenceImpl = assertStringList(candidate.referenceImpl, "handoff.referenceImpl", { minLength: 1 });
  for (const ref of referenceImpl) {
    assertNoTmpReference(ref, "handoff.referenceImpl");
    if (ref !== "none_new" && !refAnchorPattern.test(ref)) {
      throw new Error(`Invalid handoff.referenceImpl entry "${ref}": must be "none_new" or "path:line".`);
    }
  }

  const baseSha = assertNonEmptyString(candidate.baseSha, "handoff.baseSha", 64);
  if (!shaPattern.test(baseSha)) {
    throw new Error(`Invalid handoff.baseSha "${baseSha}": expected a 7-40 hex commit SHA.`);
  }
  const verificationRequired = assertStringList(candidate.verificationRequired, "handoff.verificationRequired", { minLength: 1 });
  for (const command of verificationRequired) assertNoTmpReference(command, "handoff.verificationRequired");

  return {
    userVerbatimAnchor,
    hqJudgment: { desiredOutcome, doneCriteria, ruledOut },
    scope: { modify, doNotTouch },
    investigatedRefs,
    referenceImpl,
    baseSha,
    verificationRequired,
  };
}

export function validateSquadMember(value: unknown, expectedBaseSha?: string): SquadMemberRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid squad member record.");
  }
  const candidate = value as Record<string, unknown>;
  const memberId = assertNonEmptyString(candidate.memberId, "squad.memberId", 64);
  if (!/^@?[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(memberId)) {
    throw new Error(`Invalid squad memberId "${memberId}".`);
  }
  const role = candidate.role as SquadRole;
  if (!["supervisor", "integrator", "implementer", "scout", "reviewer"].includes(role)) {
    throw new Error(`Invalid squad role "${String(role)}".`);
  }
  const writePolicy = candidate.writePolicy as SquadWritePolicy;
  if (!["read_only", "worktree_isolated", "integration_merge"].includes(writePolicy)) {
    throw new Error(`Invalid squad writePolicy "${String(writePolicy)}".`);
  }
  if ((role === "scout" || role === "reviewer") && writePolicy !== "read_only") {
    throw new Error(`Squad member ${memberId} (${role}) must use writePolicy "read_only".`);
  }
  const label = assertNonEmptyString(candidate.label ?? memberId, "squad.label", 128);
  const engine = assertNonEmptyString(candidate.engine ?? "codex", "squad.engine", 64);
  const model = assertNonEmptyString(candidate.model ?? `${engine}/default`, "squad.model", 128);
  const worktreePath = assertNonEmptyString(candidate.worktreePath, "squad.worktreePath", 4096);
  if (!path.isAbsolute(worktreePath)) {
    throw new Error(`Squad member ${memberId} worktreePath must be an absolute path.`);
  }
  const branch = assertNonEmptyString(candidate.branch ?? "HEAD", "squad.branch", 128);
  const baseSha = assertNonEmptyString(candidate.baseSha ?? expectedBaseSha ?? "", "squad.baseSha", 64);
  if (!shaPattern.test(baseSha)) {
    throw new Error(`Squad member ${memberId} has invalid baseSha "${baseSha}".`);
  }
  if (expectedBaseSha && baseSha !== expectedBaseSha && role === "implementer") {
    throw new Error(`Squad implementer ${memberId} baseSha (${baseSha}) does not match WorkItem baseSha (${expectedBaseSha}).`);
  }
  const headSha = candidate.headSha == null ? null : assertNonEmptyString(candidate.headSha, "squad.headSha", 64);
  const threadId = candidate.threadId == null ? null : assertNonEmptyString(candidate.threadId, "squad.threadId", 128);
  const hostRef = candidate.hostRef == null ? null : parseHostRef(candidate.hostRef);
  const subtaskId = assertNonEmptyString(candidate.subtaskId ?? memberId.replace(/^@/, ""), "squad.subtaskId", 96);
  const ownedPaths = assertStringList(candidate.ownedPaths ?? [], "squad.ownedPaths", { minLength: 0 });
  const status = (candidate.status ?? "idle") as SquadMemberStatus;
  if (!["idle", "running", "settled", "cooldown_429", "needs_attention"].includes(status)) {
    throw new Error(`Invalid squad member status "${String(status)}".`);
  }
  const reason = candidate.reason == null ? null : assertNonEmptyString(candidate.reason, "squad.reason", 256);
  const failureStreak = typeof candidate.failureStreak === "number" && Number.isSafeInteger(candidate.failureStreak) && candidate.failureStreak >= 0
    ? candidate.failureStreak
    : 0;
  const lastErrorSignature = candidate.lastErrorSignature == null ? null : assertNonEmptyString(candidate.lastErrorSignature, "squad.lastErrorSignature", 512);
  const cooldownUntil = candidate.cooldownUntil == null ? null : assertNonEmptyString(candidate.cooldownUntil, "squad.cooldownUntil", 64);
  const updatedAt = typeof candidate.updatedAt === "string" && Number.isFinite(Date.parse(candidate.updatedAt))
    ? candidate.updatedAt
    : new Date().toISOString();
  return {
    memberId,
    role,
    label,
    engine,
    model,
    writePolicy,
    worktreePath,
    branch,
    baseSha,
    headSha,
    threadId,
    hostRef,
    subtaskId,
    ownedPaths,
    status,
    reason,
    failureStreak,
    lastErrorSignature,
    cooldownUntil,
    updatedAt,
  };
}

export function validateSquadWorktrees(squad: SquadMemberRecord[], expectedBaseSha: string): void {
  const seenMemberIds = new Set<string>();
  const isolatedWorktreeOwners = new Map<string, string>();
  let integrationRoot: { canonical: string; memberId: string } | null = null;

  for (const member of squad) {
    if (seenMemberIds.has(member.memberId)) {
      throw new Error(`Duplicate squad memberId "${member.memberId}".`);
    }
    seenMemberIds.add(member.memberId);
    if (!fs.existsSync(member.worktreePath) || !fs.statSync(member.worktreePath).isDirectory()) {
      throw new Error(`Squad member ${member.memberId} worktree directory does not exist: ${member.worktreePath}`);
    }
    const canonical = fs.realpathSync(member.worktreePath);
    if (member.role === "implementer" && member.writePolicy === "worktree_isolated" && member.status !== "cooldown_429") {
      if (member.baseSha !== expectedBaseSha) {
        throw new Error(`Squad implementer ${member.memberId} baseSha (${member.baseSha}) diverges from WorkItem baseSha (${expectedBaseSha}).`);
      }
      const existingOwner = isolatedWorktreeOwners.get(canonical);
      if (existingOwner) {
        throw new Error(`Squad worktree conflict: multiple writers (${existingOwner} and ${member.memberId}) cannot share the same worktree (${canonical}).`);
      }
      if (integrationRoot && integrationRoot.canonical === canonical) {
        throw new Error(`Squad worktree conflict: implementer ${member.memberId} cannot share the integration worktree with ${integrationRoot.memberId}.`);
      }
      isolatedWorktreeOwners.set(canonical, member.memberId);
    } else if (member.writePolicy === "integration_merge") {
      const existingWriter = isolatedWorktreeOwners.get(canonical);
      if (existingWriter) {
        throw new Error(`Squad worktree conflict: integrator ${member.memberId} cannot share a worktree with active implementer ${existingWriter}.`);
      }
      integrationRoot = { canonical, memberId: member.memberId };
    }
  }
}

export function parseGoalRecord(value: unknown, expectedId?: string): GoalRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid goal record.");
  }
  const candidate = value as Record<string, unknown>;
  const id = assertNonEmptyString(candidate.id, "goal.id", 96);
  if (!validIdPattern.test(id) || (expectedId && id !== expectedId)) {
    throw new Error(`Invalid goal id "${id}".`);
  }
  const revision = Number(candidate.revision);
  if (candidate.schemaVersion !== 1 || !Number.isSafeInteger(revision) || revision < 1) {
    throw new Error("Invalid goal schemaVersion or revision.");
  }
  const title = assertNonEmptyString(candidate.title, "goal.title", 256);
  const summary = assertNonEmptyString(candidate.summary ?? title, "goal.summary", 4096);
  const status = (candidate.status ?? "active") as GoalStatus;
  if (!["active", "paused", "completed", "archived"].includes(status)) {
    throw new Error(`Invalid goal status "${String(status)}".`);
  }
  const supervisorThreadId = candidate.supervisorThreadId == null ? null : assertNonEmptyString(candidate.supervisorThreadId, "goal.supervisorThreadId", 128);
  const repositories = assertStringList(candidate.repositories ?? [], "goal.repositories", { minLength: 0, maxItems: 32, maxItemLength: 512 });
  const createdAt = typeof candidate.createdAt === "string" && Number.isFinite(Date.parse(candidate.createdAt)) ? candidate.createdAt : new Date().toISOString();
  const updatedAt = typeof candidate.updatedAt === "string" && Number.isFinite(Date.parse(candidate.updatedAt)) ? candidate.updatedAt : createdAt;
  return { schemaVersion: 1, id, revision, title, summary, status, supervisorThreadId, repositories, createdAt, updatedAt };
}

export function parseWorkItemRecord(value: unknown, expectedId?: string): WorkItemRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid WorkItem record.");
  }
  const candidate = value as Record<string, unknown>;
  const id = assertNonEmptyString(candidate.id, "workItem.id", 96);
  if (!validIdPattern.test(id) || (expectedId && id !== expectedId)) {
    throw new Error(`Invalid WorkItem id "${id}".`);
  }
  const revision = Number(candidate.revision);
  if (candidate.schemaVersion !== 1 || !Number.isSafeInteger(revision) || revision < 1) {
    throw new Error("Invalid WorkItem schemaVersion or revision.");
  }
  const goalId = assertNonEmptyString(candidate.goalId, "workItem.goalId", 96);
  if (!validIdPattern.test(goalId)) throw new Error(`Invalid WorkItem goalId "${goalId}".`);
  const title = assertNonEmptyString(candidate.title, "workItem.title", 256);
  const repository = assertNonEmptyString(candidate.repository, "workItem.repository", 256);
  const workspace = assertNonEmptyString(candidate.workspace, "workItem.workspace", 4096);
  if (!path.isAbsolute(workspace)) throw new Error("WorkItem workspace must be an absolute path.");
  const status = (candidate.status ?? "ready") as WorkItemStatus;
  if (!["draft", "ready", "in_progress", "ready_for_acceptance", "needs_attention", "done", "paused"].includes(status)) {
    throw new Error(`Invalid WorkItem status "${String(status)}".`);
  }
  const reason = candidate.reason == null ? null : assertNonEmptyString(candidate.reason, "workItem.reason", 256);
  const supervisorThreadId = candidate.supervisorThreadId == null ? null : assertNonEmptyString(candidate.supervisorThreadId, "workItem.supervisorThreadId", 128);
  const integratorThreadId = candidate.integratorThreadId == null ? null : assertNonEmptyString(candidate.integratorThreadId, "workItem.integratorThreadId", 128);
  const responsibleHostRef = candidate.responsibleHostRef == null ? null : parseHostRef(candidate.responsibleHostRef);

  const handoff = validateHandoffContract(candidate.handoff);

  const rawBrief = (candidate.brief && typeof candidate.brief === "object" && !Array.isArray(candidate.brief) ? candidate.brief : {}) as Record<string, unknown>;
  const briefRevision = Number(rawBrief.revision ?? 1);
  if (!Number.isSafeInteger(briefRevision) || briefRevision < 1) throw new Error("Invalid workItem.brief.revision.");
  const brief: WorkItemBrief = {
    revision: briefRevision,
    goalSummary: assertNonEmptyString(rawBrief.goalSummary ?? handoff.hqJudgment.desiredOutcome, "workItem.brief.goalSummary", 4096),
    scope: assertStringList(rawBrief.scope ?? handoff.scope.modify, "workItem.brief.scope", { minLength: 1 }),
    doNotTouch: assertStringList(rawBrief.doNotTouch ?? handoff.scope.doNotTouch, "workItem.brief.doNotTouch", { minLength: 0 }),
    doneCriteria: assertStringList(rawBrief.doneCriteria ?? handoff.hqJudgment.doneCriteria, "workItem.brief.doneCriteria", { minLength: 1 }),
    ruledOut: assertStringList(rawBrief.ruledOut ?? handoff.hqJudgment.ruledOut, "workItem.brief.ruledOut", { minLength: 0 }),
    constraints: assertStringList(rawBrief.constraints ?? [], "workItem.brief.constraints", { minLength: 0 }),
    openQuestions: assertStringList(rawBrief.openQuestions ?? [], "workItem.brief.openQuestions", { minLength: 0 }),
  };

  const rawPolicy = (candidate.policy && typeof candidate.policy === "object" && !Array.isArray(candidate.policy) ? candidate.policy : {}) as Record<string, unknown>;
  const policyRevision = Number(rawPolicy.revision ?? 1);
  if (!Number.isSafeInteger(policyRevision) || policyRevision < 1) throw new Error("Invalid workItem.policy.revision.");
  const policy: WorkItemPolicy = {
    revision: policyRevision,
    enabled: rawPolicy.enabled !== false,
    paused: rawPolicy.paused === true,
    takeover: rawPolicy.takeover === true,
    maxInputBytes: typeof rawPolicy.maxInputBytes === "number" && Number.isSafeInteger(rawPolicy.maxInputBytes) ? rawPolicy.maxInputBytes : 16384,
    maxAttempts: typeof rawPolicy.maxAttempts === "number" && Number.isSafeInteger(rawPolicy.maxAttempts) ? rawPolicy.maxAttempts : 2,
  };

  if (!Array.isArray(candidate.squad) || candidate.squad.length > 16) {
    throw new Error("Invalid workItem.squad: expected up to 16 squad members.");
  }
  const squad = candidate.squad.map(entry => validateSquadMember(entry, handoff.baseSha));

  if (!Array.isArray(candidate.board) || candidate.board.length > 200) {
    throw new Error("Invalid workItem.board: expected up to 200 board entries.");
  }
  const board: SquadBoardEntry[] = candidate.board.map((rawEntry, index) => {
    if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
      throw new Error(`Invalid board entry at index ${index}.`);
    }
    const entry = rawEntry as Record<string, unknown>;
    const kind = entry.kind as SquadBoardEntryKind;
    if (!["dispatch", "progress", "handback", "handoff", "integration", "attention"].includes(kind)) {
      throw new Error(`Invalid board entry kind "${String(kind)}".`);
    }
    const role = (entry.role ?? "implementer") as SquadRole;
    if (!["supervisor", "integrator", "implementer", "scout", "reviewer"].includes(role)) {
      throw new Error(`Invalid board entry role "${String(role)}".`);
    }
    return {
      id: assertNonEmptyString(entry.id, `board[${index}].id`, 96),
      at: typeof entry.at === "string" && Number.isFinite(Date.parse(entry.at)) ? entry.at : new Date().toISOString(),
      kind,
      memberId: assertNonEmptyString(entry.memberId, `board[${index}].memberId`, 64),
      role,
      title: assertNonEmptyString(entry.title, `board[${index}].title`, 256),
      summary: assertNonEmptyString(entry.summary, `board[${index}].summary`, 4096),
      threadId: entry.threadId == null ? null : assertNonEmptyString(entry.threadId, `board[${index}].threadId`, 128),
      turnId: entry.turnId == null ? null : assertNonEmptyString(entry.turnId, `board[${index}].turnId`, 128),
      subtaskId: entry.subtaskId == null ? null : assertNonEmptyString(entry.subtaskId, `board[${index}].subtaskId`, 96),
      worktreePath: entry.worktreePath == null ? null : assertNonEmptyString(entry.worktreePath, `board[${index}].worktreePath`, 4096),
      branch: entry.branch == null ? null : assertNonEmptyString(entry.branch, `board[${index}].branch`, 128),
      baseSha: entry.baseSha == null ? null : assertNonEmptyString(entry.baseSha, `board[${index}].baseSha`, 64),
      headSha: entry.headSha == null ? null : assertNonEmptyString(entry.headSha, `board[${index}].headSha`, 64),
      changedFiles: assertStringList(entry.changedFiles ?? [], `board[${index}].changedFiles`, { minLength: 0, maxItems: 64 }),
      verificationPassed: typeof entry.verificationPassed === "boolean" ? entry.verificationPassed : null,
      spilloverId: entry.spilloverId == null ? null : assertNonEmptyString(entry.spilloverId, `board[${index}].spilloverId`, 128),
      draftPrompt: entry.draftPrompt == null ? null : assertNonEmptyString(entry.draftPrompt, `board[${index}].draftPrompt`, 4096),
    };
  });

  const createdAt = typeof candidate.createdAt === "string" && Number.isFinite(Date.parse(candidate.createdAt)) ? candidate.createdAt : new Date().toISOString();
  const updatedAt = typeof candidate.updatedAt === "string" && Number.isFinite(Date.parse(candidate.updatedAt)) ? candidate.updatedAt : createdAt;
  return {
    schemaVersion: 1,
    id,
    revision,
    goalId,
    title,
    repository,
    workspace,
    status,
    reason,
    supervisorThreadId,
    integratorThreadId,
    responsibleHostRef,
    brief,
    handoff,
    policy,
    squad,
    board,
    createdAt,
    updatedAt,
  };
}
