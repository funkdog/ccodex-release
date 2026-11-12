import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { buildDesktopSessionsPatch } from "../bridge/desktop-sessions.mjs";

const source = buildDesktopSessionsPatch();
const refresh = source.match(/function refreshEntry\(\) \{[\s\S]*?\n  \}/)?.[0];
assert(refresh, "The test must use the installed runtime's refresh function");

const english = "Chat sidebar options";
const simplified = "\u804a\u5929\u4fa7\u8fb9\u680f\u9009\u9879";
const traditional = "\u804a\u5929\u5074\u908a\u6b04\u9078\u9805";
const traditionalAlternative = "\u5c0d\u8a71\u5074\u908a\u6b04\u9078\u9805";

function fixture(initialLabel) {
  let label = initialLabel;
  let sidebarPresent = true;
  let optionsPresent = true;
  let text = "Manage";
  let title = "Manage sessions in bulk";
  let writes = 0;
  let appends = 0;
  const attributes = new Map([["aria-label", "Bulk session management"]]);
  const element = (parent = null, names = []) => {
    const node = {
      parentElement: parent,
      children: new Set(),
      attributes: new Set(names),
      classList: new Set(),
      hidden: false,
      hasAttribute(name) { return this.attributes.has(name); },
      querySelector(selector) {
        assert.equal(selector, "[data-app-action-sidebar-section-toggle]");
        const search = parent => {
          for (const child of parent.children || []) {
            if (child.hasAttribute("data-app-action-sidebar-section-toggle")) return child;
            const found = search(child);
            if (found) return found;
          }
          return null;
        };
        return search(this);
      },
      append(child) {
        child.parentElement?.children.delete(child);
        this.children.add(child);
        child.parentElement = this;
        if (child === entry) appends++;
      },
    };
    node.classList.contains = name => node.classList.has(name);
    parent?.children.add(node);
    return node;
  };
  let header, controls, hover, inner, toggle;
  const sidebar = element();
  const entry = {
    parentElement: null,
    hasAttribute(name) { return attributes.has(name); },
    get textContent() { return text; },
    set textContent(value) { text = value; writes++; },
    get title() { return title; },
    set title(value) { title = value; writes++; },
    getAttribute(name) { return attributes.get(name) ?? null; },
    setAttribute(name, value) { attributes.set(name, value); writes++; },
  };
  const anchor = {
    parentElement: null,
    hasAttribute(name) { return name === "aria-label"; },
    getAttribute(name) { return name === "aria-label" ? label : null; },
  };
  function mount(depth = 2, titleDepth = 0) {
    header = element(sidebar);
    header.classList.add("group/nav-section-title");
    let titleParent = header;
    for (let index = 0; index < titleDepth; index++) titleParent = element(titleParent);
    toggle = element(titleParent, ["data-app-action-sidebar-section-toggle"]);
    toggle.textContent = label === english ? "Recent" :
      label === simplified || label === traditional || label === traditionalAlternative ? "\u6700\u8fd1" : "Project";
    controls = element(header);
    hover = element(controls);
    hover.hidden = true;
    inner = hover;
    for (let index = 0; index < depth; index++) inner = element(inner);
    anchor.parentElement = inner;
    inner.children.add(anchor);
  }
  mount();
  sidebar.querySelector = selector =>
    optionsPresent && selector === `[aria-label="${label}"]` ? anchor : null;
  sidebar.querySelectorAll = selector => {
    assert.equal(selector, "[data-app-action-sidebar-section-toggle]");
    return toggle.parentElement.children.has(toggle) ? [toggle] : [];
  };
  function visible() {
    let connected = false;
    for (let node = entry; node; node = node.parentElement) {
      if (node.hidden) return false;
      if (node === sidebar) connected = true;
    }
    return connected;
  }
  const context = vm.createContext({
    entry,
    document: {
      querySelector(selector) {
        assert.equal(selector, ".app-shell-left-panel");
        return sidebarPresent ? sidebar : null;
      },
    },
  });
  return {
    refresh() { vm.runInContext(refresh + "; refreshEntry();", context); },
    entry,
    get writes() { return writes; },
    get appends() { return appends; },
    get children() { return [...header.children].filter(child => child === entry).length; },
    get visible() { return visible(); },
    get header() { return header; },
    get hoverHidden() { return hover.hidden; },
    relabel(value) { label = value; toggle.textContent = label === english ? "Recent" : "\u6700\u8fd1"; },
    removeOptions() { optionsPresent = false; },
    remount(depth, titleDepth) {
      sidebar.children.delete(header);
      header.parentElement = null;
      mount(depth, titleDepth);
    },
    moveIntoHover() { hover.append(entry); },
    removeSidebar() { sidebarPresent = false; },
    removeHeader() { toggle.parentElement.children.delete(toggle); },
  };
}

