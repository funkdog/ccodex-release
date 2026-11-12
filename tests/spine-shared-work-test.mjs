import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { startGateway } from "../gateway/server.mjs";
import { connectGateway, writeMessage } from "../gateway/ipc.mjs";
import { RpcPeer } from "../gateway/rpc-peer.mjs";
import { WorkService } from "../gateway/spine/work-service.mjs";
import { pathToFileURL } from "node:url";

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mc-shared-work-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const service = new WorkService(home, {});
  service.upsertGoal({ id: "goal-design", title: "改善协作动线", summary: "让人和模型围绕同一份工作继续讨论" });
  return { home, service };
}

function draft(overrides = {}) {
  return {
    id: "work-flow", goalId: "goal-design", expectedRevision: 0,
    title: "梳理从聊天进入工作的动线", userIntent: "先讨论产品设计，不修改代码",
    outcome: "用户知道当前依据、进展和下一步", status: "draft",
    progress: "已明确共同注意力的范围", owner: "小鼠头",
    nextStep: { kind: "discussion", description: "比较两个真实场景", owner: "你与小鼠头" },
    openQuestions: ["何时把讨论中的意图登记为目标？"],
    context: [{ id: "proposal", kind: "result", title: "入口动线草案", summary: "浏览与切换讨论分开", state: "candidate", reference: "chat:design/turn-1" }],
    ...overrides,
  };
}

test("a non-code work item persists and resumes without a repository, synthetic commit or model execution", t => {
  const { home, service } = fixture(t);
  const created = service.upsertSharedWork(draft());
  assert.equal(created.workItem.kind, "general");
  assert.equal(created.workItem.revision, 1);
  assert.equal(Object.hasOwn(created.workItem, "workspace"), false);
  assert.equal(Object.hasOwn(created.workItem, "handoff"), false);
  assert.equal(fs.existsSync(path.join(service.store.workItemsDirectory, "work-flow.general.json")), true);
  assert.deepEqual(service.listWorkItems({}).items, [], "a general record must not break the existing code-only reader");
  assert.equal(fs.existsSync(path.join(home, ".git")), false);
  const resumed = new WorkService(home, {}).readWorkContext({ id: "work-flow" });
  assert.equal(resumed.goal.id, "goal-design");
  assert.equal(resumed.continuation.userIntent, "先讨论产品设计，不修改代码");
  assert.equal(resumed.continuation.candidates[0].id, "proposal");
  assert.deepEqual(resumed.continuation.adopted, []);
  assert.equal(resumed.continuation.nextStep.kind, "discussion");
});

test("adopted context and a changed direction survive reload, and stale writers cannot overwrite them", t => {
  const { home, service } = fixture(t);
  service.upsertSharedWork(draft());
  const saved = service.upsertSharedWork({
    id: "work-flow", expectedRevision: 1,
    context: [{ id: "proposal", kind: "result", title: "入口动线草案", summary: "浏览与切换讨论分开", state: "adopted", reference: "chat:design/turn-2" }],
    progress: "已采纳入口边界，等待场景走查", changeNote: "用户采纳了入口方案",
  });
  assert.equal(saved.workItem.revision, 2);
  assert.throws(() => service.upsertSharedWork({ id: "work-flow", expectedRevision: 1, title: "过时标题" }), /revision conflict/i);
  assert.throws(() => service.upsertSharedWork({ id: "work-flow", title: "隐式覆盖" }), /expectedRevision/);
  const context = new WorkService(home, {}).readWorkContext({ id: "work-flow" });
  assert.equal(context.continuation.adopted[0].reference, "chat:design/turn-2");
  assert.equal(context.continuation.candidates.length, 0);
  assert.equal(context.continuation.progress, "已采纳入口边界，等待场景走查");
});

test("a planning record can be incomplete, while an actionable work item states its output and acceptance criteria", t => {
  const { service } = fixture(t);
  assert.throws(() => service.upsertSharedWork(draft({ status: "ready", nextStep: { kind: "action", description: "开始做", owner: "小鼠头" } })), /output|criteria|产出|判据/i);
  const ready = service.upsertSharedWork(draft({
    status: "ready", expectedOutput: "两段场景走查记录", doneCriteria: ["每段记录用户看见什么、做什么、是否丢失上下文"],
    nextStep: { kind: "action", description: "走查两个非代码目标", owner: "体验走查" },
  }));
  assert.equal(ready.workItem.expectedOutput, "两段场景走查记录");
  assert.throws(() => service.upsertSharedWork({ id: "work-flow", expectedRevision: 1, goalId: "missing-goal" }), /Unknown goal/);
});

test("invalid context is rejected before persisting and general work cannot enter Git squad execution", async t => {
  const { service } = fixture(t);
  assert.throws(() => service.upsertSharedWork(draft({ context: [{ id: "proposal", kind: "result", title: "未溯源", summary: "尚无依据", state: "adopted" }] })), /reference/);
  service.upsertSharedWork(draft());
  await assert.rejects(service.dispatchSquad({ workItemId: "work-flow" }), /code execution|code work|代码/);
  assert.equal(service.readWorkContext({ id: "work-flow" }).workItem.revision, 1);
});

