import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { CdpTargetSessions, connectCdp, evaluate, reloadPage } from "../bridge/desktop-cdp.mjs";
import { installContextControls } from "../bridge/desktop-patch.mjs";

const URL = "ws://synthetic.invalid/renderer";
const MODEL_INSPECTION = "globalThis.__codexCopilotModelControlsV1?.inspect?.() ?? null";
const flush = () => new Promise((resolve) => setImmediate(resolve));

function transport({ autoOpen = true, onSend } = {}) {
  const sockets = [];
  class MockWebSocket extends EventTarget {
    readyState = 0;
    sent = [];
    closeCalls = 0;
    listeners = new Map();

    constructor(url) {
      super();
      this.url = url;
      sockets.push(this);
      if (autoOpen) queueMicrotask(() => this.open());
    }

    addEventListener(type, listener, options) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(listener);
      super.addEventListener(type, listener, options);
    }

    removeEventListener(type, listener, options) {
      this.listeners.get(type)?.delete(listener);
      super.removeEventListener(type, listener, options);
    }

    open() {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.dispatchEvent(new Event("open"));
    }

    send(data) {
      assert.equal(this.readyState, 1, "send must never run on a closed transport");
      const message = JSON.parse(data);
      this.sent.push(message);
      onSend?.(this, message);
    }

    receive(message) {
      this.dispatchEvent(new MessageEvent("message", {
        data: typeof message === "string" ? message : JSON.stringify(message),
      }));
    }

    reply(message, result = {}) {
      this.receive({ id: message.id, result });
    }

    fail() {
      this.dispatchEvent(new Event("error"));
    }

    peerClose() {
      this.readyState = 3;
      this.dispatchEvent(new Event("close"));
    }

    close() {
      this.closeCalls++;
      this.peerClose();
    }

    assertReleased() {
      assert.equal(this.readyState, 3);
      assert.equal([...this.listeners.values()].reduce((total, set) => total + set.size, 0), 0);
    }
  }
  return {
    sockets,
    options: { WebSocketImpl: MockWebSocket, timeoutMs: 500 },
    get socket() { return sockets.at(-1); },
  };
}

function rendererTransport({
  script = "let a=i?.authMethod===`chatgpt`,next=1;",
  emitScript = true,
  modelControlsState = "unavailable",
  modelControlsInspection = null,
  intercept,
} = {}) {
  return transport({
    onSend(socket, message) {
      if (intercept?.(socket, message)) return;
      if (message.method === "Debugger.enable" && emitScript) {
        socket.receive({
          method: "Debugger.scriptParsed",
          params: { scriptId: "synthetic-script", url: "app://-/assets/app-initial-test.js" },
        });
      }
      socket.reply(message, message.method === "Debugger.getScriptSource"
        ? { scriptSource: script }
        : message.method === "Runtime.evaluate" && message.params.expression === MODEL_INSPECTION
        ? { result: { value: modelControlsInspection } }
        : message.method === "Runtime.evaluate" &&
          message.params.expression.includes("__codexCopilotModelControlsV1")
        ? { result: { value: modelControlsState } }
        : { result: { value: true } });
    },
  });
}

function installOptions(mock, extra = {}) {
  return { ...mock.options, commandTimeoutMs: 500, ...extra };
}

test("CDP correlates concurrent replies without consuming events or unrelated IDs", async () => {
  const mock = transport();
  const events = [];
  const session = await connectCdp(URL, { ...mock.options, onEvent: (event) => events.push(event) });
  const first = session.send("First");
  const second = session.send("Second");
  mock.socket.receive("{not json");
  mock.socket.receive(null);
  mock.socket.receive({ id: 9000, result: {} });
  mock.socket.receive({ method: "Changed", params: { value: 1 } });
  mock.socket.reply(mock.socket.sent[1], { value: 2 });
  mock.socket.reply(mock.socket.sent[0], { value: 1 });
  assert.deepEqual(await Promise.all([first, second]), [{ value: 1 }, { value: 2 }]);
  assert.deepEqual(events, [{ method: "Changed", params: { value: 1 } }]);
  session.close();
  assert.equal(session.signal.aborted, true);
  mock.socket.assertReleased();
});

test("CDP constructor failures reject without opening a transport", async () => {
  await assert.rejects(connectCdp(URL, {
    WebSocketImpl: class { constructor() { throw new Error("constructor failed"); } },
  }), /constructor failed/);
});

test("CDP rejects invalid deadlines and already-aborted callers before connecting", async () => {
  const mock = transport();
  for (const timeoutMs of [0, -1, NaN, Infinity]) {
    await assert.rejects(connectCdp(URL, { ...mock.options, timeoutMs }), /positive finite/);
  }
  const controller = new AbortController();
  controller.abort(new Error("caller already cancelled"));
  await assert.rejects(connectCdp(URL, { ...mock.options, signal: controller.signal }), /already cancelled/);
  assert.equal(mock.sockets.length, 0);
});

