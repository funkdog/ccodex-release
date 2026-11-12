import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createNativeSessionController, installNativeSessionHooks } from "../bridge/desktop-native-session.mjs";

test("new drafts display saved approval defaults while creation delegates inheritance to the gateway", () => {
  const c = createNativeSessionController();
  c.setApprovalDefaults([{ id: "copilot/sol", defaultCliApprovalMode: "auto" }, { id: "antigravity/gemini", defaultCliApprovalMode: "deny" }]);
  c.select("mycodex/copilot/sol");
  assert.equal(c.preferences().cliApprovalMode, "auto");
  const intent = c.begin({ clientUserMessageId: "approval-draft", input: [{ type: "text", text: "hello" }] });
  const outgoing = c.outgoing("mcp-request", { hostId: "local", request: { method: "thread/start", params: { model: "mycodex/copilot/sol" } } });
  assert.equal(Object.hasOwn(outgoing.request.params, "cliApprovalMode"), false, "An inherited display value must not become an explicit ask override");
  intent.finish();
  c.configure({ cliApprovalMode: "ask" });
  assert.equal(c.preferences().cliApprovalMode, "ask");
  c.select(null); c.select("mycodex/antigravity/gemini");
  assert.equal(c.preferences().cliApprovalMode, "deny");
  c.remember({ id: "existing", model: "mycodex/copilot/sol", cliApprovalMode: "deny" });
  assert.equal(c.preferences("existing").cliApprovalMode, "deny");
});
import { buildNativeSessionsPatch, mountCurrentNativeSessions, selectHostDraftModel, selectHostSpeed, sameNativeModelSource } from "../bridge/desktop-native-composer.mjs";
import { currentHostContracts } from "../bridge/desktop-current-host-contract.mjs";
import { modelExecutionIdentity } from "../bridge/desktop-execution-model.mjs";

test("native provider model IDs containing slashes retain native ownership rather than becoming CLI engine IDs", () => {
  assert.deepEqual(modelExecutionIdentity("provider/own-model"), { engine: "", source: "native", model: "provider/own-model" });
  assert.equal(sameNativeModelSource("provider/first", "provider/second"), true);
  assert.equal(sameNativeModelSource("provider/first", "mycodex/claude/second"), false);
  assert.equal(sameNativeModelSource("mycodex/codex-copilot/api-aaaaaaaaaaaa--first", "mycodex/codex-copilot/api-bbbbbbbbbbbb--second"), false);
  assert.equal(sameNativeModelSource("mycodex/codex-copilot/api-aaaaaaaaaaaa--first", "mycodex/codex-copilot/api-aaaaaaaaaaaa--second"), true);
});
import { inspectCurrentHost } from "../bridge/desktop-current-host.mjs";
import { startGateway } from "../gateway/server.mjs";
import { AppServerRouter } from "../gateway/router.mjs";
import { RpcPeer } from "../gateway/rpc-peer.mjs";
import { connectGateway, writeMessage } from "../gateway/ipc.mjs";
import { readThreadOwnership } from "../gateway/state.mjs";
import { watchGatewayUi } from "../bridge/desktop-gateway-ui.mjs";

test("host draft selection rejects missing capabilities, rejected choices, stale drafts and unacknowledged changes without retry", async () => {
  let calls = 0;
  const model = "mycodex/copilot/sol", options = [{ model: { model, defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "high" }] } }];
  const picker = { model: "gpt-native", reasoningEffort: "medium", modelOptions: options,
    onSelectModel() { calls++; return false; } };
  const base = { model, effort: "high", current: () => true, read: () => picker, wait: async () => {} };
  await assert.rejects(selectHostDraftModel({ ...base, read: () => null }), /入口暂不可用/);
  await assert.rejects(selectHostDraftModel({ ...base, model: "mycodex/unknown/nope" }), /未出现在/);
  await assert.rejects(selectHostDraftModel({ ...base, effort: "ultra" }), /不支持/); assert.equal(calls, 0);
  await assert.rejects(selectHostDraftModel(base), /拒绝/); assert.equal(calls, 1);
  let current = true;
  const unconfirmed = { ...picker, onSelectModel() { calls++; } };
  await assert.rejects(selectHostDraftModel({ ...base, read: () => unconfirmed, current: () => current, wait: async () => { current = false; } }), /上下文已变化/);
  assert.equal(calls, 2);
  await assert.rejects(selectHostDraftModel({ ...base, read: () => unconfirmed }), /尚未确认/);
  assert.equal(calls, 3, "A timeout must never replay a model selection"); assert.equal(picker.model, "gpt-native");
});