test("the authenticated gateway registers and resumes general work through the same writer", { timeout: 15000 }, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mc-shared-rpc-"));
  const config = { home, endpoint: path.join(home, "s"), token: randomUUID(), generation: "shared-work-test", spine: { mcp: true },
    defaultEngine: "fixture", engines: new Map([["fixture", { models: async () => [], run: async () => { throw new Error("This planning test must never run a model."); } }]]) };
  const gateway = await startGateway(config);
  let socket;
  const peer = new RpcPeer(message => writeMessage(socket, message));
  t.after(async () => { socket?.destroy(); peer.close(); await gateway.close(); fs.rmSync(home, { recursive: true, force: true }); });
  socket = await connectGateway(config, message => peer.receive(message));
  await peer.request("initialize", { clientInfo: { name: "shared-work-test", version: "1" } });
  await peer.request("diy/goals/upsert", { id: "goal-design", title: "改善协作动线" });
  await peer.request("diy/work/record", draft());
  const page = await peer.request("diy/work/shared_list", { limit: 1 });
  assert.equal(page.items[0].id, "work-flow");
  assert.equal(page.goals[0].id, "goal-design");
  assert.equal(page.nextOffset, null);
  const context = await peer.request("diy/work/context", { id: "work-flow" });
  assert.equal(context.continuation.candidates[0].state, "candidate");
  const legacy = await peer.request("diy/work/list", {});
  assert.deepEqual(legacy.items, [], "legacy Git execution must not interpret general records as code bindings");
});

test("general and code work share an identity namespace without overwriting each other's bindings", t => {
  const { home, service } = fixture(t);
  const code = { id: "code-task", title: "代码任务", goalId: "goal-design", repository: "fixture", workspace: home, squad: [], handoff: {
    userVerbatimAnchor: "验证代码记录不被通用工作覆盖", hqJudgment: { desiredOutcome: "保留原执行绑定", doneCriteria: ["原记录保持不变"], ruledOut: [] },
    scope: { modify: ["fixture.mjs"], doNotTouch: [] }, investigatedRefs: ["none_checked"], referenceImpl: ["none_new"], baseSha: "1234567", verificationRequired: ["fixture verification"],
  } };
  service.upsertWorkItem(code);
  assert.throws(() => service.upsertSharedWork(draft({ id: "code-task" })), /kind cannot change/);
  assert.equal(service.getWorkItem({ id: "code-task" }).workItem.workspace, home);
  service.upsertSharedWork(draft());
  assert.throws(() => service.upsertWorkItem({ ...code, id: "work-flow" }), /kind cannot change/);
  assert.equal(service.readWorkContext({ id: "work-flow" }).workItem.userIntent, draft().userIntent);
});