for (const label of [english, simplified, traditional, traditionalAlternative]) {
  test(`mounts the session entry for ${label}`, () => {
    const ui = fixture(label);
    ui.refresh();
    assert.equal(ui.children, 1);
    assert.equal(ui.visible, true, "The entry must be visible without revealing native hover controls");
    assert.equal(ui.entry.parentElement, ui.header);
    assert.equal(ui.hoverHidden, true, "Native hover-only actions must remain unchanged");
    assert.equal(ui.entry.textContent, label === english ? "Manage" : "\u7ba1\u7406");
    assert.equal(ui.entry.getAttribute("aria-label"),
      label === english ? "Bulk session management" : "\u6279\u91cf\u4f1a\u8bdd\u7ba1\u7406");
    const writes = ui.writes;
    ui.refresh();
    assert.equal(ui.children, 1);
    assert.equal(ui.appends, 1);
    assert.equal(ui.writes, writes, "Repeated refresh must not create a mutation loop");
  });
}

test("moves the same entry after a React header remount", () => {
  const ui = fixture(simplified);
  ui.refresh();
  ui.remount();
  ui.refresh();
  assert.equal(ui.children, 1);
  assert.equal(ui.appends, 2);
  assert.equal(ui.entry.textContent, "\u7ba1\u7406");
  assert.equal(ui.visible, true);
});

test("moves an entry already inside the hidden action group into the visible header", () => {
  const ui = fixture(simplified);
  ui.moveIntoHover();
  assert.equal(ui.visible, false);
  ui.refresh();
  assert.equal(ui.entry.parentElement, ui.header);
  assert.equal(ui.visible, true);
  assert.equal(ui.hoverHidden, true);
  const appends = ui.appends;
  ui.refresh();
  assert.equal(ui.appends, appends);
});

test("finds the visible header through different native wrapper depths", () => {
  for (const depth of [0, 1, 3, 6]) {
    for (const titleDepth of [0, 1, 2, 4]) {
      const ui = fixture(english);
      ui.remount(depth, titleDepth);
      ui.refresh();
      assert.equal(ui.entry.parentElement, ui.header);
      assert.equal(ui.visible, true);
      assert.equal(ui.hoverHidden, true);
    }
  }
});

test("retains visibility when React wraps an existing section title during redraw", () => {
  const ui = fixture(simplified);
  ui.refresh();
  ui.remount(2, 2);
  ui.refresh();
  assert.equal(ui.visible, true);
  assert.equal(ui.entry.parentElement, ui.header);
  assert.equal(ui.appends, 2);
});

test("updates labels when the existing sidebar changes language", () => {
  const ui = fixture(english);
  ui.refresh();
  ui.relabel(simplified);
  ui.refresh();
  assert.equal(ui.entry.textContent, "\u7ba1\u7406");
  ui.relabel(english);
  ui.refresh();
  assert.equal(ui.entry.textContent, "Manage");
  assert.equal(ui.children, 1);
  assert.equal(ui.appends, 1);
});

test("does not attach to a project menu or a missing sidebar/header", () => {
  const project = fixture("\u9879\u76ee\u4fa7\u8fb9\u680f\u9009\u9879");
  project.refresh();
  assert.equal(project.appends, 0);
  const absent = fixture(english);
  absent.removeSidebar();
  absent.refresh();
  assert.equal(absent.appends, 0);
  const noHeader = fixture(english);
  noHeader.removeHeader();
  noHeader.refresh();
  assert.equal(noHeader.appends, 0);
});

test("keeps an already updated controller without replacing its state", () => {
  let refreshed = 0;
  const context = vm.createContext({
    __codexCopilotSessionsV1: {
      revision: 8,
      sidebarLocaleVersion: 1,
      sidebarPlacementVersion: 3,
      readLifecycleVersion: 1,
      deleteLifecycleVersion: 1,
      resultLifecycleVersion: 1,
      metadataLifecycleVersion: 1,
      refreshEntry() { refreshed++; },
      dispose() { assert.fail("An updated controller must not be disposed"); },
    },
  });
  assert.equal(vm.runInContext(source, context), "active");
  assert.equal(refreshed, 1);
});

