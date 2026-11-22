import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { startGateway } from "../gateway/server.mjs";
import { connectGateway, writeMessage } from "../gateway/ipc.mjs";
import { RpcPeer } from "../gateway/rpc-peer.mjs";
import { validateHandoffContract, validateSquadWorktrees } from "../gateway/spine/work-contracts.mjs";

function git(cwd, args) {
  const res = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "MyCodex Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "MyCodex Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
  assert.equal(res.status, 0, `git ${args.join(" ")} failed: ${res.stderr || res.stdout}`);
  return (res.stdout ?? "").trim();
}

function createGitWorktreeFixture(root) {
  const mainRepo = path.join(root, "repo-main");
  const wt1 = path.join(root, "wt-impl-1");
  const wt2 = path.join(root, "wt-impl-2");
  const wtScout = path.join(root, "wt-scout");
  fs.mkdirSync(mainRepo, { recursive: true, mode: 0o700 });
  git(mainRepo, ["init", "-b", "main"]);
  fs.mkdirSync(path.join(mainRepo, "shared"), { recursive: true });
  fs.mkdirSync(path.join(mainRepo, "src"), { recursive: true });
  fs.writeFileSync(path.join(mainRepo, "shared/contract.ts"), "export const CONTRACT_V = 1;\n");
  fs.writeFileSync(path.join(mainRepo, "src/index.ts"), "export const ready = true;\n");
  git(mainRepo, ["add", "."]);
  git(mainRepo, ["commit", "-m", "chore: wave 0 baseline contract"]);
  const baseSha = git(mainRepo, ["rev-parse", "--short=7", "HEAD"]);
  git(mainRepo, ["worktree", "add", "-b", "codex/impl-1", wt1, "HEAD"]);
  git(mainRepo, ["worktree", "add", "-b", "codex/impl-2", wt2, "HEAD"]);
  git(mainRepo, ["worktree", "add", "--detach", wtScout, "HEAD"]);
  return { mainRepo, wt1, wt2, wtScout, baseSha };
}

test("Handoff 6-element gatekeeper and Mode B worktree isolation reject invalid contracts, /tmp paths and shared writers", t => {
  const tempRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "mc-handoff-gate-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const dirA = path.join(tempRoot, "wt-a");
  const dirB = path.join(tempRoot, "wt-b");
  fs.mkdirSync(dirA, { mode: 0o700 });
  fs.mkdirSync(dirB, { mode: 0o700 });

  const validHandoff = {
    userVerbatimAnchor: "我倾向于模式B，独立Git Worktree 并发，后续由指定工作会话来汇总合并和验收。",
    hqJudgment: {
      desiredOutcome: "按 WorkItem 绑定专属小队并在独立 Git Worktree 中并行实现。",
      doneCriteria: ["1 Worktree = 1 Writer", "Wave 2 由 @integrator 合并验收"],
      ruledOut: ["全局大群聊混杂不同目标", "多个实现者共享同一 Worktree"],
    },
    scope: {
      modify: ["src/module-a.ts", "src/module-b.ts"],
      doNotTouch: ["shared/contract.ts"],
    },
    investigatedRefs: ["gateway/spine/contracts.mts:9"],
    referenceImpl: ["gateway/spine/work-dispatch.mts:35"],
    baseSha: "a1b2c3d",
    verificationRequired: ["node tools/typescript-task.mjs test"],
  };

  assert.equal(validateHandoffContract(validHandoff).baseSha, "a1b2c3d");
  assert.throws(() => validateHandoffContract({ ...validHandoff, investigatedRefs: ["gateway/spine/contracts.mts"] }), /path:line/);
  assert.throws(() => validateHandoffContract({ ...validHandoff, referenceImpl: ["/tmp/scratch-plan.md:12"] }), /cannot reference \/tmp/);
  assert.throws(() => validateHandoffContract({ ...validHandoff, scope: { modify: ["/private/tmp/leak.ts"], doNotTouch: [] } }), /cannot reference \/tmp/);
  assert.throws(() => validateHandoffContract({ ...validHandoff, baseSha: "not-a-sha" }), /baseSha/);

  assert.throws(() => validateSquadWorktrees([
    {
      memberId: "@impl-1", role: "implementer", label: "Codex", engine: "fixture", model: "fixture/model",
      writePolicy: "worktree_isolated", worktreePath: dirA, branch: "codex/impl-1", baseSha: "a1b2c3d",
      headSha: null, threadId: null, hostRef: null, subtaskId: "sub-1", ownedPaths: ["src/module-a.ts"],
      status: "idle", reason: null, failureStreak: 0, lastErrorSignature: null, cooldownUntil: null, updatedAt: new Date().toISOString(),
    },
    {
      memberId: "@impl-2", role: "implementer", label: "Antigravity", engine: "fixture", model: "fixture/model",
      writePolicy: "worktree_isolated", worktreePath: dirA, branch: "codex/impl-2", baseSha: "a1b2c3d",
      headSha: null, threadId: null, hostRef: null, subtaskId: "sub-2", ownedPaths: ["src/module-b.ts"],
      status: "idle", reason: null, failureStreak: 0, lastErrorSignature: null, cooldownUntil: null, updatedAt: new Date().toISOString(),
    },
  ], "a1b2c3d"), /multiple writers/);
});