test("CDP close during the handshake settles immediately", async () => {
  const mock = transport({ autoOpen: false });
  const pending = connectCdp(URL, mock.options);
  mock.socket.peerClose();
  await assert.rejects(pending, /connection closed/);
  assert.equal(mock.socket.sent.length, 0);
  mock.socket.assertReleased();
});

test("CDP socket errors terminate both connecting and active sessions", async () => {
  const connecting = transport({ autoOpen: false });
  const pending = connectCdp(URL, connecting.options);
  connecting.socket.fail();
  await assert.rejects(pending, /socket error/);
  connecting.socket.assertReleased();
  const active = transport();
  const session = await connectCdp(URL, active.options);
  const command = session.send("Waiting");
  active.socket.fail();
  await assert.rejects(command, /socket error/);
  active.socket.assertReleased();
});

test("CDP handshake timeout closes and removes its listeners", async () => {
  const mock = transport({ autoOpen: false });
  await assert.rejects(connectCdp(URL, { ...mock.options, timeoutMs: 20 }), /connection timeout/);
  assert.equal(mock.socket.closeCalls, 1);
  mock.socket.assertReleased();
});

test("CDP abort closes an in-progress handshake", async () => {
  const mock = transport({ autoOpen: false });
  const controller = new AbortController();
  const pending = connectCdp(URL, { ...mock.options, signal: controller.signal });
  controller.abort(new Error("cancelled handshake"));
  await assert.rejects(pending, /cancelled handshake/);
  mock.socket.assertReleased();
});

test("CDP peer close rejects every pending command and future calls", async () => {
  const mock = transport();
  const session = await connectCdp(URL, mock.options);
  const results = Promise.allSettled([session.send("One"), session.send("Two")]);
  mock.socket.peerClose();
  for (const result of await results) {
    assert.equal(result.status, "rejected");
    assert.match(result.reason.message, /connection closed/);
  }
  await assert.rejects(session.send("Three"), /connection closed/);
  assert.equal(mock.socket.sent.length, 2);
  mock.socket.assertReleased();
});

test("CDP abort settles all commands once and never replays them", async () => {
  const mock = transport();
  const controller = new AbortController();
  const session = await connectCdp(URL, { ...mock.options, signal: controller.signal });
  const results = Promise.allSettled([session.send("One"), session.send("Two")]);
  const reason = new Error("cancelled session");
  controller.abort(reason);
  for (const result of await results) assert.equal(result.reason, reason);
  assert.equal(await session.closed, reason);
  session.close();
  mock.socket.fail();
  assert.equal(mock.socket.closeCalls, 1);
  assert.equal(mock.socket.sent.length, 2);
  mock.socket.assertReleased();
});

test("CDP never sends during closing even before the close event arrives", async () => {
  for (const state of [2, 3]) {
    const mock = transport();
    const session = await connectCdp(URL, mock.options);
    const first = session.send("AlreadyWaiting");
    mock.socket.readyState = state;
    const results = await Promise.allSettled([first, session.send("MustNotSend")]);
    assert.ok(results.every((result) => result.status === "rejected" && /not open/.test(result.reason.message)));
    assert.equal(mock.socket.sent.length, 1);
    assert.equal(session.signal.aborted, true);
    mock.socket.peerClose();
    mock.socket.assertReleased();
  }
});

test("CDP send failure retires the connection and settles other waiters", async () => {
  const mock = transport({ onSend(_socket, message) {
    if (message.method === "Broken") throw new Error("send failed");
  } });
  const session = await connectCdp(URL, mock.options);
  const results = await Promise.allSettled([session.send("Waiting"), session.send("Broken")]);
  assert.ok(results.every((result) => result.status === "rejected" && /send failed/.test(result.reason.message)));
  mock.socket.assertReleased();
});

test("CDP command timeout rejects every waiter, ignores late replies and does not retry", async () => {
  const mock = transport();
  const session = await connectCdp(URL, { ...mock.options, timeoutMs: 20 });
  const results = await Promise.allSettled([session.send("First"), session.send("Second")]);
  assert.ok(results.every((result) => result.status === "rejected" && /First timeout/.test(result.reason.message)));
  for (const command of mock.socket.sent) mock.socket.reply(command);
  assert.equal(mock.socket.sent.length, 2);
  assert.equal(mock.socket.closeCalls, 1);
  mock.socket.assertReleased();
});