test("a native model without adjustable reasoning can still switch models through the host picker", async () => {
  const target = "mycodex/codex-copilot/api-aaaaaaaaaaaa--gpt-6.1-sol";
  let calls = 0;
  const picker = { model: "mycodex/codex-copilot/api-aaaaaaaaaaaa--gpt-6.2-astra", reasoningEffort: null, reasoningEffortDisabled: true,
    modelOptions: [{ model: { model: target, supportedReasoningEfforts: [] } }],
    onSelectModel(model, effort) { calls++; this.model = model; this.reasoningEffort = effort; return true; } };
  const selected = await selectHostDraftModel({ model: target, effort: null, current: () => true, read: () => picker, wait: async () => {} });
  assert.equal(selected.model, target); assert.equal(calls, 1);
});

test("native speed respects host capability, acknowledgement and chat/model identity without retrying", async () => {
  let calls = 0;
  const picker = { model: "gpt-native", selectedServiceTier: null,
    serviceTierOptions: [{ value: null }, { value: "priority", iconKind: "fast" }],
    onSelectServiceTier(value) { calls++; this.selectedServiceTier = value; } };
  const base = { value: "priority", read: () => picker, current: () => true, wait: async () => {} };
  await selectHostSpeed(base); assert.equal(picker.selectedServiceTier, "priority");
  await selectHostSpeed({ ...base, value: null }); assert.equal(picker.selectedServiceTier, null);
  for (const read of [() => null, () => ({ ...picker, disabled: true }), () => ({ ...picker, serviceTierOptionsLoading: true }),
    () => ({ ...picker, model: "mycodex/copilot/other" }), () => ({ ...picker, serviceTierOptions: [{ value: null }] })])
    await assert.rejects(selectHostSpeed({ ...base, read }), /暂不可用/);
  assert.equal(calls, 2);
  const unconfirmed = { ...picker, onSelectServiceTier() { calls++; } };
  await assert.rejects(selectHostSpeed({ ...base, read: () => unconfirmed }), /尚未确认/);
  assert.equal(calls, 3);
  let current = true;
  await assert.rejects(selectHostSpeed({ ...base, read: () => unconfirmed, current: () => current, wait: async () => { current = false; } }), /已变化/);
  let after = unconfirmed;
  await assert.rejects(selectHostSpeed({ ...base, read: () => after, wait: async () => { after = { ...unconfirmed, model: "gpt-other" }; } }), /已变化/);
  await assert.rejects(selectHostSpeed({ ...base, read: () => ({ ...picker, onSelectServiceTier: () => false }) }), /拒绝/);
  assert.equal(calls, 5, "A rejection, stale context or timeout must never replay a speed selection");
});

test("declared lazy native exports wait without mounting, while missing or wrong exports remain incompatible", async () => {
  const contract = currentHostContracts.findLast(item => item.moduleFormat !== "rspack-cache"), managerName = contract.managerExport ?? "VUn", busName = contract.busExport ?? "eLt";
  class Manager { startConversation() {} setDefaultModelConfig() {} }
  const original = Manager.prototype.startConversation;
  const bus = { dispatchMessage() {}, dispatchHostMessage() {}, subscribe() {} };
  const window = { electronBridge: { getSentryInitOptions: () => ({ appVersion: contract.version }) },
    get document() { assert.fail("Uninitialized exports must not reach the page"); } };
  for (const [managerValue, busValue] of [[undefined, bus], [Manager, undefined], [undefined, undefined]]) {
    assert.equal(await mountCurrentNativeSessions({ window, services: {},
      importModule: async url => url === contract.initialModule ? { [managerName]: managerValue } : { [busName]: busValue } }), "pending");
    assert.equal(Manager.prototype.startConversation, original);
  }
  for (const [managerModule, busModule] of [[{}, { [busName]: bus }], [{ [managerName]: Manager }, {}],
    [{ [managerName]: function wrongInitializer() {} }, { [busName]: bus }], [{ [managerName]: Manager }, { [busName]: {} }]]) {
    await assert.rejects(mountCurrentNativeSessions({ window, services: {},
      importModule: async url => url === contract.initialModule ? managerModule : busModule }), /capabilities differ/);
    assert.equal(Manager.prototype.startConversation, original);
  }
});