test("Mode B squad orchestrates parallel isolated Git worktrees, 2-strike circuit breaker, 429 handoff, Wave 2 @integrator merge and MCP tools", { timeout: 25000 }, async t => {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "mc-p3-squad-"));
  const { mainRepo, wt1, wt2, wtScout, baseSha } = createGitWorktreeFixture(home);

  let impl2Mode = "success";
  let activeWriters = 0;
  let maxConcurrentWriters = 0;

  const engine = {
    displayName: "Squad Fixture Engine",
    models: async () => [{ id: "squad-v1", name: "Squad V1", inputModalities: ["text"] }],
    run: async context => {
      activeWriters++;
      maxConcurrentWriters = Math.max(maxConcurrentWriters, activeWriters);
      await new Promise(resolve => setTimeout(resolve, 25));
      try {
        const cwd = fs.realpathSync(context.cwd);
        if (cwd === fs.realpathSync(wt1)) {
          fs.writeFileSync(path.join(wt1, "src/module-a.ts"), "export const moduleA = 'implemented-by-impl-1';\n");
          git(wt1, ["add", "src/module-a.ts"]);
          git(wt1, ["commit", "-m", "feat(impl-1): add module-a"]);
          context.onText("已完成 src/module-a.ts 的独立 Worktree 实现并通过单元自检。");
          return;
        }
        if (cwd === fs.realpathSync(wt2)) {
          if (impl2Mode === "rate_limit_429") {
            throw new Error("HTTP 429 Too Many Requests: rate_limit exceeded for primary engine");
          }
          if (impl2Mode === "same_error") {
            throw new Error("AssertionError: expected schema revision 2 to match fixture contract");
          }
          if (impl2Mode === "touch_forbidden") {
            fs.writeFileSync(path.join(wt2, "shared/contract.ts"), "export const CONTRACT_V = 999;\n");
            context.onText("尝试直接修改 shared/contract.ts");
            return;
          }
          fs.writeFileSync(path.join(wt2, "src/module-b.ts"), "export const moduleB = 'implemented-by-squad-wt2';\n");
          git(wt2, ["add", "src/module-b.ts"]);
          git(wt2, ["commit", "-m", "feat(impl-2): add module-b"]);
          context.onText("已完成 src/module-b.ts 的独立 Worktree 实现并通过门禁验证。");
          return;
        }
        context.onText("只读勘探完成：确认 src/module-a.ts 与 src/module-b.ts 零耦合，可安全并行合入。");
      } finally {
        activeWriters--;
      }
    },
  };

  const config = {
    home,
    endpoint: path.join(home, "gateway.sock"),
    token: randomUUID(),
    generation: "squad-fixture",
    spine: { mcp: true },
    defaultEngine: "fixture",
    engines: new Map([["fixture", engine]]),
  };
  const gateway = await startGateway(config);
  const sockets = [];
  t.after(async () => {
    sockets.forEach(s => s.destroy());
    await gateway.close();
    fs.rmSync(home, { recursive: true, force: true });
  });

  const connect = async () => {
    let socket;
    const peer = new RpcPeer(message => writeMessage(socket, message));
    socket = await connectGateway(config, message => peer.receive(message));
    sockets.push(socket);
    await peer.request("initialize", { clientInfo: { name: "squad-test", version: "1.0" } });
    return peer;
  };

  const peer = await connect();
  const mouseSupervisorThreadId = "01a18068-2e8b-7b10-8337-711dbe634e1b";
  const p3IntegratorThreadId = "01a19c88-1227-7b70-9d56-9284d3461752";

  // 1. Upsert Goal (owned by 🟡 小鼠头🐭 global supervisor) & WorkItem (bound to P3 integrator + dedicated squad)
  const { goal } = await peer.request("diy/goals/upsert", {
    id: "goal-mycodex-p3",
    title: "MyCodex P3 多智能体小队并行架构",
    summary: "由 🟡 小鼠头🐭 顶层统筹拆解，各 WorkItem 绑定独立小队与 Git Worktree 并行开发。",
    supervisorThreadId: mouseSupervisorThreadId,
    repositories: ["MyCodex"],
  });
  assert.equal(goal.id, "goal-mycodex-p3");

  const handoff = {
    userVerbatimAnchor: "我倾向于模式B，独立Git Worktree 并发，后续由指定工作会话来汇总合并和验收。",
    hqJudgment: {
      desiredOutcome: "完成 WorkItem 绑定的小队群聊与独立 Git Worktree 并行执行。",
      doneCriteria: ["src/module-a.ts 与 src/module-b.ts 并行落地", "Wave 2 合并后无冲突且不触碰 shared/contract.ts"],
      ruledOut: ["禁止多实现者共享同一 Worktree"],
    },
    scope: {
      modify: ["src/module-a.ts", "src/module-b.ts"],
      doNotTouch: ["shared/contract.ts"],
    },
    investigatedRefs: ["gateway/spine/contracts.mts:9"],
    referenceImpl: ["gateway/spine/work-dispatch.mts:35"],
    baseSha,
    verificationRequired: ["node tools/typescript-task.mjs test"],
  };

  const { workItem: created } = await peer.request("diy/work/upsert", {
    id: "wi-squad-mode-b",
    goalId: goal.id,
    title: "模式B：独立 Worktree 小队并行与 @integrator 验收",
    repository: "MyCodex",
    workspace: mainRepo,
    supervisorThreadId: mouseSupervisorThreadId,
    integratorThreadId: p3IntegratorThreadId,
    handoff,
    squad: [
      {
        memberId: "@integrator",
        role: "integrator",
        label: "P3 迭代主会话",
        engine: "fixture",
        model: "fixture/squad-v1",
        writePolicy: "integration_merge",
        worktreePath: mainRepo,
        branch: "main",
        baseSha,
        threadId: p3IntegratorThreadId,
        subtaskId: "wave2-merge",
        ownedPaths: ["src/module-a.ts", "src/module-b.ts"],
      },
      {
        memberId: "@impl-1",
        role: "implementer",
        label: "Codex + Copilot",
        engine: "fixture",
        model: "fixture/squad-v1",
        writePolicy: "worktree_isolated",
        worktreePath: wt1,
        branch: "codex/impl-1",
        baseSha,
        subtaskId: "wave1-module-a",
        ownedPaths: ["src/module-a.ts"],
      },
      {
        memberId: "@impl-2",
        role: "implementer",
        label: "Antigravity",
        engine: "fixture",
        model: "fixture/squad-v1",
        writePolicy: "worktree_isolated",
        worktreePath: wt2,
        branch: "codex/impl-2",
        baseSha,
        subtaskId: "wave1-module-b",
        ownedPaths: ["src/module-b.ts"],
      },
      {
        memberId: "@scout",
        role: "scout",
        label: "Gemini CLI",
        engine: "fixture",
        model: "fixture/squad-v1",
        writePolicy: "read_only",
        worktreePath: wtScout,
        branch: "HEAD",
        baseSha,
        subtaskId: "wave1-scout",
        ownedPaths: [],
      },
    ],
  });
  assert.equal(created.id, "wi-squad-mode-b");
  assert.equal(created.squad.length, 4);

  // Context-aware thread matching: passing p3IntegratorThreadId selects wi-squad-mode-b
  const listed = await peer.request("diy/work/list", { threadId: p3IntegratorThreadId });
  assert.equal(listed.activeWorkItemId, "wi-squad-mode-b");

  // 2. Test 2-Strike Escalation circuit breaker on @impl-2
  impl2Mode = "same_error";
  const strike1 = await peer.request("diy/work/dispatch", {
    workItemId: "wi-squad-mode-b",
    memberIds: ["@impl-2"],
  });
  const impl2AfterStrike1 = strike1.workItem.squad.find(m => m.memberId === "@impl-2");
  assert.equal(impl2AfterStrike1.failureStreak, 1);
  assert.equal(impl2AfterStrike1.reason, "turn_failed_strike_1");

  const strike2 = await peer.request("diy/work/dispatch", {
    workItemId: "wi-squad-mode-b",
    memberIds: ["@impl-2"],
  });
  const impl2AfterStrike2 = strike2.workItem.squad.find(m => m.memberId === "@impl-2");
  assert.equal(impl2AfterStrike2.failureStreak, 2);
  assert.equal(impl2AfterStrike2.status, "needs_attention");
  assert.equal(impl2AfterStrike2.reason, "stalled_same_error");
  assert.equal(strike2.workItem.status, "needs_attention");
  assert.equal(strike2.workItem.reason, "stalled_same_error");

  // 3. Test 429 Cooldown & 1-Click Handoff to @impl-backup
  impl2Mode = "rate_limit_429";
  const rateLimited = await peer.request("diy/work/dispatch", {
    workItemId: "wi-squad-mode-b",
    memberIds: ["@impl-2"],
  });
  assert.equal(rateLimited.workItem.squad.find(m => m.memberId === "@impl-2").status, "cooldown_429");

  impl2Mode = "success";
  const handedOff = await peer.request("diy/work/handoff", {
    workItemId: "wi-squad-mode-b",
    fromMemberId: "@impl-2",
    toMemberId: "@impl-backup",
    toLabel: "Claude Code Backup",
    note: "Antigravity 429 冷却，切换备用实现者沿用 wt2 继续完成 module-b",
    executeNow: false,
  });
  assert.equal(handedOff.workItem.squad.find(m => m.memberId === "@impl-2").writePolicy, "read_only");
  assert.equal(handedOff.workItem.squad.find(m => m.memberId === "@impl-backup").worktreePath, wt2);

  // 4. Parallel Wave 1 Dispatch (@impl-1, @impl-backup, @scout)
  maxConcurrentWriters = 0;
  const wave1 = await peer.request("diy/work/dispatch", {
    workItemId: "wi-squad-mode-b",
    directive: "执行 Wave 1 并行开发与只读勘探",
  });
  assert.ok(maxConcurrentWriters >= 2, `Expected parallel squad execution, saw concurrency=${maxConcurrentWriters}`);
  assert.equal(wave1.workItem.status, "ready_for_acceptance");

  const settledImpl1 = wave1.workItem.squad.find(m => m.memberId === "@impl-1");
  const settledBackup = wave1.workItem.squad.find(m => m.memberId === "@impl-backup");
  assert.equal(settledImpl1.status, "settled");
  assert.equal(settledBackup.status, "settled");
  assert.notEqual(settledImpl1.headSha, baseSha);
  assert.notEqual(settledBackup.headSha, baseSha);

  // Verify spillover log pointer from Handback card can be read via diy/logs/read
  const handbackCard = wave1.results.find(entry => entry.memberId === "@impl-1");
  assert.ok(handbackCard.spilloverId);
  assert.deepEqual(handbackCard.changedFiles, ["src/module-a.ts"]);
  const logRead = await peer.request("diy/logs/read", {
    id: handbackCard.spilloverId,
    startLine: 1,
    endLine: 1,
  });
  assert.match(logRead.content, /module-a\.ts/);

  // 5. Wave 2 @integrator Merge & Verification
  const integrated = await peer.request("diy/work/integrate", {
    workItemId: "wi-squad-mode-b",
    markDone: true,
  });
  assert.equal(integrated.workItem.status, "done");
  assert.equal(fs.existsSync(path.join(mainRepo, "src/module-a.ts")), true);
  assert.equal(fs.existsSync(path.join(mainRepo, "src/module-b.ts")), true);
  assert.deepEqual(integrated.integration.changedFiles, ["src/module-a.ts", "src/module-b.ts"]);
});