test("response delivery timeout keeps the owning binding and never replays a completed operation", async () => {
  const mock = transport({ onSend(socket, message) {
    if (message.method === "StillHealthy") socket.reply(message, { accepted: true });
  } });
  const session = await connectCdp(URL, { ...mock.options, timeoutMs: 20 });
  await assert.rejects(session.dispatchResponse("codex-copilot-session-response", {
    id: "completed-batch", ok: true, body: { complete: true },
  }), /timeout/);
  assert.equal(session.active, true);
  assert.equal(session.signal.aborted, false);
  const delivery = mock.socket.sent[0];
  mock.socket.reply(delivery);
  assert.deepEqual(await session.send("StillHealthy"), { accepted: true });
  assert.equal(mock.socket.sent.length, 2);
  assert.equal(mock.socket.sent.filter(message =>
    message.params.expression?.includes("completed-batch")).length, 1);
  session.close();
  mock.socket.assertReleased();
});

test("response-only delivery is restricted to bounded private response events", async () => {
  const mock = transport();
  const session = await connectCdp(URL, mock.options);
  for (const [event, detail] of [
    ["arbitrary-native-action", { id: "one" }],
    ["codex-copilot-account-response", {}],
    ["codex-copilot-account-response", { id: "x".repeat(129) }],
    ["codex-copilot-account-response", { id: "one", text: "x".repeat(8 * 1024 * 1024) }],
  ]) await assert.rejects(session.dispatchResponse(event, detail), /Invalid|bounded/);
  assert.equal(mock.socket.sent.length, 0);
  session.close();
  mock.socket.assertReleased();
});

test("CDP protocol errors reject only the matching request", async () => {
  const mock = transport();
  const session = await connectCdp(URL, mock.options);
  const failed = session.send("Unsupported");
  const success = session.send("Supported");
  mock.socket.receive({ id: mock.socket.sent[0].id, error: { message: "unsupported command" } });
  mock.socket.reply(mock.socket.sent[1], { value: 2 });
  await assert.rejects(failed, /unsupported command/);
  assert.deepEqual(await success, { value: 2 });
  assert.equal(session.active, true);
  session.close();
  mock.socket.assertReleased();
});

test("CDP notification-handler failure closes pending commands", async () => {
  const mock = transport();
  const session = await connectCdp(URL, {
    ...mock.options,
    onEvent() { throw new Error("event handler failed"); },
  });
  const pending = session.send("Waiting");
  mock.socket.receive({ method: "Changed" });
  await assert.rejects(pending, /event handler failed/);
  mock.socket.assertReleased();
});

test("one-shot evaluation preserves falsy values and always closes", async () => {
  for (const value of [null, false, 0, "", "synthetic"]) {
    const mock = transport({ onSend: (socket, message) => socket.reply(message, { result: { value } }) });
    assert.equal(await evaluate(URL, "synthetic", mock.options), value);
    assert.equal(mock.socket.sent[0].method, "Runtime.evaluate");
    assert.equal(mock.socket.sent[0].params.returnByValue, true);
    mock.socket.assertReleased();
  }
});

test("one-shot evaluation never reports protocol or renderer exceptions as success", async () => {
  for (const error of [
    { error: { message: "protocol failure" } },
    { result: { exceptionDetails: { exception: { description: "renderer failure" } } } },
    { result: { exceptionDetails: { text: "evaluation failure" } } },
  ]) {
    const mock = transport({ onSend: (socket, message) => socket.receive({ id: message.id, ...error }) });
    await assert.rejects(evaluate(URL, "synthetic", mock.options), /failure/);
    mock.socket.assertReleased();
  }
});

test("one-shot evaluation rejects a close before its response instead of hanging", async () => {
  const mock = transport({ onSend: (socket) => socket.peerClose() });
  await assert.rejects(evaluate(URL, "synthetic", mock.options), /connection closed/);
  mock.socket.assertReleased();
});

test("page reload uses the existing uncached request and closes after acknowledgement", async () => {
  const mock = transport({ onSend: (socket, message) => socket.reply(message) });
  assert.equal(await reloadPage(URL, mock.options), "reloading");
  assert.deepEqual(mock.socket.sent.map(({ method, params }) => ({ method, params })), [
    { method: "Page.reload", params: { ignoreCache: true } },
  ]);
  mock.socket.assertReleased();
});

test("page reload close or protocol failure is surfaced without replay", async () => {
  for (const mode of ["closed", "error"]) {
    const mock = transport({ onSend(socket, message) {
      if (mode === "closed") socket.peerClose();
      else socket.receive({ id: message.id, error: { message: "reload failed" } });
    } });
    await assert.rejects(reloadPage(URL, mock.options), /closed|reload failed/);
    assert.equal(mock.socket.sent.length, 1);
    mock.socket.assertReleased();
  }
});

