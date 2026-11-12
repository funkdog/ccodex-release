import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import {
  buildLegacyDesktopModelControlsPatch as buildDesktopModelControlsPatch,
  desktopModelGroups,
  desktopPickerBinding,
  desktopPickerSelection,
  desktopPickerState,
} from "../bridge/desktop-model-controls.mjs";

const catalog = {
  models: [
    {
      slug: "gpt-a", display_name: "\u200BGPT-A", visibility: "hide",
      copilot: { base_model: "gpt-a" },
    },
    ...[
      ["gpt-a--default-context", "Standard", "default", 400_000],
      ["gpt-a--long-context", "Long", "long_context", 1_100_000],
      ["gpt-b--default-context", "Standard", "default", 300_000],
      ["gpt-b--long-context", "Long", "long_context", 800_000],
    ].map(([slug, name, tier, window]) => ({
      slug,
      display_name: `\u200BGPT-${slug[4].toUpperCase()} · ${name} (${window / 1000}K prompt)`,
      visibility: "list",
      context_window: window,
      copilot: {
        base_model: slug.slice(0, 5),
        context_tier: tier,
        default_context_window_tokens: tier === "default" ? window : 300_000,
        long_context_window_tokens: tier === "long_context" ? window : null,
      },
    })),
    {
      slug: "gpt-c", display_name: "\u200BGPT-C", visibility: "list",
      context_window: 128_000,
      copilot: {
        base_model: "gpt-c", default_context_window_tokens: 128_000,
      },
    },
  ],
};
const groups = desktopModelGroups(catalog);

function props() {
  const models = catalog.models.filter(entry => entry.visibility === "list")
    .map(entry => ({
      model: entry.slug,
      displayName: entry.display_name,
      defaultReasoningEffort: entry.slug.startsWith("gpt-b") ? "low" : "medium",
      supportedReasoningEfforts: (entry.slug.startsWith("gpt-b")
        ? ["low", "medium"] : ["low", "medium", "high"])
        .map(reasoningEffort => ({ reasoningEffort })),
    }));
  return {
    model: "gpt-a--long-context",
    reasoningEffort: "high",
    modelOptions: models.map(model => ({ model, disabledReason: null })),
    models,
    modelOptionsDisabled: false,
    reasoningEffortDisabled: false,
    onSelectModel() {},
    onBeforeSelectModel() { return true; },
  };
}

test("Desktop model picker deduplicates native Context aliases", () => {
  assert.deepEqual(groups.map(group => [group.id, group.name]), [
    ["gpt-a", "GPT-A"], ["gpt-b", "GPT-B"], ["gpt-c", "GPT-C"],
  ]);
  const state = desktopPickerState(groups, props());
  assert.equal(state.modelName, "GPT-A");
  assert.equal(state.tier, "long_context");
  assert.equal(state.window, "1.1M");
  assert.deepEqual(state.models.map(model => model.label), ["GPT-A", "GPT-B", "GPT-C"]);
  assert.deepEqual(state.contexts.map(context => context.label), ["400K", "1.1M"]);
});

test("Model, Effort and Context change one dimension at a time", () => {
  const active = props();
  assert.deepEqual(desktopPickerSelection(groups, active, "context", "default"), {
    slug: "gpt-a--default-context", effort: "high",
  });

  test("new native effort capabilities remain selectable while unadvertised or invalid parameters are rejected", () => {
    const active = props();
    const model = active.models.find(model => model.model === active.model);
    model.supportedReasoningEfforts.push({ reasoningEffort: "future_effort" });
    assert(desktopPickerState(groups, active).efforts.includes("future_effort"));
    assert.deepEqual(desktopPickerSelection(groups, active, "effort", "future_effort"), {
      slug: active.model, effort: "future_effort",
    });
    assert.equal(desktopPickerSelection(groups, active, "effort", "not_advertised"), null);
    model.supportedReasoningEfforts.push({ reasoningEffort: "unsafe\nvalue" });
    assert(!desktopPickerState(groups, active).efforts.includes("unsafe\nvalue"));
  });
  assert.deepEqual(desktopPickerSelection(groups, active, "effort", "low"), {
    slug: "gpt-a--long-context", effort: "low",
  });
  assert.deepEqual(desktopPickerSelection(groups, active, "model", "gpt-b"), {
    slug: "gpt-b--long-context", effort: "low",
  }, "A new model preserves Long, but chooses an advertised effort");
  assert.deepEqual(desktopPickerSelection(groups, active, "model", "gpt-c"), {
    slug: "gpt-c", effort: "high",
  }, "A model without Long keeps its own sole Context");
  active.modelOptions.find(option => option.model.model === "gpt-b--long-context")
    .disabledReason = { reason: "disabled" };
  assert.deepEqual(desktopPickerSelection(groups, active, "model", "gpt-b"), {
    slug: "gpt-b--default-context", effort: "low",
  });
  assert.equal(desktopPickerSelection(groups, active, "context", "missing"), null);
  assert.equal(desktopPickerSelection(groups, active, "effort", "max"), null);
  active.reasoningEffortDisabled = true;
  assert.equal(desktopPickerSelection(groups, active, "effort", "low"), null);
});

class Element {
  constructor(tag, document) {
    this.tagName = tag.toUpperCase();
    this.document = document;
    this.children = [];
    this.attributes = new Map();
    this.dataset = {};
    this.style = {};
    this.listeners = new Map();
    this.textContent = "";
  }
  get parentElement() { return this.parent || null; }
  get parentNode() { return this.parent || null; }
  get nextSibling() {
    if (!this.parent) return null;
    return this.parent.children[this.parent.children.indexOf(this) + 1] || null;
  }
  get isConnected() { return this.document.documentElement?.contains(this) || false; }
  get hidden() { return this.attributes.has("hidden"); }
  set hidden(value) {
    if (value) this.setAttribute("hidden", "");
    else this.removeAttribute("hidden");
  }
  get disabled() { return this.attributes.has("disabled"); }
  set disabled(value) {
    if (value) this.setAttribute("disabled", "");
    else this.removeAttribute("disabled");
  }
  setAttribute(name, value) {
    if (this.getAttribute(name) === String(value)) return;
    this.attributes.set(name, String(value));
    this.document.mutation?.({ type: "attributes", target: this, attributeName: name });
  }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) {
    if (!this.attributes.delete(name)) return;
    this.document.mutation?.({ type: "attributes", target: this, attributeName: name });
  }
  appendChild(child) {
    if (child.parent) child.parent.removeChild(child);
    child.parent = this;
    this.children.push(child);
    this.document.mutation?.({ type: "childList", target: this });
    return child;
  }
  insertBefore(child, reference) {
    if (!reference) return this.appendChild(child);
    assert.ok(this.children.includes(reference), "The reference must belong to this parent");
    if (child === reference) return child;
    if (child.parent) child.parent.removeChild(child);
    child.parent = this;
    this.children.splice(this.children.indexOf(reference), 0, child);
    this.document.mutation?.({ type: "childList", target: this });
    return child;
  }
  removeChild(child) {
    assert.ok(this.children.includes(child), "Only an attached child can be removed");
    this.children.splice(this.children.indexOf(child), 1);
    child.parent = null;
    if (child.contains(this.document.activeElement)) {
      this.document.activeElement = this.document.body;
    }
    this.document.mutation?.({ type: "childList", target: this });
    return child;
  }
  append(...children) { children.forEach(child => this.appendChild(child)); }
  replaceChildren(...children) {
    for (const child of [...this.children]) this.removeChild(child);
    this.append(...children);
  }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  click() {
    if (!this.disabled) this.document.dispatch("click", this);
  }
  focus() {
    if (this.disabled || !this.isConnected) return;
    for (let node = this; node; node = node.parent) {
      if (node.hidden) return;
    }
    this.document.activeElement = this;
    this.document.dispatch("focusin", this);
  }
  matches(selector) {
    if (selector === "*") return true;
    if (selector === "button:not(:disabled)") {
      return this.tagName === "BUTTON" && !this.disabled;
    }
    if (selector.startsWith("#")) return this.id === selector.slice(1);
    const attribute = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(selector);
    if (attribute) {
      return attribute[2] === undefined
        ? this.getAttribute(attribute[1]) !== null
        : this.getAttribute(attribute[1]) === attribute[2];
    }
    return this.tagName === selector.toUpperCase();
  }
  closest(selector) {
    for (let node = this; node; node = node.parent) {
      if (node.matches(selector)) return node;
    }
    return null;
  }
  contains(target) {
    return this === target || this.children.some(child => child.contains(target));
  }
  querySelectorAll(selector) {
    const all = this.children.flatMap(child => [child, ...child.querySelectorAll("*")]);
    return all.filter(child => child.matches(selector));
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  getBoundingClientRect() {
    return this.tagName === "BUTTON"
      ? { left: 100, top: 500, bottom: 530 }
      : { height: this.children.length * 42 + 20 };
  }
}

