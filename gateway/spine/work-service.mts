import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { GatewayProtocol } from "../protocol.mjs";
import type { GatewayConnection, GatewayParams } from "../contracts.mjs";
import type { SpineRegistry } from "./registry.mjs";
import type { DispatchAuthority, ReactionRequest } from "./work-dispatch-contracts.mjs";
import type {
  GoalRecord,
  WorkItemRecord,
  SquadMemberRecord,
  SquadBoardEntry,
} from "./work-contracts.mjs";
import {
  parseGoalRecord,
  parseWorkItemRecord,
  validateHandoffContract,
  validateSquadMember,
  validateSquadWorktrees,
} from "./work-contracts.mjs";
import { WorkStore } from "./work-store.mjs";
import { parseGeneralWorkItem, workId } from "./work-context.mjs";

const internalConnection: GatewayConnection = {
  role: "default",
  initialized: true,
  send() {},
  request() {
    return Promise.reject(new Error("Interactive prompts are not permitted during background squad execution."));
  },
};

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
}

function matchesBoundaryPath(changedFile: string, pattern: string): boolean {
  const normalizedFile = normalizeRelativePath(changedFile);
  const normalizedPattern = normalizeRelativePath(pattern);
  if (!normalizedFile || !normalizedPattern) return false;
  return normalizedFile === normalizedPattern || normalizedFile.startsWith(`${normalizedPattern}/`);
}

function normalizeErrorSignature(raw: string): string {
  return raw
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, "<ts>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

function runGit(cwd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 8000 });
  return {
    ok: result.status === 0,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
  };
}

function isGitWorktree(directory: string): boolean {
  try {
    return fs.existsSync(path.join(directory, ".git"));
  } catch {
    return false;
  }
}

function ensureGitExclude(workspace: string, pattern = ".mycodex-worktrees/"): void {
  const res = runGit(workspace, ["rev-parse", "--git-path", "info/exclude"]);
  if (!res.ok || !res.stdout) return;
  const excludePath = path.isAbsolute(res.stdout) ? res.stdout : path.resolve(workspace, res.stdout);
  try {
    fs.mkdirSync(path.dirname(excludePath), { recursive: true });
    const existing = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, "utf8") : "";
    if (!existing.split("\n").map(line => line.trim()).includes(pattern)) {
      fs.writeFileSync(excludePath, `${existing.trimEnd()}\n${pattern}\n`, "utf8");
    }
  } catch {
    // Best-effort exclude update.
  }
}

function inspectWorktreeState(worktreePath: string, baseSha: string): { headSha: string; changedFiles: string[] } {
  if (!isGitWorktree(worktreePath)) {
    return { headSha: baseSha, changedFiles: [] };
  }
  const headRes = runGit(worktreePath, ["rev-parse", "--short=7", "HEAD"]);
  const headSha = headRes.ok && headRes.stdout ? headRes.stdout : baseSha;
  const changed = new Set<string>();

  const diffBase = runGit(worktreePath, ["diff", "--name-only", baseSha]);
  if (diffBase.ok && diffBase.stdout) {
    for (const line of diffBase.stdout.split("\n")) {
      const trimmed = normalizeRelativePath(line.trim());
      if (trimmed && !trimmed.startsWith(".mycodex-worktrees")) changed.add(trimmed);
    }
  }
  const statusRes = runGit(worktreePath, ["status", "--porcelain"]);
  if (statusRes.ok && statusRes.stdout) {
    for (const line of statusRes.stdout.split("\n")) {
      const match = line.match(/^\s*[A-Z?]{1,2}\s+(.+)$/);
      if (!match) continue;
      const rawPath = match[1].trim().split(" -> ").at(-1) ?? "";
      const trimmed = normalizeRelativePath(rawPath);
      if (trimmed && !trimmed.startsWith(".mycodex-worktrees")) changed.add(trimmed);
    }
  }
  return { headSha, changedFiles: [...changed].sort() };
}

function buildSquadMemberPrompt(item: WorkItemRecord, member: SquadMemberRecord, directive?: string): string {
  const recentBoard = item.board
    .slice(-5)
    .map(entry => `- [${entry.kind}] ${entry.memberId}: ${entry.title} — ${entry.summary}`)
    .join("\n") || "- (尚无历史看板记录)";
  const ownedScope = member.ownedPaths.length ? member.ownedPaths : item.handoff.scope.modify;
  return [
    `[MyCodex Squad Dispatch · WorkItem ${item.id} · Brief rev.${item.brief.revision} · Member ${member.memberId} (${member.role})]`,
    `1. 用户原话锚点 (User Verbatim Anchor): ${item.handoff.userVerbatimAnchor}`,
    `2. 主聊判断与完成判据 (HQ Judgment):`,
    `   - 期望结果: ${item.handoff.hqJudgment.desiredOutcome}`,
    `   - 完成判据: ${item.handoff.hqJudgment.doneCriteria.join("；")}`,
    `   - 已排除方向: ${item.handoff.hqJudgment.ruledOut.join("；") || "无"}`,
    `3. 改动边界与写入策略 (Scope & Write Policy = ${member.writePolicy}):`,
    `   - 负责范围 (Modify): ${ownedScope.join(", ")}`,
    `   - 严禁触碰 (Do Not Touch): ${item.handoff.scope.doNotTouch.join(", ") || "无"}`,
    `   - 独立工作区 (Worktree): ${member.worktreePath} (baseSha: ${member.baseSha})`,
    `4. 已查引用 (Investigated Refs): ${item.handoff.investigatedRefs.join(", ")}`,
    `5. 参考实现 (Reference Impl): ${item.handoff.referenceImpl.join(", ")}`,
    `6. 必跑验证 (Verification Required): ${item.handoff.verificationRequired.join(" && ")}`,
    `---`,
    `当前 WorkItem 专属小队看板摘要:`,
    recentBoard,
    `---`,
    `本次派发指令: ${directive?.trim() || `请按上述范围与完成判据执行 ${member.subtaskId}，完成后回传改动文件、验证结果与 HEAD SHA。`}`,
  ].join("\n");
}

export class WorkService {
  readonly home: string;
  readonly store: WorkStore;
  private registry: SpineRegistry;
  private protocol?: GatewayProtocol;
  private changed: () => void;
  private queues = new Map<string, Promise<unknown>>();

  constructor(home: string, registry: SpineRegistry, protocol?: GatewayProtocol, changed: () => void = () => {}) {
    this.home = home;
    this.store = new WorkStore(home);
    this.registry = registry;
    this.protocol = protocol;
    this.changed = changed;
  }