test("renderer initialization succeeds and releases its connection on context reset", async () => {
  const mock = rendererTransport();
  const session = await installContextControls(URL, installOptions(mock));
  assert.equal(session.active, true);
  assert.equal(session.contextControlsAvailable, false);
  assert.ok(!mock.socket.sent.some(({ method }) => method.startsWith("Debugger.")));
  assert.deepEqual(mock.socket.sent.filter((message) => message.method === "Runtime.addBinding")
    .map(message => message.params.name), ["__codexCopilotAccountRequest", "__codexCopilotSessionRequest"]);
  mock.socket.receive({ method: "Runtime.executionContextsCleared" });
  assert.match((await session.closed).message, /renderer context changed/);
  mock.socket.assertReleased();
});

test("renderer ownership denial happens before opening a connection or sending any mutation", async () => {
  const mock = rendererTransport();
  await assert.rejects(installContextControls(URL, installOptions(mock, {
    assertOwned: () => { throw new Error("private process lifetime ended"); },
  })), /private process lifetime ended/);
  assert.equal(mock.sockets.length, 0);
});

test("renderer lifetime change during installation closes its session instead of keeping an unowned binding", async () => {
  const mock = rendererTransport();
  let checks = 0;
  await assert.rejects(installContextControls(URL, installOptions(mock, {
    assertOwned: () => { if (++checks === 3) throw new Error("private endpoint owner changed"); },
  })), /private endpoint owner changed/);
  mock.socket.assertReleased();
});

test("renderer initialization does not inspect optional bundles or enable a permission debugger", async () => {
  const mock = rendererTransport({ emitScript: false, intercept(socket, message) {
    if (message.method !== "Debugger.enable") return false;
    socket.reply(message);
    setImmediate(() => socket.receive({
      method: "Debugger.scriptParsed",
      params: { scriptId: "late-script", url: "app://-/assets/app-initial-next.js?version=next" },
    }));
    return true;
  } });
  const session = await installContextControls(URL, installOptions(mock));
  assert.ok(!mock.socket.sent.some(({ method }) => method.startsWith("Debugger.")));
  session.close();
  mock.socket.assertReleased();
});

test("renderer installation deadline closes a stalled handshake", async () => {
  const mock = transport({ autoOpen: false });
  await assert.rejects(installContextControls(URL, installOptions(mock, { timeoutMs: 20 })), /context control timeout/);
  mock.socket.assertReleased();
});

test("renderer installation deadline closes a stalled command and settles the initialization", async () => {
  const mock = transport();
  await assert.rejects(installContextControls(URL, installOptions(mock, { timeoutMs: 20 })), /context control timeout/);
  assert.deepEqual(mock.socket.sent.map((message) => message.method), ["Runtime.enable"]);
  mock.socket.assertReleased();
});

test("detached renderers retain Context and Account immediately without waiting for a legacy bundle", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const detachedUrl = `${URL}/detached-window`;
  const modelInspection = {
    revision: 2, bound: true, menuOpen: false, model: "gpt6.1-sol", effort: "max", context: "400K",
  };
  const mock = rendererTransport({
    emitScript: false,
    modelControlsState: "active",
    modelControlsInspection: modelInspection,
    intercept(socket, message) {
      if (message.method === "Debugger.enable") {
        socket.reply(message);
        socket.receive({
          method: "Debugger.scriptParsed",
          params: { scriptId: "detached-script", url: "app://-/assets/detached-window-test.js" },
        });
        return true;
      }
      return false;
    },
  });
  const sessions = new CdpTargetSessions();
  let session;
  let failure;
  let settled = false;
  const installing = installContextControls(detachedUrl, {
    WebSocketImpl: mock.options.WebSocketImpl,
  }).then((result) => {
    settled = true;
    session = result;
  }, (error) => {
    settled = true;
    failure = error;
  });
  t.after(async () => {
    sessions.close();
    mock.socket.peerClose();
    await installing;
    mock.socket.assertReleased();
  });
  await flush();
  assert.deepEqual(mock.socket.sent.map(({ method }) => method), [
    "Runtime.enable", "Runtime.addBinding", "Runtime.evaluate", "Runtime.addBinding",
    "Runtime.evaluate", "Runtime.evaluate", "Runtime.evaluate", "Runtime.evaluate",
  ]);
  assert.match(mock.socket.sent[2].params.expression, /__codexCopilotAccountUiV3/);
  assert.equal(mock.socket.sent[3].params.name, "__codexCopilotSessionRequest");
  assert.match(mock.socket.sent[4].params.expression, /__codexCopilotSessionsV1/);
  assert.match(mock.socket.sent[5].params.expression, /__codexCopilotCreditsV1/);
  assert.match(mock.socket.sent[6].params.expression, /__codexCopilotModelControlsV1/);
  assert.equal(mock.socket.sent[7].params.expression, MODEL_INSPECTION);
  t.mock.timers.tick(249);
  await flush();
  assert.equal(settled, true);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(settled, true, "Context installation must not depend on legacy bundle discovery");
  assert.equal(failure, undefined);
  assert.equal(session.active, true);
  assert.equal(session.signal.aborted, false);
  assert.equal(session.modelControlsAvailable, true);
  assert.equal(session.modelControlsState, "active");
  assert.equal(session.modelControlsReloadRequired, false);
  assert.equal(session.modelControlsBound, true);
  assert.deepEqual(session.modelControlsInspection, modelInspection);
  assert.equal(session.contextControlsAvailable, false);
  sessions.set("detached", session);
  t.mock.timers.tick(15000);
  await flush();
  sessions.retain([{ id: "detached", webSocketDebuggerUrl: detachedUrl }]);
  assert.equal(sessions.get("detached"), session);
  assert.equal(mock.socket.closeCalls, 0, "the original installation deadline must be cleared");
  assert.equal(mock.sockets.length, 1);
  const before = mock.socket.sent.length;
  mock.socket.receive({
    method: "Debugger.scriptParsed",
    params: { scriptId: "too-late-script", url: "app://-/assets/app-initial-late.js" },
  });
  await flush();
  assert.equal(mock.socket.sent.length, before, "late optional scripts must not restart installation");
  assert.ok(!mock.socket.sent.some(({ method }) =>
    method === "Debugger.getScriptSource" || method === "Debugger.setBreakpoint"));
  mock.socket.receive({
    method: "Runtime.bindingCalled",
    params: {
      name: "__codexCopilotAccountRequest",
      payload: JSON.stringify({ id: "detached-account", action: "not-an-account-action" }),
    },
  });
  await flush();
  assert.equal(mock.socket.sent.length, before + 1);
  assert.match(mock.socket.sent.at(-1).params.expression, /"id":"detached-account","ok":false/);
  mock.socket.receive({ method: "Runtime.executionContextsCleared" });
  assert.match((await session.closed).message, /renderer context changed/);
  assert.equal(sessions.has("detached"), false);
  mock.socket.assertReleased();
});

