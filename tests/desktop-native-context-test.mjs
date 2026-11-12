import assert from "node:assert/strict";
import test from "node:test";
import { buildDesktopModelControlsPatch } from "../bridge/desktop-model-controls.mjs";
import {
  deferred,
  groups,
  listenerSnapshot,
  picker,
  props,
  snapshotNative as originalNativeSnapshot,
  snapshotTree,
} from "./fixtures/desktop-native-context-harness.mjs";

const snapshotNative = (ui, options) => originalNativeSnapshot(ui, {
  normalizeModelLabels: true, ignoreOpenState: true, ...options,
});

function makePicker(t, initial = props(), identity, options) {
  const ui = picker(initial, identity, options);
  t.after(() => ui.dispose());
  return ui;
}

function committingPicker(t, overrides = {}) {
  const calls = [];
  const before = [];
  const notifications = [];
  let ui;
  ui = makePicker(t, props({
    ...overrides,
    onBeforeSelectModel(slug) { before.push(slug); return true; },
    onSelectModel(slug, effort) {
      calls.push([slug, effort]);
      ui.commitAlternate({ ...ui.committedProps, model: slug, reasoningEffort: effort });
    },
    onSelectModelOption() {
      notifications.push([ui.committedProps.model, ui.committedProps.reasoningEffort]);
    },
  }));
  return { ui, calls, before, notifications };
}

function assertIdle(ui) {
  assert.equal(ui.pendingTimers, 0, "No acknowledgement/permission timer should remain");
  assert.equal(ui.pendingFrames, 0, "No refresh animation frame should remain");
  assert.equal(ui.pendingRecords, 0, "Observer records should have drained");
}

function changeThread(ui, next, replacement, patch = { conversationId: "thread-b" }) {
  const identity = { ...ui.identity, ...patch };
  if (replacement) ui.replaceTrigger(next, identity);
  else ui.commitAlternate(next, identity);
}

test("the public production factory installs revision-6 in-panel Context controls and preserves native DOM", t => {
  const ui = makePicker(t, props(), undefined, { autoInstall: false });
  const native = snapshotNative(ui, { ignoreAliasMarks: true });
  const originalChildren = [...ui.toolbar.children];
  const attachedFiber = ui.trigger.__reactFiber$synthetic;
  const documentListeners = listenerSnapshot(ui.document);
  const originalNodes = new Set(ui.document.querySelectorAll("*"));

  // Deliberately call the real exported factory, never the legacy alias.
  assert.equal(ui.runPatch(buildDesktopModelControlsPatch(groups)), "active");
  ui.flushFrames();
  const inspected = ui.controller.inspect();
  assert.equal(inspected.revision, 6);
  assert.equal(inspected.mode, "native-context-only");
  assert.equal(inspected.bound, true);
  assert.equal(inspected.nativeTriggerPreserved, true);
  assert.equal(inspected.model, "gpt-a");
  assert.equal(inspected.effort, "high");
  assert.equal(inspected.context, "long_context");
  assert.deepEqual(snapshotNative(ui, { ignoreAliasMarks: true }), native);
  assert.equal(ui.trigger.__reactFiber$synthetic, attachedFiber);
  assert.deepEqual(ui.toolbar.children.filter(node => node !== ui.button), originalChildren);
  assert.equal(ui.trigger.nextSibling, ui.trailingButton);
  assert.equal(ui.button.parentElement, ui.effortRow);
  assert.equal(ui.button.nextSibling, ui.menu);
  assert.equal(ui.menu.parentElement, ui.effortRow);
  assert.equal(inspected.placement, "native-effort-row");
  assert.equal(ui.button.getAttribute("aria-haspopup"), "menu");
  assert.equal(ui.button.getAttribute("aria-controls"), ui.menu.id);
  assert.equal(ui.button.getAttribute("aria-expanded"), "false");
  assert.equal(ui.menu.hidden, true);
  assert.equal(ui.menu.getAttribute("aria-label"), "Context window");
  assert.deepEqual(ui.document.querySelectorAll("*")
    .filter(node => !originalNodes.has(node)).map(node => node.id).sort(), [
    "codex-copilot-context-extension-style",
    "codex-copilot-context-menu",
    "codex-copilot-context-trigger",
  ], "Only the extension stylesheet, Context button and Context menu may be added");
  assert.equal(ui.activeObservers, 1);
  assert.equal(listenerSnapshot(ui.document)[0][1][0].callback,
    documentListeners[0][1][0].callback, "The native document handler must also remain installed");
  for (const id of [
    "codex-copilot-model-controls-style",
    "codex-copilot-model-menu",
    "codex-copilot-model-trigger",
    "codex-copilot-effort-trigger",
  ]) {
    assert.equal(ui.document.querySelector("#" + id), null, `No legacy replacement ${id}`);
  }
  assert.equal(ui.document.querySelector("[data-codex-copilot-native-model]"), null);
  assert.equal(ui.document.querySelector('[data-cc-model-setting="model"]'), null);
  assert.equal(ui.document.querySelector('[data-cc-model-setting="effort"]'), null);
  assert.doesNotMatch(ui.style.textContent, /data-codex-copilot-native-model/);
  assert.doesNotMatch(ui.style.textContent, /native-effort-slider|intelligence-trigger/);
  assertIdle(ui);
});

test("the composer placeholder reflects the committed model and effort without replacing native handlers", t => {
  const ui = makePicker(t, props(), undefined, { compactPanel: true });
  const listeners = listenerSnapshot(ui.trigger);
  const leaf = ui.trigger.querySelector("span");
  leaf.textContent = "\u9009\u62e9\u5f3a\u5ea6";
  ui.refresh();
  assert.equal(leaf.textContent, "GPT-A · High");
  assert.deepEqual(listenerSnapshot(ui.trigger), listeners);
  ui.commitAlternate({ ...ui.committedProps, reasoningEffort: "low" });
  ui.refresh();
  assert.equal(leaf.textContent, "GPT-A · Low");
  ui.dispose();
  assert.equal(leaf.textContent, "\u9009\u62e9\u5f3a\u5ea6");
});

test("a hidden stale composer does not prevent binding the visible picker", t => {
  const ui = makePicker(t, props(), undefined, { compactPanel: true });
  const hidden = ui.document.createElement("div");
  hidden.hidden = true;
  const stale = ui.document.createElement("button");
  stale.setAttribute("data-codex-intelligence-trigger", "true");
  hidden.append(stale);
  ui.document.body.insertBefore(hidden, ui.toolbar);
  ui.refresh();
  assert.equal(ui.controller.inspect().bound, true);
  assert.equal(ui.button.parentElement, ui.header);
  assert.equal(ui.controller.inspect().model, "gpt-a");
});