test("UI watcher survives temporary endpoint and binding timeouts without retiring other bindings", async () => {
  let updates = 0, checks = 0, waits = 0, healthReports = 0;
  const warnings = [];
  const failures = [new DOMException("endpoint timeout", "TimeoutError"), new DOMException("endpoint timeout", "TimeoutError"),
    new Error("CDP Runtime.evaluate timeout"), new Error("Execution context was destroyed.")];
  await watchGatewayUi({ active: () => updates < 5, assertHost: () => { checks++; },
    update: async () => { const error = failures[updates++]; if (error) throw error; },
    wait: async () => { waits++; }, warn: message => warnings.push(message), onTransient: () => { healthReports++; } });
  assert.equal(updates, 5, "A healthy poll after temporary failure must still run");
  assert.equal(checks, 5, "Every retry must revalidate the app lifetime");
  assert.equal(waits, 4);
  assert.equal(warnings.length, 3, "Repeated identical failures must not flood the log");
  assert.equal(healthReports, 4, "Every failed poll renews degraded health even when duplicate log messages are suppressed");
});

test("UI watcher refuses changed host ownership and unknown UI contracts without retry", async () => {
  for (const ownershipFailure of [true, false]) {
    let calls = 0, waits = 0;
    await assert.rejects(watchGatewayUi({ active: () => true,
      assertHost: () => { if (ownershipFailure) throw new Error("Host lifetime changed"); },
      update: async () => { calls++; throw new Error("Unexpected renderer endpoint."); },
      wait: async () => { waits++; } }), ownershipFailure ? /Host lifetime/ : /Unexpected renderer/);
    assert.equal(calls, ownershipFailure ? 0 : 1);
    assert.equal(waits, 0);
  }
});

test("UI watcher retries a timed-out host identity probe without using an unverified host", async () => {
  let checks = 0, updates = 0, waits = 0;
  await watchGatewayUi({ active: () => checks < 3,
    assertHost() {
      if (++checks === 1) throw Object.assign(new Error("spawnSync /usr/sbin/lsof ETIMEDOUT"),
        { code: "ETIMEDOUT", syscall: "spawnSync /usr/sbin/lsof", path: "/usr/sbin/lsof" });
    }, update: async () => { updates++; }, wait: async () => { waits++; }, warn() {} });
  assert.equal(updates, 2, "No binding or UI operation may run after the failed identity check");
  assert.equal(waits, 2);
  for (const error of [Object.assign(new Error("denied"), { code: "EPERM", path: "/usr/sbin/lsof" }),
    Object.assign(new Error("unrelated timeout"), { code: "ETIMEDOUT", path: "/unknown/program" })]) {
    await assert.rejects(watchGatewayUi({ active: () => true, assertHost() { throw error; },
      update: async () => assert.fail("Unverified host"), wait: async () => assert.fail("Not retryable") }), e => e === error);
  }
});

test("native draft model settings are acknowledged as a local override and never written to native config", async () => {
  const controller = createNativeSessionController();
  const writes = []; let draft = true;
  class Manager {
    hostId = "local"; requestClient = { getThreadPrewarmPolicy: async () => "legacy" };
    async startConversation(options) { return options; }
    async setDefaultModelConfig(...args) { writes.push(args); return { status: "ok" }; }
  }
  const original = Manager.prototype.setDefaultModelConfig;
  const bus = { dispatchMessage() {}, subscribe() { return () => {}; } };
  const hook = installNativeSessionHooks({ Manager, bus, controller, eligible: () => draft,
    configureDraftModel: async (model, effort) => {
      if (!draft) return false;
      if (!model.startsWith("mycodex/")) { controller.select(null); return false; }
      if (effort !== "high") throw new Error("Unsupported draft effort");
      controller.select(model); controller.configure({ reasoningEffort: effort }); return true;
    } });
  const local = new Manager(), remote = new Manager(); remote.hostId = "remote";
  const model = "mycodex/antigravity/gemini";
  assert.deepEqual(await local.setDefaultModelConfig(model, "high", "work"), { status: "okOverridden" });
  assert.equal(writes.length, 0);
  const created = await local.startConversation({ clientUserMessageId: "native-menu", input: [{ type: "text", text: "fixture" }] });
  assert.equal(created.collaborationMode.settings.model, model);
  assert.equal(created.collaborationMode.settings.reasoning_effort, "high");
  await assert.rejects(local.setDefaultModelConfig(model, "ultra"), /Unsupported draft effort/);
  assert.equal(controller.preferences().reasoningEffort, "high"); assert.equal(writes.length, 0);
  await remote.setDefaultModelConfig(model, "high"); assert.equal(writes.length, 1);
  draft = false; await local.setDefaultModelConfig(model, "high"); assert.equal(writes.length, 2);
  draft = true; await local.setDefaultModelConfig("gpt-native", "medium");
  assert.equal(writes.length, 3); assert.equal(controller.selection(), null);
  hook.dispose(); assert.equal(Manager.prototype.setDefaultModelConfig, original);
});

