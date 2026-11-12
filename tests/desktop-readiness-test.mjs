import assert from "node:assert/strict";
import test from "node:test";
import { awaitDesktopRenderer } from "../bridge/desktop-readiness.mjs";

function harness(overrides = {}) {
  let clock = 0;
  return {
    pid: 1234, port: 22691, timeoutMs: 1000,
    now: () => clock,
    pause: async ms => { clock += ms; },
    owner: async () => 1234,
    isAlive: () => true,
    request: async () => ({
      ok: true,
      json: async () => [{ id: "own-renderer", type: "page", url: "app://-/index.html",
        webSocketDebuggerUrl: "ws://127.0.0.1:22691/devtools/page/own-renderer" }],
    }),
    ...overrides,
  };
}

test("Desktop readiness confirms a vendor page and its exact process owner", async () => {
  assert.deepEqual(await awaitDesktopRenderer(harness()), {
    pid: 1234, port: 22691, rendererVerified: true, endpointOwnerVerified: true,
    rendererId: "own-renderer", rendererUrl: "app://-/index.html",
  });
});

test("Desktop readiness cannot borrow another process's endpoint", async () => {
  await assert.rejects(awaitDesktopRenderer(harness({ owner: async () => 9999 })), /another process/);
});

test("Desktop readiness rejects a private endpoint redirected to another origin", async () => {
  await assert.rejects(awaitDesktopRenderer(harness({
    request: async () => ({ ok: true, json: async () => [{
      type: "page", url: "app://-/index.html",
      webSocketDebuggerUrl: "ws://unrelated.invalid:22691/devtools/page/p",
    }] }),
  })), /expected private loopback/);
});

test("Desktop readiness does not equate a closed new process with an older focused window", async () => {
  await assert.rejects(awaitDesktopRenderer(harness({
    isAlive: () => false,
    request: () => assert.fail("do not inspect a stale process endpoint"),
  })), /exited before/);
});

test("Desktop readiness waits through startup but does not accept an arbitrary web tab", async () => {
  await assert.rejects(awaitDesktopRenderer(harness({
    request: async () => ({ ok: true, json: async () => [{
      type: "page", url: "https://example.invalid", webSocketDebuggerUrl: "ws://127.0.0.1:22691/p",
    }] }),
  })), /did not become ready/);
});

test("Desktop readiness handles transient endpoint connection failure without replaying input", async () => {
  const base = harness();
  const ready = base.request;
  let calls = 0;
  base.request = async (...args) => {
    if (++calls < 3) throw new Error("not listening yet");
    return ready(...args);
  };
  assert.equal((await awaitDesktopRenderer(base)).rendererVerified, true);
  assert.equal(calls, 3);
});

test("Desktop readiness rechecks process lifetime after asynchronous endpoint ownership", async () => {
  let checks = 0;
  await assert.rejects(awaitDesktopRenderer(harness({
    assertIdentity: () => { if (++checks === 2) throw new Error("PID lifetime changed"); },
  })), /PID lifetime changed/);
  assert.equal(checks, 2);
});

test("Desktop readiness refuses success if the process exits during endpoint ownership inspection", async () => {
  let alive = true;
  await assert.rejects(awaitDesktopRenderer(harness({
    isAlive: () => alive,
    owner: async () => { alive = false; return 1234; },
  })), /exited during/);
});

test("Desktop readiness forbids HTTP redirects to a different endpoint", async () => {
  let options;
  await awaitDesktopRenderer(harness({
    request: async (_url, supplied) => {
      options = supplied;
      return { ok: true, json: async () => [{
        type: "page", url: "app://-/index.html",
        webSocketDebuggerUrl: "ws://127.0.0.1:22691/devtools/page/own",
      }] };
    },
  }));
  assert.equal(options.redirect, "error");
});