test("the compact native panel reserves model width and wraps labels rather than clipping them", t => {
  const ui = makePicker(t, props(), undefined, { compactPanel: true });
  assert.match(ui.style.textContent, /min-width: min\(340px, calc\(100vw - 24px\)\)/);
  assert.match(ui.style.textContent, /flex: 1 1 auto; min-width: 0/);
  assert.match(ui.style.textContent, /white-space: normal; overflow: visible; text-overflow: clip/);
  assert.equal(ui.nativeMenu.hasAttribute("data-cc-context-popover"), true);
  ui.dispose();
  assert.equal(ui.nativeMenu.hasAttribute("data-cc-context-popover"), false);
});

test("the original native trigger still opens its own popover with its original pointer and keyboard handlers", t => {
  const ui = makePicker(t);
  const triggerListeners = listenerSnapshot(ui.trigger);
  const nativeMenu = ui.nativeMenu;
  const nativeChildren = [...nativeMenu.children];
  ui.document.dispatch("pointerdown", ui.trigger);
  ui.key("ArrowDown", ui.trigger);
  ui.trigger.click();
  ui.flushFrames();
  assert.equal(ui.nativeEvents.clicks, 1);
  assert.equal(ui.nativeEvents.pointers, 1);
  assert.deepEqual(ui.nativeEvents.keys, ["ArrowDown"]);
  assert.equal(ui.trigger.getAttribute("aria-expanded"), "true");
  assert.equal(nativeMenu.hidden, false);
  assert.deepEqual(nativeMenu.children, nativeChildren);
  assert.equal(ui.menu.hidden, true, "The native click must not open a substitute picker");
  assert.deepEqual(listenerSnapshot(ui.trigger), triggerListeners);
  ui.trigger.click();
  ui.flushFrames();
  assert.equal(ui.nativeEvents.clicks, 2);
  assert.equal(nativeMenu.hidden, true);
  assert.equal(ui.trigger.hidden, false);
  assert.equal(ui.trigger.hasAttribute("data-codex-copilot-native-model"), false);
  assertIdle(ui);
});

test("the existing Effort slider keeps its nodes, styles and listeners throughout Context changes", async t => {
  const { ui, calls } = committingPicker(t);
  const slider = ui.nativeEffort;
  const sliderTree = snapshotTree(slider);
  const effortRow = snapshotTree(ui.effortRow);
  const listeners = listenerSnapshot(slider);
  const nativeCss = ui.nativeStyle.textContent;
  ui.trigger.click();
  ui.flushFrames();
  ui.open();
  ui.option("default").click();
  await ui.settle();
  assert.deepEqual(calls, [["gpt-a--default-context", "high"]]);
  assert.deepEqual(snapshotTree(slider), sliderTree);
  assert.deepEqual(snapshotTree(ui.effortRow), effortRow);
  assert.equal(ui.nativeStyle.textContent, nativeCss);
  assert.equal(slider.isConnected, true);
  assert.equal(ui.nativeMenu.hidden, false);
  assert.equal(ui.trigger.getAttribute("aria-expanded"), "true");
  ui.document.dispatch("pointerdown", slider);
  ui.key("ArrowLeft", slider);
  ui.inputEffort("low");
  ui.refresh();
  assert.deepEqual(ui.nativeEvents.effortInputs, ["low"]);
  assert.equal(ui.nativeEvents.pointers, 1);
  assert.deepEqual(ui.nativeEvents.keys, ["ArrowLeft"]);
  assert.equal(ui.committedProps.model, "gpt-a--default-context");
  assert.equal(ui.committedProps.reasoningEffort, "low");
  assert.equal(ui.controller.inspect().effort, "low");
  assert.equal(ui.thumb.style.transform, "translateX(0%)");
  assert.deepEqual(listenerSnapshot(slider), listeners);
  assert.equal(ui.document.querySelector("#native-effort-slider"), slider);
  assert.deepEqual(calls, [["gpt-a--default-context", "high"]],
    "The native slider must not accidentally dispatch a Context selection");
  assertIdle(ui);
});

test("only exact native model aliases are marked, never the native Effort row or unknown rows", async t => {
  const { ui } = committingPicker(t);
  const attribute = "data-cc-context-model-alias-hidden";
  const sliderTree = snapshotTree(ui.effortRow);
  assert.equal(ui.modelRows.get("gpt-a--default-context").hasAttribute(attribute), true);
  assert.equal(ui.modelRows.get("gpt-a--long-context").hasAttribute(attribute), false);
  assert.equal(ui.unknownRow.hasAttribute(attribute), false,
    "A label containing an alias as a substring is not an exact catalog alias");
  assert.deepEqual(snapshotTree(ui.effortRow), sliderTree);
  assert.equal(ui.effortRow.querySelectorAll("[" + attribute + "]").length, 0);
  ui.open();
  ui.option("default").click();
  await ui.settle();
  assert.equal(ui.modelRows.get("gpt-a--default-context").hasAttribute(attribute), false);
  assert.equal(ui.modelRows.get("gpt-a--long-context").hasAttribute(attribute), true);
  assert.deepEqual(snapshotTree(ui.effortRow), sliderTree);
  ui.dispose();
  assert.equal(ui.nativeMenu.querySelectorAll("[" + attribute + "]").length, 0);
  assert.deepEqual(snapshotTree(ui.effortRow), sliderTree);
});

for (const [base, initialTier, effort, expectedWindow] of [
  ["gpt-a", "default", "high", "1.1M"],
  ["gpt-a", "long_context", "high", "400K"],
  ["gpt-b", "default", "low", "800K"],
  ["gpt-b", "long_context", "medium", "300K"],
]) {
  const initialSlug = `${base}--${initialTier === "default" ? "default" : "long"}-context`;
  const targetTier = initialTier === "default" ? "long_context" : "default";
  const targetSlug = `${base}--${targetTier === "default" ? "default" : "long"}-context`;
  test(`${base} ${initialTier} -> ${targetTier} changes only Context and preserves ${effort} Effort`, async t => {
    const { ui, calls, before, notifications } = committingPicker(t, {
      model: initialSlug, reasoningEffort: effort,
    });
    const native = snapshotNative(ui, { ignoreAliasMarks: true });
    ui.open();
    assert.equal(ui.option(initialTier).getAttribute("aria-checked"), "true");
    assert.equal(ui.option(targetTier).getAttribute("aria-checked"), "false");
    assert.deepEqual(ui.menu.querySelectorAll("button").map(node =>
      node.getAttribute("data-cc-context-tier")), ["default", "long_context"]);
    ui.option(targetTier).click();
    await ui.settle();
    assert.deepEqual(before, [targetSlug]);
    assert.deepEqual(calls, [[targetSlug, effort]]);
    assert.deepEqual(notifications, [[targetSlug, effort]]);
    assert.equal(ui.committedProps.model, targetSlug);
    assert.equal(ui.committedProps.reasoningEffort, effort);
    assert.equal(ui.controller.inspect().model, base);
    assert.equal(ui.controller.inspect().context, targetTier);
    assert.equal(ui.menu.hidden, true);
    assert.equal(ui.button.getAttribute("aria-label"), "Context window " + expectedWindow);
    assert.deepEqual(snapshotNative(ui, { ignoreAliasMarks: true }), native);
    assertIdle(ui);
  });
}

