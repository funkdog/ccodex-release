import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import { verifyDesktopBackend } from "../release/desktop-preflight.mjs";
import { awaitDesktopBackend, desktopStartupStatus } from "../release/desktop-startup.mjs";

test("only the actual Desktop PID's local backend transition counts as startup success", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-desktop-status-"));
  const receipt = { pid: 424242, launchedAt: new Date().toISOString() };
  const date = new Date(receipt.launchedAt);
  const logs = path.join(home, "host-profile", "AppData", "Local", "Codex", "Logs",
    String(date.getUTCFullYear()), String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"));
  fs.mkdirSync(logs, { recursive: true });
  const ready = "app_server_connection.state_changed hostId=local initialized=true next=connected\n";
  try {
    fs.writeFileSync(path.join(logs, "desktop-123-t0.log"), ready);
    assert.deepEqual(desktopStartupStatus({ home, receipt }), { ready: false });
    fs.writeFileSync(path.join(logs, "desktop-424242-t0.log"), ready);
    assert.deepEqual(desktopStartupStatus({ home, receipt }), { ready: true, desktopBackendVerified: true });
    fs.writeFileSync(path.join(logs, "desktop-424242-t1.log"),
      "Desktop bootstrap failed to start the main app\n");
    assert.throws(() => desktopStartupStatus({ home, receipt }), /actual Desktop backend failed/);
  } finally {
    assert(home.startsWith(path.join(os.tmpdir(), "ccodex-desktop-status-")));
    fs.rmSync(home, { recursive: true, force: true });
  }
});

function fixture(mode = "ready") {
  const home = path.resolve("private state with spaces");
  const process = new EventEmitter();
  Object.assign(process, { stdout: new PassThrough(), stderr: new PassThrough(),
    stdin: new PassThrough(), killed: false, kill() { this.killed = true; } });
  const calls = [];
  let options;
  let input = "";
  process.stdin.on("data", bytes => {
    input += bytes;
    for (;;) {
      const end = input.indexOf("\n");
      if (end < 0) break;
      const message = JSON.parse(input.slice(0, end));
      input = input.slice(end + 1);
      calls.push(message);
      if (!message.id || mode === "timeout") continue;
      if (mode === "sqlite-failure") {
        process.stderr.write("failed to initialize sqlite state runtime: database is locked");
        queueMicrotask(() => process.emit("close", 1));
        continue;
      }
      const result = message.method === "initialize" ?
        { codexHome: mode === "wrong-profile" ? path.resolve("stock-profile") : home } :
        { data: [], nextCursor: null };
      if (mode === "rpc-failure" && message.method === "thread/list") {
        process.stdout.write(JSON.stringify({ id: message.id,
          error: { code: -32603, message: "State query failed" } }) + "\n");
      } else {
        process.stdout.write(JSON.stringify({ id: message.id, result }) + "\n");
      }
    }
  });
  process.stdin.on("finish", () => {
    if (mode !== "shutdown-timeout") queueMicrotask(() => process.emit("close", mode === "bad-exit" ? 1 : 0));
  });
  const parameters = { root: path.resolve("private release"), home,
    runtime: { resources: path.resolve("private release", "desktop", "app", "resources") },
    env: { CODEX_HOME: home, CODEX_COPILOT_HOME: home },
    timeoutMs: 200, shutdownMs: 30,
    command(root, executable, args) { return { file: executable, args }; },
    start(file, args, opts) {
      options = { file, args, ...opts };
      return process;
    } };
  return { parameters, process, calls, options: () => options };
}

test("the renderer opening is not accepted as native Desktop backend readiness", async () => {
  let time = 0, attempts = 0, checked = 0;
  const result = await awaitDesktopBackend({ home: "private", receipt: { pid: 123 },
    assertIdentity: () => { checked++; },
    status: () => ({ ready: ++attempts === 3 }),
    now: () => time, pause: async () => { time += 200; },
  });
  assert.deepEqual(result, { desktopBackendVerified: true });
  assert.equal(attempts, 3);
  assert.equal(checked, 3);
});

test("actual Desktop SQLite failure prevents helper activation even after a preflight succeeds", async () => {
  await assert.rejects(awaitDesktopBackend({ home: "private", receipt: { pid: 123 },
    assertIdentity() {},
    status() { throw new Error("Actual Desktop SQLite initialization failed"); },
  }), /Actual Desktop SQLite/);
});

test("a visible window with no native handshake times out rather than becoming a successful receipt", async () => {
  let time = 0;
  await assert.rejects(awaitDesktopBackend({ home: "private", receipt: { pid: 123 },
    timeoutMs: 400, assertIdentity() {}, status: () => ({ ready: false }),
    now: () => time, pause: async () => { time += 200; },
  }), /did not become ready/);
});

test("Desktop validates the pinned native backend and its SQLite query before launching a GUI", async () => {
  const value = fixture();
  assert.deepEqual(await verifyDesktopBackend(value.parameters), {
    sqliteReady: true, profileVerified: true, stateQueryVerified: true, modelRequestsSent: false,
  });
  assert.deepEqual(value.calls.map(call => call.method), ["initialize", "initialized", "thread/list"]);
  assert.equal(value.options().env.CODEX_HOME, value.parameters.home);
  assert.equal(value.options().env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE, "Codex Desktop");
  assert.equal(value.options().cwd, path.dirname(value.parameters.runtime.resources));
  assert.equal(value.process.killed, false);
});

for (const [mode, message] of [
  ["wrong-profile", /different profile/],
  ["sqlite-failure", /database is locked/],
  ["rpc-failure", /State query failed/],
  ["bad-exit", /exit 1/],
  ["timeout", /timed out/],
  ["shutdown-timeout", /shutdown/],
]) {
  test(`Desktop state validation rejects ${mode} without resetting or substituting a profile`, async () => {
    const value = fixture(mode);
    await assert.rejects(verifyDesktopBackend(value.parameters), message);
    assert.equal(value.process.killed, mode === "shutdown-timeout");
  });
}