test("late legacy bundles never cause a native permission breakpoint", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const mock = rendererTransport({ emitScript: false });
  const installing = installContextControls(URL, { WebSocketImpl: mock.options.WebSocketImpl });
  t.after(() => mock.socket.peerClose());
  await flush();
  t.mock.timers.tick(249);
  mock.socket.receive({
    method: "Debugger.scriptParsed",
    params: { scriptId: "within-grace", url: "app://-/assets/app-initial-late.js?version=next" },
  });
  const session = await installing;
  assert.equal(session.contextControlsAvailable, false);
  assert.ok(!mock.socket.sent.some(({ method }) => method.startsWith("Debugger.")));
  t.mock.timers.tick(15000);
  await flush();
  assert.equal(session.active, true);
  session.close();
  mock.socket.assertReleased();
});

test("renderer reset during initialization fails promptly and does not continue sending", async () => {
  const mock = rendererTransport({ intercept(socket, message) {
    if (message.method !== "Runtime.addBinding") return false;
    socket.receive({ method: "Runtime.executionContextsCleared" });
    return true;
  } });
  await assert.rejects(installContextControls(URL, installOptions(mock)), /renderer context changed/);
  assert.deepEqual(mock.socket.sent.map((message) => message.method), ["Runtime.enable", "Runtime.addBinding"]);
  mock.socket.assertReleased();
});

test("optional renderer hooks never mask Runtime or CDP installation errors", async (t) => {
  const failures = [
    { method: "Runtime.enable" },
    { method: "Runtime.addBinding" },
    { method: "Runtime.evaluate", marker: "__codexCopilotAccountUiV3" },
    { method: "Runtime.evaluate", marker: "__codexCopilotCreditsV1" },
    { method: "Runtime.evaluate", marker: "__codexCopilotModelControlsV1" },
    { method: "Runtime.evaluate", marker: MODEL_INSPECTION, modelControlsState: "active" },
  ];
  for (const { method, marker, emitScript = false, modelControlsState } of failures) {
    await t.test(marker || method, async () => {
      const reason = `synthetic ${marker || method} installation failure`;
      const mock = rendererTransport({ emitScript, modelControlsState, intercept(socket, message) {
        if (message.method !== method ||
            (marker && !message.params.expression.includes(marker))) return false;
        if (method === "Runtime.evaluate") {
          socket.reply(message, { exceptionDetails: { text: reason } });
        } else {
          socket.receive({ id: message.id, error: { message: reason } });
        }
        return true;
      } });
      await assert.rejects(installContextControls(URL, installOptions(mock)),
        (error) => error.message === reason);
      assert.equal(mock.socket.closeCalls, 1);
      mock.socket.assertReleased();
    });
  }
});