test("choosing the already selected Context is a no-op and focuses only the additional button", async t => {
  const { ui, calls, before, notifications } = committingPicker(t);
  ui.open();
  ui.option("long_context").click();
  await ui.settle();
  assert.deepEqual(calls, []);
  assert.deepEqual(before, []);
  assert.deepEqual(notifications, []);
  assert.equal(ui.menu.hidden, true);
  assert.equal(ui.document.activeElement, ui.button);
  assert.equal(ui.trigger.getAttribute("aria-expanded"), "true");
  assertIdle(ui);
});

test("a Context choice stays pending while its original click bubbles to document", async t => {
  const permission = deferred();
  t.after(() => permission.resolve(true));
  const calls = [];
  let ui;
  ui = makePicker(t, props({
    onBeforeSelectModel() { return permission.promise; },
    onSelectModel(slug, effort) {
      calls.push([slug, effort]);
      ui.commitAlternate({ ...ui.committedProps, model: slug, reasoningEffort: effort });
    },
  }));
  ui.open();
  const choice = ui.option("default");
  const event = choice.click();
  assert.ok(event.composedPath().includes(ui.menu));
  assert.ok(event.composedPath().includes(ui.document));
  assert.equal(ui.menu.hidden, false,
    "Replacing menu children must not reinterpret this bubbling click as an outside click");
  assert.equal(ui.pendingTimers, 1, "The same click must not cancel its pending permission");
  assert.deepEqual(calls, []);
  permission.resolve(true);
  await ui.settle();
  assert.deepEqual(calls, [["gpt-a--default-context", "high"]]);
  assert.equal(ui.menu.hidden, true);
  assertIdle(ui);
});

for (const phase of ["permission", "selection"]) {
  for (const result of ["false", "async-false", "throw", "reject"]) {
    test(`${phase} ${result} reports refusal without optimistic changes and allows an explicit retry`, async t => {
      let refusing = true;
      const calls = [];
      const before = [];
      const notifications = [];
      const refuse = () => {
        if (result === "false") return false;
        if (result === "async-false") return Promise.resolve(false);
        if (result === "throw") throw new Error("native Context refused");
        return Promise.reject(new Error("native Context refused"));
      };
      let ui;
      ui = makePicker(t, props({
        onBeforeSelectModel(slug) {
          before.push(slug);
          return refusing && phase === "permission" ? refuse() : true;
        },
        onSelectModel(slug, effort) {
          calls.push([slug, effort]);
          if (refusing && phase === "selection") return refuse();
          ui.commitAlternate({ ...ui.committedProps, model: slug, reasoningEffort: effort });
        },
        onSelectModelOption() { notifications.push("applied"); },
      }));
      const native = snapshotNative(ui, { ignoreAliasMarks: true });
      ui.open();
      ui.option("default").click();
      await ui.settle();
      assert.deepEqual(before, ["gpt-a--default-context"]);
      assert.deepEqual(calls, phase === "selection" ? [["gpt-a--default-context", "high"]] : []);
      assert.deepEqual(notifications, []);
      assert.equal(ui.committedProps.model, "gpt-a--long-context");
      assert.equal(ui.committedProps.reasoningEffort, "high");
      assert.equal(ui.menu.hidden, false);
      assert.equal(ui.option("default").disabled, false);
      if (result === "throw" || result === "reject") {
        assert.deepEqual(ui.alerts(), ["native Context refused"]);
      } else {
        assert.match(ui.alerts().join(" "), phase === "permission" ? /not allow/i : /not apply/i);
      }
      assert.deepEqual(snapshotNative(ui, { ignoreAliasMarks: true }), native);
      assertIdle(ui);
      refusing = false;
      ui.option("default").click();
      await ui.settle();
      assert.deepEqual(before, ["gpt-a--default-context", "gpt-a--default-context"]);
      assert.equal(calls.length, phase === "selection" ? 2 : 1);
      assert.deepEqual(calls.at(-1), ["gpt-a--default-context", "high"]);
      assert.deepEqual(notifications, ["applied"]);
      assert.equal(ui.menu.hidden, true);
      assert.equal(ui.committedProps.reasoningEffort, "high");
      assertIdle(ui);
    });
  }
}

test("native Effort changed during awaited permission is preserved by the newest committed callback", async t => {
  const permission = deferred();
  t.after(() => permission.resolve(true));
  const before = [];
  const calls = [];
  let ui;
  ui = makePicker(t, props({
    onBeforeSelectModel(slug) { before.push(slug); return permission.promise; },
    onSelectModel(...args) { calls.push(["stale", ...args]); },
  }));
  const sliderListeners = listenerSnapshot(ui.nativeEffort);
  ui.open();
  const triggerTree = snapshotTree(ui.trigger);
  ui.option("default").click();
  await ui.settle();
  assert.deepEqual(calls, [], "Permission must finish before a native model callback is invoked");
  assert.deepEqual(before, ["gpt-a--default-context"]);
  assert.ok(ui.menu.querySelectorAll("button").every(option => option.disabled));
  assert.equal(ui.trigger.disabled, false, "A pending Context choice must not disable the native picker");
  ui.inputEffort("low");
  assert.equal(ui.committedProps.reasoningEffort, "low");
  ui.commitAlternate({
    ...ui.committedProps,
    onSelectModel(slug, effort) {
      calls.push(["current", slug, effort]);
      ui.commitAlternate({ ...ui.committedProps, model: slug, reasoningEffort: effort });
    },
  });
  ui.refresh();
  assert.equal(ui.button.disabled, true);
  assert.deepEqual(snapshotTree(ui.trigger), triggerTree);
  assert.deepEqual(listenerSnapshot(ui.nativeEffort), sliderListeners);
  permission.resolve(true);
  await ui.settle();
  assert.deepEqual(calls, [["current", "gpt-a--default-context", "low"]],
    "The old high Effort and old callback must never overwrite the native slider's newer commit");
  assert.equal(ui.committedProps.model, "gpt-a--default-context");
  assert.equal(ui.committedProps.reasoningEffort, "low");
  assert.equal(ui.controller.inspect().effort, "low");
  assert.deepEqual(ui.nativeEvents.effortInputs, ["low"]);
  assert.equal(ui.menu.hidden, true);
  assertIdle(ui);
});

test("uncommitted Effort work cannot replace the current effort while permission is pending", async t => {
  const permission = deferred();
  t.after(() => permission.resolve(true));
  const calls = [];
  let ui;
  ui = makePicker(t, props({
    onBeforeSelectModel() { return permission.promise; },
    onSelectModel(slug, effort) {
      calls.push([slug, effort]);
      ui.commitAlternate({ ...ui.committedProps, model: slug, reasoningEffort: effort });
    },
  }));
  ui.open();
  ui.option("default").click();
  await ui.settle();
  ui.prepareAlternate({ ...ui.committedProps, reasoningEffort: "low" });
  permission.resolve(true);
  await ui.settle();
  assert.deepEqual(calls, [["gpt-a--default-context", "high"]]);
  assert.equal(ui.committedProps.reasoningEffort, "high");
  assertIdle(ui);
});

