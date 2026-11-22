import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { projectStoredItemToV2, clipUtf8, boundedJson, displayLimits } from "../gateway/display-projector.mjs";
import { displayFixture } from "./fixtures/display.mjs";
import { ThreadStore } from "../gateway/state.mjs";
import { claudeToolMapping, endToolDisplay, unifiedDiff } from "../gateway/engines/tool-display.mjs";
import { createAcpDisplay } from "../gateway/engines/acp-display.mjs";

test("display lifecycle has authoritative snapshots, honest exit codes and UTF-8 budgets", () => {
  const f = displayFixture();
  f.sink.thinkingDelta("thought", "检查"); f.sink.thinkingDone("thought");
  f.sink.commandStart({ id: "cmd", command: "pwd", cwd: "/tmp" });
  f.sink.commandOutputDelta("cmd", "中".repeat(100000));
  f.sink.commandEnd({ id: "cmd", status: "failed" });
  const commands = f.events.filter(e => e.params.item?.type === "commandExecution");
  assert.equal(commands[0].params.item.aggregatedOutput, null);
  const final = commands.at(-1).params.item;
  assert.equal(final.exitCode, null); assert.equal(final.status, "failed");
  assert(Buffer.byteLength(final.aggregatedOutput) <= displayLimits.output);
  assert(!final.aggregatedOutput.includes("�"));
  assert.equal(f.events.find(e => e.method === "item/commandExecution/outputDelta").params.delta, final.aggregatedOutput);
  assert.equal(clipUtf8("中a", 2), "");
  assert(Buffer.byteLength(JSON.stringify(boundedJson({ value: '\\"'.repeat(100000) }))) <= displayLimits.arguments);
  assert.deepEqual(f.turn.items.map(projectStoredItemToV2), f.events.filter(e => e.method === "item/completed").map(e => e.params.item));
});

test("native approvals fail closed and expose no policy amendments", async () => {
  for (const decision of ["accept", "acceptForSession", "decline", "cancel", ["accept"], { acceptWithExecpolicyAmendment: {} }, null]) {
    let params;
    const f = displayFixture(async (_method, value) => { params = value; return { decision }; });
    f.sink.commandStart({ id: "cmd", command: "pwd", cwd: "/tmp" });
    assert.equal(await f.sink.requestCommandApproval({ itemId: "cmd", command: "pwd", cwd: "/tmp" }), typeof decision === "string" ? decision : "cancel");
    assert.notEqual(params.itemId, "cmd"); assert.equal(typeof params.startedAtMs, "number");
    assert.deepEqual(params.availableDecisions, ["accept", "acceptForSession", "decline", "cancel"]);
    assert.equal(params.proposedExecpolicyAmendment, undefined);
    assert.equal(await f.sink.requestCommandApproval({ itemId: "cmd", command: "different command", cwd: "/tmp" }), "cancel");
    f.controller.abort(); assert.equal(await f.sink.requestCommandApproval({ itemId: "cmd", command: "pwd", cwd: "/tmp" }), "cancel");
  }
});

test("Claude exact tools map structured facts and successful changes without writing the fixture", t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "display-tools-")); t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const file = path.join(cwd, "a.txt"); fs.writeFileSync(file, "old\n");
  const f = displayFixture();
  const cases = [
    ["Read", { file_path: file }, "commandExecution"], ["Grep", { pattern: "old", path: cwd }, "commandExecution"],
    ["Glob", { pattern: "*.txt" }, "commandExecution"], ["LS", {}, "commandExecution"], ["Bash", { command: "pwd" }, "commandExecution"],
    ["Edit", { file_path: file, old_string: "old", new_string: "new" }, "fileChange"],
    ["MultiEdit", { file_path: file, edits: [{ old_string: "old", new_string: "new" }] }, "fileChange"],
    ["Write", { file_path: file, content: "new\n" }, "fileChange"], ["TodoWrite", { todos: [{ content: "verify", status: "in_progress" }] }, "plan"],
    ["WebSearch", { query: "fixture" }, "webSearch"], ["WebFetch", { url: "https://example.test" }, "webSearch"],
    ["mcp__server_with_underscore__inspect", { value: 1 }, "mcpToolCall"],
  ];
  for (const [name, input, type] of cases) {
    const mapping = claudeToolMapping(f.sink, name, name, input, cwd); assert(mapping, name);
    if (mapping.kind !== "web") mapping.start();
    endToolDisplay(f.sink, mapping, name, true, [{ type: "text", text: "result" }]);
    assert.equal(f.events.filter(e => e.method === "item/completed").at(-1).params.item.type, type, name);
  }
  assert.equal(fs.readFileSync(file, "utf8"), "old\n");
  assert(f.events.some(e => e.method === "turn/diff/updated" && e.params.diff.includes("+new")));
  assert.equal(claudeToolMapping(f.sink, "bad", "Edit", { file_path: file, old_string: "absent", new_string: "new" }, cwd), null);
  assert.equal(claudeToolMapping(f.sink, "bad", "Read", {}, cwd), null);
  assert.equal(claudeToolMapping(f.sink, "bad", "WebFetch", { url: "javascript:evil()" }, cwd), null);
  const mcp = f.events.find(e => e.params.item?.type === "mcpToolCall").params.item;
  assert.equal(mcp.server, "server_with_underscore"); assert.equal(mcp.mcpAppUi, null);
});