  private serial<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    const tracked = next.then(() => {}, () => {}).finally(() => {
      if (this.queues.get(key) === tracked) this.queues.delete(key);
    });
    this.queues.set(key, tracked);
    return next;
  }

  resolveAuthority(request: ReactionRequest): DispatchAuthority | undefined {
    const item = this.store.getWorkItem(request.workItemId);
    if (!item || !item.responsibleHostRef) return undefined;
    const member = request.subtaskId
      ? item.squad.find(candidate => candidate.subtaskId === request.subtaskId || candidate.memberId === request.subtaskId)
      : undefined;
    const targetHostRef = member?.hostRef ?? item.responsibleHostRef;
    const targetWorkspace = member?.worktreePath ?? item.workspace;
    return {
      briefRevision: item.brief.revision,
      policyRevision: item.policy.revision,
      responsible: targetHostRef,
      workspace: targetWorkspace,
      resourceVersion: item.handoff.baseSha,
      instructions: [
        `Goal Summary: ${item.brief.goalSummary}`,
        `Allowed Scope: ${item.brief.scope.join(", ")}`,
        `Do Not Touch: ${item.brief.doNotTouch.join(", ") || "none"}`,
        `Done Criteria: ${item.brief.doneCriteria.join("; ")}`,
      ].join("\n"),
      enabled: item.policy.enabled,
      paused: item.policy.paused,
      takeover: item.policy.takeover,
      maxInputBytes: item.policy.maxInputBytes,
      maxAttempts: item.policy.maxAttempts,
    };
  }

  verifyResources(authority: DispatchAuthority): boolean {
    try {
      return path.isAbsolute(authority.workspace) && fs.existsSync(authority.workspace) && fs.statSync(authority.workspace).isDirectory();
    } catch {
      return false;
    }
  }

  listGoals() {
    return { goals: this.store.listGoals() };
  }

  listSharedWork(params: Record<string, unknown>) {
    const goalId = params.goalId === undefined ? undefined : workId(params.goalId, "goalId");
    const offset = params.offset ?? 0, limit = params.limit ?? 12;
    if (!Number.isSafeInteger(offset) || Number(offset) < 0 || !Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 20) throw new Error("Invalid work page.");
    const all = this.store.listGeneralWorkItems({ goalId });
    const items: typeof all = [];
    for (const item of all.slice(Number(offset), Number(offset) + Number(limit))) {
      if (items.length && Buffer.byteLength(JSON.stringify([...items, item])) > 180 * 1024) break;
      items.push(item);
    }
    const nextOffset = Number(offset) + items.length;
    const ids = new Set(items.map(item => item.goalId));
    return { goals: this.store.listGoals().filter(goal => ids.has(goal.id)), items, total: all.length, nextOffset: nextOffset < all.length ? nextOffset : null };
  }

  upsertSharedWork(params: Record<string, unknown>) {
    const id = params.id === undefined ? `work-${randomUUID().slice(0, 8)}` : workId(params.id, "work.id");
    if (!Number.isSafeInteger(params.expectedRevision) || Number(params.expectedRevision) < 0) throw new Error("expectedRevision is required (0 when creating work).");
    const expectedRevision = Number(params.expectedRevision);
    const existing = this.store.getGeneralWorkItem(id);
    const goalId = workId(params.goalId ?? existing?.goalId, "goalId");
    if (!this.store.getGoal(goalId)) throw new Error(`Unknown goal "${goalId}".`);
    if (existing && existing.goalId !== goalId) throw new Error("Moving work to another goal requires an explicit move operation.");
    const now = new Date().toISOString();
    const record = parseGeneralWorkItem({
      ...existing, ...params, schemaVersion: 1, kind: "general", id, goalId, revision: expectedRevision + 1,
      title: params.title ?? existing?.title, userIntent: params.userIntent ?? existing?.userIntent,
      status: params.status ?? existing?.status ?? "draft", context: params.context ?? existing?.context ?? [],
      openQuestions: params.openQuestions ?? existing?.openQuestions ?? [], doneCriteria: params.doneCriteria ?? existing?.doneCriteria ?? [],
      createdAt: existing?.createdAt ?? now, updatedAt: now,
    }, id);
    const saved = this.store.saveGeneralWorkItem(record, expectedRevision);
    this.changed();
    return { workItem: saved };
  }

  readWorkContext(params: Record<string, unknown>) {
    const id = workId(params.id, "work.id"), item = this.store.getGeneralWorkItem(id);
    if (!item) throw new Error(`Unknown general work "${id}".`);
    const goal = this.store.getGoal(item.goalId);
    if (!goal) throw new Error(`Unknown goal "${item.goalId}".`);
    return { goal, workItem: item, continuation: {
      workItemId: item.id, revision: item.revision, userIntent: item.userIntent, outcome: item.outcome,
      status: item.status, progress: item.progress, expectedOutput: item.expectedOutput, doneCriteria: item.doneCriteria,
      adopted: item.context.filter(entry => entry.state === "adopted"),
      candidates: item.context.filter(entry => entry.state === "candidate"),
      references: item.context.filter(entry => entry.state === "reference"),
      openQuestions: item.openQuestions, nextStep: item.nextStep, decision: item.decision,
    } };
  }

  upsertGoal(params: Record<string, unknown>) {
    const id = typeof params.id === "string" && params.id.trim() ? params.id.trim() : `goal-${randomUUID().slice(0, 8)}`;
    const existing = this.store.getGoal(id);
    const expectedRevision = typeof params.expectedRevision === "number" ? params.expectedRevision : (existing?.revision ?? 0);
    const now = new Date().toISOString();
    const next = parseGoalRecord({
      schemaVersion: 1,
      id,
      revision: expectedRevision + 1,
      title: params.title ?? existing?.title,
      summary: params.summary ?? existing?.summary ?? params.title,
      status: params.status ?? existing?.status ?? "active",
      supervisorThreadId: params.supervisorThreadId !== undefined ? params.supervisorThreadId : (existing?.supervisorThreadId ?? null),
      repositories: params.repositories ?? existing?.repositories ?? [],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }, id);
    const saved = this.store.saveGoal(next, expectedRevision);
    this.changed();
    return { goal: saved };
  }

  listWorkItems(params: Record<string, unknown> = {}) {
    const goalId = typeof params.goalId === "string" && params.goalId.trim() ? params.goalId.trim() : undefined;
    const status = typeof params.status === "string" && params.status.trim() ? params.status.trim() : undefined;
    const threadId = typeof params.threadId === "string" && params.threadId.trim() ? params.threadId.trim() : undefined;
    const goals = this.store.listGoals();
    const items = this.store.listWorkItems({ goalId, status });

    let activeWorkItemId: string | null = null;
    if (threadId) {
      const matched = items.find(item =>
        item.integratorThreadId === threadId ||
        item.supervisorThreadId === threadId ||
        item.responsibleHostRef?.threadId === threadId ||
        item.squad.some(member => member.threadId === threadId || member.hostRef?.threadId === threadId)
      );
      if (matched) activeWorkItemId = matched.id;
    }
    if (!activeWorkItemId && items.length > 0) {
      activeWorkItemId = items[0].id;
    }
    return { goals, items, activeWorkItemId };
  }

  getWorkItem(params: Record<string, unknown>) {
    const id = typeof params.id === "string" ? params.id.trim() : "";
    if (!id) throw new Error("WorkItem id is required.");
    const item = this.store.getWorkItem(id);
    if (!item) throw new Error(`Unknown WorkItem "${id}".`);
    const goal = this.store.getGoal(item.goalId) ?? null;
    return { workItem: item, goal };
  }

  upsertWorkItem(params: Record<string, unknown>) {
    const id = typeof params.id === "string" && params.id.trim() ? params.id.trim() : `wi-${randomUUID().slice(0, 8)}`;
    const existing = this.store.getWorkItem(id);
    const expectedRevision = typeof params.expectedRevision === "number" ? params.expectedRevision : (existing?.revision ?? 0);
    const now = new Date().toISOString();

    const workspace = typeof params.workspace === "string" && params.workspace.trim()
      ? params.workspace.trim()
      : (existing?.workspace ?? "");
    const handoff = validateHandoffContract(params.handoff ?? existing?.handoff);
    const rawSquad = Array.isArray(params.squad) ? params.squad : (existing?.squad ?? []);
    const preparedSquad = rawSquad.map(raw => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
      const entry = { ...(raw as Record<string, unknown>) };
      if (!entry.worktreePath && workspace) {
        const role = String(entry.role ?? "implementer");
        const policy = String(entry.writePolicy ?? (role === "implementer" ? "worktree_isolated" : role === "integrator" ? "integration_merge" : "read_only"));
        const rawId = String(entry.memberId ?? "member").replace(/^@/, "").replace(/[^A-Za-z0-9_-]/g, "-");
        const branch = typeof entry.branch === "string" && entry.branch.trim() && entry.branch !== "HEAD"
          ? entry.branch.trim()
          : `codex/squad/${id}/${rawId}`;
        entry.branch = branch;
        if (role === "implementer" && policy === "worktree_isolated" && isGitWorktree(workspace)) {
          ensureGitExclude(workspace, ".mycodex-worktrees/");
          const wtDir = path.join(workspace, ".mycodex-worktrees", id, rawId);
          fs.mkdirSync(path.dirname(wtDir), { recursive: true, mode: 0o700 });
          if (!isGitWorktree(wtDir)) {
            const addRes = runGit(workspace, ["worktree", "add", "--force", "-B", branch, wtDir, handoff.baseSha]);
            if (!addRes.ok) {
              throw new Error(`Failed to create Git worktree for ${String(entry.memberId)}: ${addRes.stderr || addRes.stdout}`);
            }
          }
          entry.worktreePath = wtDir;
        } else {
          entry.worktreePath = workspace;
        }
      }
      return entry;
    });
    const squad = preparedSquad.map(member => validateSquadMember(member, handoff.baseSha));
    validateSquadWorktrees(squad, handoff.baseSha);

    const goalId = typeof params.goalId === "string" && params.goalId.trim()
      ? params.goalId.trim()
      : (existing?.goalId ?? "goal-default");
    if (!this.store.getGoal(goalId)) {
      this.store.saveGoal({
        schemaVersion: 1,
        id: goalId,
        revision: 1,
        title: typeof params.goalTitle === "string" && params.goalTitle.trim() ? params.goalTitle.trim() : String(params.title ?? "默认目标"),
        summary: handoff.hqJudgment.desiredOutcome,
        status: "active",
        supervisorThreadId: typeof params.supervisorThreadId === "string" ? params.supervisorThreadId : null,
        repositories: typeof params.repository === "string" ? [params.repository] : [],
        createdAt: now,
        updatedAt: now,
      }, 0);
    }

    const board: SquadBoardEntry[] = Array.isArray(params.board)
      ? (params.board as SquadBoardEntry[])
      : (existing?.board ? [...existing.board] : []);
    if (!existing && board.length === 0) {
      board.push({
        id: `board-${randomUUID().slice(0, 8)}`,
        at: now,
        kind: "dispatch",
        memberId: "@supervisor",
        role: "supervisor",
        title: `立项拆解：${String(params.title ?? id)}`,
        summary: `已冻结 Handoff 6 要素契约与共同基线 ${handoff.baseSha}，分配 ${squad.length} 名小队成员准备执行。`,
        threadId: typeof params.supervisorThreadId === "string" ? params.supervisorThreadId : null,
        turnId: null,
        subtaskId: null,
        worktreePath: typeof params.workspace === "string" ? params.workspace : null,
        branch: "HEAD",
        baseSha: handoff.baseSha,
        headSha: handoff.baseSha,
        changedFiles: [],
        verificationPassed: null,
        spilloverId: null,
        draftPrompt: null,
      });
    }

    const record = parseWorkItemRecord({
      schemaVersion: 1,
      id,
      revision: expectedRevision + 1,
      goalId,
      title: params.title ?? existing?.title,
      repository: params.repository ?? existing?.repository ?? "MyCodex",
      workspace: params.workspace ?? existing?.workspace,
      status: params.status ?? existing?.status ?? "ready",
      reason: params.reason !== undefined ? params.reason : (existing?.reason ?? null),
      supervisorThreadId: params.supervisorThreadId !== undefined ? params.supervisorThreadId : (existing?.supervisorThreadId ?? null),
      integratorThreadId: params.integratorThreadId !== undefined ? params.integratorThreadId : (existing?.integratorThreadId ?? null),
      responsibleHostRef: params.responsibleHostRef !== undefined ? params.responsibleHostRef : (existing?.responsibleHostRef ?? null),
      brief: params.brief ?? existing?.brief ?? {
        revision: (existing?.brief.revision ?? 0) + 1,
        goalSummary: handoff.hqJudgment.desiredOutcome,
        scope: handoff.scope.modify,
        doNotTouch: handoff.scope.doNotTouch,
        doneCriteria: handoff.hqJudgment.doneCriteria,
        ruledOut: handoff.hqJudgment.ruledOut,
        constraints: [],
        openQuestions: [],
      },
      handoff,
      policy: params.policy ?? existing?.policy ?? {
        revision: 1,
        enabled: true,
        paused: false,
        takeover: false,
        maxInputBytes: 16384,
        maxAttempts: 2,
      },
      squad,
      board,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }, id);

    const saved = this.store.saveWorkItem(record, expectedRevision);
    this.changed();
    return { workItem: saved };
  }

  async dispatchSquad(params: Record<string, unknown>) {
    const workItemId = typeof params.workItemId === "string" ? params.workItemId.trim() : "";
    if (!workItemId) throw new Error("workItemId is required for squad dispatch.");
    if (this.store.getGeneralWorkItem(workItemId)) throw new Error("General work has no code execution binding; Git squad dispatch was not started.");
    const directive = typeof params.directive === "string" ? params.directive.trim() : undefined;
    const requestedIds = Array.isArray(params.memberIds)
      ? params.memberIds.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      : undefined;

    return this.serial(workItemId, async () => {
      let current = this.store.getWorkItem(workItemId);
      if (!current) throw new Error(`Unknown WorkItem "${workItemId}".`);
      if (!current.policy.enabled || current.policy.paused || current.policy.takeover) {
        throw new Error("WorkItem policy is disabled, paused or in manual takeover mode.");
      }

      validateHandoffContract(current.handoff);
      validateSquadWorktrees(current.squad, current.handoff.baseSha);

      const targets = current.squad.filter(member => {
        if (requestedIds && requestedIds.length > 0) return requestedIds.includes(member.memberId);
        return (member.role === "implementer" || member.role === "scout" || member.role === "reviewer") &&
          member.status !== "cooldown_429";
      });
      if (targets.length === 0) {
        throw new Error("No eligible squad members matched for dispatch.");
      }

      const dispatchTime = new Date().toISOString();
      const dispatchEntry: SquadBoardEntry = {
        id: `board-${randomUUID().slice(0, 8)}`,
        at: dispatchTime,
        kind: "dispatch",
        memberId: "@integrator",
        role: "integrator",
        title: `Wave 1 并行派发：${targets.map(member => member.memberId).join(", ")}`,
        summary: directive || `按 Brief rev.${current.brief.revision} 与共同基线 ${current.handoff.baseSha} 启动 ${targets.length} 名队员并行作业。`,
        threadId: current.integratorThreadId,
        turnId: null,
        subtaskId: null,
        worktreePath: current.workspace,
        branch: "HEAD",
        baseSha: current.handoff.baseSha,
        headSha: current.handoff.baseSha,
        changedFiles: [],
        verificationPassed: null,
        spilloverId: null,
        draftPrompt: null,
      };

      const runningIds = new Set(targets.map(member => member.memberId));
      current = this.store.saveWorkItem({
        ...current,
        revision: current.revision + 1,
        status: "in_progress",
        reason: null,
        squad: current.squad.map(member =>
          runningIds.has(member.memberId)
            ? { ...member, status: "running", reason: null, updatedAt: dispatchTime }
            : member
        ),
        board: [...current.board, dispatchEntry].slice(-200),
        updatedAt: dispatchTime,
      }, current.revision);
      this.changed();

      const memberOutcomes = await Promise.all(targets.map(async member => {
        return this.executeSquadMemberTurn(current!, member, directive);
      }));

      const settledAt = new Date().toISOString();
      const updatedSquad = current.squad.map(member => {
        const outcome = memberOutcomes.find(entry => entry.member.memberId === member.memberId);
        return outcome ? outcome.member : member;
      });
      const newBoardEntries = memberOutcomes.map(entry => entry.boardEntry);

      const hasStalled = updatedSquad.some(member => member.status === "needs_attention" && member.reason === "stalled_same_error");
      const hasBoundaryViolation = updatedSquad.some(member => member.status === "needs_attention" && member.reason === "boundary_violation");
      const hasAttention = updatedSquad.some(
        member => member.status === "needs_attention" ||
          (member.status === "cooldown_429" && member.reason !== "handed_off")
      );
      const activeImplementers = updatedSquad.filter(member => member.role === "implementer" && member.writePolicy === "worktree_isolated");
      const allImplementersSettled = activeImplementers.length > 0 && activeImplementers.every(member => member.status === "settled");
      const allNonImplementersSettled = activeImplementers.length === 0 && updatedSquad.length > 0 && updatedSquad.every(member => member.status === "settled");

      const nextStatus = hasStalled || hasBoundaryViolation || hasAttention
        ? "needs_attention"
        : allImplementersSettled
          ? "ready_for_acceptance"
          : allNonImplementersSettled
            ? "done"
          : "in_progress";
      const nextReason = hasStalled
        ? "stalled_same_error"
        : hasBoundaryViolation
          ? "boundary_violation"
          : hasAttention
            ? (updatedSquad.find(member => member.reason)?.reason ?? "member_attention")
            : null;

      current = this.store.saveWorkItem({
        ...current,
        revision: current.revision + 1,
        status: nextStatus,
        reason: nextReason,
        squad: updatedSquad,
        board: [...current.board, ...newBoardEntries].slice(-200),
        updatedAt: settledAt,
      }, current.revision);
      this.changed();
      return { workItem: current, results: memberOutcomes.map(entry => entry.boardEntry) };
    });
  }

  private async executeSquadMemberTurn(item: WorkItemRecord, member: SquadMemberRecord, directive?: string): Promise<{ member: SquadMemberRecord; boardEntry: SquadBoardEntry }> {
    const now = new Date().toISOString();
    if (!this.protocol) {
      const fallbackEntry: SquadBoardEntry = {
        id: `board-${randomUUID().slice(0, 8)}`,
        at: now,
        kind: "attention",
        memberId: member.memberId,
        role: member.role,
        title: `${member.memberId} 执行引擎未就绪`,
        summary: "当前网关未挂载 CLI 协议路由器，无法启动工作区会话。",
        threadId: member.threadId,
        turnId: null,
        subtaskId: member.subtaskId,
        worktreePath: member.worktreePath,
        branch: member.branch,
        baseSha: member.baseSha,
        headSha: member.headSha,
        changedFiles: [],
        verificationPassed: false,
        spilloverId: null,
        draftPrompt: null,
      };
      return {
        member: { ...member, status: "needs_attention", reason: "protocol_unavailable", updatedAt: now },
        boardEntry: fallbackEntry,
      };
    }

    let threadId = member.threadId;
    if (!threadId || !this.protocol.store.threads.has(threadId)) {
      const availableModels = await this.protocol.models();
      const cliModels = availableModels.filter(m => !m.nativeCopilot && !m.nativeProvider);
      const matchedModel = cliModels.find(m => m.id === member.model) ?? cliModels[0] ?? availableModels[0];
      const chosenModel = matchedModel ? matchedModel.id : member.model;
      const modes = matchedModel?.cliApprovalModes ?? ["ask"];
      const desiredMode = member.writePolicy === "read_only"
        ? (modes.includes("read-only") ? "read-only" : "ask")
        : (modes.includes("auto") ? "auto" : "ask");
      const started = await this.protocol.handle("thread/start", {
        model: chosenModel,
        cwd: member.worktreePath,
        cliApprovalMode: desiredMode,
      } as unknown as GatewayParams, internalConnection) as { thread: { id: string } };
      threadId = started.thread.id;
      await this.protocol.handle("thread/name/set", {
        threadId,
        name: `[${member.memberId}] ${item.title}`,
      } as unknown as GatewayParams, internalConnection);
    }

    const prompt = buildSquadMemberPrompt(item, member, directive);
    let turnId: string | null = null;
    let turnStatus = "failed";
    let turnErrorText = "";
    let assistantText = "";

    try {
      const turnResult = await this.protocol.handle("turn/start", {
        threadId,
        input: [{ type: "text", text: prompt, text_elements: [] }],
      } as unknown as GatewayParams, internalConnection) as { turn: { id: string } };
      turnId = turnResult.turn.id;
      const active = this.protocol.active.get(threadId);
      if (active?.done) await active.done;
      const storedThread = this.protocol.store.get(threadId);
      const completedTurn = storedThread.turns.find(candidate => candidate.id === turnId) ?? storedThread.turns.at(-1);
      turnStatus = completedTurn?.status ?? "failed";
      turnErrorText = completedTurn?.error?.message ?? "";
      assistantText = (completedTurn?.items ?? [])
        .filter((entry): entry is { id: string; type: "agentMessage"; text: string; phase: string } => entry.type === "agentMessage")
        .map(entry => entry.text)
        .join("\n")
        .trim();
    } catch (cause) {
      turnStatus = "failed";
      turnErrorText = cause instanceof Error ? cause.message : String(cause);
    }

    const combinedOutput = [assistantText, turnErrorText ? `[Error] ${turnErrorText}` : ""].filter(Boolean).join("\n") || "(no output)";
    const pointer = this.registry.logs.save(Buffer.from(combinedOutput, "utf8"), threadId, turnId ?? "turn");
    const { headSha, changedFiles } = inspectWorktreeState(member.worktreePath, member.baseSha);
    const completedAt = new Date().toISOString();

    if (member.writePolicy === "read_only" && changedFiles.length > 0) {
      const draftPrompt = `WorkItem ${item.id} (${item.title}) 的只读队员 ${member.memberId} 在 ${member.worktreePath} 修改了文件：${changedFiles.join(", ")}。请确认是否回滚或调整写入授权。`;
      return {
        member: {
          ...member,
          threadId,
          headSha,
          status: "needs_attention",
          reason: "boundary_violation",
          updatedAt: completedAt,
        },
        boardEntry: {
          id: `board-${randomUUID().slice(0, 8)}`,
          at: completedAt,
          kind: "attention",
          memberId: member.memberId,
          role: member.role,
          title: `🚨 只读越界告警：${member.memberId} 修改了工作区文件`,
          summary: `只读角色 (${member.role}) 不允许写盘，但检测到改动：${changedFiles.join(", ")}`,
          threadId,
          turnId,
          subtaskId: member.subtaskId,
          worktreePath: member.worktreePath,
          branch: member.branch,
          baseSha: member.baseSha,
          headSha,
          changedFiles,
          verificationPassed: false,
          spilloverId: pointer.id,
          draftPrompt,
        },
      };
    }

    const violatedPaths = changedFiles.filter(file =>
      item.handoff.scope.doNotTouch.some(forbidden => matchesBoundaryPath(file, forbidden))
    );
    if (violatedPaths.length > 0) {
      const draftPrompt = `WorkItem ${item.id} (${item.title}) 队员 ${member.memberId} 触碰了禁改边界 doNotTouch 文件：${violatedPaths.join(", ")}（Worktree: ${member.worktreePath}）。请决策是否丢弃该改动或升级契约。`;
      return {
        member: {
          ...member,
          threadId,
          headSha,
          status: "needs_attention",
          reason: "boundary_violation",
          updatedAt: completedAt,
        },
        boardEntry: {
          id: `board-${randomUUID().slice(0, 8)}`,
          at: completedAt,
          kind: "attention",
          memberId: member.memberId,
          role: member.role,
          title: `🚨 禁改边界越界：${member.memberId} 触碰了 doNotTouch`,
          summary: `检测到禁改路径被修改：${violatedPaths.join(", ")}`,
          threadId,
          turnId,
          subtaskId: member.subtaskId,
          worktreePath: member.worktreePath,
          branch: member.branch,
          baseSha: member.baseSha,
          headSha,
          changedFiles,
          verificationPassed: false,
          spilloverId: pointer.id,
          draftPrompt,
        },
      };
    }

    const rateLimited = /\b429\b|rate[_ -]?limit|too many requests|quota exceeded/i.test(combinedOutput);
    if (rateLimited) {
      const cooldownUntil = new Date(Date.now() + 60_000).toISOString();
      const draftPrompt = `WorkItem ${item.id} 队员 ${member.memberId} (${member.label}) 遇到 429 速率限制已进入冷却，建议将独立 Worktree (${member.worktreePath}) 一键 Handoff 给待命队员继续执行。`;
      return {
        member: {
          ...member,
          threadId,
          headSha,
          status: "cooldown_429",
          reason: "rate_limited_429",
          cooldownUntil,
          updatedAt: completedAt,
        },
        boardEntry: {
          id: `board-${randomUUID().slice(0, 8)}`,
          at: completedAt,
          kind: "attention",
          memberId: member.memberId,
          role: member.role,
          title: `⏳ 429 冷却待接力：${member.memberId} (${member.label})`,
          summary: `触发配额或速率限制 (429)，已保留独立 Worktree 现场 (${member.worktreePath})，可一键 Handoff 切换其他引擎续跑。`,
          threadId,
          turnId,
          subtaskId: member.subtaskId,
          worktreePath: member.worktreePath,
          branch: member.branch,
          baseSha: member.baseSha,
          headSha,
          changedFiles,
          verificationPassed: false,
          spilloverId: pointer.id,
          draftPrompt,
        },
      };
    }

    const explicitFailure = turnStatus !== "completed" || /^\[STRIKE_ERROR\]/m.test(assistantText);
    if (explicitFailure) {
      const signature = normalizeErrorSignature(turnErrorText || assistantText || "turn_failed");
      const streak = member.lastErrorSignature === signature ? (member.failureStreak ?? 0) + 1 : 1;
      const isTwoStrike = streak >= 2;
      const reason = isTwoStrike ? "stalled_same_error" : "turn_failed_strike_1";
      const title = isTwoStrike
        ? `🛑 2-Strike 熔断告警：${member.memberId} 连续 ${streak} 次卡在同一错误`
        : `⚠️ 执行异常 (Strike 1/2)：${member.memberId}`;
      const summary = isTwoStrike
        ? `连续 ${streak} 次命中相同错误签名「${signature}」，已自动暂停该队员并请求主会话 (@integrator / 🟡 小鼠头🐭) 介入裁决。`
        : `首次执行未通过：${signature}`;
      const draftPrompt = `【小队熔断升级 · WorkItem ${item.id}】队员 ${member.memberId} 在独立 Worktree (${member.worktreePath}) 连续 ${streak} 次卡在相同错误：\n${signature}\n原始日志指针：${pointer.id}\n请裁决是否调整 Brief 方案或接管处理。`;
      return {
        member: {
          ...member,
          threadId,
          headSha,
          status: "needs_attention",
          reason,
          failureStreak: streak,
          lastErrorSignature: signature,
          updatedAt: completedAt,
        },
        boardEntry: {
          id: `board-${randomUUID().slice(0, 8)}`,
          at: completedAt,
          kind: "attention",
          memberId: member.memberId,
          role: member.role,
          title,
          summary,
          threadId,
          turnId,
          subtaskId: member.subtaskId,
          worktreePath: member.worktreePath,
          branch: member.branch,
          baseSha: member.baseSha,
          headSha,
          changedFiles,
          verificationPassed: false,
          spilloverId: pointer.id,
          draftPrompt,
        },
      };
    }

    let finalHeadSha = headSha;
    if (member.writePolicy === "worktree_isolated" && isGitWorktree(member.worktreePath) && changedFiles.length > 0) {
      const dirty = runGit(member.worktreePath, ["status", "--porcelain"]);
      if (dirty.ok && dirty.stdout) {
        runGit(member.worktreePath, ["add", "-A"]);
        runGit(member.worktreePath, ["commit", "-m", `feat(${member.subtaskId}): squad handback by ${member.memberId}`]);
      }
      const latestHead = runGit(member.worktreePath, ["rev-parse", "--short=7", "HEAD"]);
      if (latestHead.ok && latestHead.stdout) finalHeadSha = latestHead.stdout;
    }

    const conciseSummary = assistantText.split("\n").filter(Boolean).slice(0, 3).join(" ").slice(0, 360) || "已完成子任务并通过门禁验证。";
    const draftPrompt = `【小队回传 · ${item.title}】队员 ${member.memberId} (${member.label}) 已完成 ${member.subtaskId}：\n- 分支/基线：${member.branch} (${member.baseSha} → ${finalHeadSha})\n- 改动文件：${changedFiles.join(", ") || "无文件改动 (只读勘探)"}\n- 核心结论：${conciseSummary}\n- 原始输出指针：${pointer.id}\n请检阅是否进入 Wave 2 汇总合并。`;
    return {
      member: {
        ...member,
        threadId,
        headSha: finalHeadSha,
        status: "settled",
        reason: null,
        failureStreak: 0,
        lastErrorSignature: null,
        cooldownUntil: null,
        updatedAt: completedAt,
      },
      boardEntry: {
        id: `board-${randomUUID().slice(0, 8)}`,
        at: completedAt,
        kind: "handback",
        memberId: member.memberId,
        role: member.role,
        title: `✅ Handback 回传：${member.memberId} (${member.subtaskId})`,
        summary: conciseSummary,
        threadId,
        turnId,
        subtaskId: member.subtaskId,
        worktreePath: member.worktreePath,
        branch: member.branch,
        baseSha: member.baseSha,
        headSha: finalHeadSha,
        changedFiles,
        verificationPassed: true,
        spilloverId: pointer.id,
        draftPrompt,
      },
    };
  }

  async handoffMember(params: Record<string, unknown>) {
    const workItemId = typeof params.workItemId === "string" ? params.workItemId.trim() : "";
    const fromMemberId = typeof params.fromMemberId === "string" ? params.fromMemberId.trim() : "";
    const toMemberId = typeof params.toMemberId === "string" ? params.toMemberId.trim() : "";
    const note = typeof params.note === "string" ? params.note.trim() : undefined;
    const executeNow = params.executeNow !== false;
    if (!workItemId || !fromMemberId || !toMemberId || fromMemberId === toMemberId) {
      throw new Error("workItemId, fromMemberId and distinct toMemberId are required for handoff.");
    }

    await this.serial(workItemId, async () => {
      const current = this.store.getWorkItem(workItemId);
      if (!current) throw new Error(`Unknown WorkItem "${workItemId}".`);
      const fromMember = current.squad.find(member => member.memberId === fromMemberId);
      if (!fromMember) throw new Error(`Unknown source squad member "${fromMemberId}".`);
      let toMember = current.squad.find(member => member.memberId === toMemberId);
      const now = new Date().toISOString();

      if (!toMember) {
        toMember = validateSquadMember({
          memberId: toMemberId,
          role: fromMember.role,
          label: typeof params.toLabel === "string" ? params.toLabel : toMemberId,
          engine: typeof params.toEngine === "string" ? params.toEngine : fromMember.engine,
          model: typeof params.toModel === "string" ? params.toModel : fromMember.model,
          writePolicy: fromMember.writePolicy,
          worktreePath: fromMember.worktreePath,
          branch: fromMember.branch,
          baseSha: fromMember.baseSha,
          headSha: fromMember.headSha,
          threadId: null,
          hostRef: null,
          subtaskId: fromMember.subtaskId,
          ownedPaths: fromMember.ownedPaths,
          status: "idle",
          reason: null,
          failureStreak: 0,
          lastErrorSignature: null,
          cooldownUntil: null,
          updatedAt: now,
        }, current.handoff.baseSha);
      }

      const updatedSquad = current.squad.map(member => {
        if (member.memberId === fromMemberId) {
          return {
            ...member,
            writePolicy: "read_only" as const,
            status: member.status === "cooldown_429" ? ("cooldown_429" as const) : ("idle" as const),
            reason: "handed_off",
            updatedAt: now,
          };
        }
        if (member.memberId === toMemberId) {
          return {
            ...member,
            role: fromMember.role,
            writePolicy: fromMember.writePolicy,
            worktreePath: fromMember.worktreePath,
            branch: fromMember.branch,
            baseSha: fromMember.baseSha,
            headSha: fromMember.headSha,
            subtaskId: fromMember.subtaskId,
            ownedPaths: fromMember.ownedPaths,
            status: "idle" as const,
            reason: null,
            failureStreak: 0,
            lastErrorSignature: null,
            cooldownUntil: null,
            updatedAt: now,
          };
        }
        return member;
      });
      if (!current.squad.some(member => member.memberId === toMemberId)) {
        updatedSquad.push(toMember);
      }

      validateSquadWorktrees(updatedSquad, current.handoff.baseSha);

      const handoffCard: SquadBoardEntry = {
        id: `board-${randomUUID().slice(0, 8)}`,
        at: now,
        kind: "handoff",
        memberId: toMemberId,
        role: fromMember.role,
        title: `🔄 跨引擎一键接力：${fromMemberId} → ${toMemberId}`,
        summary: note || `已将独立 Worktree (${fromMember.worktreePath})、基线 ${fromMember.baseSha} 与 Brief rev.${current.brief.revision} 交接给 ${toMemberId} 继续执行。`,
        threadId: toMember.threadId,
        turnId: null,
        subtaskId: fromMember.subtaskId,
        worktreePath: fromMember.worktreePath,
        branch: fromMember.branch,
        baseSha: fromMember.baseSha,
        headSha: fromMember.headSha,
        changedFiles: [],
        verificationPassed: null,
        spilloverId: null,
        draftPrompt: `WorkItem ${current.id} 已将子任务 ${fromMember.subtaskId} 从 ${fromMemberId} 接力切换至 ${toMemberId}（复用 Worktree ${fromMember.worktreePath}）。`,
      };

      this.store.saveWorkItem({
        ...current,
        revision: current.revision + 1,
        squad: updatedSquad,
        board: [...current.board, handoffCard].slice(-200),
        updatedAt: now,
      }, current.revision);
      this.changed();
    });

    if (executeNow) {
      return this.dispatchSquad({
        workItemId,
        memberIds: [toMemberId],
        directive: note || `接力 ${fromMemberId} 的未竟工作，沿用当前 Worktree 现场与 Brief 完成剩余任务并验证。`,
      });
    }
    return this.getWorkItem({ id: workItemId });
  }

  async integrateWorkItem(params: Record<string, unknown>) {
    const workItemId = typeof params.workItemId === "string" ? params.workItemId.trim() : "";
    if (!workItemId) throw new Error("workItemId is required for Wave 2 integration.");
    const markDone = params.markDone === true;
    const note = typeof params.note === "string" ? params.note.trim() : undefined;

    return this.serial(workItemId, async () => {
      const current = this.store.getWorkItem(workItemId);
      if (!current) throw new Error(`Unknown WorkItem "${workItemId}".`);

      const settledImplementers = current.squad.filter(
        member => member.role === "implementer" && member.status === "settled"
      );
      const blockingMembers = current.squad.filter(
        member => member.status === "needs_attention"
      );
      if (blockingMembers.length > 0) {
        throw new Error(`Cannot integrate WorkItem "${workItemId}" while squad members need attention: ${blockingMembers.map(member => member.memberId).join(", ")}.`);
      }
      if (settledImplementers.length === 0) {
        throw new Error(`Cannot integrate WorkItem "${workItemId}": no settled implementer branches are ready.`);
      }

      const mergedCommits: string[] = [];
      const aggregatedFiles = new Set<string>();
      let integrationHeadSha = current.handoff.baseSha;

      for (const entry of current.board) {
        if (entry.kind === "handback") {
          for (const file of entry.changedFiles) aggregatedFiles.add(file);
        }
      }

      if (isGitWorktree(current.workspace)) {
        for (const impl of settledImplementers) {
          const state = inspectWorktreeState(impl.worktreePath, impl.baseSha);
          for (const file of state.changedFiles) aggregatedFiles.add(file);
          const sameCommit = Boolean(state.headSha) && (
            state.headSha === current.handoff.baseSha ||
            current.handoff.baseSha.startsWith(state.headSha) ||
            state.headSha.startsWith(current.handoff.baseSha)
          );
          if (state.headSha && !sameCommit) {
            const hasCommit = runGit(current.workspace, ["cat-file", "-e", `${state.headSha}^{commit}`]).ok;
            if (hasCommit) {
              const mergeRes = runGit(current.workspace, ["merge", "--no-edit", state.headSha]);
              if (!mergeRes.ok) {
                runGit(current.workspace, ["merge", "--abort"]);
                throw new Error(`Git merge conflict while integrating ${impl.memberId} (${state.headSha}): ${mergeRes.stderr || mergeRes.stdout}`);
              }
            }
            mergedCommits.push(`${impl.memberId}:${state.headSha}`);
          }
        }
        const headRes = runGit(current.workspace, ["rev-parse", "--short=7", "HEAD"]);
        if (headRes.ok && headRes.stdout) integrationHeadSha = headRes.stdout;
      } else {
        for (const impl of settledImplementers) {
          if (impl.headSha) mergedCommits.push(`${impl.memberId}:${impl.headSha}`);
        }
        integrationHeadSha = settledImplementers.at(-1)?.headSha ?? current.handoff.baseSha;
      }

      const changedFiles = [...aggregatedFiles].sort();
      const violatedPaths = changedFiles.filter(file =>
        current.handoff.scope.doNotTouch.some(forbidden => matchesBoundaryPath(file, forbidden))
      );
      if (violatedPaths.length > 0) {
        throw new Error(`Wave 2 integration rejected: merged changes touched doNotTouch paths (${violatedPaths.join(", ")}).`);
      }

      const now = new Date().toISOString();
      const nextStatus = markDone ? "done" : "ready_for_acceptance";
      const summary = note || `Wave 2 @integrator 已汇总合并 ${settledImplementers.map(member => member.memberId).join(", ")} 的独立 Worktree 改动（${mergedCommits.join(", ") || integrationHeadSha}），共涉及 ${changedFiles.length} 个文件，通过边界与完成判据核验。`;
      const draftPrompt = `【Wave 2 汇总验收 · ${current.title}】\n- 汇总工作项：${current.id} (Brief rev.${current.brief.revision})\n- 合入实现者：${settledImplementers.map(member => `${member.memberId} (${member.branch} @ ${member.headSha ?? member.baseSha})`).join("、")}\n- 集成基线 → HEAD：${current.handoff.baseSha} → ${integrationHeadSha}\n- 改动文件清单：${changedFiles.join(", ") || "无"}\n- 验收状态：${nextStatus}\n请做最终主聊验收确认。`;

      const integrationCard: SquadBoardEntry = {
        id: `board-${randomUUID().slice(0, 8)}`,
        at: now,
        kind: "integration",
        memberId: "@integrator",
        role: "integrator",
        title: `🏁 Wave 2 汇总合并完成 (${current.handoff.baseSha} → ${integrationHeadSha})`,
        summary,
        threadId: current.integratorThreadId,
        turnId: null,
        subtaskId: "wave2-integration",
        worktreePath: current.workspace,
        branch: "HEAD",
        baseSha: current.handoff.baseSha,
        headSha: integrationHeadSha,
        changedFiles,
        verificationPassed: true,
        spilloverId: null,
        draftPrompt,
      };

      const updatedSquad = current.squad.map(member =>
        member.role === "integrator"
          ? { ...member, headSha: integrationHeadSha, status: "settled" as const, reason: null, updatedAt: now }
          : member
      );

      const saved = this.store.saveWorkItem({
        ...current,
        revision: current.revision + 1,
        status: nextStatus,
        reason: null,
        squad: updatedSquad,
        board: [...current.board, integrationCard].slice(-200),
        updatedAt: now,
      }, current.revision);
      this.changed();
      return { workItem: saved, integration: integrationCard };
    });
  }

  async planGoal(params: Record<string, unknown>) {
    const title = typeof params.title === "string" && params.title.trim()
      ? params.title.trim()
      : "新目标：由小鼠头拆解并行小队任务";
    const desiredOutcome = typeof params.desiredOutcome === "string" && params.desiredOutcome.trim()
      ? params.desiredOutcome.trim()
      : (typeof params.summary === "string" && params.summary.trim() ? params.summary.trim() : title);
    const goalId = typeof params.id === "string" && params.id.trim()
      ? params.id.trim()
      : `goal-${randomUUID().slice(0, 8)}`;
    const repoRoot = path.resolve(import.meta.dirname, "..", "..");
    ensureGitExclude(repoRoot, ".mycodex-worktrees/");
    const defaultSandboxRepo = path.join(repoRoot, ".mycodex-worktrees", "workspaces", goalId);
    const workspace = typeof params.workspace === "string" && params.workspace.trim() && path.isAbsolute(params.workspace.trim())
      ? params.workspace.trim()
      : defaultSandboxRepo;

    if (!isGitWorktree(workspace)) {
      fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
      runGit(workspace, ["init", "-b", "main"]);
      runGit(workspace, ["config", "user.name", "MyCodex Supervisor"]);
      runGit(workspace, ["config", "user.email", "supervisor@mycodex.local"]);
      fs.writeFileSync(path.join(workspace, "README.md"), `# ${title}\n\n期望结果：${desiredOutcome}\n`, "utf8");
      fs.writeFileSync(path.join(workspace, "feature-a.js"), `export function runFeatureA() {\n  return "baseline-a";\n}\n`, "utf8");
      fs.writeFileSync(path.join(workspace, "feature-b.js"), `export function runFeatureB() {\n  return "baseline-b";\n}\n`, "utf8");
      fs.writeFileSync(path.join(workspace, "core-guard.js"), `export const CORE_IMMUTABLE = true;\n`, "utf8");
      runGit(workspace, ["add", "-A"]);
      runGit(workspace, ["commit", "-m", `chore(${goalId}): initialize baseline workspace`]);
    }
    ensureGitExclude(workspace, ".mycodex-worktrees/");
    const headRes = runGit(workspace, ["rev-parse", "--short=7", "HEAD"]);
    const baseSha = headRes.ok && headRes.stdout ? headRes.stdout : "0000000";

    let chosenModel = "copilot/gpt-5.6-sol-fast";
    let chosenEngine = "copilot";
    const supervisorThreadId = typeof params.supervisorThreadId === "string" && params.supervisorThreadId.trim()
      ? params.supervisorThreadId.trim()
      : "orbit";
    let plannerSummary = `小鼠头🐭 已将目标「${title}」拆解为 3 个分步工作项（Step 1 侦察定界 → Step 2 双 Worktree 并行开发 → Step 3 Wave 2 合流验收），基线 ${baseSha}。`;

    if (this.protocol) {
      try {
        const available = await this.protocol.models();
        const cliModels = available.filter(m => !m.nativeCopilot && !m.nativeProvider);
        const preferred = cliModels.find(m => /fast|mini|haiku/i.test(m.id)) ?? cliModels[0] ?? available[0];
        if (preferred) {
          chosenModel = preferred.id;
          chosenEngine = preferred.id.split("/")[0] || "copilot";
        }
        if (params.runSupervisorTurn === true) {
          const started = await this.protocol.handle("thread/start", {
            model: chosenModel,
            cwd: workspace,
            cliApprovalMode: "read-only",
          } as unknown as GatewayParams, internalConnection) as { thread: { id: string } };
          await this.protocol.handle("thread/name/set", {
            threadId: started.thread.id,
            name: `[🐭 小鼠头拆活] ${title}`,
          } as unknown as GatewayParams, internalConnection);
          const turnRes = await this.protocol.handle("turn/start", {
            threadId: started.thread.id,
            input: [{
              type: "text",
              text: `你是小鼠头🐭主会话总管。请针对目标「${title}」（期望结果：${desiredOutcome}）给出简洁的 3 步拆解确认（不超过 3 行）：Step 1 @scout 边界侦察、Step 2 @impl-a/@impl-b 双分支并行实现、Step 3 @integrator Wave 2 合流验收。不要调用工具，直接回复拆解摘要。`,
              text_elements: [],
            }],
          } as unknown as GatewayParams, internalConnection) as { turn: { id: string } };
          const active = this.protocol.active.get(started.thread.id);
          if (active?.done) await active.done;
          const stored = this.protocol.store.get(started.thread.id);
          const doneTurn = stored.turns.find(t => t.id === turnRes.turn.id) ?? stored.turns.at(-1);
          const text = (doneTurn?.items ?? [])
            .filter((entry): entry is { id: string; type: "agentMessage"; text: string; phase: string } => entry.type === "agentMessage")
            .map(entry => entry.text)
            .join(" ")
            .trim();
          if (text) plannerSummary = text.slice(0, 280);
        }
      } catch {
        // Keep deterministic 3-step plan if model discovery fails.
      }
    }

    const { goal } = this.upsertGoal({
      id: goalId,
      title,
      summary: plannerSummary,
      status: "active",
      supervisorThreadId,
      repositories: [path.basename(workspace)],
    });

    const step1 = this.upsertWorkItem({
      id: `${goalId}-step-1`,
      goalId: goal.id,
      title: `STEP 01 · 架构侦察与改动边界冻结`,
      repository: path.basename(workspace),
      workspace,
      status: "ready",
      supervisorThreadId,
      handoff: {
        userVerbatimAnchor: desiredOutcome,
        hqJudgment: {
          desiredOutcome: `扫描 ${path.basename(workspace)} 仓库结构，确认 feature-a.js 与 feature-b.js 的无冲突并行改动边界`,
          doneCriteria: [
            `确认基线 commit (${baseSha}) 与核心禁碰文件 core-guard.js`,
            `输出 Step 2 并行实现者的模块切分清单`,
          ],
          ruledOut: [`禁止在侦察阶段修改任何源码文件`],
        },
        scope: {
          modify: [`README.md`],
          doNotTouch: [`core-guard.js`],
        },
        investigatedRefs: [`README.md:1`, `feature-a.js:1`, `feature-b.js:1`],
        referenceImpl: [`core-guard.js:1`],
        baseSha,
        verificationRequired: [`git status --short`],
      },
      squad: [
        {
          memberId: "@scout",
          role: "scout",
          label: "代码侦察兵 · 只读摸底",
          engine: chosenEngine,
          model: chosenModel,
          writePolicy: "read_only",
          worktreePath: workspace,
          branch: "main",
          baseSha,
          subtaskId: "step1-recon",
          ownedPaths: [`README.md`],
          status: "idle",
        },
      ],
    }).workItem;

    const step2 = this.upsertWorkItem({
      id: `${goalId}-step-2`,
      goalId: goal.id,
      title: `STEP 02 · Mode B 双 Worktree 独立分支并行开发`,
      repository: path.basename(workspace),
      workspace,
      status: "ready",
      supervisorThreadId,
      handoff: {
        userVerbatimAnchor: desiredOutcome,
        hqJudgment: {
          desiredOutcome: `由 @impl-a 与 @impl-b 在各自独立 Git Worktree 分支并行实现 feature-a.js 与 feature-b.js 并自动提交 commit`,
          doneCriteria: [
            `@impl-a 在独立 Worktree 分支完成 feature-a.js 增强并提交 commit`,
            `@impl-b 在独立 Worktree 分支完成 feature-b.js 增强并提交 commit`,
            `严禁触碰 core-guard.js 禁改边界`,
          ],
          ruledOut: [`禁止两名实现者共享同一 Worktree 目录`],
        },
        scope: {
          modify: [`feature-a.js`, `feature-b.js`],
          doNotTouch: [`core-guard.js`],
        },
        investigatedRefs: [`feature-a.js:1`, `feature-b.js:1`],
        referenceImpl: [`README.md:1`],
        baseSha,
        verificationRequired: [`git status --short`],
      },
      squad: [
        {
          memberId: "@impl-a",
          role: "implementer",
          label: "并行实现者 A · 负责 feature-a.js",
          engine: chosenEngine,
          model: chosenModel,
          writePolicy: "worktree_isolated",
          branch: `codex/squad/${goalId}-step-2/impl-a`,
          baseSha,
          subtaskId: "step2-feature-a",
          ownedPaths: [`feature-a.js`],
          status: "idle",
        },
        {
          memberId: "@impl-b",
          role: "implementer",
          label: "并行实现者 B · 负责 feature-b.js",
          engine: chosenEngine,
          model: chosenModel,
          writePolicy: "worktree_isolated",
          branch: `codex/squad/${goalId}-step-2/impl-b`,
          baseSha,
          subtaskId: "step2-feature-b",
          ownedPaths: [`feature-b.js`],
          status: "idle",
        },
      ],
    }).workItem;

    const step3 = this.upsertWorkItem({
      id: `${goalId}-step-3`,
      goalId: goal.id,
      title: `STEP 03 · 独立审查与 Wave 2 主分支汇总验收`,
      repository: path.basename(workspace),
      workspace,
      status: "ready",
      supervisorThreadId,
      handoff: {
        userVerbatimAnchor: desiredOutcome,
        hqJudgment: {
          desiredOutcome: `审查并行分支改动合规性，并由 @integrator 将已完成的分支改动合入主工作区完成最终验收`,
          doneCriteria: [
            `@reviewer 核对各分支改动未越界且符合完成判据`,
            `执行 Wave 2 合流并确认主分支 git status 干净`,
          ],
          ruledOut: [`未通过边界核验前不得合入主分支`],
        },
        scope: {
          modify: [`README.md`],
          doNotTouch: [`core-guard.js`],
        },
        investigatedRefs: [`README.md:1`, `feature-a.js:1`, `feature-b.js:1`],
        referenceImpl: [`core-guard.js:1`],
        baseSha,
        verificationRequired: [`git status --short`],
      },
      squad: [
        {
          memberId: "@reviewer",
          role: "reviewer",
          label: "独立审查员 · 边界与质量核验",
          engine: chosenEngine,
          model: chosenModel,
          writePolicy: "read_only",
          worktreePath: workspace,
          branch: "main",
          baseSha,
          subtaskId: "step3-review",
          ownedPaths: [`README.md`],
          status: "idle",
        },
      ],
    }).workItem;

    return {
      goal,
      items: [step1, step2, step3],
      activeWorkItemId: step2.id,
    };
  }
}