test("a delayed native selection stays pending even if React commits before its promise resolves", async t => {
  const completion = deferred();
  t.after(() => completion.resolve());
  const calls = [];
  const notifications = [];
  const ui = makePicker(t, props({
    onSelectModel(...args) { calls.push(args); return completion.promise; },
    onSelectModelOption() { notifications.push("applied"); },
  }));
  ui.open();
  ui.option("default").click();
  await ui.settle();
  assert.deepEqual(calls, [["gpt-a--default-context", "high"]]);
  ui.commitAlternate({ ...ui.committedProps, model: "gpt-a--default-context" });
  ui.refresh();
  ui.advance(100);
  assert.equal(ui.menu.hidden, false);
  assert.ok(ui.menu.querySelectorAll("button").every(option => option.disabled));
  assert.deepEqual(notifications, []);
  completion.resolve();
  await ui.settle();
  assert.equal(ui.menu.hidden, true);
  assert.deepEqual(notifications, ["applied"]);
  assert.deepEqual(calls, [["gpt-a--default-context", "high"]]);
  assertIdle(ui);
});

test("a void native wrapper waits for committed Context and Effort, ignoring matching alternate work", async t => {
  const calls = [];
  const ui = makePicker(t, props({ onSelectModel(...args) { calls.push(args); } }));
  const expando = ui.trigger.__reactFiber$synthetic;
  ui.open();
  ui.option("default").click();
  await ui.settle();
  assert.deepEqual(calls, [["gpt-a--default-context", "high"]]);
  assert.equal(ui.menu.hidden, false);
  assert.equal(ui.option("default").disabled, true);
  const acknowledged = { ...ui.committedProps, model: "gpt-a--default-context" };
  ui.prepareAlternate(acknowledged);
  ui.advance(100);
  assert.equal(ui.menu.hidden, false, "An uncommitted matching alternate is not acknowledgement");
  ui.commitAlternate({ ...acknowledged, reasoningEffort: "low" });
  ui.advance(100);
  assert.equal(ui.menu.hidden, false, "Matching Context but not Effort is not acknowledgement");
  ui.commitAlternate(acknowledged);
  ui.advance(100);
  assert.equal(ui.menu.hidden, true);
  assert.equal(ui.button.getAttribute("aria-label"), "Context window 400K");
  assert.equal(ui.trigger.__reactFiber$synthetic, expando);
  assert.equal(calls.length, 1, "Acknowledgement polling must never resend the selection");
  assertIdle(ui);
});

test("an unacknowledged Context callback times out without optimistic state or automatic retry", async t => {
  const calls = [];
  const ui = makePicker(t, props({ onSelectModel(...args) { calls.push(args); } }));
  ui.open();
  ui.option("default").click();
  await ui.settle();
  ui.advance(7999);
  assert.equal(ui.menu.hidden, false);
  assert.equal(ui.option("default").disabled, true);
  assert.deepEqual(ui.alerts(), []);
  ui.advance(1);
  assert.match(ui.alerts().join(" "), /not confirmed/i);
  assert.equal(ui.menu.hidden, false);
  assert.equal(ui.option("default").disabled, false);
  assert.equal(ui.committedProps.model, "gpt-a--long-context");
  assert.equal(ui.committedProps.reasoningEffort, "high");
  assert.equal(ui.button.getAttribute("aria-label"), "Context window 1.1M");
  ui.advance(20_000);
  assert.deepEqual(calls, [["gpt-a--default-context", "high"]]);
  assertIdle(ui);
});

for (const phase of ["permission", "selection"]) {
  test(`a ${phase} promise settling after the deadline cannot finish an expired Context operation`, async t => {
    const completion = deferred();
    t.after(() => completion.resolve(true));
    const calls = [];
    const notifications = [];
    const ui = makePicker(t, props({
      onBeforeSelectModel() { return phase === "permission" ? completion.promise : true; },
      onSelectModel(...args) {
        calls.push(args);
        return phase === "selection" ? completion.promise : undefined;
      },
      onSelectModelOption() { notifications.push("applied"); },
    }));
    ui.open();
    ui.option("default").click();
    await ui.settle();
    ui.advance(8000);
    assert.match(ui.alerts().join(" "), /not confirmed/i);
    assert.equal(ui.option("default").disabled, false);
    assert.equal(ui.pendingTimers, 0);
    completion.resolve(true);
    await ui.settle();
    assert.deepEqual(calls, phase === "permission" ? [] : [["gpt-a--default-context", "high"]]);
    assert.deepEqual(notifications, []);
    assert.equal(ui.committedProps.model, "gpt-a--long-context");
    assert.equal(ui.committedProps.reasoningEffort, "high");
    assert.equal(ui.menu.hidden, false);
    assert.match(ui.alerts().join(" "), /not confirmed/i);
    assertIdle(ui);
  });
}

for (const dismissal of ["outside-click", "Escape"]) {
  test(`${dismissal} cancels awaited permission without a late selection or stolen focus`, async t => {
    const permission = deferred();
    t.after(() => permission.resolve(true));
    const calls = [];
    const ui = makePicker(t, props({
      onBeforeSelectModel() { return permission.promise; },
      onSelectModel(...args) { calls.push(args); },
    }));
    ui.open();
    ui.option("default").click();
    await ui.settle();
    if (dismissal === "Escape") {
      const event = ui.key("Escape", ui.menu);
      assert.equal(event.defaultPrevented, true);
      assert.equal(ui.document.activeElement, ui.button);
    } else {
      ui.dismiss();
    }
    assert.equal(ui.menu.hidden, true);
    assert.equal(ui.pendingTimers, 0);
    ui.editor.focus();
    permission.resolve(true);
    await ui.settle();
    assert.deepEqual(calls, []);
    assert.equal(ui.document.activeElement, ui.editor);
    assert.equal(ui.menu.hidden, true);
    assertIdle(ui);
  });
}

