import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { MediaStore, extractToolOutput, MAX_MEDIA_BYTES } from "../gateway/media.mjs";
import { GatewayProtocol } from "../gateway/protocol.mjs";
import { ThreadStore } from "../gateway/state.mjs";
import { antigravityEngine } from "../gateway/engines/antigravity.mjs";
import { geminiCliEngine } from "../gateway/engines/gemini-cli.mjs";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN6sAAAAASUVORK5CYII=", "base64");
function fixture(t) { const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "mg-media-")); t.after(() => fs.rmSync(home, { recursive: true, force: true })); return home; }
test("multimodal blocks are removed from tool text before serialization and explicit file outputs are selected conservatively", () => {
  const data = Buffer.concat([png, Buffer.alloc(400000)]).toString("base64");
  const result = extractToolOutput([{ type: "content", content: { type: "image", mimeType: "image/png", data } }, { type: "text", text: "assertion context" }]);
  assert.equal(result.images.length, 1); assert.equal(result.images[0].data, data); assert.ok(result.output.length < 1000); assert.match(result.output, /assertion context/); assert.doesNotMatch(result.output, /iVBOR/);
  assert.equal(extractToolOutput({ savedPath: "/fixture/view.png" }, { toolName: "view_image" }).images.length, 1);
  assert.equal(extractToolOutput("/fixture/view.png", { toolName: "list_files" }).images.length, 0);
  assert.equal(extractToolOutput("Generated image at /fixture/view.png", { toolName: "generate_image" }).images.length, 1);
});
test("private media verifies format/size, refuses symlinks and duplicate output identities, and copies project originals", t => {
  const home = fixture(t), store = new MediaStore(home), thread = randomUUID(), item = randomUUID(), source = path.join(home, "original ü image.png"); fs.writeFileSync(source, png);
  const saved = store.save(thread, item, { kind: "file", path: source }); assert.deepEqual(fs.readFileSync(saved.savedPath), png); assert.equal(fs.statSync(saved.savedPath).mode & 0o777, 0o600); assert.match(saved.result, /^file:\/\//);
  assert.throws(() => store.save(thread, item, { kind: "file", path: source }), /EEXIST/);
  const linked = path.join(home, "linked.png"); fs.symlinkSync(source, linked); assert.throws(() => store.save(thread, randomUUID(), { kind: "file", path: linked }), /regular/);
  assert.throws(() => store.save(thread, randomUUID(), { kind: "blob", mimeType: "image/jpeg", data: png.toString("base64") }), /format/);
  const huge = path.join(home, "huge.png"); const fd = fs.openSync(huge, "w"); fs.ftruncateSync(fd, MAX_MEDIA_BYTES + 1); fs.closeSync(fd); assert.throws(() => store.save(thread, randomUUID(), { kind: "file", path: huge }), /bounded/);
  store.removeThread(thread); assert.equal(fs.existsSync(saved.savedPath), false); assert.deepEqual(fs.readFileSync(source), png);
});
test("imageGeneration streams in the standard protocol, survives summary/restart, and forks retain media after source deletion", async t => {
  const home = fixture(t), data = Buffer.concat([png, Buffer.alloc(300000)]).toString("base64"), events = []; let runs = 0;
  const engine = { adapter: "test", models: async () => [{ id: "fixture" }], forkSession: async () => "fork-" + randomUUID(), deleteSession: async () => {}, run: async ({ onTool, onSession, onText }) => { runs++; onSession("source-session"); onTool({ phase: "start", id: "image", name: "generate_image", input: {} }); onTool({ phase: "end", id: "image", success: true, output: [{ type: "image", mimeType: "image/png", data }] }); onText("done"); } };
  const engines = new Map([["test", engine]]), store = new ThreadStore(path.join(home, "gateway/threads"));
  let protocol = new GatewayProtocol({ home, store, engines, defaultEngine: "test", notify: (method, params) => events.push({ method, params }) });
  t.after(() => protocol.close()); const connection = { initialized: true, send() {}, request: async () => ({ answers: {} }) };
  const { thread } = await protocol.handle("thread/start", { cwd: home }, connection);
  await protocol.handle("turn/start", { threadId: thread.id, input: [{ type: "text", text: "image fixture" }] }, connection); await protocol.active.get(thread.id).done;
  const image = store.get(thread.id).turns[0].items.find(item => item.type === "imageGeneration"); assert.ok(image); assert.equal(image.status, "completed");
  assert.deepEqual(events.filter(event => event.params.item?.id === image.id).map(event => event.method), ["item/started", "item/completed"]);
  assert.ok(fs.statSync(path.join(home, "gateway/threads", thread.id + ".json")).size < 32000);
  const summary = await protocol.handle("thread/turns/list", { threadId: thread.id, itemsView: "summary" }, connection); assert.equal(summary.data[0].items.some(item => item.type === "imageGeneration"), true);
  const { thread: branch } = await protocol.handle("thread/fork", { threadId: thread.id }, connection); assert.equal(runs, 1);
  const forkImage = store.get(branch.id).turns[0].items.find(item => item.type === "imageGeneration"); assert.notEqual(forkImage.savedPath, image.savedPath);
  await protocol.deleteThread(thread.id); assert.equal(fs.existsSync(image.savedPath), false); assert.equal(fs.existsSync(forkImage.savedPath), true);
  await protocol.close(); protocol = new GatewayProtocol({ home, store: new ThreadStore(store.directory), engines, defaultEngine: "test", notify() {} });
  const restored = await protocol.handle("thread/turns/list", { threadId: branch.id }, connection); assert.equal(restored.data[0].items[1].type, "imageGeneration");
});
test("ACP Antigravity and Gemini adapters emit structured image blocks without base64 in tool text", async t => {
  const home = fixture(t); const events = [];
  const antigravity = antigravityEngine({ executable: path.resolve("tests/fixtures/antigravity-acp.mjs"), cliHome: home, harnessPath: "/fixture/harness", env: {}, accountCheck() {}, environment: (env, { cliHome }) => ({ ...env, GEMINI_HOME: cliHome }) });
  await antigravity.run({ cwd: home, model: "gemini-a", prompt: "output-images", signal: new AbortController().signal, onSession() {}, onText() {}, ask: async () => ({ answers: {} }), onTool: event => events.push(event) });
  const gemini = geminiCliEngine({ executable: path.resolve("tests/fixtures/gemini-acp.mjs"), cliHome: home, env: {}, accountCheck() {} });
  await gemini.run({ cwd: home, model: "gemini-fixture", prompt: "output-images", signal: new AbortController().signal, onSession() {}, onText() {}, ask: async () => ({ answers: {} }), onTool: event => events.push(event) });
  const completed = events.filter(event => event.phase === "end"); assert.equal(completed.length, 2); for (const event of completed) { assert.equal(event.images.length, 1); assert.doesNotMatch(event.output, /iVBOR/); assert.match(event.output, /Image output/); }
});