// The DOM's __reactFiber expando deliberately stays on side A. React commits
// alternate buffers by changing HostRoot.stateNode.current, not that expando.
// Both parent chains are retained so uncommitted work is also testable.
function fiberPair(trigger, initial, identity) {
  const rootState = { current: null };
  const roots = [0, 1].map(() => ({
    tag: 3, return: null, sibling: null, memoizedProps: null, stateNode: rootState,
  }));
  for (const [index, root] of roots.entries()) {
    const conversation = {
      tag: 0, return: root, sibling: null, memoizedProps: { ...identity }, stateNode: null,
    };
    const owner = {
      tag: 0, return: conversation, sibling: null, memoizedProps: initial, stateNode: null,
    };
    const host = {
      tag: 5, return: owner, child: null, sibling: null, memoizedProps: {}, stateNode: trigger,
    };
    root.child = conversation;
    conversation.child = owner;
    owner.child = host;
    root.alternate = roots[1 - index];
  }
  for (const [index, root] of roots.entries()) {
    root.child.alternate = roots[1 - index].child;
    root.child.child.alternate = roots[1 - index].child.child;
    root.child.child.child.alternate = roots[1 - index].child.child.child;
  }
  rootState.current = roots[0];
  trigger.__reactFiber$synthetic = roots[0].child.child.child;
  return rootState;
}

function wrapTriggerFibers(rootState, depth) {
  const paths = [rootState.current, rootState.current.alternate].map(root => {
    const owner = root.child.child;
    const host = owner.child;
    const wrappers = [];
    let parent = owner;
    for (let index = 0; index < depth; index++) {
      const wrapper = {
        tag: 0, return: parent, child: null, sibling: null,
        memoizedProps: {}, stateNode: null,
      };
      parent.child = wrapper;
      wrappers.push(wrapper);
      parent = wrapper;
    }
    parent.child = host;
    host.return = parent;
    return wrappers;
  });
  for (let index = 0; index < depth; index++) {
    paths[0][index].alternate = paths[1][index];
    paths[1][index].alternate = paths[0][index];
  }
}

