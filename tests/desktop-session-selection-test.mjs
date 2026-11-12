import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import {
  buildDesktopSessionsPatch, buildDesktopSessionSelectionPatch,
} from "../bridge/desktop-sessions.mjs";

const source = buildDesktopSessionSelectionPatch();

function fixture() {
  const nodes = new Map();
  let appends = 0, writes = 0;
  const document = {
    head: {
      append(node) {
        nodes.set(node.id, node);
        appends++;
      },
    },
    getElementById(id) { return nodes.get(id) || null; },
    createElement(tag) {
      assert.equal(tag, "style", "Do not replace the manager or its checkboxes");
      let text = "";
      return {
        id: "",
        get textContent() { return text; },
        set textContent(value) { text = value; writes++; },
      };
    },
  };
  const controller = {
    selected: new Set(["first", "second"]),
    pendingPlan: "keep-this-plan",
    inspect() { assert.fail("A style-only patch must not need controller state"); },
    dispose() { assert.fail("A style-only patch must never dispose the controller"); },
  };
  const context = vm.createContext({ document, __codexCopilotSessionsV1: controller });
  return {
    context, controller, document, nodes,
    run() { return vm.runInContext(source, context); },
    get css() { return nodes.get("codex-copilot-session-selection-style")?.textContent; },
    get appends() { return appends; },
    get writes() { return writes; },
  };
}

test("selection appearance is standalone and restores native checked/mixed glyphs", () => {
  new vm.Script(source);
  const ui = fixture();
  assert.equal(ui.run(), "active");
  assert.match(ui.css, /input\[type=checkbox\] \{[\s\S]*?appearance:auto/);
  assert.match(ui.css, /width:20px; height:20px/);
  assert.match(ui.css, /padding:0; margin:2px 0/);
  assert.match(ui.css, /accent-color:var\(--ccs-selection-accent\)/);
});

test("selected rows use the real checked state, a full-row tint and a contrasting rail", () => {
  const ui = fixture();
  ui.run();
  assert.match(ui.css, /tr:has\(input\[type=checkbox\]:checked\) > td \{\s*background:/);
  assert.match(ui.css, /td:first-child \{\s*box-shadow:inset 4px/);
  assert.match(ui.css, /--ccs-selection-row:light-dark\(#e5efff,#143655\)/);
});

test("keyboard focus, disabled protection and mixed selection remain distinguishable", () => {
  const ui = fixture();
  ui.run();
  assert.match(ui.css, /input\[type=checkbox\]:focus-visible/);
  assert.match(ui.css, /:disabled:not\(:checked\):not\(:indeterminate\)/);
  assert.match(ui.css, /@media\(forced-colors:active\)/);
  assert.match(ui.css, /outline:2px solid Highlight/);
  assert.doesNotMatch(ui.css, /input\[type=checkbox\]:disabled \{[^}]*opacity/);
});

test("selected count is legible and does not depend on the displayed page", () => {
  const ui = fixture();
  ui.run();
  assert.match(ui.css, /\[data-role=count\] \{[\s\S]*?background:#215bc2; color:#fff/);
  assert.match(ui.css, /font-variant-numeric:tabular-nums/);
});

test("appearance injection preserves the exact live controller and batch state", () => {
  const ui = fixture();
  const selected = ui.controller.selected;
  assert.equal(ui.run(), "active");
  assert.equal(ui.context.__codexCopilotSessionsV1, ui.controller);
  assert.equal(ui.controller.selected, selected);
  assert.deepEqual([...selected], ["first", "second"]);
  assert.equal(ui.controller.pendingPlan, "keep-this-plan");
  assert.doesNotMatch(source, /showModal|\.close\(|\.checked\s*=|location\.reload|\.dispose\(/);
});

test("repeated appearance injection neither duplicates styles nor loops through DOM mutations", () => {
  const ui = fixture();
  ui.run();
  assert.equal(ui.appends, 1);
  assert.equal(ui.writes, 1);
  ui.run();
  ui.run();
  assert.equal(ui.appends, 1);
  assert.equal(ui.writes, 1);
});

test("the production factory upgrades appearance without replacing a selected open controller", () => {
  const ui = fixture();
  let refreshed = 0;
  const previous = {
    revision: 8, sidebarLocaleVersion: 1, sidebarPlacementVersion: 3,
    readLifecycleVersion: 1, deleteLifecycleVersion: 1, resultLifecycleVersion: 1,
    metadataLifecycleVersion: 1,
    inspect() { return { open: true, selected: 281, loading: true, pendingPlan: "keep" }; },
    refreshEntry() { refreshed++; },
    dispose() { assert.fail("Preserve the live manager"); },
  };
  ui.context.__codexCopilotSessionsV1 = previous;
  assert.equal(vm.runInContext(buildDesktopSessionsPatch(), ui.context), "active");
  assert.equal(ui.context.__codexCopilotSessionsV1, previous);
  assert.equal(refreshed, 1);
  assert.equal(ui.appends, 1);
});

test("appearance injection safely waits for a document head", () => {
  assert.equal(vm.runInNewContext(source), "unavailable");
  assert.equal(vm.runInNewContext(source, { document: {} }), "unavailable");
});