test("a fresh empty Recent section exposes management without an options menu", () => {
  for (const label of [english, simplified, traditional, traditionalAlternative]) {
    const ui = fixture(label);
    ui.removeOptions();
    ui.refresh();
    assert.equal(ui.visible, true);
    assert.equal(ui.entry.parentElement, ui.header);
    assert.equal(ui.entry.textContent, label === english ? "Manage" : "\u7ba1\u7406");
  }
});

test("a changed localized options label still mounts via the Recent section", () => {
  const ui = fixture(simplified);
  ui.relabel("\u804a\u5929\u4fa7\u8fb9\u680f\u66f4\u591a\u9009\u9879");
  ui.refresh();
  assert.equal(ui.visible, true);
  assert.equal(ui.entry.textContent, "\u7ba1\u7406");
});

test("localized attribute and text changes trigger session-entry refresh", () => {
  assert.match(source, /observer\.observe\(document\.body, \{ childList: true, subtree: true, characterData: true,/);
  assert.match(source, /attributeFilter: \["aria-label", "data-app-action-sidebar-section-toggle"\]/);
});

for (const busy of [
  { open: true }, { loading: true }, { applying: true },
  { pendingPlan: "plan" }, { preview: "preview" }, { selected: 2 },
]) {
  test(`preserves existing user state during placement upgrade: ${Object.keys(busy)[0]}`, () => {
    const context = vm.createContext({
      __codexCopilotSessionsV1: {
        revision: 3,
        inspect() { return busy; },
        dispose() { assert.fail("A busy or unsaved controller must not be disposed"); },
      },
    });
    assert.equal(vm.runInContext(source, context), "reload-required");
  });
}

test("disposes only an idle old controller before installing the replacement", () => {
  let disposed = 0;
  const reachedDom = new Error("reached new controller DOM");
  const context = vm.createContext({
    __codexCopilotSessionsV1: {
      revision: 3,
      inspect() {
        return { open: false, loading: false, applying: false,
          pendingPlan: null, preview: null, selected: 0 };
      },
      dispose() { disposed++; },
    },
    document: { createElement() { throw reachedDom; } },
  });
  assert.throws(() => vm.runInContext(source, context), error => error === reachedDom);
  assert.equal(disposed, 1);
});

test("closing a pending list cancels only read requests and preserves selection", () => {
  const cancel = source.match(/function cancelClosedRead\(\) \{[\s\S]*?\n  \}/)?.[0];
  assert(cancel);
  const rejected = [], cleared = [], selection = new Map([["chosen", { title: "Keep me" }]]);
  const context = vm.createContext({
    debounce: 7, selecting: false, applying: false, pendingPlan: null, preview: null,
    sequence: 3, loading: true, selection,
    pendingRequests: new Map([
      ["read", { operation: "list", timer: 8, reject: error => rejected.push(error.message) }],
      ["write", { operation: "apply", timer: 9, reject: () => assert.fail("Do not cancel a batch") }],
    ]),
    clearTimeout: timer => cleared.push(timer),
    status() {}, controls() {},
  });
  assert.equal(vm.runInContext(cancel + "; cancelClosedRead()", context), true);
  assert.equal(context.loading, false);
  assert.equal(context.sequence, 4);
  assert.equal(context.pendingRequests.has("read"), false);
  assert.equal(context.pendingRequests.has("write"), true);
  assert.equal(selection.size, 1);
  assert.deepEqual(cleared, [7, 8]);
  assert.equal(rejected.length, 1);
});

test("closing a manager never cancels a preview, selection fetch or confirmed batch", () => {
  const cancel = source.match(/function cancelClosedRead\(\) \{[\s\S]*?\n  \}/)?.[0];
  for (const state of [
    { selecting: true }, { applying: true }, { pendingPlan: "batch" }, { preview: "preview" },
  ]) {
    const context = vm.createContext({
      debounce: null, selecting: false, applying: false, pendingPlan: null, preview: null,
      ...state, pendingRequests: new Map([["read", { operation: "list" }]]),
      clearTimeout() {}, status() { assert.fail("Do not alter batch state"); },
      controls() { assert.fail("Do not alter batch state"); },
    });
    assert.equal(vm.runInContext(cancel + "; cancelClosedRead()", context), false);
    assert.equal(context.pendingRequests.size, 1);
  }
  assert.match(source, /else if \(!preview\) await load\(false\)/);
});