for (const replacement of [false, true]) {
  const label = replacement ? "a replacement native trigger" : "the same native trigger";
  test(`conversation navigation with ${label} closes an open Context menu even when settings match`, t => {
    const ui = makePicker(t);
    ui.open();
    changeThread(ui, props(), replacement);
    ui.refresh();
    assert.equal(ui.menu.hidden, true);
    assert.equal(ui.button.getAttribute("aria-expanded"), "false");
    assert.equal(ui.trigger.hasAttribute("data-codex-copilot-native-model"), false);
    assertIdle(ui);
  });

  test(`a stale Context row click after navigation with ${label} updates neither conversation`, async t => {
    const calls = [];
    const ui = makePicker(t, props({
      onSelectModel(...args) { calls.push(["thread-a", ...args]); },
    }));
    ui.open();
    const oldChoice = ui.option("default");
    changeThread(ui, props({
      onSelectModel(...args) { calls.push(["thread-b", ...args]); },
    }), replacement);
    // Intentionally click before the MutationObserver/rAF refresh.
    oldChoice.click();
    await ui.settle();
    assert.deepEqual(calls, []);
    assert.equal(ui.menu.hidden, true);
    assert.equal(ui.committedProps.model, "gpt-a--long-context");
    assertIdle(ui);
  });

  for (const result of ["resolve", "reject"]) {
    test(`old permission ${result} after navigation with ${label} cannot affect the new Context menu`, async t => {
      const permission = deferred();
      t.after(() => permission.resolve(true));
      const calls = [];
      const ui = makePicker(t, props({
        onBeforeSelectModel() { return permission.promise; },
        onSelectModel(...args) { calls.push(["thread-a", ...args]); },
      }));
      ui.open();
      ui.option("default").click();
      await ui.settle();
      changeThread(ui, props({
        onSelectModel(...args) { calls.push(["thread-b", ...args]); },
      }), replacement);
      ui.refresh();
      assert.equal(ui.menu.hidden, true);
      assert.equal(ui.pendingTimers, 0);
      ui.open();
      const focus = ui.document.activeElement;
      if (result === "resolve") permission.resolve(true);
      else permission.reject(new Error("old permission rejected"));
      await ui.settle();
      assert.deepEqual(calls, []);
      assert.equal(ui.menu.hidden, false);
      assert.equal(ui.option("default").disabled, false);
      assert.deepEqual(ui.alerts(), []);
      assert.equal(ui.document.activeElement, focus);
      assertIdle(ui);
    });
  }
}

for (const field of ["permissionsHostId", "permissionsCwdOverride"]) {
  test(`a native ${field} change invalidates the Context owner without changing conversationId`, t => {
    const ui = makePicker(t);
    ui.open();
    ui.setIdentity({ [field]: field === "permissionsHostId" ? "another-host" : "C:\\another-fixture" });
    ui.refresh();
    assert.equal(ui.menu.hidden, true);
    assert.equal(ui.button.disabled, false);
    assertIdle(ui);
  });
}

for (const result of ["resolve", "reject"]) {
  test(`an old selection ${result} cannot unlock or close a newer conversation's pending Context operation`, async t => {
    const old = deferred();
    const newer = deferred();
    t.after(() => { old.resolve(); newer.resolve(); });
    const calls = [];
    const notifications = [];
    const ui = makePicker(t, props({
      onSelectModel(...args) { calls.push(["thread-a", ...args]); return old.promise; },
      onSelectModelOption() { notifications.push("thread-a"); },
    }));
    ui.open();
    ui.option("default").click();
    await ui.settle();
    assert.deepEqual(calls, [["thread-a", "gpt-a--default-context", "high"]]);
    changeThread(ui, props({
      onSelectModel(...args) { calls.push(["thread-b", ...args]); return newer.promise; },
      onSelectModelOption() { notifications.push("thread-b"); },
    }), false);
    ui.refresh();
    assert.equal(ui.pendingTimers, 0);
    ui.open();
    ui.option("default").click();
    await ui.settle();
    if (result === "resolve") old.resolve();
    else old.reject(new Error("old selection rejected"));
    await ui.settle();
    assert.equal(ui.menu.hidden, false);
    assert.equal(ui.option("default").disabled, true);
    assert.equal(ui.pendingTimers, 1);
    assert.deepEqual(ui.alerts(), []);
    assert.deepEqual(notifications, []);
    ui.option("default").click();
    assert.deepEqual(calls, [
      ["thread-a", "gpt-a--default-context", "high"],
      ["thread-b", "gpt-a--default-context", "high"],
    ], "The new pending operation must still block duplicate submission");
    ui.commitAlternate({ ...ui.committedProps, model: "gpt-a--default-context" });
    newer.resolve();
    await ui.settle();
    assert.equal(ui.menu.hidden, true);
    assert.deepEqual(notifications, ["thread-b"]);
    assertIdle(ui);
  });
}

test("conversation navigation cancels committed-acknowledgement polling without later retries", async t => {
  const calls = [];
  const ui = makePicker(t, props({
    onSelectModel(...args) { calls.push(["thread-a", ...args]); },
  }));
  ui.open();
  ui.option("default").click();
  await ui.settle();
  assert.equal(ui.pendingTimers, 1);
  changeThread(ui, props(), false);
  ui.refresh();
  assert.equal(ui.pendingTimers, 0);
  ui.open();
  ui.advance(10_000);
  assert.equal(ui.menu.hidden, false);
  assert.equal(ui.option("default").disabled, false);
  assert.deepEqual(ui.alerts(), []);
  assert.deepEqual(calls, [["thread-a", "gpt-a--default-context", "high"]]);
  assertIdle(ui);
});

for (const boundary of ["disabled-property", "aria-disabled", "props.disabled"]) {
  test(`native ${boundary} removes only the Context attachment and restores it when enabled`, t => {
    const ui = makePicker(t);
    const button = ui.button;
    const trigger = ui.trigger;
    const sliderTree = snapshotTree(ui.nativeEffort);
    ui.open();
    if (boundary === "disabled-property") trigger.disabled = true;
    else if (boundary === "aria-disabled") trigger.setAttribute("aria-disabled", "true");
    else ui.setProps({ ...ui.committedProps, disabled: true });
    const disabledTrigger = snapshotTree(trigger);
    ui.refresh();
    assert.equal(ui.controller.inspect().bound, false);
    assert.equal(ui.button, null);
    assert.equal(ui.menu.hidden, true);
    assert.deepEqual(snapshotTree(trigger), disabledTrigger);
    assert.deepEqual(snapshotTree(ui.nativeEffort), sliderTree);
    assert.equal(trigger.isConnected, true);
    assert.equal(trigger.hidden, false);
    if (boundary === "disabled-property") trigger.disabled = false;
    else if (boundary === "aria-disabled") trigger.removeAttribute("aria-disabled");
    else ui.setProps({ ...ui.committedProps, disabled: false });
    ui.refresh();
    assert.equal(ui.button, button);
    assert.equal(ui.trigger, trigger);
    assert.equal(trigger.nextSibling, ui.trailingButton);
    assert.equal(button.parentElement, ui.effortRow);
    assert.equal(ui.controller.inspect().bound, true);
    assertIdle(ui);
  });
}

for (const [name, flags] of [
  ["modelOptionsDisabled", { modelOptionsDisabled: true }],
  ["daybreak.disabled", { daybreak: { disabled: true } }],
  ["daybreak.isSaving", { daybreak: { isSaving: true } }],
]) {
  test(`${name} disables Context without rewriting the native trigger or Effort slider`, t => {
    const calls = [];
    const ui = makePicker(t, props({ onSelectModel(...args) { calls.push(args); } }));
    const triggerTree = snapshotTree(ui.trigger);
    const sliderTree = snapshotTree(ui.nativeEffort);
    ui.setProps({ ...ui.committedProps, ...flags });
    ui.refresh();
    assert.equal(ui.button.disabled, true);
    ui.button.click();
    assert.equal(ui.menu.hidden, true);
    assert.deepEqual(calls, []);
    assert.deepEqual(snapshotTree(ui.trigger), triggerTree);
    assert.deepEqual(snapshotTree(ui.nativeEffort), sliderTree);
    assert.equal(ui.trigger.disabled, false);
    assert.equal(ui.nativeEffort.hasAttribute("aria-disabled"), false);
    assertIdle(ui);
  });
}

