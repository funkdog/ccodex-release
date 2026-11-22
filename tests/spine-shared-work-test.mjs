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
