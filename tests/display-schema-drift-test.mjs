import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createDisplaySink, projectStoredItemToV2 } from "../gateway/display-projector.mjs";

const ledger = JSON.parse(fs.readFileSync(new URL("../assets/display-coverage-ledger.json", import.meta.url), "utf8"));
const native = process.env.MYCODEX_TEST_NATIVE_CLI ?? (process.platform === "darwin"
  ? "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex" : "codex");

test("projected cards, notifications and approvals validate against the installed experimental schema; new variants fail", { timeout: 30000 }, async t => {
  let Ajv;
  try { ({ default: Ajv } = await import("ajv")); }
  catch (error) {
    if (error.code !== "ERR_MODULE_NOT_FOUND" || !error.message.includes("'ajv'")) throw error;
    if (process.env.MYCODEX_REQUIRE_DISPLAY_SCHEMA === "1") assert.fail("Required Ajv dependency is unavailable; install the pinned development dependencies with npm ci before admission checks.");
    t.skip("Ajv is not installed in this clean checkout; npm ci enables Schema validation, and MYCODEX_REQUIRE_DISPLAY_SCHEMA=1 makes this prerequisite mandatory."); return;
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "display-schema-")); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const generated = spawnSync(native, ["app-server", "generate-json-schema", "--experimental", "--out", directory], {
    env: { ...process.env, CODEX_HOME: directory }, encoding: "utf8", timeout: 20000,
  });
  if (generated.error?.code === "ENOENT") {
    if (process.env.MYCODEX_REQUIRE_DISPLAY_SCHEMA === "1") assert.fail("Required installed Codex schema exporter is unavailable");
    t.skip("Installed Codex unavailable; set MYCODEX_TEST_NATIVE_CLI and MYCODEX_REQUIRE_DISPLAY_SCHEMA=1 in admission checks"); return;
  }
  assert.equal(generated.status, 0, generated.stderr || String(generated.error));
  const read = file => JSON.parse(fs.readFileSync(path.join(directory, file), "utf8"));
  const notification = read("ServerNotification.json"), requestSchema = read("ServerRequest.json"), itemSchema = read("v2/ItemStartedNotification.json");
  assert.deepEqual(itemSchema.definitions.ThreadItem.oneOf.map(s => s.properties.type.enum[0]).sort(), Object.keys(ledger.items).sort(), "Unclassified ThreadItem variants; update the coverage ledger deliberately");
  assert.deepEqual(notification.oneOf.map(s => s.properties.method.enum[0]).sort(), Object.keys(ledger.notifications).sort(), "Unclassified notification variants");
  for (const section of [ledger.items, ledger.notifications]) for (const entry of Object.values(section)) {
    assert(["projected", "unsupported_by_boundary"].includes(entry.status));
    if (entry.status === "unsupported_by_boundary") assert(entry.reason?.length > 15);
  }
  // Formats exported by schemars are structural annotations, not custom validators.
  const formats = {};
  const visit = value => { if (!value || typeof value !== "object") return; if (typeof value.format === "string") formats[value.format] = true; for (const child of Object.values(value)) visit(child); };
  visit(notification); visit(requestSchema);
  const ajv = new Ajv({ strict: false, allErrors: true, formats });
  const validateNotification = ajv.compile(notification), validateRequest = ajv.compile(requestSchema);
  const check = (validator, value) => assert(validator(value), JSON.stringify(validator.errors));
  const turn = { id: "turn", status: "completed", error: null, items: [] }, context = { threadId: "thread", turnId: "turn" }, events = [];
  const display = createDisplaySink({ turn, context, signal: new AbortController().signal, beforeItem() {}, save() {},
    notify: (method, params) => events.push({ method, params }),
    request: async (method, params) => { check(validateRequest, { id: "approval", method, params }); return { decision: "accept" }; } });
  const sink = display.sink;
  sink.thinkingDelta("r", "thought"); sink.thinkingDone("r");
  sink.commandStart({ id: "c", command: "cat a", cwd: "/tmp", actionHint: { type: "read", path: "/tmp/a", name: "a" } });
  await sink.requestCommandApproval({ itemId: "c", command: "cat a", cwd: "/tmp" });
  sink.commandOutputDelta("c", "result"); sink.commandEnd({ id: "c", status: "completed" });
  for (const hint of [{ type: "unknown" }, { type: "search", query: null, path: null }, { type: "listFiles", path: null }]) {
    sink.commandStart({ id: hint.type, command: "fixture", cwd: "/tmp", actionHint: hint }); sink.commandEnd({ id: hint.type, status: "failed" });
  }
  sink.fileChangeStart({ id: "f", changes: [{ path: "/tmp/a", kind: "update", diff: "fixture" }] });
  await sink.requestFileApproval({ itemId: "f" }); sink.fileChangeEnd({ id: "f", status: "completed" });
  sink.mcpStart({ id: "m", server: "server", tool: "tool", arguments: {} }); sink.mcpEnd({ id: "m", status: "completed", result: { content: [{ type: "text", text: "ok" }] } });
  sink.webSearch({ id: "w", query: "query", action: { type: "search", query: "query" } });
  sink.imageView({ id: "i", path: "/tmp/image.png" }); sink.planUpdate({ steps: [{ step: "verify", status: "completed" }] });
  display.finish();
  for (const event of events) check(validateNotification, event);
  for (const item of turn.items) check(validateNotification, { method: "item/completed", params: { ...context, completedAtMs: 1, item: projectStoredItemToV2(item) } });
  const malformed = structuredClone(events.find(event => event.params.item?.type === "commandExecution"));
  delete malformed.params.item.command;
  assert.equal(validateNotification(malformed), false, "The gate must reject missing required fields");
});

test("catalog template drift requires an explicit ledger refresh; Chat has a separate versioned template", () => {
  const bytes = fs.readFileSync(new URL("../assets/catalog-templates.json", import.meta.url));
  const models = JSON.parse(bytes).models;
  assert.equal(createHash("sha256").update(bytes).digest("hex"), ledger.templates.sha256, "Official template text changed; review capabilities and instruction changes before refreshing the ledger");
  assert.deepEqual([...new Set(models.flatMap(model => Object.keys(model)))].sort(), ledger.templates.modelFields);
  assert.deepEqual([...new Set(models.flatMap(model => Object.keys(model.model_messages ?? {})))].sort(), ledger.templates.messageFields);
  const chat = fs.readFileSync(new URL("../assets/chat-instructions.md", import.meta.url), "utf8");
  assert(chat.includes("{{model_name}}")); assert(chat.includes("single assistant text stream"));
  assert.doesNotMatch(chat, /\{\{\s*personality\s*\}\}/, "Current core consumes literal instructions; no obsolete personality slot may escape");
  assert(chat.includes("[app.ts](/abs/path/app.ts:12)"));
  for (const heading of ["## Editing constraints", "## Special user requests", "## Frontend tasks"]) {
    const official = models.find(model => model.slug === "gpt-5.4").model_messages.instructions_template;
    const section = official.slice(official.indexOf(heading)).split(/\n(?=##? )/)[0];
    assert(chat.includes(section.trimEnd()), `Chat must retain the official ${heading} contract`);
  }
  assert(!chat.includes("multi_tool_use.parallel"));
});