test("reasoningEffortDisabled does not block an otherwise permitted Context change", async t => {
  const { ui, calls } = committingPicker(t, { reasoningEffortDisabled: true });
  const sliderTree = snapshotTree(ui.nativeEffort);
  assert.equal(ui.button.disabled, false);
  ui.open();
  ui.option("default").click();
  await ui.settle();
  assert.deepEqual(calls, [["gpt-a--default-context", "high"]]);
  assert.deepEqual(snapshotTree(ui.nativeEffort), sliderTree);
  assertIdle(ui);
});

test("per-option native disabled reasons prevent Context submission while preserving enabled native controls", async t => {
  const calls = [];
  const active = props({
    model: "gpt-a--default-context",
    onSelectModel(...args) { calls.push(args); },
  });
  active.modelOptions.find(option => option.model.model === "gpt-a--long-context")
    .disabledReason = { reason: "native unavailable" };
  const ui = makePicker(t, active);
  const sliderTree = snapshotTree(ui.nativeEffort);
  ui.open();
  assert.equal(ui.option("long_context").disabled, true);
  assert.equal(ui.option("default").disabled, false);
  ui.option("long_context").click();
  await ui.settle();
  assert.deepEqual(calls, []);
  assert.equal(ui.menu.hidden, false);
  assert.deepEqual(snapshotTree(ui.nativeEffort), sliderTree);
  assert.equal(ui.trigger.disabled, false);
  assertIdle(ui);
});

test("a model with only one available Context keeps the native picker and Effort but disables the extra button", t => {
  const ui = makePicker(t, props({ model: "gpt-c" }));
  assert.equal(ui.button.disabled, true);
  assert.equal(ui.controller.inspect().model, "gpt-c");
  assert.equal(ui.controller.inspect().context, "default");
  ui.button.click();
  assert.equal(ui.menu.hidden, true);
  ui.trigger.click();
  ui.flushFrames();
  assert.equal(ui.nativeMenu.hidden, false);
  ui.inputEffort("low");
  ui.refresh();
  assert.equal(ui.controller.inspect().effort, "low");
  assert.deepEqual(ui.nativeEvents.effortInputs, ["low"]);
  assertIdle(ui);
});

for (const change of ["native-disabled", "model-options-disabled", "target-disabled", "target-removed", "base-model"]) {
  test(`${change} while permission is pending cannot apply a stale Context selection`, async t => {
    const permission = deferred();
    t.after(() => permission.resolve(true));
    const calls = [];
    const ui = makePicker(t, props({
      onBeforeSelectModel() { return permission.promise; },
      onSelectModel(...args) { calls.push(args); },
    }));
    ui.open();
    ui.option("default").click();
    await ui.settle();
    if (change === "native-disabled") {
      ui.trigger.disabled = true;
    } else if (change === "model-options-disabled") {
      ui.setProps({ ...ui.committedProps, modelOptionsDisabled: true });
    } else if (change === "target-disabled") {
      ui.setProps({
        ...ui.committedProps,
        modelOptions: ui.committedProps.modelOptions.map(option =>
          option.model.model === "gpt-a--default-context"
            ? { ...option, disabledReason: { reason: "became unavailable" } } : option),
      });
    } else if (change === "target-removed") {
      ui.setProps({
        ...ui.committedProps,
        modelOptions: ui.committedProps.modelOptions.filter(option =>
          option.model.model !== "gpt-a--default-context"),
      });
    } else {
      ui.commitAlternate({
        ...ui.committedProps, model: "gpt-b--long-context", reasoningEffort: "medium",
      });
    }
    // No refresh first: choose() must enforce the current native boundary itself.
    permission.resolve(true);
    await ui.settle();
    assert.deepEqual(calls, []);
    assert.equal(ui.committedProps.model,
      change === "base-model" ? "gpt-b--long-context" : "gpt-a--long-context");
    assert.equal(ui.committedProps.reasoningEffort, change === "base-model" ? "medium" : "high");
    assert.equal(ui.pendingTimers, 0);
    if (change === "native-disabled" || change === "base-model") {
      assert.equal(ui.menu.hidden, true);
    } else {
      assert.equal(ui.menu.hidden, false);
      assert.match(ui.alerts().join(" "), /no longer supports|unavailable/i);
    }
    ui.flushFrames();
    assertIdle(ui);
  });
}

test("repeated production injection refreshes one controller without duplicating nodes, observers or listeners", t => {
  const ui = makePicker(t);
  const controller = ui.controller;
  const button = ui.button;
  const menu = ui.menu;
  const style = ui.style;
  const documentListeners = listenerSnapshot(ui.document);
  const native = snapshotNative(ui, { ignoreAliasMarks: true });
  for (let count = 0; count < 12; count++) {
    assert.equal(ui.install(), "active");
    ui.flushFrames();
    assert.equal(ui.controller, controller);
    assert.equal(ui.button, button);
    assert.equal(ui.menu, menu);
    assert.equal(ui.style, style);
  }
  for (const id of [button.id, menu.id, style.id]) {
    assert.equal(ui.document.querySelectorAll("#" + id).length, 1);
  }
  assert.equal(ui.activeObservers, 1);
  assert.deepEqual(listenerSnapshot(ui.document), documentListeners);
  assert.deepEqual(snapshotNative(ui, { ignoreAliasMarks: true }), native);
  ui.open();
  assert.equal(ui.menu.hidden, false, "One click must not toggle twice due to duplicate listeners");
  ui.flushFrames(); // Deliver the real observer microtask caused by opening the menu.
  assertIdle(ui);
});

test("reinjection during awaited permission retains the operation and sends only one native callback", async t => {
  const permission = deferred();
  t.after(() => permission.resolve(true));
  const calls = [];
  let ui;
  ui = makePicker(t, props({
    onBeforeSelectModel() { return permission.promise; },
    onSelectModel(slug, effort) {
      calls.push([slug, effort]);
      ui.commitAlternate({ ...ui.committedProps, model: slug, reasoningEffort: effort });
    },
  }));
  const controller = ui.controller;
  ui.open();
  ui.option("default").click();
  await ui.settle();
  assert.equal(ui.install(), "active");
  ui.flushFrames();
  assert.equal(ui.controller, controller);
  assert.equal(ui.pendingTimers, 1);
  assert.ok(ui.menu.querySelectorAll("button").every(option => option.disabled));
  ui.option("default").click();
  permission.resolve(true);
  await ui.settle();
  assert.deepEqual(calls, [["gpt-a--default-context", "high"]]);
  assert.equal(ui.menu.hidden, true);
  assertIdle(ui);
});