function picker(initial = props(), identity = {
  conversationId: "thread-a", permissionsHostId: "local-test-host",
  permissionsCwdOverride: "C:\\isolated-fixture",
}, { wrapperDepth = 0 } = {}) {
  const handlers = new Map();
  const observers = [];
  const frames = [];
  const timers = new Map();
  let clock = 0;
  let timerId = 0;
  const document = {
    activeElement: null,
    createElement(tag) { return new Element(tag, document); },
    addEventListener(name, callback) { handlers.set(name, callback); },
    removeEventListener(name, callback) {
      if (handlers.get(name) === callback) handlers.delete(name);
    },
    querySelector(selector) { return document.documentElement.querySelector(selector); },
    mutation(record) {
      for (const observer of observers) {
        if (observer.target !== record.target &&
            !(observer.options.subtree && observer.target.contains(record.target))) continue;
        if (!observer.options[record.type]) continue;
        if (record.type === "attributes" && observer.options.attributeFilter &&
            !observer.options.attributeFilter.includes(record.attributeName)) continue;
        observer.records.push(record);
      }
    },
    dispatch(type, target, init = {}) {
      const event = {
        type, target, ...init, defaultPrevented: false, propagationStopped: false,
        immediatePropagationStopped: false,
        preventDefault() { this.defaultPrevented = true; },
        stopPropagation() { this.propagationStopped = true; },
        stopImmediatePropagation() {
          this.immediatePropagationStopped = true;
          this.propagationStopped = true;
        },
      };
      handlers.get(type)?.(event);
      if (!event.propagationStopped) target.listeners.get(type)?.(event);
      return event;
    },
  };
  document.documentElement = new Element("html", document);
  document.head = new Element("head", document);
  document.body = new Element("body", document);
  document.documentElement.append(document.head, document.body);
  document.activeElement = document.body;
  const makeTrigger = () => {
    const button = document.createElement("button");
    button.setAttribute("data-codex-intelligence-trigger", "true");
    button.setAttribute("aria-label", "选择模型");
    return button;
  };
  let trigger = makeTrigger();
  document.body.appendChild(trigger);
  let fibers = fiberPair(trigger, initial, identity);
  wrapTriggerFibers(fibers, wrapperDepth);
  const windowHandlers = new Map();
  const scope = {
    document, innerWidth: 900, innerHeight: 900,
    Date: class extends Date { static now() { return clock; } },
    setTimeout(callback, delay = 0) {
      const id = ++timerId;
      timers.set(id, { callback, due: clock + delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; this.records = []; }
      observe(target, options) {
        this.target = target;
        this.options = options;
        observers.push(this);
      }
      disconnect() {
        this.target = null;
        this.options = {};
        this.records = [];
      }
    },
    requestAnimationFrame(callback) { frames.push(callback); },
    addEventListener(name, callback) { windowHandlers.set(name, callback); },
    removeEventListener(name, callback) {
      if (windowHandlers.get(name) === callback) windowHandlers.delete(name);
    },
  };
  scope.globalThis = scope;
  assert.equal(vm.runInNewContext(buildDesktopModelControlsPatch(groups), scope), "active");
  const root = document.querySelector("#codex-copilot-model-menu");
  const flushFrames = () => {
    for (let count = 0; count < 40; count++) {
      for (const observer of observers) {
        if (observer.records.length) observer.callback(observer.records.splice(0));
      }
      if (!frames.length) return;
      for (const callback of frames.splice(0)) callback();
    }
    assert.fail("The renderer did not settle within 40 animation frames");
  };
  flushFrames();
  return {
    document, scope, root, flushFrames,
    get trigger() { return trigger; },
    get hostRoot() { return fibers; },
    get pendingTimers() { return timers.size; },
    get committedProps() { return fibers.current.child.child.memoizedProps; },
    get identity() { return fibers.current.child.memoizedProps; },
    setProps(next) { fibers.current.child.child.memoizedProps = next; },
    setIdentity(next) {
      fibers.current.child.memoizedProps = { ...fibers.current.child.memoizedProps, ...next };
    },
    prepareAlternate(next, nextIdentity = fibers.current.child.memoizedProps) {
      fibers.current.alternate.child.memoizedProps = { ...nextIdentity };
      fibers.current.alternate.child.child.memoizedProps = next;
    },
    commitAlternate(next, nextIdentity = fibers.current.child.memoizedProps) {
      fibers.current.alternate.child.memoizedProps = { ...nextIdentity };
      fibers.current.alternate.child.child.memoizedProps = next;
      fibers.current = fibers.current.alternate;
    },
    replaceTrigger(next, nextIdentity = fibers.current.child.memoizedProps) {
      const previous = trigger;
      document.body.removeChild(previous);
      trigger = makeTrigger();
      document.body.appendChild(trigger);
      fibers = fiberPair(trigger, next, nextIdentity);
      wrapTriggerFibers(fibers, wrapperDepth);
      return previous;
    },
    advance(milliseconds) {
      const until = clock + milliseconds;
      for (let count = 0; ; count++) {
        assert.ok(count < 1000, "The fake timer queue must terminate");
        const ready = [...timers].filter(([, timer]) => timer.due <= until)
          .sort((left, right) => left[1].due - right[1].due)[0];
        if (!ready) break;
        const [id, timer] = ready;
        timers.delete(id);
        clock = timer.due;
        timer.callback();
        flushFrames();
      }
      clock = until;
      flushFrames();
    },
    refresh() {
      scope.__codexCopilotModelControlsV1.refresh();
      flushFrames();
    },
    open(key) {
      trigger.focus();
      if (key) return document.dispatch("keydown", trigger, { key });
      trigger.click();
    },
    control(id) {
      const button = root.querySelectorAll("button").find(item => item.dataset.ccControl === id);
      assert.ok(button, `Expected the ${id} control to be rendered`);
      return button;
    },
    setting(kind) {
      const button = document.querySelector(`[data-cc-model-setting="${kind}"]`);
      assert.ok(button, `Expected the independent ${kind} toolbar button`);
      return button;
    },
    key(key, target = document.activeElement) {
      return document.dispatch("keydown", target, { key });
    },
    dismiss() { document.dispatch("pointerdown", document.body); },
    alerts() { return root.querySelectorAll('[role="alert"]').map(item => item.textContent); },
    async settle() {
      await new Promise(resolve => setImmediate(resolve));
      flushFrames();
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("toolbar exposes Model, Effort and Context as three independent sibling controls", () => {
  const ui = picker();
  const buttons = ["model", "effort", "context"].map(kind => ui.setting(kind));
  assert.ok(buttons.every(button => button.parentNode === buttons[0].parentNode));
  assert.equal(buttons[0].parentNode.getAttribute("role"), "group");
  assert.deepEqual(buttons.map(button => button.getAttribute("aria-label")), [
    "Model GPT-A", "Effort High", "Context window 1.1M",
  ]);
  assert.deepEqual(buttons.map(button =>
    button.querySelector('[data-cc-setting-value]').textContent), ["GPT-A", "High", "1.1M"]);
  assert.equal(ui.trigger.getAttribute("data-codex-copilot-model-summary"), "GPT-A");
  assert.equal(ui.trigger.getAttribute("data-codex-copilot-native-model"), "true");
});

for (const [kind, options] of [
  ["model", ["GPT-A", "GPT-B", "GPT-C"]],
  ["effort", ["Low", "Medium", "High"]],
  ["context", ["400K", "1.1M"]],
]) {
  test(`${kind} toolbar button directly opens only its own choices`, () => {
    const ui = picker();
    ui.setting(kind).click();
    assert.equal(ui.root.hidden, false);
    assert.deepEqual(ui.root.querySelectorAll('[role="menuitemradio"]')
      .map(button => button.children[0].textContent), options);
    assert.equal(ui.root.querySelectorAll('[data-cc-control="back"]').length, 0);
    assert.equal(ui.setting(kind).getAttribute("aria-expanded"), "true");
    assert.equal(ui.scope.__codexCopilotModelControlsV1.inspect().view, kind);
  });
}

test("independent toolbar selection changes one setting and restores its own focus", async () => {
  const active = props();
  const calls = [];
  active.onSelectModel = async (slug, effort) => {
    calls.push([slug, effort]);
    active.model = slug;
    active.reasoningEffort = effort;
  };
  const ui = picker(active);
  ui.setting("effort").click();
  ui.control("low").click();
  await ui.settle();
  assert.deepEqual(calls, [["gpt-a--long-context", "low"]]);
  assert.ok(ui.document.activeElement === ui.setting("effort"),
    "Effort selection must restore focus to its own live toolbar button");
  assert.equal(ui.setting("context").getAttribute("aria-label"), "Context window 1.1M");
  ui.setting("context").click();
  ui.control("default").click();
  await ui.settle();
  assert.deepEqual(calls.at(-1), ["gpt-a--default-context", "low"]);
  assert.ok(ui.document.activeElement === ui.setting("context"),
    "Context selection must restore focus to its own live toolbar button");
  assert.equal(ui.setting("model").getAttribute("aria-label"), "Model GPT-A");
  assert.equal(ui.setting("effort").getAttribute("aria-label"), "Effort Low");
});

test("pending selection preserves menu focus without taking it back from another control", async () => {
  const selected = deferred();
  const active = props();
  active.onSelectModel = (slug, effort) => {
    active.model = slug;
    active.reasoningEffort = effort;
    return selected.promise;
  };
  const ui = picker(active);
  ui.setting("effort").click();
  ui.control("low").click();
  await ui.settle();
  assert.ok(ui.document.activeElement === ui.root,
    "The pending rerender must keep focus in the still-owned menu");
  const outside = ui.document.createElement("button");
  ui.document.body.appendChild(outside);
  outside.focus();
  selected.resolve(true);
  await ui.settle();
  assert.equal(active.reasoningEffort, "low");
  assert.ok(ui.document.activeElement === outside,
    "Confirmation must not steal focus from explicit user navigation");
});

test("independent toolbar keeps native availability, fallback and disposal", () => {
  const ui = picker({ ...props(), modelOptionsDisabled: true });
  assert.equal(ui.setting("model").disabled, true);
  assert.equal(ui.setting("effort").disabled, false);
  assert.equal(ui.setting("context").disabled, true);
  ui.setting("effort").focus();
  const opening = ui.key("ArrowDown");
  assert.equal(opening.defaultPrevented, true);
  assert.equal(ui.root.hidden, false);
  ui.key("Escape");
  assert.equal(ui.root.hidden, true);
  assert.equal(ui.document.activeElement, ui.setting("effort"));
  ui.setProps({ ...props(), model: "unknown-model" });
  ui.refresh();
  assert.equal(ui.document.querySelector("[data-cc-model-setting]"), null);
  assert.equal(ui.trigger.getAttribute("data-codex-copilot-native-model"), null);
  ui.setProps(props());
  ui.refresh();
  assert.ok(ui.setting("model"));
  ui.scope.__codexCopilotModelControlsV1.dispose();
  assert.equal(ui.document.querySelector("[data-cc-model-setting]"), null);
  assert.equal(ui.trigger.getAttribute("aria-label"), "选择模型");
});

test("renderer uses native thread callbacks and displays three separate rows", async () => {
  const active = props();
  const calls = [];
  active.onSelectModel = async (slug, effort) => {
    calls.push([slug, effort]);
    active.model = slug;
    active.reasoningEffort = effort;
  };
  const ui = picker(active);
  const { root, trigger } = ui;
  assert.equal(trigger.getAttribute("data-codex-copilot-model-summary"), "GPT-A");
  ui.open();
  assert.equal(root.hidden, false);
  assert.deepEqual(root.children.map(row => row.children[0].textContent),
    ["Model", "Effort", "Context window"]);
  root.children[2].click();
  assert.deepEqual(root.children[2].children.map(item => item.children[0].textContent),
    ["400K", "1.1M"]);
  root.children[2].children[0].click();
  await ui.settle();
  assert.deepEqual(calls.at(-1), ["gpt-a--default-context", "high"]);
  assert.equal(active.model, "gpt-a--default-context");
  assert.equal(root.hidden, true);

  ui.open();
  root.children[1].click();
  root.children[2].children[0].click();
  await ui.settle();
  assert.deepEqual(calls.at(-1), ["gpt-a--default-context", "low"]);

  ui.open();
  root.children[0].click();
  assert.deepEqual(root.children[2].children.map(item => item.children[0].textContent),
    ["GPT-A", "GPT-B", "GPT-C"]);
  root.children[2].children[1].click();
  await ui.settle();
  assert.deepEqual(calls.at(-1), ["gpt-b--default-context", "low"]);
  assert.equal(trigger.getAttribute("data-codex-copilot-model-summary"), "GPT-B");
  assert.equal(trigger.getAttribute("aria-label"), "Model GPT-B");
  assert.equal(ui.setting("effort").getAttribute("aria-label"), "Effort Low");
  assert.equal(ui.setting("context").getAttribute("aria-label"), "Context window 300K");

  active.model = "model-from-another-profile";
  ui.refresh();
  assert.equal(root.hidden, true, "Unknown app state must fall back to the native picker");
  assert.equal(trigger.getAttribute("data-codex-copilot-model-summary"), null);
  assert.equal(trigger.getAttribute("aria-label"), "选择模型");
});

test("renderer reports a committed binding and installs each revision only once", () => {
  const ui = picker();
  const installed = ui.scope.__codexCopilotModelControlsV1;
  assert.deepEqual({ ...installed.inspect() }, {
    revision: 3, bound: true, menuOpen: false, view: null,
    model: "GPT-A", effort: "high", context: "1.1M",
  });
  assert.equal(vm.runInNewContext(buildDesktopModelControlsPatch(groups), ui.scope), "active");
  assert.ok(ui.scope.__codexCopilotModelControlsV1 === installed);
  assert.equal(ui.document.documentElement.querySelectorAll("#codex-copilot-model-menu").length, 1);
  ui.open();
  assert.equal(installed.inspect().menuOpen, true);
});

test("renderer does not layer new callbacks over a legacy undisposable patch", () => {
  const ui = picker();
  const installed = ui.scope.__codexCopilotModelControlsV1;
  ui.scope.__codexCopilotModelControlsV1 = { close() {}, refresh() {} };
  assert.equal(vm.runInNewContext(buildDesktopModelControlsPatch(groups), ui.scope),
    "reload-required");
  assert.equal(ui.document.documentElement.querySelectorAll("#codex-copilot-model-menu").length, 1);
  assert.equal(ui.scope.__codexCopilotModelControlsV1.revision, undefined);
  installed.dispose();
});

test("renderer disposal removes its controls, observers and event handlers", () => {
  const ui = picker();
  const installed = ui.scope.__codexCopilotModelControlsV1;
  ui.open();
  installed.dispose();
  installed.dispose();
  ui.flushFrames();
  assert.equal(ui.scope.__codexCopilotModelControlsV1, undefined);
  assert.equal(ui.root.isConnected, false);
  assert.equal(ui.document.documentElement.querySelector("#codex-copilot-model-menu-style"), null);
  assert.equal(ui.trigger.getAttribute("data-codex-copilot-model-summary"), null);
  assert.equal(ui.trigger.getAttribute("aria-label"), "选择模型");
  assert.equal(ui.key("Enter", ui.trigger).defaultPrevented, false);
  assert.equal(vm.runInNewContext(buildDesktopModelControlsPatch(groups), ui.scope), "active");
  ui.flushFrames();
  assert.equal(ui.scope.__codexCopilotModelControlsV1.inspect().bound, true);
  assert.equal(ui.document.documentElement.querySelectorAll("#codex-copilot-model-menu").length, 1);
});

test("renderer follows every committed Fiber buffer without changing the DOM expando", () => {
  const ui = picker();
  const attachedFiber = ui.trigger.__reactFiber$synthetic;
  for (const [model, reasoningEffort, summary, window] of [
    ["gpt-b--default-context", "low", "GPT-B", "300K"],
    ["gpt-a--default-context", "medium", "GPT-A", "400K"],
    ["gpt-b--long-context", "medium", "GPT-B", "800K"],
  ]) {
    ui.commitAlternate({ ...props(), model, reasoningEffort });
    assert.equal(ui.trigger.__reactFiber$synthetic, attachedFiber);
    ui.refresh();
    assert.equal(ui.trigger.getAttribute("data-codex-copilot-model-summary"), summary,
      `The committed ${model} / ${reasoningEffort} props must win over the attached stale Fiber`);
    assert.equal(ui.setting("context").getAttribute("aria-label"), `Context window ${window}`);
    assert.equal(ui.setting("effort").querySelector("[data-cc-setting-value]").textContent,
      reasoningEffort === "low" ? "Low" : "Medium");
  }
});

test("selection calls the committed alternate's native callback, never a stale closure", async () => {
  const calls = [];
  const stale = { ...props(), onSelectModel: (...args) => calls.push(["stale", ...args]) };
  const committed = {
    ...props(), model: "gpt-b--default-context", reasoningEffort: "medium",
    onSelectModel: (...args) => {
      calls.push(["committed", ...args]);
      [committed.model, committed.reasoningEffort] = args;
    },
  };
  const ui = picker(stale);
  ui.commitAlternate(committed, { ...ui.identity, conversationId: "thread-b" });
  ui.refresh();
  ui.open();
  ui.control("effort").click();
  ui.control("low").click();
  await ui.settle();
  assert.deepEqual(calls, [["committed", "gpt-b--default-context", "low"]],
    "Calling the attached Fiber would update an obsolete model/thread callback");
});

test("an uncommitted alternate must not replace the committed props or callback", async () => {
  const calls = [];
  const committed = {
    ...props(),
    onSelectModel: (...args) => {
      calls.push(["current", ...args]);
      [committed.model, committed.reasoningEffort] = args;
    },
  };
  const ui = picker(committed);
  ui.prepareAlternate({
    ...props(), model: "gpt-b--default-context", reasoningEffort: "low",
    onSelectModel: (...args) => calls.push(["uncommitted", ...args]),
  });
  ui.refresh();
  assert.equal(ui.trigger.getAttribute("data-codex-copilot-model-summary"), "GPT-A");
  ui.open();
  ui.control("effort").click();
  ui.control("medium").click();
  await ui.settle();
  assert.deepEqual(calls, [["current", "gpt-a--long-context", "medium"]],
    "Always preferring .alternate would read work that React has not committed");
});

test("binding follows committed child edges when a shared host has a stale return pointer", () => {
  const trigger = { isConnected: true };
  const rootState = fiberPair(trigger, props(), { conversationId: "thread-a" });
  const rootA = rootState.current;
  const rootB = rootA.alternate;
  const ownerA = rootA.child.child;
  const ownerB = rootB.child.child;
  const hostA = ownerA.child;
  const committed = { ...props(), model: "gpt-b--default-context", reasoningEffort: "low" };
  ownerB.memoizedProps = committed;
  ownerB.child = hostA;
  rootState.current = rootB;
  assert.equal(hostA.return, ownerA, "The shared host deliberately retains its stale parent");
  const binding = desktopPickerBinding(groups, trigger);
  assert.ok(binding?.fiber === ownerB,
    "Resolve the picker above the trigger along committed child edges, not host.return");
  assert.equal(binding.props, committed);
  assert.equal(binding.state.slug, "gpt-b--default-context");
});

test("a shared committed picker is not replaced by its disconnected alternate", () => {
  const trigger = { isConnected: true };
  const committed = props();
  const rootState = fiberPair(trigger, committed, { conversationId: "thread-a" });
  const rootA = rootState.current;
  const rootB = rootA.alternate;
  const shared = rootA.child.child;
  rootB.child.child.memoizedProps = {
    ...props(), model: "gpt-b--default-context", reasoningEffort: "low",
  };
  rootB.child.child = shared;
  rootState.current = rootB;
  assert.equal(shared.return, rootA.child,
    "A bailed-out picker can be shared without updating its return pointer");
  const binding = desktopPickerBinding(groups, trigger);
  assert.ok(binding?.fiber === shared,
    "Blindly selecting the alternate belonging to rootB would read a disconnected picker");
  assert.equal(binding.props, committed);
  assert.equal(binding.state.slug, "gpt-a--long-context");
});

test("binding follows sibling links and ignores unrelated model-like components", () => {
  const trigger = { isConnected: true };
  const committed = props();
  const rootState = fiberPair(trigger, committed, { conversationId: "thread-a" });
  const root = rootState.current;
  root.child = {
    tag: 0, return: root, child: null, sibling: root.child, stateNode: null,
    memoizedProps: { ...props(), model: "gpt-c" },
  };
  const binding = desktopPickerBinding(groups, trigger);
  assert.ok(binding?.props === committed,
    "The first sibling with model props is not necessarily the trigger's picker");
});

for (const depth of [320, 900]) {
  test(`deep Desktop binding follows ${depth} wrappers on both committed buffers`, () => {
    const trigger = { isConnected: true };
    const initial = props();
    const rootState = fiberPair(trigger, initial, { conversationId: "thread-a" });
    wrapTriggerFibers(rootState, depth);
    assert.ok(desktopPickerBinding(groups, trigger)?.props === initial,
      "The real Desktop has more than 512 reachable ancestor Fibers");
    const committed = { ...props(), model: "gpt-b--default-context", reasoningEffort: "low" };
    rootState.current.alternate.child.child.memoizedProps = committed;
    rootState.current = rootState.current.alternate;
    const binding = desktopPickerBinding(groups, trigger);
    assert.ok(binding?.props === committed,
      "Increasing depth must not make the attached stale buffer authoritative");
    assert.equal(binding.state.modelName, "GPT-B");
  });
}

test("deep Desktop renderer displays independent controls and preserves native callbacks", async () => {
  const calls = [];
  const active = {
    ...props(),
    onSelectModel: (...args) => {
      calls.push(args);
      [active.model, active.reasoningEffort] = args;
    },
  };
  const ui = picker(active, { conversationId: "isolated-deep-thread" }, { wrapperDepth: 320 });
  assert.equal(ui.trigger.getAttribute("data-codex-copilot-model-summary"), "GPT-A");
  ui.open();
  assert.deepEqual(ui.root.children.map(row => row.children[0].textContent),
    ["Model", "Effort", "Context window"]);
  ui.control("effort").click();
  ui.control("low").click();
  await ui.settle();
  assert.deepEqual(calls, [["gpt-a--long-context", "low"]]);
  ui.open();
  ui.control("context").click();
  ui.control("default").click();
  await ui.settle();
  assert.deepEqual(calls.at(-1), ["gpt-a--default-context", "low"]);
});

test("excessive or cyclic Desktop ancestry still falls back safely", () => {
  const trigger = { isConnected: true };
  const rootState = fiberPair(trigger, props(), { conversationId: "thread-a" });
  wrapTriggerFibers(rootState, 2200);
  assert.equal(desktopPickerBinding(groups, trigger), null,
    "A malformed or excessive graph must not remove the traversal budget");
  const cycle = { tag: 0, memoizedProps: props(), stateNode: null };
  cycle.return = cycle;
  trigger.__reactFiber$synthetic = {
    tag: 5, stateNode: trigger, return: cycle, child: null,
  };
  assert.equal(desktopPickerBinding(groups, trigger), null);
});

for (const missing of ["HostRoot", "current root", "committed trigger path"]) {
  test(`a missing ${missing} restores native controls instead of trusting cached props`, () => {
    const ui = picker();
    ui.open();
    ui.flushFrames();
    if (missing === "HostRoot") {
      ui.trigger.__reactFiber$synthetic = {
        tag: 5, stateNode: ui.trigger,
        return: { tag: 0, return: null, memoizedProps: props() },
      };
    } else if (missing === "current root") {
      ui.hostRoot.current = null;
    } else {
      ui.hostRoot.current.child = null;
    }
    ui.refresh();
    assert.equal(ui.root.hidden, true);
    assert.equal(ui.trigger.getAttribute("data-codex-copilot-model-summary"), null);
    assert.equal(ui.trigger.getAttribute("aria-label"), "选择模型");
    assert.equal(ui.key("Enter", ui.trigger).defaultPrevented, false);
  });
}

test("a void native wrapper waits for committed acknowledgement, not matching uncommitted props", async () => {
  const calls = [];
  const ui = picker({ ...props(), onSelectModel: (...args) => { calls.push(args); } });
  ui.open();
  ui.control("effort").click();
  ui.control("low").click();
  await ui.settle();
  assert.deepEqual(calls, [["gpt-a--long-context", "low"]]);
  assert.equal(ui.root.hidden, false,
    "The native wrapper returning undefined does not mean React committed the selection");
  assert.equal(ui.control("low").disabled, true);
  assert.equal(ui.trigger.getAttribute("data-codex-copilot-model-summary"), "GPT-A");
  const acknowledged = { ...ui.committedProps, reasoningEffort: "low" };
  ui.prepareAlternate(acknowledged);
  ui.advance(100);
  assert.equal(ui.root.hidden, false, "Uncommitted matching work cannot acknowledge an update");
  assert.equal(ui.control("low").disabled, true);
  ui.commitAlternate(acknowledged);
  ui.advance(100);
  assert.equal(ui.root.hidden, true);
  assert.equal(ui.trigger.getAttribute("data-codex-copilot-model-summary"), "GPT-A");
  assert.equal(ui.setting("effort").getAttribute("aria-label"), "Effort Low");
  assert.equal(ui.pendingTimers, 0, "A confirmed operation must release its polling timer");
  assert.equal(calls.length, 1, "Acknowledgement polling must never send a second update");
});

test("unacknowledged native selections time out without reporting success or retrying themselves", async () => {
  const calls = [];
  const ui = picker({ ...props(), onSelectModel: (...args) => { calls.push(args); } });
  ui.open();
  ui.control("context").click();
  ui.control("default").click();
  await ui.settle();
  ui.advance(7999);
  assert.equal(ui.root.hidden, false);
  assert.equal(ui.control("default").disabled, true);
  assert.deepEqual(ui.alerts(), []);
  ui.advance(1);
  assert.equal(ui.root.hidden, false);
  assert.match(ui.alerts().join(" "), /not confirmed/i);
  assert.equal(ui.control("default").disabled, false, "A timeout must allow an explicit retry");
  assert.equal(ui.committedProps.model, "gpt-a--long-context");
  assert.deepEqual(calls, [["gpt-a--default-context", "high"]]);
  assert.equal(ui.pendingTimers, 0);
});

test("thread navigation cancels an old acknowledgement timer without altering the new menu", async () => {
  const calls = [];
  const ui = picker({ ...props(), onSelectModel: (...args) => { calls.push(args); } });
  ui.open();
  ui.control("effort").click();
  ui.control("low").click();
  await ui.settle();
  assert.ok(ui.pendingTimers > 0, "The void native wrapper should be awaiting acknowledgement");
  ui.setProps(props());
  ui.setIdentity({ conversationId: "thread-b" });
  ui.refresh();
  assert.equal(ui.root.hidden, true);
  assert.equal(ui.pendingTimers, 0);
  ui.open();
  ui.advance(10_000);
  assert.equal(ui.root.hidden, false);
  assert.equal(ui.control("effort").disabled, false);
  assert.deepEqual(ui.alerts(), []);
  assert.equal(calls.length, 1);
});

test("rerendering the same thread keeps its menu open and uses the newest callback", async () => {
  const calls = [];
  const active = { ...props(), onSelectModel: (...args) => calls.push(["old", ...args]) };
  const ui = picker(active);
  ui.open();
  ui.control("effort").click();
  const next = {
    ...active,
    onSelectModel: (...args) => {
      calls.push(["new", ...args]);
      [next.model, next.reasoningEffort] = args;
    },
  };
  ui.setProps(next);
  ui.refresh();
  assert.equal(ui.root.hidden, false,
    "An ordinary rerender or a fresh callback identity is not a thread change");
  ui.control("low").click();
  await ui.settle();
  assert.deepEqual(calls, [["new", "gpt-a--long-context", "low"]]);
});

for (const replacement of [false, true]) {
  const description = replacement ? "a replacement trigger" : "a reused trigger";
  const changeThread = (ui, next) => {
    const identity = { ...ui.identity, conversationId: "thread-b" };
    if (replacement) ui.replaceTrigger(next, identity);
    else {
      ui.setProps(next);
      ui.setIdentity(identity);
    }
  };

  test(`changing threads with ${description} closes the old menu even when settings match`, () => {
    const ui = picker();
    const previousTrigger = ui.trigger;
    ui.open();
    ui.control("context").click();
    changeThread(ui, props());
    ui.refresh();
    assert.equal(ui.root.hidden, true,
      "A popup opened for thread-a cannot silently become thread-b's popup");
    assert.notEqual(previousTrigger.getAttribute("aria-expanded"), "true");
  });

  test(`a stale menu click after changing threads with ${description} updates neither thread`, async () => {
    const calls = [];
    const ui = picker({
      ...props(), onSelectModel: (...args) => calls.push(["thread-a", ...args]),
    });
    ui.open();
    ui.control("context").click();
    const oldChoice = ui.control("default");
    changeThread(ui, {
      ...props(),
      onSelectModel: (...args) => calls.push(["thread-b", ...args]),
    });
    // Deliberately click before MutationObserver/requestAnimationFrame refresh.
    // The existing menu is still visible during this event-loop race.
    oldChoice.click();
    await ui.settle();
    assert.deepEqual(calls, [],
      "An option rendered for thread-a must not dispatch to thread-b's current callback");
    assert.equal(ui.root.hidden, true);
  });
}

for (const field of ["permissionsHostId", "permissionsCwdOverride"]) {
  test(`changing native ancestor ${field} invalidates an open menu even for the same conversation`, () => {
    const ui = picker();
    ui.open();
    ui.control("context").click();
    ui.setIdentity({ [field]: field === "permissionsHostId" ? "other-host" : "C:\\other-fixture" });
    ui.refresh();
    assert.equal(ui.root.hidden, true,
      "Conversation identity alone is insufficient across native host/workspace changes");
  });
}

async function pendingThreadUpdate() {
  const completion = deferred();
  const calls = [];
  const ui = picker({
    ...props(),
    onSelectModel: (...args) => {
      calls.push(["thread-a", ...args]);
      return completion.promise;
    },
  });
  ui.open();
  ui.control("effort").click();
  ui.control("low").click();
  await ui.settle();
  assert.deepEqual(calls, [["thread-a", "gpt-a--long-context", "low"]]);
  assert.ok(ui.root.querySelectorAll("button").every(button => button.disabled),
    "The submitting thread must not send duplicate requests");
  ui.dismiss();
  ui.setProps({
    ...props(),
    onSelectModel: (...args) => calls.push(["thread-b", ...args]),
  });
  ui.setIdentity({ conversationId: "thread-b" });
  ui.refresh();
  return { ui, completion, calls };
}

test("a pending update for another thread does not disable the new thread's controls", async () => {
  const { ui, completion } = await pendingThreadUpdate();
  try {
    ui.open();
    assert.equal(ui.control("effort").disabled, false,
      "Thread-b must not inherit thread-a's in-flight submitting flag");
  } finally {
    completion.resolve();
    await ui.settle();
  }
});

for (const result of ["resolve", "reject"]) {
  test(`an old thread's ${result === "resolve" ? "resolved" : "rejected"} update cannot change the new thread's open menu`, async () => {
    const { ui, completion, calls } = await pendingThreadUpdate();
    ui.open();
    if (result === "reject") completion.reject(new Error("thread-a update rejected"));
    else completion.resolve();
    await ui.settle();
    assert.equal(ui.root.hidden, false,
      "Finishing thread-a's update must not dismiss the menu opened for thread-b");
    assert.deepEqual(ui.alerts(), [],
      "A rejection from thread-a must not be displayed in thread-b's menu");
    assert.equal(ui.control("effort").disabled, false);
    assert.deepEqual(calls, [["thread-a", "gpt-a--long-context", "low"]]);
  });
}

test("an old pending update cannot steal focus after its menu is dismissed", async () => {
  const { ui, completion } = await pendingThreadUpdate();
  const editor = ui.document.createElement("textarea");
  ui.document.body.appendChild(editor);
  editor.focus();
  completion.resolve();
  await ui.settle();
  assert.ok(ui.document.activeElement === editor,
    "Finishing thread-a must not focus the reused trigger while the user types in thread-b");
});

test("settling an old request must not unlock a newer thread's pending request", async () => {
  const { ui, completion, calls } = await pendingThreadUpdate();
  const newer = deferred();
  ui.setProps({
    ...ui.committedProps,
    onSelectModel: (...args) => {
      calls.push(["thread-b", ...args]);
      return newer.promise;
    },
  });
  ui.refresh();
  try {
    ui.open();
    assert.equal(ui.control("effort").disabled, false,
      "The new thread must be able to start its own independent update");
    ui.control("effort").click();
    ui.control("low").click();
    await ui.settle();
    assert.deepEqual(calls, [
      ["thread-a", "gpt-a--long-context", "low"],
      ["thread-b", "gpt-a--long-context", "low"],
    ]);
    completion.resolve();
    await ui.settle();
    ui.refresh();
    assert.equal(ui.root.hidden, false);
    assert.equal(ui.control("low").disabled, true,
      "Thread-a's finally block must not clear thread-b's submitting state");
    ui.control("low").click();
    assert.equal(calls.length, 2, "Do not send a duplicate update while thread-b is pending");
  } finally {
    completion.resolve();
    newer.resolve();
    await ui.settle();
  }
});

test("native model and reasoning disabled flags are independent", () => {
  const active = { ...props(), modelOptionsDisabled: true };
  assert.equal(desktopPickerSelection(groups, active, "model", "gpt-b"), null);
  assert.equal(desktopPickerSelection(groups, active, "context", "default"), null);
  assert.deepEqual(desktopPickerSelection(groups, active, "effort", "low"), {
    slug: "gpt-a--long-context", effort: "low",
  }, "modelOptionsDisabled must not veto an independently enabled reasoning control");

  active.modelOptionsDisabled = false;
  active.reasoningEffortDisabled = true;
  assert.equal(desktopPickerSelection(groups, active, "effort", "low"), null);
  assert.deepEqual(desktopPickerSelection(groups, active, "context", "default"), {
    slug: "gpt-a--default-context", effort: "high",
  });
});

for (const [description, flags] of [
  ["disabled", { disabled: true }],
  ["daybreak.disabled", { daybreak: { disabled: true } }],
  ["daybreak.isSaving", { daybreak: { isSaving: true } }],
]) {
  test(`native ${description} blocks model, effort and context updates`, async () => {
    const calls = [];
    const active = { ...props(), ...flags, onSelectModel: (...args) => calls.push(args) };
    for (const [kind, value] of [["model", "gpt-b"], ["effort", "low"], ["context", "default"]]) {
      assert.equal(desktopPickerSelection(groups, active, kind, value), null);
    }
    const ui = picker(active);
    const event = ui.open("Enter");
    if (flags.disabled) {
      assert.equal(ui.root.hidden, true);
      assert.equal(event.defaultPrevented, false, "A disabled picker must remain native");
    } else {
      for (const id of ["model", "effort", "context"]) {
        assert.equal(ui.control(id).disabled, true);
        ui.control(id).click();
      }
    }
    await ui.settle();
    assert.deepEqual(calls, []);
  });
}

test("an enabled Effort row remains actionable when native model selection is disabled", async () => {
  const calls = [];
  const active = {
    ...props(), modelOptionsDisabled: true,
    onSelectModel: (...args) => {
      calls.push(args);
      [active.model, active.reasoningEffort] = args;
    },
  };
  const ui = picker(active);
  ui.open();
  assert.equal(ui.control("model").disabled, true);
  assert.equal(ui.control("context").disabled, true);
  assert.equal(ui.control("effort").disabled, false);
  ui.control("effort").click();
  assert.equal(ui.control("low").disabled, false);
  ui.control("low").click();
  await ui.settle();
  assert.deepEqual(calls, [["gpt-a--long-context", "low"]],
    "A visibly enabled effort choice must not fail with 'This selection is unavailable'");
});

for (const [view, flag, value] of [
  ["model", "modelOptionsDisabled", "gpt-b"],
  ["context", "modelOptionsDisabled", "default"],
  ["effort", "reasoningEffortDisabled", "low"],
]) {
  test(`a native ${flag} update disables an already open ${view} submenu`, async () => {
    const calls = [];
    const active = { ...props(), onSelectModel: (...args) => calls.push(args) };
    const ui = picker(active);
    ui.open();
    ui.control(view).click();
    ui.setProps({ ...active, [flag]: true });
    ui.refresh();
    assert.equal(ui.control(value).disabled, true);
    ui.control(value).click();
    await ui.settle();
    assert.deepEqual(calls, []);
  });
}

test("per-option disabled reasons block context choices and fully disabled model groups", async () => {
  const calls = [];
  const active = { ...props(), onSelectModel: (...args) => calls.push(args) };
  for (const option of active.modelOptions) {
    if (option.model.model === "gpt-a--default-context" ||
        option.model.model.startsWith("gpt-b")) {
      option.disabledReason = { reason: "native restriction" };
    }
  }
  const state = desktopPickerState(groups, active);
  assert.equal(state.contexts.find(item => item.id === "default").disabled, true);
  assert.equal(state.models.find(item => item.id === "gpt-b").disabled, true);
  assert.equal(desktopPickerSelection(groups, active, "context", "default"), null);
  assert.equal(desktopPickerSelection(groups, active, "model", "gpt-b"), null);
  const ui = picker(active);
  ui.open();
  ui.control("context").click();
  assert.equal(ui.control("default").disabled, true);
  ui.control("default").click();
  ui.control("back").click();
  ui.control("model").click();
  assert.equal(ui.control("gpt-b").disabled, true);
  ui.control("gpt-b").click();
  await ui.settle();
  assert.deepEqual(calls, []);
});

for (const attribute of ["disabled", "aria-disabled"]) {
  test(`the native trigger becoming ${attribute} closes the popup without an explicit refresh`, () => {
    const ui = picker();
    ui.open();
    ui.flushFrames();
    assert.equal(ui.root.hidden, false);
    ui.trigger.setAttribute(attribute, attribute === "disabled" ? "" : "true");
    ui.flushFrames();
    assert.equal(ui.root.hidden, true,
      "Observe native trigger availability changes, including aria-disabled");
    assert.equal(ui.trigger.getAttribute("data-codex-copilot-model-summary"), null);
    assert.equal(ui.trigger.getAttribute("aria-label"), "选择模型");
    const event = ui.key("Enter", ui.trigger);
    assert.equal(event.defaultPrevented, false,
      "Unavailable native controls must not be intercepted");
  });
}

test("models without reasoning support disable Effort and submit null instead of an invented effort", async () => {
  const calls = [];
  const active = {
    ...props(),
    onSelectModel: (...args) => {
      calls.push(args);
      [active.model, active.reasoningEffort] = args;
    },
  };
  const target = active.models.find(model => model.model === "gpt-c");
  target.supportedReasoningEfforts = [];
  delete target.defaultReasoningEffort;
  assert.deepEqual(desktopPickerSelection(groups, active, "model", "gpt-c"), {
    slug: "gpt-c", effort: null,
  });
  const ui = picker(active);
  ui.open();
  ui.control("model").click();
  ui.control("gpt-c").click();
  await ui.settle();
  assert.deepEqual(calls, [["gpt-c", null]]);
  ui.setProps({ ...active, model: "gpt-c", reasoningEffort: null });
  ui.refresh();
  ui.open();
  assert.equal(ui.control("effort").disabled, true);
  assert.equal(ui.control("context").disabled, true);
  ui.control("effort").click();
  assert.ok(ui.control("model"), "No empty effort submenu should be opened");
  assert.deepEqual(desktopPickerState(groups, ui.committedProps).efforts, []);
});

test("the explicit 'none' reasoning effort is distinct from a model with no effort control", async () => {
  const calls = [];
  const active = {
    ...props(),
    onSelectModel: (...args) => {
      calls.push(args);
      [active.model, active.reasoningEffort] = args;
    },
  };
  const target = active.models.find(model => model.model === active.model);
  target.supportedReasoningEfforts = ["none", "low", "high"]
    .map(reasoningEffort => ({ reasoningEffort }));
  assert.deepEqual(desktopPickerSelection(groups, active, "effort", "none"), {
    slug: "gpt-a--long-context", effort: "none",
  });
  const ui = picker(active);
  ui.open();
  assert.equal(ui.control("effort").disabled, false);
  ui.control("effort").click();
  assert.equal(ui.control("none").children[0].textContent, "None");
  ui.control("none").click();
  await ui.settle();
  assert.deepEqual(calls, [["gpt-a--long-context", "none"]]);
});

test("a synchronous native preselection veto makes no update and leaves the menu usable", async () => {
  const calls = [];
  const before = [];
  const ui = picker({
    ...props(),
    onBeforeSelectModel: slug => { before.push(slug); return false; },
    onSelectModel: (...args) => calls.push(args),
  });
  ui.open();
  ui.control("effort").click();
  ui.control("low").click();
  await ui.settle();
  assert.deepEqual(before, ["gpt-a--long-context"]);
  assert.deepEqual(calls, []);
  assert.equal(ui.root.hidden, false);
  assert.equal(ui.control("low").disabled, false);
});

for (const asynchronous of [false, true]) {
  const description = asynchronous ? "an asynchronous rejection" : "a synchronous exception";
  test(`a native callback with ${description} shows an error and permits retry`, async () => {
    let fail = true;
    const calls = [];
    const active = {
      ...props(),
      onSelectModel: (...args) => {
        calls.push(args);
        if (fail) {
          const error = new Error("native update refused");
          if (asynchronous) return Promise.reject(error);
          throw error;
        }
        [active.model, active.reasoningEffort] = args;
      },
    };
    const ui = picker(active);
    ui.open();
    ui.control("effort").click();
    ui.control("low").click();
    await ui.settle();
    assert.equal(ui.root.hidden, false);
    assert.deepEqual(ui.alerts(), ["native update refused"]);
    assert.equal(active.reasoningEffort, "high");
    assert.equal(ui.control("low").disabled, false);
    fail = false;
    ui.control("low").click();
    await ui.settle();
    assert.equal(calls.length, 2);
    assert.equal(active.reasoningEffort, "low");
    assert.equal(ui.root.hidden, true);
  });

  test(`a native callback returning ${asynchronous ? "Promise<false>" : "false"} is not treated as success`, async () => {
    const calls = [];
    const active = {
      ...props(),
      onSelectModel: (...args) => {
        calls.push(args);
        return asynchronous ? Promise.resolve(false) : false;
      },
    };
    const ui = picker(active);
    ui.open();
    ui.control("effort").click();
    ui.control("low").click();
    await ui.settle();
    assert.deepEqual(calls, [["gpt-a--long-context", "low"]]);
    assert.equal(active.reasoningEffort, "high");
    assert.equal(ui.root.hidden, false,
      "A native false return declined the update; keep the menu available for retry");
    assert.equal(ui.control("low").disabled, false);
  });
}

test("choosing the already selected effort is a no-op, closes, and restores trigger focus", async () => {
  const calls = [];
  const ui = picker({
    ...props(),
    onBeforeSelectModel: (...args) => calls.push(["before", ...args]),
    onSelectModel: (...args) => calls.push(["select", ...args]),
  });
  ui.open();
  ui.control("effort").click();
  ui.control("high").click();
  await ui.settle();
  assert.deepEqual(calls, []);
  assert.equal(ui.root.hidden, true);
  assert.equal(ui.document.activeElement, ui.trigger);
});

for (const key of ["Enter", " ", "ArrowDown"]) {
  test(`${JSON.stringify(key)} opens the menu without also activating the native picker`, () => {
    const ui = picker();
    const event = ui.open(key);
    assert.equal(ui.root.hidden, false);
    assert.equal(ui.document.activeElement, ui.control("model"));
    assert.equal(event.defaultPrevented, true);
    assert.equal(event.immediatePropagationStopped, true);
    assert.equal(ui.trigger.getAttribute("aria-expanded"), "true");
  });
}

test("keyboard opening focuses the first enabled row when Model is natively disabled", () => {
  const ui = picker({ ...props(), modelOptionsDisabled: true });
  ui.open("ArrowDown");
  assert.equal(ui.control("model").disabled, true);
  assert.equal(ui.control("effort").disabled, false);
  assert.equal(ui.document.activeElement?.dataset.ccControl, "effort",
    "A disabled button cannot receive focus; leaving focus on the trigger breaks keyboard navigation");
});

test("menu arrows wrap, Home/End skip disabled choices, and Escape restores focus", () => {
  const active = props();
  for (const option of active.modelOptions) {
    if (option.model.model.startsWith("gpt-b")) option.disabledReason = { reason: "disabled" };
  }
  const ui = picker(active);
  ui.open("Enter");
  ui.control("model").click();
  assert.equal(ui.document.activeElement, ui.control("back"));
  ui.key("ArrowDown");
  assert.equal(ui.document.activeElement, ui.control("gpt-a"));
  ui.key("ArrowDown");
  assert.equal(ui.document.activeElement, ui.control("gpt-c"));
  ui.key("ArrowDown");
  assert.equal(ui.document.activeElement, ui.control("back"));
  ui.key("ArrowUp");
  assert.equal(ui.document.activeElement, ui.control("gpt-c"));
  ui.key("Home");
  assert.equal(ui.document.activeElement, ui.control("back"));
  ui.key("End");
  assert.equal(ui.document.activeElement, ui.control("gpt-c"));
  const back = ui.key("Escape");
  assert.equal(back.defaultPrevented, true);
  assert.equal(ui.root.hidden, false);
  assert.equal(ui.document.activeElement, ui.control("model"));
  ui.key("Escape");
  assert.equal(ui.root.hidden, true);
  assert.equal(ui.document.activeElement, ui.trigger);
  assert.equal(ui.trigger.getAttribute("aria-expanded"), "false");
});

test("Tab can move focus out of the menu and close it without a native selection", () => {
  const calls = [];
  const ui = picker({ ...props(), onSelectModel: (...args) => calls.push(args) });
  const outside = ui.document.createElement("input");
  ui.document.body.appendChild(outside);
  ui.open("Enter");
  const event = ui.key("Tab");
  assert.equal(event.defaultPrevented, false);
  outside.focus();
  assert.equal(ui.root.hidden, true);
  assert.equal(ui.document.activeElement, outside);
  assert.deepEqual(calls, []);
});