test("a legacy Debugger interceptor cannot stall native Context installation", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const mock = rendererTransport({ emitScript: false, intercept(_socket, message) {
    return message.method === "Debugger.enable";
  } });
  const installing = installContextControls(URL, {
    WebSocketImpl: mock.options.WebSocketImpl,
  });
  t.after(() => mock.socket.peerClose());
  await flush();
  t.mock.timers.tick(250);
  await flush();
  assert.equal(mock.socket.closeCalls, 0);
  const session = await installing;
  assert.ok(!mock.socket.sent.some(({ method }) => method.startsWith("Debugger.")));
  session.close();
  assert.equal(mock.socket.closeCalls, 1);
  mock.socket.assertReleased();
});

test("post-install renderer loss closes Context without a legacy optional-bundle path", async (t) => {
  for (const elapsed of [249, 250]) {
    for (const mode of ["peer-close", "socket-error", "context-reset"]) {
      await t.test(`${mode} at ${elapsed}ms`, async (t) => {
        t.mock.timers.enable({ apis: ["setTimeout"] });
        const mock = rendererTransport({ emitScript: false });
        const session = await installContextControls(URL, {
          WebSocketImpl: mock.options.WebSocketImpl,
        });
        const closed = session.closed;
        t.after(() => mock.socket.peerClose());
        await flush();
        t.mock.timers.tick(elapsed);
        if (mode === "peer-close") mock.socket.peerClose();
        else if (mode === "socket-error") mock.socket.fail();
        else mock.socket.receive({ method: "Runtime.executionContextsCleared" });
        assert.match((await closed).message, /connection closed|socket error|renderer context changed/);
        assert.ok(!mock.socket.sent.some(({ method }) => method === "Debugger.getScriptSource"));
        mock.socket.assertReleased();
      });
    }
  }
});

test("renderer degradation preserves model installation, reload and binding states", async (t) => {
  const cases = [
    { state: "active", inspection: {
      revision: 2, bound: true, menuOpen: false, model: "gpt6.1-sol", effort: "max", context: "400K",
    }, bound: true },
    { state: "active", inspection: {
      revision: 2, bound: false, menuOpen: false, model: null, effort: null, context: null,
    }, bound: false },
    { state: "active", inspection: null, bound: null },
    { state: "reload-required", inspection: { revision: 1, bound: true }, bound: null },
    { state: "unavailable", inspection: null, bound: null },
  ];
  for (const { state, inspection, bound } of cases) {
    await t.test(`${state}, binding=${bound}`, async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const mock = rendererTransport({
        emitScript: false, modelControlsState: state, modelControlsInspection: inspection,
      });
      const installing = installContextControls(URL, { WebSocketImpl: mock.options.WebSocketImpl });
      t.after(() => mock.socket.peerClose());
      await flush();
      t.mock.timers.tick(250);
      const session = await installing;
      assert.equal(session.active, true);
      assert.equal(session.contextControlsAvailable, false);
      assert.equal(session.modelControlsState, state);
      assert.equal(session.modelControlsAvailable, state === "active");
      assert.equal(session.modelControlsReloadRequired, state === "reload-required");
      assert.equal(session.modelControlsBound, bound);
      assert.deepEqual(session.modelControlsInspection, state === "active" ? inspection : null);
      const inspections = mock.socket.sent.filter(({ method, params }) =>
        method === "Runtime.evaluate" && params.expression === MODEL_INSPECTION);
      assert.equal(inspections.length, state === "active" ? 1 : 0);
      assert.ok(!mock.socket.sent.some(({ method }) => method === "Page.reload"));
      session.close();
      mock.socket.assertReleased();
    });
  }
});

test("unknown renderer signatures keep account controls without a permission hook", async () => {
  const mock = rendererTransport({ script: "unrecognized upstream implementation" });
  const session = await installContextControls(URL, installOptions(mock));
  assert.equal(session.active, true);
  assert.equal(session.contextControlsAvailable, false);
  assert.deepEqual(mock.socket.sent.filter((message) => message.method === "Runtime.addBinding")
    .map(message => message.params.name), ["__codexCopilotAccountRequest", "__codexCopilotSessionRequest"]);
  assert.ok(!mock.socket.sent.some((message) => message.method === "Debugger.setBreakpoint"));
  session.close();
  mock.socket.assertReleased();
});

test("independent Desktop model controls do not depend on the Speed permission hook", async () => {
  const mock = rendererTransport({
    script: "unrecognized upstream implementation",
    modelControlsState: "active",
    modelControlsInspection: { revision: 2, bound: false },
  });
  const session = await installContextControls(URL, installOptions(mock));
  assert.equal(session.contextControlsAvailable, false);
  assert.equal(session.modelControlsAvailable, true);
  assert.equal(session.modelControlsState, "active");
  assert.equal(session.modelControlsBound, false);
  assert.equal(mock.socket.sent.filter(message =>
    message.method === "Runtime.evaluate" &&
    message.params.expression.includes("__codexCopilotModelControlsV1") &&
    message.params.expression !== MODEL_INSPECTION).length, 1);
  session.close();
  mock.socket.assertReleased();
});

