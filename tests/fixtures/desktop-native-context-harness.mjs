import assert from "node:assert/strict";
import vm from "node:vm";
import {
  buildDesktopModelControlsPatch,
  desktopModelGroups,
} from "../../bridge/desktop-model-controls.mjs";

// Independent adaptation of the legacy Element/picker/fiberPair fixture.
// Do not import that test file: it intentionally exercises the legacy builder.
export const catalog = {
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
      copilot: { base_model: "gpt-c", default_context_window_tokens: 128_000 },
    },
  ],
};

export const groups = desktopModelGroups(catalog);

export function props(overrides = {}) {
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
    models,
    modelOptions: models.map(model => ({ model, disabledReason: null })),
    disabled: false,
    modelOptionsDisabled: false,
    reasoningEffortDisabled: false,
    onBeforeSelectModel() { return true; },
    onSelectModel() {},
    ...overrides,
  };
}

function addListener(target, name, callback, options = {}) {
  const capture = typeof options === "boolean" ? options : Boolean(options.capture);
  const entries = target.listeners.get(name) || [];
  if (entries.some(entry => entry.callback === callback && entry.capture === capture)) return;
  entries.push({ callback, capture, once: Boolean(options?.once) });
  target.listeners.set(name, entries);
}

function removeListener(target, name, callback, options = {}) {
  const capture = typeof options === "boolean" ? options : Boolean(options.capture);
  const entries = target.listeners.get(name) || [];
  const remaining = entries.filter(entry => entry.callback !== callback || entry.capture !== capture);
  if (remaining.length) target.listeners.set(name, remaining);
  else target.listeners.delete(name);
}

export class Element {
  [Symbol.for("nodejs.util.inspect.custom")]() {
    return `<${this.tagName}${this.id ? "#" + this.id : ""}>`;
  }

  constructor(tag, document) {
    this.tagName = tag.toUpperCase();
    this.nodeType = 1;
    this.document = document;
    this.ownerDocument = document;
    this.children = [];
    this.parent = null;
    this.attributes = new Map();
    this.style = {};
    this.listeners = new Map();
    this._text = "";
    this.dataset = new Proxy({}, {
      get: (_, key) => this.getAttribute(
        "data-" + String(key).replace(/[A-Z]/g, letter => "-" + letter.toLowerCase()),
      ) ?? undefined,
      set: (_, key, value) => {
        this.setAttribute(
          "data-" + String(key).replace(/[A-Z]/g, letter => "-" + letter.toLowerCase()),
          value,
        );
        return true;
      },
    });
  }

  get parentElement() { return this.parent; }
  get parentNode() { return this.parent; }
  get nextSibling() {
    return this.parent?.children[this.parent.children.indexOf(this) + 1] || null;
  }
  get isConnected() { return Boolean(this.document.documentElement?.contains(this)); }
  get id() { return this.getAttribute("id") || ""; }
  set id(value) { this.setAttribute("id", value); }
  get className() { return this.getAttribute("class") || ""; }
  set className(value) { this.setAttribute("class", value); }
  get hidden() { return this.hasAttribute("hidden"); }
  set hidden(value) {
    if (value) this.setAttribute("hidden", "");
    else this.removeAttribute("hidden");
  }
  get disabled() { return this.hasAttribute("disabled"); }
  set disabled(value) {
    if (value) this.setAttribute("disabled", "");
    else this.removeAttribute("disabled");
  }
  get textContent() {
    return this._text + this.children.map(child => child.textContent).join("");
  }
  set textContent(value) {
    const removedNodes = [...this.children];
    for (const child of removedNodes) this.detach(child);
    this._text = String(value);
    this.document.mutation({
      type: "childList", target: this, addedNodes: [], removedNodes,
    });
  }