test("ACP partial updates merge, late diffs map, duplicate terminal events do not duplicate cards", () => {
  const f = displayFixture(), fallback = [], timeline = createAcpDisplay(f.sink, "/tmp", e => fallback.push(e));
  timeline.update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } });
  timeline.update({ sessionUpdate: "plan", entries: [{ content: "work", status: "in_progress" }] });
  timeline.update({ sessionUpdate: "tool_call", toolCallId: "edit", status: "pending" });
  timeline.update({ sessionUpdate: "tool_call_update", toolCallId: "edit", status: "completed", content: [{ type: "diff", path: "a", oldText: "old", newText: "new" }] });
  timeline.update({ sessionUpdate: "tool_call_update", toolCallId: "edit", status: "completed" });
  timeline.update({ sessionUpdate: "tool_call", toolCallId: "unknown", title: "Unrecognized", rawInput: { value: 1 }, status: "completed" });
  assert.deepEqual(f.turn.items.map(projectStoredItemToV2).map(i => i.type), ["reasoning", "plan", "fileChange"]);
  assert.equal(f.events.filter(e => e.method === "item/completed" && e.params.item.type === "fileChange").length, 1);
  assert.deepEqual(fallback.map(e => e.phase), ["start", "end"]);
  assert(unifiedDiff("/tmp/a", "old", "new").diff.includes("\\ No newline at end of file"));
});

test("ACP streams only snapshot suffixes and heals final command output and changed diffs", () => {
  const f = displayFixture(), timeline = createAcpDisplay(f.sink, "/tmp", () => assert.fail("Known tools should be projected"));
  const command = { sessionUpdate: "tool_call", toolCallId: "c", kind: "execute", rawInput: { command: "pwd" }, status: "in_progress" };
  timeline.update(command);
  for (const text of ["first", "first second", "replacement"]) timeline.update({ sessionUpdate: "tool_call_update", toolCallId: "c", content: [{ type: "content", content: { type: "text", text } }] });
  timeline.update({ sessionUpdate: "tool_call_update", toolCallId: "c", status: "completed", content: [{ type: "content", content: { type: "text", text: "final result" } }] });
  assert.deepEqual(f.events.filter(e => e.method === "item/commandExecution/outputDelta").map(e => e.params.delta), ["first", " second"]);
  assert.equal(f.turn.items[0].output, "final result");
  timeline.update({ sessionUpdate: "tool_call", toolCallId: "f", status: "pending", content: [{ type: "diff", path: "new", oldText: null, newText: "preview" }] });
  timeline.update({ sessionUpdate: "tool_call_update", toolCallId: "f", status: "completed", content: [{ type: "diff", path: "new", oldText: null, newText: "actual" }] });
  assert.equal(f.turn.items[1].changes[0].kind, "add");
  assert(f.turn.items[1].changes[0].diff.includes("+actual"));
  assert(!f.turn.items[1].changes[0].diff.includes("+preview"));
});

for (const turnStatus of ["inProgress", "completed"]) test(`unfinished persisted display facts recover without replay under turn status ${turnStatus}`, t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "display-store-")); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const f = displayFixture(); f.sink.commandStart({ id: "cmd", command: "pwd", cwd: directory });
  f.turn.status = turnStatus;
  const id = randomUUID(), store = new ThreadStore(directory);
  const legacy = { id: randomUUID(), type: "dynamicToolCall", namespace: "test", tool: "old", arguments: {}, status: "completed", contentItems: [], success: true, durationMs: null };
  f.turn.items.push(legacy);
  store.save({ schemaVersion: 1, id, engineId: "test", turns: [f.turn], status: { type: "active" } });
  const saved = new ThreadStore(directory).get(id);
  assert.equal(saved.turns[0].status, "failed"); assert.equal(saved.turns[0].items[0].status, "failed");
  assert.equal(projectStoredItemToV2(saved.turns[0].items[0]).exitCode, null);
  assert.deepEqual(projectStoredItemToV2(saved.turns[0].items[1]), legacy);
});