test("renderer evaluation failure cannot be reported as active controls", async () => {
  const mock = rendererTransport({ intercept(socket, message) {
    if (message.method !== "Runtime.evaluate") return false;
    socket.reply(message, { exceptionDetails: { text: "UI initialization failed" } });
    return true;
  } });
  await assert.rejects(installContextControls(URL, installOptions(mock)), /UI initialization failed/);
  mock.socket.assertReleased();
});

test("renderer account responses stay on the owning connection", async () => {
  const mock = rendererTransport();
  const session = await installContextControls(URL, installOptions(mock));
  const before = mock.socket.sent.length;
  mock.socket.receive({
    method: "Runtime.bindingCalled",
    params: {
      name: "__codexCopilotAccountRequest",
      payload: JSON.stringify({ id: "invalid-test", action: "not-an-account-action" }),
    },
  });
  await flush();
  assert.equal(mock.socket.sent.length, before + 1);
  assert.match(mock.socket.sent.at(-1).params.expression, /"id":"invalid-test","ok":false/);
  session.close();
  mock.socket.assertReleased();
});

test("an account response acknowledgement timeout does not send an error response again", async () => {
  const mock = rendererTransport({ intercept(_socket, message) {
    return message.params?.expression?.includes("codex-copilot-account-response") &&
      message.params.expression.includes("delivery-timeout");
  } });
  const session = await installContextControls(URL, installOptions(mock, { commandTimeoutMs: 30 }));
  const before = mock.socket.sent.length;
  mock.socket.receive({ method: "Runtime.bindingCalled", params: {
    name: "__codexCopilotAccountRequest",
    payload: JSON.stringify({ id: "delivery-timeout", action: "invalid-action" }),
  } });
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(mock.socket.sent.length, before + 1);
  assert.equal(session.active, true);
  session.close();
  mock.socket.assertReleased();
});

test("renderer disconnect aborts its pending account fetch without sending or replaying a response", async (t) => {
  let fetchSignal;
  let calls = 0;
  t.mock.method(globalThis, "fetch", (_url, options) => {
    calls++;
    fetchSignal = options.signal;
    return new Promise((_resolve, reject) => {
      fetchSignal.addEventListener("abort", () => reject(fetchSignal.reason), { once: true });
    });
  });
  const mock = rendererTransport();
  const session = await installContextControls(URL, installOptions(mock));
  const before = mock.socket.sent.length;
  mock.socket.receive({
    method: "Runtime.bindingCalled",
    params: {
      name: "__codexCopilotAccountRequest",
      payload: JSON.stringify({ id: "read-account", action: "account-request", path: "/account", method: "GET" }),
    },
  });
  await flush();
  assert.equal(calls, 1);
  session.close();
  await flush();
  assert.equal(fetchSignal.aborted, true);
  assert.equal(mock.socket.sent.length, before);
  assert.equal(calls, 1);
  mock.socket.assertReleased();
});

test("replacing a renderer cannot lose the new session to an old close callback", async () => {
  const mock = transport();
  const sessions = new CdpTargetSessions();
  const first = await connectCdp(URL, mock.options);
  const next = await connectCdp(URL, mock.options);
  sessions.set("target", first);
  sessions.set("target", next);
  await flush();
  assert.equal(first.active, false);
  assert.equal(sessions.get("target"), next);
  sessions.close();
  for (const socket of mock.sockets) socket.assertReleased();
});

test("target pruning closes disappeared or changed endpoints and retains matching ones", async () => {
  const mock = transport();
  const sessions = new CdpTargetSessions();
  for (const id of ["removed", "changed", "retained"]) {
    sessions.set(id, await connectCdp(`${URL}/${id}`, mock.options));
  }
  sessions.retain([
    { id: "changed", webSocketDebuggerUrl: `${URL}/replacement` },
    { id: "retained", webSocketDebuggerUrl: `${URL}/retained` },
  ]);
  assert.equal(sessions.has("removed"), false);
  assert.equal(sessions.has("changed"), false);
  assert.equal(sessions.has("retained"), true);
  sessions.close();
  for (const socket of mock.sockets) socket.assertReleased();
});