  hasAttribute(name) { return this.attributes.has(name); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  setAttribute(name, value) {
    const oldValue = this.getAttribute(name);
    this.attributes.set(name, String(value));
    // Real MutationObserver also sees a same-value setAttribute. Suppressing
    // these notifications could conceal a self-sustaining refresh loop.
    this.document.mutation({ type: "attributes", target: this, attributeName: name, oldValue });
  }
  removeAttribute(name) {
    const oldValue = this.getAttribute(name);
    if (!this.attributes.delete(name)) return;
    this.document.mutation({ type: "attributes", target: this, attributeName: name, oldValue });
  }
  detach(child) {
    assert.ok(this.children.includes(child), "Only an attached child can be removed");
    this.children.splice(this.children.indexOf(child), 1);
    child.parent = null;
    if (child.contains(this.document.activeElement)) {
      this.document.activeElement = this.document.body;
    }
  }
  appendChild(child) { return this.insertBefore(child, null); }
  insertBefore(child, reference) {
    assert.ok(reference === null || this.children.includes(reference),
      "The insertion reference must belong to this parent");
    if (child === reference) return child;
    if (child.parent) child.parent.removeChild(child);
    child.parent = this;
    const index = reference === null ? this.children.length : this.children.indexOf(reference);
    this.children.splice(index, 0, child);
    this.document.mutation({
      type: "childList", target: this, addedNodes: [child], removedNodes: [],
    });
    return child;
  }
  removeChild(child) {
    this.detach(child);
    this.document.mutation({
      type: "childList", target: this, addedNodes: [], removedNodes: [child],
    });
    return child;
  }
  append(...children) { children.forEach(child => this.appendChild(child)); }
  remove() { this.parent?.removeChild(this); }
  replaceChildren(...children) {
    const removedNodes = [...this.children];
    for (const child of removedNodes) this.detach(child);
    this._text = "";
    for (const child of children) {
      if (child.parent) child.parent.removeChild(child);
      child.parent = this;
      this.children.push(child);
    }
    if (removedNodes.length || children.length) {
      this.document.mutation({
        type: "childList", target: this, addedNodes: children, removedNodes,
      });
    }
  }
  addEventListener(name, callback, options) { addListener(this, name, callback, options); }
  removeEventListener(name, callback, options) { removeListener(this, name, callback, options); }
  dispatchEvent(event) { return !this.document.dispatch(event.type, this, event).defaultPrevented; }
  click() {
    if (!this.disabled) return this.document.dispatch("click", this);
  }
  focus() {
    if (this.disabled || !this.isConnected) return;
    for (let node = this; node; node = node.parent) {
      if (node.hidden) return;
    }
    this.document.activeElement = this;
    this.document.dispatch("focusin", this);
  }
  contains(target) {
    return this === target || this.children.some(child => child.contains(target));
  }
  matches(selector) {
    if (selector === ":popover-open") return this.popoverOpen === true;
    if (selector.includes(",")) {
      return selector.split(",").some(part => this.matches(part.trim()));
    }
    if (selector === "*") return true;
    if (selector === "button:not(:disabled)") {
      return this.tagName === "BUTTON" && !this.disabled;
    }
    if (/^\.[A-Za-z_][\w-]*$/.test(selector)) {
      return this.className.split(/\s+/).includes(selector.slice(1));
    }
    if (selector.startsWith("#")) return this.id === selector.slice(1);
    const attribute = /^\[([^=\]]+)(?:="((?:\\.|[^"])*)")?\]$/.exec(selector);
    if (attribute) {
      return attribute[2] === undefined
        ? this.hasAttribute(attribute[1])
        : this.getAttribute(attribute[1]) === attribute[2].replace(/\\(["\\])/g, "$1");
    }
    return this.tagName === selector.toUpperCase();
  }
  closest(selector) {
    for (let node = this; node; node = node.parent) {
      if (node.matches(selector)) return node;
    }
    return null;
  }
  querySelectorAll(selector) {
    const descendants = this.children.flatMap(child => [child, ...child.querySelectorAll("*")]);
    return descendants.filter(child => child.matches(selector));
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  showPopover() { this.popoverOpen = true; }
  hidePopover() { this.popoverOpen = false; }
  getBoundingClientRect() {
    const height = this.tagName === "BUTTON" ? 30 : this.children.length * 42 + 20;
    return { left: 100, right: 220, top: 500, bottom: 500 + height, width: 120, height };
  }
}

// The DOM expando stays on A. Only HostRoot.stateNode.current changes when
// React commits B; matching props on uncommitted B must not acknowledge a request.
export function fiberPair(trigger, initial, identity, wrapperDepth = 0) {
  const rootState = { current: null };
  const roots = [0, 1].map(() => ({
    tag: 3, return: null, sibling: null, memoizedProps: null, stateNode: rootState,
  }));
  const paths = roots.map(root => {
    const conversation = {
      tag: 0, return: root, sibling: null, memoizedProps: { ...identity }, stateNode: null,
    };
    const owner = {
      tag: 0, return: conversation, sibling: null, memoizedProps: initial, stateNode: null,
    };
    root.child = conversation;
    conversation.child = owner;
    const path = [root, conversation, owner];
    let parent = owner;
    for (let index = 0; index < wrapperDepth; index++) {
      const wrapper = {
        tag: 0, return: parent, child: null, sibling: null, memoizedProps: {}, stateNode: null,
      };
      parent.child = wrapper;
      parent = wrapper;
      path.push(wrapper);
    }
    const host = {
      tag: 5, return: parent, child: null, sibling: null, memoizedProps: {}, stateNode: trigger,
    };
    parent.child = host;
    path.push(host);
    return path;
  });
  for (let index = 0; index < paths[0].length; index++) {
    paths[0][index].alternate = paths[1][index];
    paths[1][index].alternate = paths[0][index];
  }
  rootState.current = roots[0];
  trigger.__reactFiber$synthetic = paths[0].at(-1);
  return rootState;
}

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export function listenerSnapshot(target) {
  return [...target.listeners].map(([name, entries]) => [
    name, entries.map(entry => ({ ...entry })),
  ]);
}

export function snapshotTree(root, {
  ignoreAliasMarks = false, normalizeModelLabels = false, ignoreExpanded = false,
  ignoreHidden = false,
} = {}) {
  const own = node => node.id?.startsWith("codex-copilot-");
  const nodes = [root, ...root.querySelectorAll("*")].filter(node => node === root || !own(node)
    && !node.closest('[id="codex-copilot-context-menu"]'));
  const normalize = value => {
    if (!normalizeModelLabels) return value;
    for (const entry of catalog.models) {
      if (value !== entry.display_name) continue;
      return groups.find(group => group.id === entry.copilot?.base_model)?.name || value;
    }
    return value;
  };
  return nodes.map(node => ({
    node,
    parent: node.parentElement,
    children: [...node.children].filter(child => !own(child)),
    attributes: [...node.attributes].filter(([name]) =>
      (!ignoreAliasMarks || name !== "data-cc-context-model-alias-hidden") &&
      name !== "data-cc-context-popover" &&
      name !== "data-cc-context-panel-row"
      && !(ignoreExpanded && node === root && name === "aria-expanded")
      && !(ignoreHidden && node === root && name === "hidden")),
    text: normalize(node._text),
    value: node.value,
    type: node.type,
    styleObject: node.style,
    style: { ...node.style },
    listeners: listenerSnapshot(node),
  }));
}

export function snapshotNative(ui, options) {
  return [
    ...snapshotTree(ui.trigger, { ...options, ignoreExpanded: options?.ignoreOpenState }),
    ...snapshotTree(ui.nativeMenu, { ...options, ignoreHidden: options?.ignoreOpenState }),
    ...snapshotTree(ui.nativeStyle, options),
    ...snapshotTree(ui.trailingButton, options),
  ];
}

export function picker(initial = props(), identity = {
  conversationId: "thread-a",
  permissionsHostId: "isolated-test-host",
  permissionsCwdOverride: "C:\\isolated-context-fixture",
}, { autoInstall = true, wrapperDepth = 0, compactPanel = false } = {}) {
  const observers = [];
  const frames = new Map();
  const timers = new Map();
  const mutations = [];
  const stats = { frames: 0, observerDeliveries: 0 };
  const nativeEvents = { clicks: 0, keys: [], pointers: 0, effortInputs: [], documentClicks: 0 };
  let clock = 0;
  let timerId = 0;
  let frameId = 0;
  let fibers;
  const document = {
    nodeType: 9,
    listeners: new Map(),
    activeElement: null,
    createElement(tag) { return new Element(tag, document); },
    addEventListener(name, callback, options) { addListener(document, name, callback, options); },
    removeEventListener(name, callback, options) {
      removeListener(document, name, callback, options);
    },
    querySelectorAll(selector) {
      const root = document.documentElement;
      if (!root) return [];
      return [...(root.matches(selector) ? [root] : []), ...root.querySelectorAll(selector)];
    },
    querySelector(selector) { return document.querySelectorAll(selector)[0] || null; },
    mutation(record) {
      mutations.push(record);
      for (const observer of observers) {
        if (!observer.target) continue;
        if (observer.target !== record.target &&
            !(observer.options.subtree && observer.target.contains(record.target))) continue;
        if (!observer.options[record.type]) continue;
        if (record.type === "attributes" && observer.options.attributeFilter &&
            !observer.options.attributeFilter.includes(record.attributeName)) continue;
        observer.records.push(record);
      }
    },
    dispatch(type, target, init = {}) {
      // Freeze the propagation path before invoking any handlers. A handler may
      // detach the target, but the click must still bubble through the old menu
      // to document, just as it does in the browser.
      const path = [];
      for (let node = target; node; node = node.parentNode) path.push(node);
      if (path.includes(document.documentElement)) path.push(document);
      const event = {
        ...init, type, target, bubbles: init.bubbles ?? true,
        currentTarget: null, eventPhase: 0, defaultPrevented: false,
        propagationStopped: false, immediatePropagationStopped: false,
        composedPath() { return [...path]; },
        preventDefault() { this.defaultPrevented = true; },
        stopPropagation() { this.propagationStopped = true; },
        stopImmediatePropagation() {
          this.immediatePropagationStopped = true;
          this.propagationStopped = true;
        },
      };
      const invoke = (node, capture, phase) => {
        event.currentTarget = node;
        event.eventPhase = phase;
        for (const entry of [...(node.listeners.get(type) || [])]) {
          if (entry.capture !== capture) continue;
          if (entry.once) removeListener(node, type, entry.callback, entry.capture);
          entry.callback(event);
          if (event.immediatePropagationStopped) break;
        }
      };
      for (const node of [...path].reverse()) {
        if (node === target) break;
        invoke(node, true, 1);
        if (event.propagationStopped) break;
      }
      if (!event.propagationStopped) {
        invoke(target, true, 2);
        if (!event.immediatePropagationStopped) invoke(target, false, 2);
      }
      if (event.bubbles && !event.propagationStopped) {
        for (const node of path.slice(1)) {
          invoke(node, false, 3);
          if (event.propagationStopped) break;
        }
      }
      event.currentTarget = null;
      event.eventPhase = 0;
      return event;
    },
  };
  document.documentElement = document.createElement("html");
  document.head = document.createElement("head");
  document.body = document.createElement("body");
  document.documentElement.append(document.head, document.body);
  document.activeElement = document.body;

  const nativeStyle = document.createElement("style");
  nativeStyle.id = "native-picker-style";
  nativeStyle.textContent = `
    [data-codex-intelligence-trigger] { display: inline-flex; }
    #native-effort-slider { touch-action: none; accent-color: var(--native-accent); }
    .native-effort-thumb { transition: transform 120ms ease; }
  `;
  document.head.appendChild(nativeStyle);
  const toolbar = document.createElement("div");
  toolbar.className = "native-picker-toolbar";
  document.body.appendChild(toolbar);
  const nativeMenu = document.createElement("div");
  nativeMenu.id = "native-model-menu";
  nativeMenu.setAttribute("role", "menu");
  nativeMenu.hidden = true;
  nativeMenu.style.cssText = "transform: translateY(-4px); animation: native-popover 120ms ease;";
  nativeMenu.setAttribute("style", nativeMenu.style.cssText);
  document.body.appendChild(nativeMenu);
  const modelRows = new Map();
  for (const option of initial.modelOptions || []) {
    const row = document.createElement("div");
    row.setAttribute("role", "menuitemradio");
    row.setAttribute("aria-label", option.model.displayName);
    const label = document.createElement("span");
    label.textContent = option.model.displayName;
    row.appendChild(label);
    row.addEventListener("click", () => {});
    nativeMenu.appendChild(row);
    modelRows.set(option.model.model, row);
  }
  const unknownRow = document.createElement("div");
  unknownRow.setAttribute("role", "menuitem");
  const unknownLabel = document.createElement("span");
  unknownLabel.textContent = (initial.modelOptions?.[0]?.model.displayName || "Automatic") +
    " (vendor recommended)";
  unknownRow.appendChild(unknownLabel);
  nativeMenu.appendChild(unknownRow);

  const effortRow = document.createElement("div");
  effortRow.setAttribute("role", "menuitem");
  effortRow.setAttribute("aria-label", "Effort");
  const effortLabel = document.createElement("span");
  effortLabel.textContent = "Effort";
  const nativeEffort = document.createElement("div");
  nativeEffort.id = "native-effort-slider";
  nativeEffort.setAttribute("role", "slider");
  if (compactPanel) nativeEffort.setAttribute("data-reasoning-slider", "true");
  nativeEffort.setAttribute("aria-label", "Reasoning effort");
  nativeEffort.setAttribute("aria-valuemin", "0");
  nativeEffort.setAttribute("aria-valuemax", "2");
  nativeEffort.setAttribute("tabindex", "0");
  nativeEffort.style.cssText = "width: 128px; touch-action: none; accent-color: var(--native-accent);";
  nativeEffort.setAttribute("style", nativeEffort.style.cssText);
  const rail = document.createElement("div");
  rail.className = "native-effort-rail";
  const thumb = document.createElement("span");
  thumb.className = "native-effort-thumb";
  nativeEffort.append(rail, thumb);
  const efforts = ["low", "medium", "high"];
  nativeEffort.value = String(Math.max(0, efforts.indexOf(initial.reasoningEffort)));
  nativeEffort.setAttribute("aria-valuenow", nativeEffort.value);
  thumb.style.transform = `translateX(${Number(nativeEffort.value) * 50}%)`;
  thumb.setAttribute("style", "transform: " + thumb.style.transform + ";");
  effortRow.append(effortLabel, nativeEffort);
  nativeMenu.appendChild(effortRow);
  let header, modelToggle, headerModel, headerEffort;
  const localizedEffort = effort => ({
    low: "低", medium: "中等", high: "高", xhigh: "极高", max: "最高", ultra: "超高",
  })[effort] || effort;
  if (compactPanel) {
    header = document.createElement("div");
    header.className = "_ViewControls_fixture_170";
    modelToggle = document.createElement("div");
    modelToggle.setAttribute("role", "menuitem");
    modelToggle.setAttribute("data-model-picker-view-toggle", "true");
    headerModel = document.createElement("span");
    headerModel.className = "_ViewToggleModelLabel_fixture_203";
    headerModel.textContent = initial.modelOptions.find(option => option.model.model === initial.model)?.model.displayName;
    headerEffort = document.createElement("span");
    headerEffort.className = "_ViewToggleEffortLabel_fixture_213";
    headerEffort.textContent = localizedEffort(initial.reasoningEffort);
    modelToggle.append(headerEffort, headerModel);
    modelToggle.addEventListener("click", () => { nativeEvents.clicks++; });
    header.appendChild(modelToggle);
    nativeMenu.insertBefore(header, effortRow);
  }
  nativeEffort.addEventListener("input", () => {
    const effort = efforts[Number(nativeEffort.value)];
    assert.ok(effort, "The fixture only generates supported native slider inputs");
    nativeEvents.effortInputs.push(effort);
    // Simulate the native slider's React commit, not a replacement Effort UI.
    commitAlternate({ ...fibers.current.child.child.memoizedProps, reasoningEffort: effort });
    nativeEffort.setAttribute("aria-valuenow", nativeEffort.value);
    thumb.style.transform = `translateX(${Number(nativeEffort.value) * 50}%)`;
    thumb.setAttribute("style", "transform: " + thumb.style.transform + ";");
  });
  nativeEffort.addEventListener("pointerdown", () => { nativeEvents.pointers++; });
  nativeEffort.addEventListener("keydown", event => { nativeEvents.keys.push(event.key); });

  const makeTrigger = () => {
    const button = document.createElement("button");
    button.id = "native-model-trigger";
    button.type = "button";
    button.className = "vendor-model-picker";
    button.setAttribute("data-codex-intelligence-trigger", "true");
    button.setAttribute("aria-label", "选择模型");
    button.setAttribute("aria-haspopup", "menu");
    button.setAttribute("aria-controls", nativeMenu.id);
    button.setAttribute("aria-expanded", "false");
    button.style.cssText = "display: inline-flex; opacity: 1; transform: translateZ(0);";
    button.setAttribute("style", button.style.cssText);
    const label = document.createElement("span");
    label.textContent = compactPanel
      ? initial.modelOptions.find(option => option.model.model === initial.model)?.model.displayName : "GPT-A";
    const chevron = document.createElement("span");
    chevron.setAttribute("aria-hidden", "true");
    chevron.textContent = "⌄";
    button.append(label, chevron);
    button.addEventListener("click", event => {
      nativeEvents.clicks++;
      nativeMenu.hidden = !nativeMenu.hidden;
      event.currentTarget.setAttribute("aria-expanded", String(!nativeMenu.hidden));
    });
    button.addEventListener("keydown", event => { nativeEvents.keys.push(event.key); });
    button.addEventListener("pointerdown", () => { nativeEvents.pointers++; });
    return button;
  };
  let trigger = makeTrigger();
  toolbar.appendChild(trigger);
  const trailingButton = document.createElement("button");
  trailingButton.textContent = "Native tools";
  trailingButton.addEventListener("click", () => {});
  toolbar.appendChild(trailingButton);
  const editor = document.createElement("textarea");
  document.body.appendChild(editor);
  fibers = fiberPair(trigger, initial, identity, wrapperDepth);
  const rowFibers = [fibers.current, fibers.current.alternate].map(root => {
    const owner = root.child.child;
    let previous = owner.child;
    const rows = [];
    for (const [slug, row] of modelRows) {
      const host = { tag: 5, key: slug, return: owner, child: null, sibling: null,
        memoizedProps: {}, stateNode: row };
      previous.sibling = host;
      previous = host;
      rows.push(host);
    }
    return rows;
  });
  for (let index = 0; index < rowFibers[0].length; index++) {
    rowFibers[0][index].alternate = rowFibers[1][index];
    rowFibers[1][index].alternate = rowFibers[0][index];
    rowFibers[0][index].stateNode.__reactFiber$synthetic = rowFibers[0][index];
  }
  if (compactPanel) {
    const roots = [fibers.current, fibers.current.alternate];
    const paths = roots.map(root => {
      const owner = root.child.child;
      const component = {
        tag: 0, return: owner, sibling: null,
        memoizedProps: { selectedPowerSelection: {
          model: initial.model, reasoningEffort: initial.reasoningEffort,
        } },
      };
      const host = { tag: 5, return: component, child: null, sibling: null,
        memoizedProps: {}, stateNode: modelToggle };
      component.child = host;
      const previousSibling = owner.child.sibling;
      owner.child.sibling = component;
      component.sibling = previousSibling;
      return [component, host];
    });
    for (let index = 0; index < 2; index++) {
      for (let part = 0; part < 2; part++) paths[index][part].alternate = paths[1 - index][part];
    }
    modelToggle.__reactFiber$synthetic = paths[0][1];
  }
  document.addEventListener("click", () => { nativeEvents.documentClicks++; });
  const nativeDocumentListeners = listenerSnapshot(document);

  function commitAlternate(next, nextIdentity = fibers.current.child.memoizedProps) {
    fibers.current.alternate.child.memoizedProps = { ...nextIdentity };
    fibers.current.alternate.child.child.memoizedProps = next;
    fibers.current = fibers.current.alternate;
  }

  const scope = {
    document, innerWidth: 900, innerHeight: 900,
    Date: class extends Date { static now() { return clock; } },
    setTimeout(callback, delay = 0) {
      const id = ++timerId;
      timers.set(id, { callback, due: clock + delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    requestAnimationFrame(callback) {
      const id = ++frameId;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) { frames.delete(id); },
    MutationObserver: class {
      constructor(callback) {
        this.callback = callback;
        this.records = [];
        this.target = null;
        this.options = {};
        observers.push(this);
      }
      observe(target, options) { this.target = target; this.options = options; }
      disconnect() { this.target = null; this.options = {}; this.records = []; }
      takeRecords() { return this.records.splice(0); }
    },
  };
  scope.globalThis = scope;
  const context = vm.createContext(scope);
  const flushObservers = () => {
    for (const observer of observers) {
      if (observer.target && observer.records.length) {
        stats.observerDeliveries++;
        observer.callback(observer.takeRecords(), observer);
      }
    }
  };
  const flushFrames = () => {
    for (let cycle = 0; cycle < 40; cycle++) {
      flushObservers();
      const ready = [...frames.values()];
      frames.clear();
      for (const callback of ready) { stats.frames++; callback(clock); }
      if (!frames.size && !observers.some(observer => observer.records.length)) return;
    }
    assert.fail("The Context extension did not settle within 40 Observer/animation-frame cycles");
  };

  const ui = {
    document, scope, toolbar, nativeMenu, nativeStyle, nativeEffort, effortRow,
    rail, thumb, trailingButton, unknownRow, modelRows, editor, nativeEvents,
    header, modelToggle, headerModel, headerEffort,
    nativeDocumentListeners, observers, mutations, stats, flushFrames, flushObservers,
    get trigger() { return trigger; },
    get hostRoot() { return fibers; },
    get committedProps() { return fibers.current.child.child.memoizedProps; },
    get identity() { return fibers.current.child.memoizedProps; },
    get controller() { return scope.__codexCopilotModelControlsV1; },
    get button() { return document.querySelector("#codex-copilot-context-trigger"); },
    get menu() { return document.querySelector("#codex-copilot-context-menu"); },
    get style() { return document.querySelector("#codex-copilot-context-extension-style"); },
    get pendingTimers() { return timers.size; },
    get pendingFrames() { return frames.size; },
    get pendingRecords() {
      return observers.reduce((total, observer) => total + observer.records.length, 0);
    },
    get activeObservers() { return observers.filter(observer => observer.target).length; },
    install(patchGroups = groups) {
      return vm.runInContext(buildDesktopModelControlsPatch(patchGroups), context);
    },
    runPatch(patch) { return vm.runInContext(patch, context); },
    setProps(next) { fibers.current.child.child.memoizedProps = next; },
    setIdentity(next) {
      fibers.current.child.memoizedProps = { ...fibers.current.child.memoizedProps, ...next };
    },
    prepareAlternate(next, nextIdentity = fibers.current.child.memoizedProps) {
      fibers.current.alternate.child.memoizedProps = { ...nextIdentity };
      fibers.current.alternate.child.child.memoizedProps = next;
    },
    commitAlternate,
    previewPower(model, effort) {
      assert(compactPanel);
      const component = fibers.current.child.child.child.sibling;
      component.memoizedProps = { selectedPowerSelection: { model, reasoningEffort: effort } };
      headerEffort.textContent = localizedEffort(effort);
      headerModel.textContent = initial.modelOptions.find(option => option.model.model === model)?.model.displayName;
    },
    replaceTrigger(next, nextIdentity = fibers.current.child.memoizedProps) {
      const previous = trigger;
      previous.remove();
      trigger = makeTrigger();
      toolbar.insertBefore(trigger, trailingButton);
      fibers = fiberPair(trigger, next, nextIdentity, wrapperDepth);
      return previous;
    },
    refresh() {
      assert.ok(ui.controller, "The fixture must have an installed Context controller");
      ui.controller.refresh();
      flushFrames();
    },
    advance(milliseconds) {
      const until = clock + milliseconds;
      for (let count = 0; ; count++) {
        assert.ok(count < 1000, "The fake timer queue must terminate");
        const ready = [...timers].filter(([, timer]) => timer.due <= until)
          .sort((left, right) => left[1].due - right[1].due || left[0] - right[0])[0];
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
    open() {
      assert.ok(ui.button, "Expected the additional Context button");
      if (nativeMenu.hidden) { trigger.click(); flushFrames(); }
      ui.button.click();
      assert.equal(ui.menu.hidden, false, "Context must open without replacing the native menu");
    },
    option(tier) {
      const option = ui.menu.querySelector(`[data-cc-context-tier="${tier}"]`);
      assert.ok(option, `Expected Context option ${tier}`);
      return option;
    },
    key(key, target = document.activeElement) {
      return document.dispatch("keydown", target, { key });
    },
    inputEffort(effort) {
      const index = efforts.indexOf(effort);
      assert.notEqual(index, -1);
      nativeEffort.value = String(index);
      document.dispatch("input", nativeEffort);
    },
    dismiss() { document.dispatch("click", editor); },
    alerts() { return ui.menu.querySelectorAll('[role="alert"]').map(item => item.textContent); },
    async settle() {
      await new Promise(resolve => setImmediate(resolve));
      flushFrames();
    },
    dispose() {
      ui.controller?.dispose?.();
      flushFrames();
    },
  };
  mutations.length = 0;
  if (autoInstall) {
    assert.equal(ui.install(), "active");
    flushFrames();
  }
  return ui;
}