test("disposal is idempotent, restores aliases, and removes only extension-owned nodes and listeners", t => {
  const ui = makePicker(t, props(), undefined, { autoInstall: false });
  const native = snapshotNative(ui);
  const toolbarChildren = [...ui.toolbar.children];
  const documentListeners = listenerSnapshot(ui.document);
  assert.equal(ui.install(), "active");
  ui.flushFrames();
  const oldController = ui.controller;
  const oldButton = ui.button;
  const oldMenu = ui.menu;
  const oldStyle = ui.style;
  ui.open();
  // Queue a real external mutation, then dispose before its scheduled refresh.
  ui.trigger.setAttribute("aria-expanded", ui.trigger.getAttribute("aria-expanded"));
  ui.flushObservers();
  assert.equal(ui.pendingFrames, 1);
  oldController.dispose();
  oldController.dispose();
  ui.flushFrames();
  assert.equal(ui.controller, undefined);
  assert.equal(ui.button, null);
  assert.equal(ui.menu, null);
  assert.equal(ui.style, null);
  assert.equal(oldButton.isConnected, false);
  assert.equal(oldMenu.isConnected, false);
  assert.equal(oldStyle.isConnected, false);
  assert.deepEqual(listenerSnapshot(oldButton), []);
  assert.deepEqual(listenerSnapshot(oldMenu), []);
  assert.equal(ui.activeObservers, 0);
  assert.deepEqual(snapshotNative(ui), native);
  assert.deepEqual(ui.toolbar.children, toolbarChildren);
  assert.deepEqual(listenerSnapshot(ui.document), documentListeners);
  assertIdle(ui);

  assert.equal(ui.install(), "active");
  ui.flushFrames();
  const currentController = ui.controller;
  assert.notEqual(currentController, oldController);
  oldController.dispose();
  assert.equal(ui.controller, currentController, "An old disposer must not delete the new controller");
  assert.equal(ui.activeObservers, 1);
  assert.equal(ui.document.querySelectorAll("#codex-copilot-context-trigger").length, 1);
  ui.trigger.click();
  ui.flushFrames();
  assert.equal(ui.nativeEvents.clicks, 2, "One native opening and one native closing click remain intact");
  assert.equal(ui.nativeMenu.hidden, true, "The restored native trigger closes its still-open native popover");
  assertIdle(ui);
});

for (const phase of ["permission", "acknowledgement"]) {
  test(`disposal during ${phase} cancels timers and cannot resurrect Context controls`, async t => {
    const permission = deferred();
    t.after(() => permission.resolve(true));
    const calls = [];
    const ui = makePicker(t, props({
      onBeforeSelectModel() { return phase === "permission" ? permission.promise : true; },
      onSelectModel(...args) { calls.push(args); },
    }));
    ui.open();
    ui.option("default").click();
    await ui.settle();
    assert.equal(ui.pendingTimers, 1);
    ui.dispose();
    assertIdle(ui);
    permission.resolve(true);
    await ui.settle();
    ui.advance(10_000);
    assert.equal(ui.controller, undefined);
    assert.equal(ui.button, null);
    assert.equal(ui.menu, null);
    assert.equal(ui.style, null);
    assert.equal(ui.activeObservers, 0);
    assert.deepEqual(calls, phase === "permission" ? [] : [["gpt-a--default-context", "high"]]);
    assert.deepEqual(listenerSnapshot(ui.document), ui.nativeDocumentListeners);
    assertIdle(ui);
  });
}

test("an undisposable previous patch requests reload without layering Context controls over it", t => {
  const ui = makePicker(t, props(), undefined, { autoInstall: false });
  const previous = { revision: 1 };
  ui.scope.__codexCopilotModelControlsV1 = previous;
  const native = snapshotNative(ui);
  assert.equal(ui.install(), "reload-required");
  assert.equal(ui.controller, previous);
  assert.equal(ui.button, null);
  assert.equal(ui.menu, null);
  assert.equal(ui.style, null);
  assert.equal(ui.activeObservers, 0);
  assert.deepEqual(snapshotNative(ui), native);
  // This fixture-owned stub deliberately has no disposer.
  delete ui.scope.__codexCopilotModelControlsV1;
});

test("a disposable previous patch is cleaned once before installing the production Context extension", t => {
  const ui = makePicker(t, props(), undefined, { autoInstall: false });
  const native = snapshotNative(ui, { ignoreAliasMarks: true });
  const previousNode = ui.document.createElement("div");
  previousNode.id = "fixture-owned-previous-control";
  ui.document.body.appendChild(previousNode);
  let disposals = 0;
  ui.scope.__codexCopilotModelControlsV1 = {
    revision: 3,
    dispose() { disposals++; previousNode.remove(); },
  };
  assert.equal(ui.install(), "active");
  ui.flushFrames();
  assert.equal(disposals, 1);
  assert.equal(previousNode.isConnected, false);
  assert.equal(ui.controller.revision, 6);
  assert.equal(ui.controller.mode, "native-context-only");
  assert.deepEqual(snapshotNative(ui, { ignoreAliasMarks: true }), native);
  assert.equal(ui.activeObservers, 1);
  assert.equal(ui.install(), "active");
  ui.flushFrames();
  assert.equal(disposals, 1);
  assertIdle(ui);
});

test("refresh settles with native aliases and an open native popover instead of looping through Observer callbacks", t => {
  const ui = makePicker(t);
  const triggerTree = snapshotTree(ui.trigger);
  const sliderTree = snapshotTree(ui.nativeEffort);
  assert.ok(ui.stats.frames <= 2, "Initial attachment should need only a bounded follow-up frame");
  ui.trigger.click();
  ui.flushFrames();
  const frameCount = ui.stats.frames;
  for (let count = 0; count < 25; count++) ui.refresh();
  assert.equal(ui.stats.frames, frameCount,
    "Alias marking/restoration and extension-owned attributes must not schedule new refresh frames");
  assert.equal(ui.pendingFrames, 0);
  assert.equal(ui.pendingRecords, 0);
  assert.deepEqual(snapshotTree(ui.nativeEffort), sliderTree);
  // The only native trigger change was its own click's aria-expanded update.
  ui.trigger.setAttribute("aria-expanded", "false");
  ui.flushFrames();
  assert.deepEqual(snapshotTree(ui.trigger), triggerTree);
  assertIdle(ui);
});

test("open-menu refreshes ignore their own child replacement and coalesce a native mutation burst", t => {
  const ui = makePicker(t);
  ui.open();
  const frames = ui.stats.frames;
  const sliderTree = snapshotTree(ui.nativeEffort);
  for (let count = 0; count < 25; count++) ui.refresh();
  assert.equal(ui.stats.frames, frames,
    "Menu replaceChildren must not recursively schedule another Observer refresh");
  for (let count = 0; count < 12; count++) {
    // Same-value writes are real attribute mutations, not fixture no-ops.
    ui.trigger.setAttribute("aria-expanded", "false");
  }
  const marker = ui.document.createElement("span");
  ui.toolbar.appendChild(marker);
  marker.remove();
  ui.flushFrames();
  assert.equal(ui.stats.frames - frames, 1, "One native mutation burst should coalesce into one refresh");
  assert.equal(ui.menu.hidden, false);
  assert.equal(ui.menu.querySelectorAll('[role="menuitemradio"]').length, 2);
  assert.deepEqual(snapshotTree(ui.nativeEffort), sliderTree);
  assertIdle(ui);
});

