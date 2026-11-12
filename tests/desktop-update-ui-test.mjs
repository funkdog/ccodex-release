import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { buildDesktopUpdateUiPatch } from "../bridge/desktop-update-ui.mjs";
import { picker, props, snapshotNative } from "./fixtures/desktop-native-context-harness.mjs";

const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture(t) {
  const ui = picker(props());
  const requests = [];
  ui.scope.crypto = { randomUUID };
  ui.scope.addEventListener = (...args) => ui.document.addEventListener(...args);
  ui.scope.removeEventListener = (...args) => ui.document.removeEventListener(...args);
  ui.scope.__codexCopilotDesktopUpdateRequest = payload => requests.push(JSON.parse(payload));
  const before = snapshotNative(ui, { ignoreAliasMarks: true });
  assert.equal(ui.runPatch(buildDesktopUpdateUiPatch()), "active");
  const updater = ui.scope.__codexCopilotDesktopUpdatesV1;
  t.after(() => { updater.dispose(); ui.dispose(); });
  const panel = ui.document.querySelector("#codex-copilot-desktop-update-panel");
  return { ui, requests, before, updater, panel,
    reply(body, request = requests.at(-1)) {
      assert.ok(request);
      ui.document.dispatch("codex-copilot-desktop-update-response", ui.document.body,
        { detail: { id: request.id, ok: true, body } });
    },
    nativeButton(label, parent = ui.document.body) {
      const button = ui.document.createElement("button");
      button.setAttribute("aria-label", label);
      button.textContent = label;
      parent.appendChild(button);
      return button;
    } };
}

test("the update patch parses, is ASCII source and has no replacement Model/Effort widgets", () => {
  const patch = buildDesktopUpdateUiPatch();
  new vm.Script(patch);
  const source = fs.readFileSync(path.join(import.meta.dirname, "..", "bridge", "desktop-update-ui.mjs"), "utf8");
  assert.doesNotMatch(source, /[^\x00-\x7f]/);
  assert.doesNotMatch(patch, /innerHTML|Debugger\.|native-model|effort-slider|window\.location/);
});

test("private update UI is idempotent and preserves the native picker, slider and animations", t => {
  const f = fixture(t);
  assert.equal(f.panel.hidden, true);
  assert.deepEqual(snapshotNative(f.ui, { ignoreAliasMarks: true }), f.before);
  assert.equal(f.ui.runPatch(buildDesktopUpdateUiPatch()), "active");
  assert.equal(f.ui.document.querySelectorAll("#codex-copilot-desktop-update-panel").length, 1);
  assert.equal(f.ui.document.querySelectorAll("#codex-copilot-desktop-update-style").length, 1);
  f.ui.trigger.click();
  assert.equal(f.ui.nativeMenu.hidden, false);
  f.ui.inputEffort("low");
  assert.equal(f.ui.nativeEffort.getAttribute("aria-valuenow"), "0");
  assert.equal(f.ui.committedProps.reasoningEffort, "low");
  assert.deepEqual(f.requests, []);
});

for (const label of ["Restart to update", "Update ChatGPT", "Check for Updates\u2026",
  "\u68c0\u67e5\u66f4\u65b0\u2026", "\u6aa2\u67e5\u66f4\u65b0\u2026"]) {
  test(`native update action ${JSON.stringify(label)} opens only the private update UI`, t => {
    const f = fixture(t);
    let nativeCalls = 0;
    const button = f.nativeButton(label);
    button.addEventListener("click", () => { nativeCalls++; });
    button.click();
    assert.equal(nativeCalls, 0);
    assert.equal(f.panel.hidden, false);
    assert.deepEqual(f.requests.map(request => request.operation), ["status"]);
  });
}

test("a matching label inside conversation markdown is not an updater control", t => {
  const f = fixture(t);
  const markdown = f.ui.document.createElement("div");
  markdown.className = "markdown";
  f.ui.document.body.appendChild(markdown);
  let calls = 0;
  const button = f.nativeButton("Restart to update", markdown);
  button.addEventListener("click", () => { calls++; });
  button.click();
  assert.equal(calls, 1);
  assert.equal(f.panel.hidden, true);
  assert.deepEqual(f.requests, []);
});

test("prepared and failed candidates remain explicit instead of displaying an applied update", async t => {
  const f = fixture(t);
  f.updater.open();
  f.reply({ selectedSnapshot: "current", busy: false, operation: {
    status: "needs-validation", candidate: "candidate",
    message: "Actual native UI acceptance is still required.",
  } });
  await flush();
  assert.match(f.panel.textContent, /still needs native UI and extension verification/);
  assert.doesNotMatch(f.panel.textContent, /Apply private update|Update selected/);
  const validate = f.panel.querySelectorAll("button").find(button => button.textContent === "Validate candidate");
  validate.click();
  assert.equal(f.requests.at(-1).operation, "validate");
  f.reply({ selectedSnapshot: "current", busy: false, operation: {
    status: "rejected", message: "Official package signature failed.",
  } });
  await flush();
  assert.match(f.panel.textContent, /Update was not applied/);
  assert.match(f.panel.textContent, /signature failed/);
});

test("busy jobs disable update mutations while keeping Close available", async t => {
  const f = fixture(t);
  f.updater.open();
  f.reply({ selectedSnapshot: "current", busy: true, operation: {
    status: "running", candidate: "candidate",
  } });
  await flush();
  const buttons = f.panel.querySelectorAll("button");
  assert.ok(buttons.filter(button => button.textContent !== "Close").every(button => button.disabled));
  const close = buttons.find(button => button.textContent === "Close");
  assert.equal(close.disabled, false);
  close.click();
  assert.equal(f.panel.hidden, true);
  assert.equal(f.ui.pendingTimers, 0);
});

test("disposing the updater removes only its own nodes and request timers", async t => {
  const f = fixture(t);
  f.updater.open();
  assert.equal(f.ui.pendingTimers, 1);
  f.updater.dispose();
  await flush();
  assert.equal(f.ui.pendingTimers, 0);
  assert.equal(f.panel.isConnected, false);
  assert.deepEqual(snapshotNative(f.ui, { ignoreAliasMarks: true }), f.before);
  f.ui.trigger.click();
  assert.equal(f.ui.nativeMenu.hidden, false);
});