test("companion workbench shows actual work, preserves browsing and drafts, and restores archived goals without synthetic squad progress", { timeout: 30000 }, async () => {
  const runtime = process.env.MYCODEX_TEST_PLAYWRIGHT ?? path.resolve(path.dirname(process.execPath), "../node_modules/playwright/index.mjs");
  const { chromium } = await import(pathToFileURL(runtime).href);
  const browser = await chromium.launch({ executablePath: process.env.MYCODEX_TEST_BROWSER ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    const files = new Set(["bridge/diy/drawer.mjs", "bridge/diy/workbench.mjs", "bridge/diy/work-panel.mjs", "bridge/diy/radar-panel.mjs", "bridge/diy/daily-panel.mjs"]);
    const root = path.resolve(import.meta.dirname, "..");
    await page.route("http://127.0.0.1/**", route => {
      const relative = new URL(route.request().url()).pathname.slice("/__compiled/".length);
      return files.has(relative) ? route.fulfill({ contentType: "text/javascript", body: fs.readFileSync(path.join(root, relative), "utf8") }) : route.fulfill({ contentType: "text/html", body: "<main><h1>隔离工作台组件验收</h1><div contenteditable='true' role='textbox'>原有草稿</div></main>" });
    });
    await page.goto("http://127.0.0.1/");
    await page.evaluate(async () => {
      const { mountWorkbench } = await import("/__compiled/bridge/diy/workbench.mjs");
      globalThis.goals = [{ id: "goal-current", title: "协同体验迭代", summary: "共同依据与持续推进", status: "active", revision: 1 }, { id: "goal-draft", title: "分享内容讨论", summary: "确定听众需求", status: "active", revision: 1 }, { id: "goal-old", title: "旧小队验收样例", summary: "测试", status: "archived", revision: 2 }];
      const work = { kind: "general", id: "work-current", goalId: "goal-current", title: "入口动线与共享上下文", revision: 2, status: "in_progress", userIntent: "在小鼠头持续推进工作", outcome: "", owner: "", progress: "登记已完成，正在走查", nextStep: { kind: "discussion", owner: "用户与小鼠头", description: "确认入口与接续体验" }, decision: null, expectedOutput: "两段场景走查", doneCriteria: ["实际看到记录并可接续"], openQuestions: ["入口是否自然？"], context: [{ id: "basis", kind: "agreement", title: "本轮产品约定", summary: "聊天与工作台共用依据", state: "adopted", reference: "fixture:user-adopted" }, { id: "candidate", kind: "result", title: "动线方案 <script>", summary: "需要实际走查", state: "candidate", reference: "fixture:proposal" }], supervisorThreadId: null };
      globalThis.records = [work, { ...work, id: "work-draft", goalId: "goal-draft", title: "确定分享重点", status: "draft", nextStep: null, expectedOutput: null, context: [], doneCriteria: [], openQuestions: [] }, { ...work, id: "work-old", goalId: "goal-old" }];
      globalThis.calls = []; globalThis.routes = []; globalThis.draftText = "原有草稿";
      const services = { async request(method, params) {
        globalThis.calls.push([method, params]);
        if (method === "diy/work/list") return { goals: globalThis.goals, items: [], activeWorkItemId: null };
        if (method === "diy/work/shared_list") return { items: globalThis.records, nextOffset: null };
        if (method === "diy/radar/list") return { unreadHighCount: 0 };
        if (method === "diy/work/record") { const record = globalThis.records.find(item => item.id === params.id); if (record.revision !== params.expectedRevision) throw new Error("revision conflict"); Object.assign(record, params, { revision: record.revision + 1 }); return { workItem: record }; }
        if (method === "diy/goals/upsert") { const goal = globalThis.goals.find(item => item.id === params.id); if (goal.revision !== params.expectedRevision) throw new Error("revision conflict"); Object.assign(goal, params, { revision: goal.revision + 1 }); return { goal }; }
        throw new Error("Unsupported fixture method");
      }, subscribe() { return () => {}; } };
      const hostActions = { async openThread(id) { globalThis.routes.push(id); }, async injectText(text) { globalThis.draftText += "\n" + text; }, async prefillDraft() { throw new Error("Never replace the current draft"); }, async copyText() {} };
      globalThis.drawer = mountWorkbench({ document, container: document.body, services, hostActions }); globalThis.drawer.open();
    });
    const panel = page.locator('[data-mycodex-drawer] .mc-companion');
    await panel.waitFor();
    assert.equal(await page.locator('[data-mycodex-drawer] .panel').evaluate(node => node.scrollTop), 0);
    assert.equal(await panel.locator('.mc-companion-work-list').count(), 0, "a single work does not repeat the goal switcher");
    assert.equal(await panel.locator('.mc-companion-goals [data-goal]').count(), 2);
    assert.match(await panel.innerText(), /两段场景走查/);
    assert.doesNotMatch(await panel.innerText(), /0\/0|分步工作项|0 名队员|通用工作 \(/);
    await panel.locator('[data-goal="goal-draft"]').click();
    assert.deepEqual(await page.evaluate(() => globalThis.routes), []);
    assert.equal(await page.evaluate(() => globalThis.draftText), "原有草稿");
    await panel.getByRole("button", { name: "继续讨论", exact: true }).click();
    await page.waitForFunction(() => globalThis.draftText.includes("work-draft"));
    assert.match(await page.evaluate(() => globalThis.draftText), /^原有草稿\n/);
    await panel.locator('[data-goal="goal-current"]').click();
    assert.match(await panel.locator('.mc-companion-focus').innerText(), /确定分享重点/);
    await panel.getByRole("button", { name: "成果与依据", exact: true }).click();
    assert.match(await panel.innerText(), /尚未采纳/);
    await panel.getByRole("button", { name: "用于当前工作", exact: true }).click();
    await page.waitForFunction(() => globalThis.records[0].revision === 3);
    const adopted = await page.evaluate(() => globalThis.records[0]);
    assert.equal(adopted.context[1].state, "adopted"); assert.equal(adopted.progress, "登记已完成，正在走查");
    await page.evaluate(() => { globalThis.drawer.close(); globalThis.drawer.open(); });
    await panel.waitFor(); assert.equal(await panel.locator('[data-goal="goal-current"]').getAttribute('aria-pressed'), 'true');
    assert.match(await panel.locator('.mc-companion-focus').innerText(), /确定分享重点/);
    await panel.getByRole("button", { name: "协作", exact: true }).click();
    assert.match(await panel.innerText(), /尚未绑定小队/);
    assert.deepEqual(await page.evaluate(() => globalThis.calls.filter(([method]) => /dispatch|handoff|integrate/.test(method))), []);
    await panel.locator('summary').click();
    await panel.getByRole("button", { name: "恢复到工作目标", exact: true }).click();
    await page.waitForFunction(() => globalThis.goals[2].status === "active");
    assert.equal(await panel.locator('.mc-companion-goals [data-goal]').count(), 3);
    const restore = await page.evaluate(() => globalThis.calls.find(([method]) => method === "diy/goals/upsert"));
    assert.deepEqual(restore[1], { id: "goal-old", expectedRevision: 2, status: "active" });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