test("empty groups and a missing document root are unavailable without mutating native controls", t => {
  const ui = makePicker(t, props(), undefined, { autoInstall: false });
  const native = snapshotNative(ui);
  assert.equal(ui.install([]), "unavailable");
  const root = ui.document.documentElement;
  try {
    ui.document.documentElement = null;
    assert.equal(ui.install(), "unavailable");
  } finally {
    ui.document.documentElement = root;
  }
  assert.equal(ui.controller, undefined);
  assert.equal(ui.button, null);
  assert.equal(ui.menu, null);
  assert.equal(ui.style, null);
  assert.equal(ui.activeObservers, 0);
  assert.deepEqual(snapshotNative(ui), native);
  assertIdle(ui);
});

test("unsupported committed native picker state retains the original fallback without a Context attachment", t => {
  const ui = makePicker(t, props({ model: "unknown-native-model" }), undefined, { autoInstall: false });
  const native = snapshotNative(ui);
  assert.equal(ui.install(), "active");
  ui.flushFrames();
  assert.equal(ui.controller.inspect().bound, false);
  assert.equal(ui.button, null);
  assert.equal(ui.menu.hidden, true);
  assert.deepEqual(snapshotNative(ui), native);
  ui.trigger.click();
  ui.flushFrames();
  assert.equal(ui.nativeEvents.clicks, 1);
  assert.equal(ui.nativeMenu.hidden, false);
  assertIdle(ui);
});

test("the Context extension resolves a deeply nested committed picker without replacing native DOM or callbacks", async t => {
  const calls = [];
  let ui;
  ui = makePicker(t, props({
    onSelectModel(slug, effort) {
      calls.push([slug, effort]);
      ui.commitAlternate({ ...ui.committedProps, model: slug, reasoningEffort: effort });
    },
  }), undefined, { wrapperDepth: 280 });
  const native = snapshotNative(ui, { ignoreAliasMarks: true });
  ui.open();
  ui.option("default").click();
  await ui.settle();
  assert.deepEqual(calls, [["gpt-a--default-context", "high"]]);
  assert.equal(ui.controller.inspect().bound, true);
  assert.deepEqual(snapshotNative(ui, { ignoreAliasMarks: true }), native);
  assertIdle(ui);
});

test("the screenshot compact panel contains Context parallel to the native model and Effort bar, never outside it", t => {
  const ui = makePicker(t, props(), undefined, { compactPanel: true });
  assert.equal(ui.button.parentElement, ui.header);
  assert.equal(ui.menu.parentElement, ui.header);
  assert.equal(ui.toolbar.children.includes(ui.button), false);
  assert.equal(ui.controller.inspect().placement, "native-model-effort-panel");
  assert.equal(ui.headerModel.textContent, "GPT-A");
  assert.equal(ui.headerEffort.textContent, "High");
  assert(ui.header.contains(ui.modelToggle));
  assert(ui.effortRow.contains(ui.nativeEffort));
  assert.equal(ui.nativeEffort.getAttribute("data-reasoning-slider"), "true");
  const slider = ui.nativeEffort;
  const listeners = listenerSnapshot(slider);
  ui.trigger.click();
  ui.flushFrames();
  ui.previewPower("gpt-b--long-context", "medium");
  ui.refresh();
  assert.equal(ui.headerModel.textContent, "GPT-B");
  assert.equal(ui.headerEffort.textContent, "Medium");
  assert.equal(ui.button.textContent, "Context 800K ⌄");
  assert.equal(ui.button.disabled, true, "An uncommitted native model/Effort preview cannot apply Context to the previous model");
  assert.equal(ui.committedProps.model, "gpt-a--long-context", "Native drag previews do not commit a Context change");
  assert.equal(ui.nativeEffort, slider);
  assert.deepEqual(listenerSnapshot(slider), listeners);
  assertIdle(ui);
});

test("the compact panel updates advertised contexts and restores only its own label changes on disposal", t => {
  const ui = makePicker(t, props(), undefined, { compactPanel: true, autoInstall: false });
  const modelText = ui.headerModel.textContent;
  const effortText = ui.headerEffort.textContent;
  ui.install();
  ui.flushFrames();
  ui.setProps({ ...ui.committedProps, model: "gpt-b--default-context", reasoningEffort: "low" });
  ui.previewPower("gpt-b--default-context", "low");
  ui.refresh();
  assert.equal(ui.headerModel.textContent, "GPT-B");
  assert.equal(ui.headerEffort.textContent, "Low");
  ui.open();
  assert.deepEqual(ui.menu.querySelectorAll("button").map(button => button.textContent), ["300K ✓", "800K"]);
  ui.setProps({ ...ui.committedProps, model: "gpt-c" });
  ui.previewPower("gpt-c", "low");
  ui.refresh();
  assert.equal(ui.button.disabled, true);
  ui.headerModel.textContent = "New vendor-rendered label";
  ui.dispose();
  assert.equal(ui.headerModel.textContent, "New vendor-rendered label", "A newer vendor update is never rolled back");
  assert.equal(ui.header.hasAttribute("data-cc-context-panel-row"), false);
  assert.equal(ui.headerEffort.textContent, "低", "The original latest native localized label is restored");
  assert(modelText.includes("Long"));
  assert.equal(effortText, "高");
});

test("model-name-only catalogs deduplicate Context aliases by committed native row keys, not descriptions or row order", t => {
  const initial = props();
  initial.models = initial.models.map(model => ({
    ...model, displayName: groups.find(group => Object.values(group.options)
      .some(context => context.slug === model.model))?.name || model.displayName,
  }));
  initial.modelOptions = initial.models.map(model => ({ model, disabledReason: null }));
  const ui = makePicker(t, initial, undefined, { compactPanel: true });
  assert.equal(ui.headerModel.textContent, "GPT-A");
  assert.equal(ui.headerEffort.textContent, "High");
  assert.equal(ui.button.parentElement, ui.header);
  assert.equal(ui.modelRows.get("gpt-a--default-context").hasAttribute("data-cc-context-model-alias-hidden"), true);
  assert.equal(ui.modelRows.get("gpt-a--long-context").hasAttribute("data-cc-context-model-alias-hidden"), false);
  assert.equal(ui.modelRows.get("gpt-b--default-context").hasAttribute("data-cc-context-model-alias-hidden"), true);
  assert.equal(ui.modelRows.get("gpt-b--long-context").hasAttribute("data-cc-context-model-alias-hidden"), false);
  assert(!ui.headerModel.textContent.includes("Long"));
  assertIdle(ui);
});