test("a native draft's inherited external selection retains its effort on first send", async () => {
  const controller = createNativeSessionController();
  class Manager {
    hostId = "local"; requestClient = { getThreadPrewarmPolicy: async () => "legacy" };
    async startConversation(options) { return options; }
  }
  const bus = { dispatchMessage() {}, subscribe() { return () => {}; } };
  const hook = installNativeSessionHooks({ Manager, bus, controller, eligible: () => true });
  const created = await new Manager().startConversation({ clientUserMessageId: "inherited-menu", input: [{ type: "text", text: "fixture" }],
    collaborationMode: { mode: "default", settings: { model: "mycodex/antigravity/gemini", reasoning_effort: "high" } } });
  assert.equal(controller.selection(), "mycodex/antigravity/gemini");
  assert.equal(created.skipAutoTitleGeneration, true);
  assert.equal(created.collaborationMode.settings.reasoning_effort, "high");
  hook.dispose();
});

test("empty native workspace hints use the CLI cwd while explicit extra roots remain visible to validation", () => {
  const c = createNativeSessionController(); c.select("mycodex/antigravity/gemini");
  const intent = c.begin({ clientUserMessageId: "workspace-draft", input: [{ type: "text", text: "fixture" }] });
  c.remember({ id: "cli-workspace", model: "mycodex/antigravity/gemini" });
  for (const method of ["thread/start", "turn/start", "thread/resume", "thread/fork"]) {
    const params = { threadId: "cli-workspace", model: "mycodex/antigravity/gemini", cwd: "/project", runtimeWorkspaceRoots: [] };
    const result = c.outgoing("mcp-request", { hostId: "local", request: { method, params } }).request.params;
    assert.equal(Object.hasOwn(result, "runtimeWorkspaceRoots"), false);
    assert.deepEqual(params.runtimeWorkspaceRoots, [], "Caller-owned request is unchanged");
    const extra = { ...params, runtimeWorkspaceRoots: ["/project", "/other"] };
    assert.deepEqual(c.outgoing("mcp-request", { hostId: "local", request: { method, params: extra } }).request.params.runtimeWorkspaceRoots,
      extra.runtimeWorkspaceRoots, "Real extra roots must never be silently discarded");
  }
  const native = { model: "gpt-native", runtimeWorkspaceRoots: [] };
  assert.equal(c.outgoing("mcp-request", { hostId: "local", request: { method: "thread/start", params: native } }).request.params, native);
  intent.finish();
});

test("draft intent is scoped to an explicit native create and never changes config, remote, background or an existing native thread", () => {
  const c = createNativeSessionController(); c.select("mycodex/copilot/model");
  const ordinary = { hostId: "local", request: { method: "thread/start", params: { model: "native" } } };
  assert.equal(c.outgoing("mcp-request", ordinary), ordinary);
  const intent = c.begin({ clientUserMessageId: "draft", input: [{ type: "text", text: "hello" }] });
  assert.equal(intent.options.skipAutoTitleGeneration, true);
  const explicit = { hostId: "local", request: { id: 1, method: "thread/start", params: { model: intent.options.collaborationMode.settings.model, threadSource: "user", sandbox: "workspace-write" } } };
  const cli = c.outgoing("mcp-request", explicit);
  assert.equal(cli.request.params.permissions, ":danger-full-access"); assert.equal(cli.request.params.sandbox, undefined);
  for (const message of [{ ...explicit, hostId: "remote" }, ordinary,
    { hostId: "local", request: { method: "config/batchWrite", params: { edits: [] } } },
    { hostId: "local", request: { method: "turn/start", params: { threadId: "native", model: "native" } } }])
    assert.equal(c.outgoing("mcp-request", message), message);
  assert.equal(c.outgoing("thread-prewarm-start", explicit), explicit);
  c.observe({ type: "mcp-response", hostId: "local", message: { result: { thread: { id: "native", model: "gpt-native" } } } });
  const nativeSend = { hostId: "local", request: { method: "turn/start", params: { threadId: "native", model: "gpt-native" } } };
  assert.equal(c.outgoing("mcp-request", nativeSend), nativeSend);
  assert.throws(() => c.begin({ clientUserMessageId: "draft", input: [{ type: "text", text: "duplicate" }] }), /already/);
  intent.finish(); assert.equal(c.outgoing("mcp-request", explicit), explicit);
  for (const extra of [{ mode: "plan" }, { sideConversation: true }, { attachments: [{}] }, { parentTurnId: "parent" }])
    assert.throws(() => c.begin({ clientUserMessageId: "other", input: [{ type: "text", text: "x" }], ...extra }));
  assert.doesNotThrow(() => new Function(buildNativeSessionsPatch("binding", "response")));
});