test("an unrelated observation timeout cannot discard a healthy renderer binding", async () => {
  const mock = transport({ onSend(socket, message) {
    if (message.method === "HistoryResponse") socket.reply(message, { accepted: true });
  } });
  const sessions = new CdpTargetSessions();
  const owning = await connectCdp(URL, mock.options);
  sessions.set("target", owning);
  const probe = await connectCdp(URL, { ...mock.options, timeoutMs: 20 });
  await assert.rejects(probe.send("BackgroundObservation"), /timeout/);
  assert.equal(sessions.get("target"), owning);
  assert.equal(owning.active, true);
  assert.deepEqual(await owning.send("HistoryResponse"), { accepted: true });
  sessions.close();
  for (const socket of mock.sockets) socket.assertReleased();
  const helper = fs.readFileSync(new globalThis.URL("../bridge/desktop-patch.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(helper, /await evaluate\(target\.webSocketDebuggerUrl,\s*"Boolean\(document\.documentElement\)"/);
  assert.doesNotMatch(helper,
    /verification temporarily timed out[\s\S]{0,200}contextSessions\.close\(\)/);
});

test("closed sessions cannot be retained or observed as active", async () => {
  const mock = transport();
  const sessions = new CdpTargetSessions();
  const session = await connectCdp(URL, mock.options);
  sessions.set("target", session);
  session.close();
  assert.equal(sessions.has("target"), false);
  assert.throws(() => sessions.set("target", session), /closed CDP session/);
  mock.socket.assertReleased();
});

test("target shutdown settles pending work on every connection", async () => {
  const mock = transport();
  const sessions = new CdpTargetSessions();
  const pending = [];
  for (const id of ["one", "two"]) {
    const session = await connectCdp(`${URL}/${id}`, mock.options);
    sessions.set(id, session);
    pending.push(session.send("Waiting"));
  }
  const results = Promise.allSettled(pending);
  sessions.close();
  assert.ok((await results).every((result) => result.status === "rejected"));
  for (const socket of mock.sockets) socket.assertReleased();
});

test("private Desktop updates use an owner-guarded binding without native updater commands", async () => {
  const calls = [];
  let guards = 0;
  const mock = rendererTransport();
  const session = await installContextControls(URL, installOptions(mock, {
    assertOwned() { guards++; },
    desktopUpdates: { request: async input => {
      calls.push(input); return { schemaVersion: 1, surface: "copilot-desktop", busy: false };
    } },
  }));
  assert.ok(mock.socket.sent.some(message => message.method === "Runtime.addBinding" &&
    message.params.name === "__codexCopilotDesktopUpdateRequest"));
  const before = guards;
  const id = "00000000-0000-4000-8000-000000000001";
  mock.socket.receive({ method: "Runtime.bindingCalled", params: {
    name: "__codexCopilotDesktopUpdateRequest", payload: JSON.stringify({ id, operation: "check" }),
  } });
  await flush();
  assert.deepEqual(calls, [{ operation: "check" }]);
  assert.ok(guards >= before + 2);
  assert.match(mock.socket.sent.at(-1).params.expression, /desktop-update-response/);
  assert.match(mock.socket.sent.at(-1).params.expression, /"ok":true/);
  assert.equal(mock.socket.sent.some(message => /installUpdate|checkForUpdates/.test(message.method)), false);
  session.close(); mock.socket.assertReleased();
});

test("private update binding rejects renderer-supplied URLs and validation paths", async () => {
  const mock = rendererTransport();
  const session = await installContextControls(URL, installOptions(mock, {
    desktopUpdates: { request: async () => assert.fail("invalid update payload must not reach the updater") },
  }));
  mock.socket.receive({ method: "Runtime.bindingCalled", params: {
    name: "__codexCopilotDesktopUpdateRequest", payload: JSON.stringify({
      id: "00000000-0000-4000-8000-000000000002", operation: "prepare",
      url: "https://unrelated.invalid",
    }),
  } });
  await flush();
  assert.match(mock.socket.sent.at(-1).params.expression, /"ok":false/);
  assert.match(mock.socket.sent.at(-1).params.expression, /Invalid private Desktop update request/);
  session.close(); mock.socket.assertReleased();
});

test("session binding preserves structured rejection codes without retrying or replaying a mutation", async () => {
  const mock = rendererTransport();
  let calls = 0;
  const session = await installContextControls(URL, installOptions(mock, {
    sessionRequest: async () => {
      calls++;
      throw Object.assign(new Error("This preview expired"), { code: "preview_required" });
    },
  }));
  mock.socket.receive({ method: "Runtime.bindingCalled", params: {
    name: "__codexCopilotSessionRequest", payload: JSON.stringify({
      id: "00000000-0000-4000-8000-000000000003", operation: "apply", args: {},
    }),
  } });
  await flush();
  assert.equal(calls, 1);
  const response = mock.socket.sent.at(-1).params.expression;
  assert.match(response, /session-response/);
  assert.match(response, /"ok":false/);
  assert.match(response, /"code":"preview_required"/);
  session.close();
  mock.socket.assertReleased();
});
