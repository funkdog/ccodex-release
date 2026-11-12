import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { buildDesktopCreditsPatch } from "../bridge/desktop-credits.mjs";
import { creditsView } from "../bridge/copilot-credits.mjs";
import { picker, props, snapshotNative } from "./fixtures/desktop-native-context-harness.mjs";

test("real Desktop ring DOM refreshes actual account projections, clears account switches and disposes without touching native controls", async t => {
  const ui = picker(props());
  t.after(() => ui.dispose());
  const native = snapshotNative(ui);
  const base = Date.now();
  let clock = base;
  let account = { status: "authenticated", accountGeneration: "one",
    credits: { ...creditsView({
      status: "available", unit: "credits", used: 750, allowance: 1000,
      updatedAt: new Date(base).toISOString(),
    }, { now: clock }), accountGeneration: "one" } };
  const listeners = new Map(), intervals = new Map();
  let intervalId = 0;
  ui.document.createElementNS = (_namespace, tag) => ui.document.createElement(tag);
  const footer = ui.document.createElement("div");
  const profile = ui.document.createElement("button");
  profile.setAttribute("aria-label", "Profile menu");
  footer.appendChild(profile);
  ui.document.body.appendChild(footer);
  ui.scope.Date = class extends Date { static now() { return clock; } };
  ui.scope.crypto = { randomUUID };
  ui.scope.addEventListener = (name, callback) => listeners.set(name, callback);
  ui.scope.removeEventListener = (name, callback) => {
    if (listeners.get(name) === callback) listeners.delete(name);
  };
  ui.scope.setInterval = (callback, ms) => { const id = ++intervalId; intervals.set(id, { callback, ms }); return id; };
  ui.scope.clearInterval = id => intervals.delete(id);
  ui.scope.__codexCopilotAccountRequest = input => {
    const request = JSON.parse(input);
    assert.deepEqual({ path: request.path, method: request.method }, { path: "/account", method: "GET" });
    queueMicrotask(() => listeners.get("codex-copilot-account-response")?.({
      detail: { id: request.id, ok: true, body: structuredClone(account) },
    }));
  };
  assert.equal(ui.runPatch(buildDesktopCreditsPatch()), "active");
  await ui.settle();
  const root = ui.document.querySelector("#codex-copilot-credits");
  const arc = root.querySelector(".cc-credits-arc");
  assert.equal(root.parentElement, footer);
  assert.equal(profile.parentElement, footer);
  assert.equal(root.querySelector("svg").getAttribute("viewBox"), "0 0 40 40");
  assert.equal(arc.getAttribute("stroke-dashoffset"), "25");
  assert.equal(arc.getAttribute("stroke"), "#bf8700");
  assert(root.textContent.includes("750 / 1,000 AI credits"));
  assert([...intervals.values()].some(entry => entry.ms === 15000));
  assert.deepEqual(snapshotNative(ui), native);
  account = { status: "authenticated", accountGeneration: "two",
    credits: { ...creditsView({
      status: "available", unit: "credits", used: 0, allowance: 2000,
      updatedAt: new Date(base).toISOString(),
    }, { now: clock }), accountGeneration: "two" } };
  await ui.scope.__codexCopilotCreditsV1.refresh();
  assert(root.textContent.includes("0 / 2,000 AI credits"));
  assert(!root.textContent.includes("750"));
  assert.equal(arc.getAttribute("stroke-dashoffset"), "100");
  clock += 900001;
  for (const interval of intervals.values()) if (interval.ms === 1000) interval.callback();
  assert.equal(root.getAttribute("data-status"), "unavailable");
  assert(root.textContent.includes("AI credits unavailable"));
  ui.scope.__codexCopilotCreditsV1.dispose();
  ui.flushFrames();
  assert.equal(root.isConnected, false);
  assert.equal(intervals.size, 0);
  assert.equal(listeners.size, 0);
  assert.equal(ui.pendingTimers, 0);
  assert.deepEqual(snapshotNative(ui), native);
});