test("native OpenAI and native provider requests preserve the user's full-access policy verbatim", () => {
  const c = createNativeSessionController();
  for (const [id, model, modelProvider] of [["openai", "gpt-native", "openai"],
    ["api", "mycodex/codex-copilot/sol", "mycodex-copilot"]]) {
    c.remember({ id, model, modelProvider });
    for (const method of ["turn/start", "turn/addUserMessage", "thread/settings/update", "thread/resume"]) {
      const params = { threadId: id, model, permissions: ":danger-full-access", approvalPolicy: "never", approvalsReviewer: "user" };
      const snapshot = structuredClone(params);
      const result = c.outgoing("mcp-request", { hostId: "local", request: { method, params } });
      for (const key of ["permissions", "approvalPolicy", "approvalsReviewer"])
        assert.deepEqual(result.request.params[key], snapshot[key]);
      assert.deepEqual(params, snapshot, "Caller-owned settings cannot be mutated");
      assert.equal(Object.hasOwn(result.request.params, "cliApprovalMode"), false);
    }
  }
  c.select("mycodex/codex-copilot/sol");
  const intent = c.begin({ clientUserMessageId: "native-api-draft", input: [{ type: "text", text: "fixture" }],
    permissions: ":danger-full-access", permissionSelection: { type: "full-access" }, useAppServerPermissionDefault: false });
  assert.equal(intent.options.permissions, ":danger-full-access");
  assert.deepEqual(intent.options.permissionSelection, { type: "full-access" });
  assert.equal(intent.options.useAppServerPermissionDefault, false);
  intent.finish();
});

test("a pending model change rejects sends until its committed model and preferences are observed", () => {
  const c = createNativeSessionController();
  c.remember({ id: "cli", model: "mycodex/copilot/a", reasoningEffort: "high", cliApprovalMode: "auto" });
  c.setModelSwitchPending("cli", true);
  const send = { hostId: "local", request: { method: "turn/start", params: { threadId: "cli", model: "mycodex/copilot/a" } } };
  assert.throws(() => c.outgoing("mcp-request", send), /模型切换尚未完成/);
  c.observe({ hostId: "local", type: "mcp-notification", params: { thread: {
    id: "cli", model: "mycodex/copilot/b", reasoningEffort: "medium", cliApprovalMode: "auto" } } });
  c.setModelSwitchPending("cli", false);
  const forwarded = c.outgoing("mcp-request", send).request.params;
  assert.equal(forwarded.model, "mycodex/copilot/b"); assert.equal(forwarded.effort, "medium"); assert.equal(forwarded.cliApprovalMode, "auto");
});

