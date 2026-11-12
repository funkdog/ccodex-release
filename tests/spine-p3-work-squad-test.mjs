import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
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

test("isolated Chrome validates P3 WorkItem-bound Squad panel, switcher isolation, prefillDraft, openThread and Handoff", { timeout: 30000 }, async () => {
  const pureSource = fs.readFileSync(path.resolve(import.meta.dirname, "../bridge/diy/work-panel.mts"), "utf8");
  assert.equal(/node:|\bprocess\.|\brequire\(|\b(?:VUn|eLt)\b|[Rr]eact[Ff]iber|app:\/\/|\/Users\//.test(pureSource), false);

  const runtime = process.env.MYCODEX_TEST_PLAYWRIGHT ?? path.resolve(path.dirname(process.execPath), "../node_modules/playwright/index.mjs");
  const { chromium } = await import(pathToFileURL(runtime).href);
  const browser = await chromium.launch({
    executablePath: process.env.MYCODEX_TEST_BROWSER ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  });
  const files = new Set(["bridge/diy/drawer.mjs", "bridge/diy/radar-panel.mjs", "bridge/diy/daily-panel.mjs", "bridge/diy/work-panel.mjs", "bridge/diy/workbench.mjs"]);
  const rootDir = path.resolve(import.meta.dirname, "..");
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
    const errors = [];
    page.on("pageerror", err => errors.push(err.message));
    await page.route("http://127.0.0.1/**", route => {
      const relative = new URL(route.request().url()).pathname.slice("/__compiled/".length);
      if (files.has(relative)) {
        return route.fulfill({ contentType: "text/javascript", body: fs.readFileSync(path.join(rootDir, relative), "utf8") });
      }
      return route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: '<main><section data-composer-input><div role="textbox" contenteditable="true"></div></section></main>',
      });
    });
    await page.goto("http://127.0.0.1/");
    await page.evaluate(async () => {
      const { mountWorkbench } = await import("/__compiled/bridge/diy/workbench.mjs");
      globalThis.uiCalls = [];
      globalThis.workItems = [
        {
          schemaVersion: 1,
          id: "wi-p3-squad",
          revision: 2,
          goalId: "goal-p3",
          title: "WorkItem A · P3 小队并发架构",
          repository: "MyCodex",
          workspace: "/workspace/mycodex",
          status: "ready_for_acceptance",
          reason: null,
          supervisorThreadId: "thread-mouse-hq",
          integratorThreadId: "thread-p3-main",
          responsibleHostRef: null,
          brief: {
            revision: 2,
            goalSummary: "每个 WorkItem 绑定独立小队与 Git Worktree",
            scope: ["gateway/spine/work-service.mts"],
            doNotTouch: ["gateway/protocol.mts"],
            doneCriteria: ["测试全绿"],
            ruledOut: ["全局混聊"],
            constraints: [],
            openQuestions: [],
          },
          handoff: {
            userVerbatimAnchor: "分不同工作到不同小队，模式B独立 Worktree 并发",
            hqJudgment: { desiredOutcome: "按工作项隔离小队", doneCriteria: ["测试全绿"], ruledOut: ["全局混聊"] },
            scope: { modify: ["gateway/spine/work-service.mts"], doNotTouch: ["gateway/protocol.mts"] },
            investigatedRefs: ["gateway/spine/contracts.mts:9"],
            referenceImpl: ["gateway/spine/work-dispatch.mts:35"],
            baseSha: "9f4b2c1",
            verificationRequired: ["node tools/typescript-task.mjs test"],
          },
          policy: { revision: 1, enabled: true, paused: false, takeover: false, maxInputBytes: 16384, maxAttempts: 2 },
          squad: [
            {
              memberId: "@integrator", role: "integrator", label: "P3 主会话", engine: "codex", model: "codex/gpt-5.4",
              writePolicy: "integration_merge", worktreePath: "/workspace/mycodex", branch: "main", baseSha: "9f4b2c1",
              headSha: "9f4b2c1", threadId: "thread-p3-main", hostRef: null, subtaskId: "wave2-merge", ownedPaths: [],
              status: "idle", reason: null, failureStreak: 0, lastErrorSignature: null, cooldownUntil: null, updatedAt: new Date().toISOString(),
            },
            {
              memberId: "@impl-1", role: "implementer", label: "Codex + Copilot", engine: "codex", model: "codex/gpt-5.4",
              writePolicy: "worktree_isolated", worktreePath: "/workspace/wt-impl-1", branch: "codex/impl-1", baseSha: "9f4b2c1",
              headSha: "c7d8e9f", threadId: "thread-impl-1", hostRef: null, subtaskId: "wave1-backend", ownedPaths: ["gateway/spine/work-service.mts"],
              status: "settled", reason: null, failureStreak: 0, lastErrorSignature: null, cooldownUntil: null, updatedAt: new Date().toISOString(),
            },
            {
              memberId: "@impl-2", role: "implementer", label: "Antigravity", engine: "antigravity", model: "antigravity/claude",
              writePolicy: "worktree_isolated", worktreePath: "/workspace/wt-impl-2", branch: "codex/impl-2", baseSha: "9f4b2c1",
              headSha: "9f4b2c1", threadId: "thread-impl-2", hostRef: null, subtaskId: "wave1-ui", ownedPaths: ["bridge/diy/work-panel.mts"],
              status: "cooldown_429", reason: "rate_limited_429", failureStreak: 0, lastErrorSignature: null, cooldownUntil: new Date().toISOString(), updatedAt: new Date().toISOString(),
            },
          ],
          board: [
            {
              id: "b-1", at: new Date().toISOString(), kind: "handback", memberId: "@impl-1", role: "implementer",
              title: "✅ Handback 回传：@impl-1 (wave1-backend)",
              summary: "已完成 WorkService 与独立 Worktree 校验器实现。",
              threadId: "thread-impl-1", turnId: "turn-1", subtaskId: "wave1-backend",
              worktreePath: "/workspace/wt-impl-1", branch: "codex/impl-1", baseSha: "9f4b2c1", headSha: "c7d8e9f",
              changedFiles: ["gateway/spine/work-service.mts"], verificationPassed: true, spilloverId: "log-1",
              draftPrompt: "【小队回传】@impl-1 已完成 wave1-backend，请检阅。",
            },
          ],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        {
          schemaVersion: 1,
          id: "wi-radar-digest",
          revision: 1,
          goalId: "goal-p3",
          title: "WorkItem B · 雷达蒸馏独立小队",
          repository: "AI-Radar",
          workspace: "/workspace/radar",
          status: "in_progress",
          reason: null,
          supervisorThreadId: "thread-mouse-hq",
          integratorThreadId: "thread-radar-main",
          responsibleHostRef: null,
          brief: {
            revision: 1,
            goalSummary: "独立的小队群聊，不与 WorkItem A 混串",
            scope: ["gateway/spine/radar.mts"],
            doNotTouch: [],
            doneCriteria: ["独立看板渲染"],
            ruledOut: [],
            constraints: [],
            openQuestions: [],
          },
          handoff: {
            userVerbatimAnchor: "不同工作分到不同小队",
            hqJudgment: { desiredOutcome: "雷达小队独立运行", doneCriteria: ["独立看板渲染"], ruledOut: [] },
            scope: { modify: ["gateway/spine/radar.mts"], doNotTouch: [] },
            investigatedRefs: ["gateway/spine/radar.mts:1"],
            referenceImpl: ["gateway/spine/daily.mts:1"],
            baseSha: "1122334",
            verificationRequired: ["node tools/typescript-task.mjs test"],
          },
          policy: { revision: 1, enabled: true, paused: false, takeover: false, maxInputBytes: 16384, maxAttempts: 2 },
          squad: [
            {
              memberId: "@scout-radar", role: "scout", label: "Gemini Scout", engine: "gemini", model: "gemini/pro",
              writePolicy: "read_only", worktreePath: "/workspace/radar", branch: "main", baseSha: "1122334",
              headSha: "1122334", threadId: "thread-radar-scout", hostRef: null, subtaskId: "radar-scan", ownedPaths: [],
              status: "running", reason: null, failureStreak: 0, lastErrorSignature: null, cooldownUntil: null, updatedAt: new Date().toISOString(),
            },
          ],
          board: [
            {
              id: "b-radar-1", at: new Date().toISOString(), kind: "progress", memberId: "@scout-radar", role: "scout",
              title: "📡 雷达小队专属进展",
              summary: "此消息仅属于 WorkItem B 的专属小队。",
              threadId: "thread-radar-scout", turnId: null, subtaskId: "radar-scan",
              worktreePath: "/workspace/radar", branch: "main", baseSha: "1122334", headSha: "1122334",
              changedFiles: [], verificationPassed: null, spilloverId: null, draftPrompt: null,
            },
          ],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ];
      const services = {
        subscribe() { return () => {}; },
        async request(method, params) {
          globalThis.uiCalls.push([method, params]);
          if (method === "diy/radar/list") return { configured: true, items: [], topics: [], total: 0, unreadHighCount: 0 };
          if (method === "diy/work/list") return {
            goals: [{ schemaVersion: 1, id: "goal-p3", revision: 1, title: "小鼠头顶层目标", summary: "", status: "active", supervisorThreadId: "thread-mouse-hq", repositories: ["MyCodex"], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
            items: globalThis.workItems,
            activeWorkItemId: "wi-p3-squad",
          };
          if (method === "diy/work/handoff") {
            const item = globalThis.workItems[0];
            item.squad.find(m => m.memberId === params.fromMemberId).status = "settled";
            return { workItem: item };
          }
          if (method === "diy/work/dispatch") return { workItem: globalThis.workItems[0], results: [] };
          if (method === "diy/work/integrate") {
            globalThis.workItems[0].status = "done";
            return { workItem: globalThis.workItems[0] };
          }
          throw new Error("Unexpected method: " + method);
        },
      };
      const hostActions = {
        async openThread(id) { globalThis.uiCalls.push(["openThread", id]); },
        async prefillDraft(text) { globalThis.uiCalls.push(["prefillDraft", text]); },
        async injectText(text) { globalThis.uiCalls.push(["injectText", text]); },
      };
      mountWorkbench({ document, container: document.body, services, hostActions });
    });

    await page.getByRole("button", { name: /✦ MyCodex/ }).click();
    await page.locator('[data-slot="work"]').click();
    await page.getByRole("button", { name: /WorkItem A · P3 小队并发架构/ }).waitFor();

    // Verify Layer 2 & Layer 3 actions on WorkItem A
    await page.getByRole("button", { name: "💬 带入主聊讨论" }).first().click();
    await page.getByRole("button", { name: "→ 进入现场" }).first().click();
    await page.getByRole("button", { name: "🔄 一键 Handoff 接力" }).click();
    await page.getByRole("textbox", { name: "小队派发指令" }).fill("核对边界并补充单测");
    await page.getByRole("button", { name: "🚀 派发小队执行" }).click();
    await page.getByRole("button", { name: "🏁 Wave 2 @integrator 汇总合并" }).click();

    // Switch to WorkItem B and verify strict Squad isolation (1 WorkItem = 1 Dedicated Squad)
    await page.getByRole("button", { name: /WorkItem B · 雷达蒸馏独立小队/ }).click();
    await page.getByRole("heading", { name: "📡 雷达小队专属进展" }).waitFor();
    assert.equal(await page.getByRole("heading", { name: /Handback 回传：@impl-1/ }).count(), 0);

    const calls = await page.evaluate(() => globalThis.uiCalls);
    assert.ok(calls.some(c => c[0] === "prefillDraft" && c[1].includes("@impl-1")));
    assert.ok(calls.some(c => c[0] === "openThread" && c[1] === "thread-p3-main"));
    assert.ok(calls.some(c => c[0] === "diy/work/handoff" && c[1].fromMemberId === "@impl-2"));
    assert.ok(calls.some(c => c[0] === "diy/work/dispatch" && c[1].directive === "核对边界并补充单测"));
    assert.ok(calls.some(c => c[0] === "diy/work/integrate" && c[1].workItemId === "wi-p3-squad"));
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