test("pinned installed modules still expose the observed native lifecycle and message bus contract", {
  skip: process.platform !== "darwin" || !fs.existsSync("/Applications/ChatGPT.app/Contents/Resources/app.asar"),
}, () => {
  const fd = fs.openSync("/Applications/ChatGPT.app/Contents/Resources/app.asar", "r");
  try {
    const prefix = Buffer.alloc(16); fs.readSync(fd, prefix, 0, 16, 0);
    const size = prefix.readUInt32LE(12), headerSize = prefix.readUInt32LE(4);
    assert.ok(size > 0 && size < 32 * 1024 * 1024);
    const bytes = Buffer.alloc(size); fs.readSync(fd, bytes, 0, size, 16); const header = JSON.parse(bytes);
    const read = relative => { let entry = header; for (const part of relative.split("/")) entry = entry.files[part];
      assert.ok(entry.size < 16 * 1024 * 1024 && !entry.unpacked && !entry.link);
      const result = Buffer.alloc(entry.size); fs.readSync(fd, result, 0, result.length, 8 + headerSize + Number(entry.offset)); return result.toString(); };
    // Check the actual installed tuple first, then the adapter selected for it.
    const host = inspectCurrentHost("/Applications/ChatGPT.app");
    const contract = currentHostContracts.find(item => item.version === host.applicationVersion);
    assert.ok(contract);
    const asset = url => `webview${new URL(url).pathname}`;
    const initial = read(asset(contract.initialModule)), shared = read(asset(contract.sharedModule));
    const exported = (source, name) => {
      const symbol = source.match(new RegExp(`([\\w$]+) as ${name}\\b`))?.[1];
      assert.ok(symbol, `Missing host export ${name}`); return symbol;
    };
    const rspack = contract.moduleFormat === "rspack-cache";
    const manager = rspack ? initial.match(new RegExp(`${contract.managerExport}:\\(\\)=>?([\\w$]+)`))?.[1] : exported(initial, contract.managerExport ?? "VUn");
    assert.ok(manager, "Manager cache export must resolve to a declared class");
    const bus = rspack ? "s" : exported(shared, contract.busExport ?? "eLt");
    const managerStart = initial.indexOf(rspack ? `class ${manager} ` : `${manager}=class`);
    assert.ok(managerStart >= 0, "Manager export must resolve to the manager class");
    const managerBody = initial.slice(managerStart, managerStart + 256000);
    assert.match(managerBody, /async startConversation\(\w+,\w+\)\{return /);
    assert.ok(initial.includes("this.params.requestClient.getThreadPrewarmPolicy?.()"));
    assert.ok(managerBody.includes("setDefaultModelConfig(e,t,n){return this.defaultTurnConfig.writeModel(e,t,n)}"));
    if (rspack) {
      assert.match(initial, /"okOverridden"===\w+\.status/);
      assert.ok(initial.includes("readThreadCreationInputs"));
      assert.ok(shared.includes(`${contract.busExport}:${bus}`));
      assert.match(shared, /\.c=[\w$]+/);
    } else {
      assert.ok(initial.includes("c?.status===`okOverridden`"));
      assert.ok(initial.includes("model:r?.settings.model??null"));
    }
    assert.match(shared, new RegExp(`${bus}=([\\w$]+)\\.getInstance\\(\\)`));
    assert.match(shared, /dispatchMessage\(\w+,\w+\)/); assert.ok(shared.includes("dispatchHostMessage(")); assert.match(shared, /subscribe\(\w+,\w+\)/);
    assert.match(initial, /"data-composer-input":(?:``|"")/);
    assert.match(initial, /if\((?:n\.skipAutoTitleGeneration!==!0|!0!==n\.skipAutoTitleGeneration)\)return [\w$]+\(/);
    const primary = read(asset(contract.primaryModule));
    const workspace = contract.workspaceModule ? read(asset(contract.workspaceModule)) : primary;
    assert.match(workspace, /"data-composer-navigation-target":(?:`workspace-project`|"workspace-project")/);
    if (rspack) assert.ok(primary.includes('"data-composer-navigation-target":"reasoning"'));
    else assert.ok(primary.includes('"data-codex-intelligence-trigger":!0,"data-composer-navigation-target":`reasoning`'));
    if (contract.sessionTransport === "host-rpc") {
      const callback = primary.match(/onSelectModel:([\w$]+)/)?.[1]; assert.ok(callback);
      assert.match(primary, new RegExp(`${callback}=\\(\\w+,\\w+\\)=>\\{\\w+\\(\\w+,\\w+\\)\\}`), "Draft callback must forward model and effort");
    }
  } finally { fs.closeSync(fd); }
});

test("hook lifecycle delegates native/remote/background creates and restores exactly its own methods", async () => {
  const controller = createNativeSessionController(); controller.select("mycodex/copilot/test");
  const calls = [], listeners = new Set(); let eligible = true;
  class Manager { hostId = "local"; async startConversation(options) { calls.push(options); return "native"; } }
  const original = Manager.prototype.startConversation;
  const bus = { dispatchMessage() {}, subscribe(type, listener) { listeners.add(listener); return () => listeners.delete(listener); } };
  const dispatch = bus.dispatchMessage;
  const hook = installNativeSessionHooks({ Manager, bus, controller, eligible: () => eligible });
  const local = new Manager(), remote = new Manager(); remote.hostId = "remote";
  const side = { sideConversation: {}, input: [] }, background = { threadSource: "automation_cron", input: [] };
  assert.equal(await local.startConversation(side), "native");
  assert.equal(await local.startConversation(background), "native");
  assert.equal(await remote.startConversation({ input: [] }), "native");
  eligible = false; assert.throws(() => local.startConversation({ input: [] }), /CLI 草稿接入不可用/);
  controller.select(null); assert.equal(await local.startConversation({ input: [] }), "native");
  assert.equal(calls.length, 4);
  hook.dispose(); assert.equal(Manager.prototype.startConversation, original); assert.equal(bus.dispatchMessage, dispatch); assert.equal(listeners.size, 0);
});

test("CLI creation suppresses native title inference and retains the remaining native lifecycle", async () => {
  const controller = createNativeSessionController(); controller.select("mycodex/copilot/test");
  let titles = 0, settled = 0;
  class Manager {
    hostId = "local";
    requestClient = { getThreadPrewarmPolicy: async () => "legacy" };
    async startConversation(options, lifecycle) {
      assert.equal(options.skipAutoTitleGeneration, true);
      await lifecycle.onFirstTurnReady({ conversationId: "cli" });
      await lifecycle.onSettled({ status: "created" });
      return "created";
    }
  }
  const bus = { dispatchMessage() {}, subscribe() { return () => {}; } };
  const hooks = installNativeSessionHooks({ Manager, bus, controller, eligible: () => true });
  try {
    const result = await new Manager().startConversation({ clientUserMessageId: "draft", input: [{ type: "text", text: "hello" }] },
      { onFirstTurnReady() { titles++; }, onSettled() { settled++; } });
    assert.equal(result, "created"); assert.equal(titles, 0); assert.equal(settled, 1);
  } finally { hooks.dispose(); }
});

test("native-create seam, first send, project sidebar and full gateway restart retain the CLI identity", { timeout: 10000 }, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ns-"));
  const config = { home, endpoint: path.join(home, "s"), token: randomUUID(), generation: "fixture", defaultEngine: "copilot",
    engines: new Map([["copilot", { adapter: "synthetic", models: async () => [{ id: "fixture" }],
      run: async ({ nativeSessionId, onSession, onText }) => { onSession(nativeSessionId || "same-cli-session"); onText("CLI reply"); } }]]) };
  let server = await startGateway(config), router, hooks;
  let nativeTurns = 0, calls = 0;
  const native = () => {
    const peer = new RpcPeer(message => {
      if (message.method?.startsWith("turn/")) nativeTurns++;
      queueMicrotask(() => peer.receive({ id: message.id, result: message.method === "thread/list"
        ? { data: [{ id: "native-existing", name: "native", createdAt: 1 }], nextCursor: null } : {} }));
    }); return peer;
  };
  async function connect() {
    const controller = createNativeSessionController(), handlers = new Map(), pending = new Map(); let seq = 0;
    const bus = {
      subscribe(type, handler) { const set = handlers.get(type) || new Set(); set.add(handler); handlers.set(type, set); return () => set.delete(handler); },
      dispatchHostMessage(message) { for (const handler of handlers.get(message.type) || []) handler(message);
        if (message.type === "mcp-response") { const p = pending.get(message.message.id); pending.delete(message.message.id);
          message.message.error ? p?.reject(new Error(message.message.error.message)) : p?.resolve(message.message.result); } },
      dispatchMessage(type, payload) { if (type === "mcp-request") void router.receive(payload.request); },
    };
    router = new AppServerRouter({ native: native(), cursorSecret: config.token,
      ownsThread: id => readThreadOwnership(path.join(home, "gateway/threads"), id),
      send: message => bus.dispatchHostMessage(message.method
        ? { type: "mcp-notification", hostId: "local", ...message }
        : { type: "mcp-response", hostId: "local", message }), connectGateway: async () => {
        let socket; const peer = new RpcPeer(message => writeMessage(socket, message));
        socket = await connectGateway(config, message => peer.receive(message));
        socket.on("close", () => peer.close()); peer.dispose = async () => socket.destroy(); return peer;
      } });
    const request = (method, params) => new Promise((resolve, reject) => {
      const id = ++seq; pending.set(id, { resolve, reject }); bus.dispatchMessage("mcp-request", { hostId: "local", request: { id, method, params } });
    });
    // Mirrors the observed public manager seam, not vendor rendering code.
    class Manager {
      hostId = "local";
      requestClient = { getThreadPrewarmPolicy: async () => "legacy" };
      async startConversation(options) {
        assert.equal(await this.requestClient.getThreadPrewarmPolicy(), "disabled", "Cached native prewarm cannot be consumed for a CLI draft");
        const created = await request("thread/start", { model: options.collaborationMode.settings.model, cwd: home, runtimeWorkspaceRoots: [] });
        await request("thread/metadata/update", { threadId: created.thread.id, projectId: "same-native-project" });
        await request("thread/settings/update", { threadId: created.thread.id, disabledPluginIds: [] });
        await request("turn/start", { threadId: created.thread.id, model: "stale-native-selection", input: options.input, runtimeWorkspaceRoots: [] });
        return created;
      }
    }
    hooks = installNativeSessionHooks({ Manager, bus, controller, eligible: () => true });
    await request("initialize", { clientInfo: { name: "fixture", version: "1" } });
    return { controller, request, manager: new Manager() };
  }
  t.after(async () => { hooks?.dispose(); await router?.close(); await server.close(); fs.rmSync(home, { recursive: true, force: true }); });
  let f = await connect(); f.controller.select("mycodex/copilot/fixture");
  assert.equal(server.protocol.store.all().length, 0, "Choosing an engine creates no persisted draft");
  const created = await f.manager.startConversation({ clientUserMessageId: "first-submit", input: [{ type: "text", text: "first" }] }); calls++;
  await Promise.all([...server.protocol.active.values()].map(turn => turn.done));
  const listed = await f.request("thread/list", { sortKey: "recency_at" });
  assert.ok(listed.data.some(thread => thread.id === "native-existing"));
  assert.ok(listed.data.some(thread => thread.id === created.thread.id && thread.projectId === "same-native-project"));
  const project = await f.request("thread/list", { projectId: "same-native-project" });
  assert.ok(project.data.some(thread => thread.id === created.thread.id));
  assert.equal(await f.manager.requestClient.getThreadPrewarmPolicy(), "legacy");
  hooks.dispose(); await router.close(); await server.close();
  assert.equal(fs.existsSync(config.endpoint), false);
  server = await startGateway(config); f = await connect();
  await f.request("thread/read", { threadId: created.thread.id });
  assert.equal(f.controller.thread(created.thread.id).model, "mycodex/copilot/fixture");
  await f.request("thread/resume", { threadId: created.thread.id, model: "native" });
  await f.request("turn/start", { threadId: created.thread.id, model: "native", input: [{ type: "text", text: "after restart" }] }); calls++;
  await Promise.all([...server.protocol.active.values()].map(turn => turn.done));
  const read = await f.request("thread/read", { threadId: created.thread.id });
  assert.equal(read.thread.turns.length, calls); assert.equal(read.thread.projectId, "same-native-project");
  assert.equal(server.protocol.store.get(created.thread.id).nativeSessionId, "same-cli-session");
  assert.equal(nativeTurns, 0); assert.equal(server.protocol.store.all().length, 1);
});

test('native CLI fork entry uses durable CLI model/policy rather than native sandbox defaults',()=>{
  const c=createNativeSessionController();c.remember({id:'cli-source',model:'mycodex/copilot/sol',reasoningEffort:'high',cliApprovalMode:'deny'});
  const params={threadId:'cli-source',lastTurnId:'turn',model:'stale-native',sandbox:'read-only',approvalPolicy:'never',config:{model_reasoning_effort:'high'}};
  const request={hostId:'local',request:{method:'thread/fork',params}};
  const fork=c.outgoing('mcp-request',request).request.params;
  assert.equal(fork.model,'mycodex/copilot/sol');assert.equal(fork.sandbox,undefined);assert.equal(fork.permissions,':danger-full-access');
  assert.equal(fork.cliApprovalMode,'deny');assert.equal(fork.effort,'high');assert.equal(fork.lastTurnId,'turn');assert.equal(params.sandbox,'read-only');
  c.setModelSwitchPending('cli-source',true);assert.throws(()=>c.outgoing('mcp-request',request),/模型切换尚未完成/);
  c.remember({id:'native-source',model:'mycodex/codex-copilot/sol',modelProvider:'mycodex-copilot'});
  const native={...params,threadId:'native-source',model:'mycodex/codex-copilot/sol'};
  assert.deepEqual(c.outgoing('mcp-request',{hostId:'local',request:{method:'thread/fork',params:native}}).request.params,native);
});

test('native search envelopes hydrate CLI ownership before a result is reopened',()=>{
  const c=createNativeSessionController();c.observe({type:'mcp-response',hostId:'local',message:{result:{data:[{thread:{id:'searched-cli',model:'mycodex/copilot/sol',reasoningEffort:'high',cliApprovalMode:'deny'},snippet:'title match'}]}}});
  const resumed=c.outgoing('mcp-request',{hostId:'local',request:{method:'thread/resume',params:{threadId:'searched-cli',model:'native-default',sandbox:'read-only'}}}).request.params;
  assert.equal(resumed.model,'mycodex/copilot/sol');assert.equal(resumed.cliApprovalMode,'deny');assert.equal(resumed.permissions,':danger-full-access');
});

test('native loaded thread IDs do not crash the observer or overwrite remembered CLI ownership',()=>{
  const c=createNativeSessionController();
  c.remember({id:'loaded-cli',model:'mycodex/copilot/sol',reasoningEffort:'high',cliApprovalMode:'deny'});
  assert.doesNotThrow(()=>c.observe({type:'mcp-response',hostId:'local',message:{result:{data:['loaded-cli','another-thread']}}}));
  const resumed=c.outgoing('mcp-request',{hostId:'local',request:{method:'thread/resume',params:{threadId:'loaded-cli',model:'native-default'}}}).request.params;
  assert.equal(resumed.model,'mycodex/copilot/sol');assert.equal(resumed.effort,'high');assert.equal(resumed.cliApprovalMode,'deny');
});
