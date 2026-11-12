import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { launchProtectedCurrentHost } from "../bridge/desktop-protected-start.mjs";

const root = path.resolve(import.meta.dirname, "..");
function fixture(t) {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "protected-start-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const host = { application: "/fixture/ChatGPT.app", executable: "/fixture/ChatGPT.app/Contents/MacOS/ChatGPT", nativeCli: process.execPath };
  const calls = [], options = { root, home, application: host.application, inherited: { HOME: "/original", CODEX_HOME: "/original-codex" }, inspectApplication: () => host, processes: () => [], lock: () => () => calls.push("unlock"), start: async (executable, env) => { calls.push({ executable, env }); return 123; } };
  return { home, host, calls, options };
}
test("protected cold startup preserves the original profile and launches without a MyCodex router", async t => {
  const f = fixture(t), result = await launchProtectedCurrentHost(f.options);
  assert.equal(result.action, "started"); assert.equal(result.enhancementAvailable, false);
  const { env, executable } = f.calls[0]; assert.equal(executable, f.host.executable); assert.equal(env.HOME, "/original"); assert.equal(env.CODEX_HOME, "/original-codex"); assert.equal(env.CODEX_ELECTRON_USER_DATA_PATH, undefined);
  assert.equal(env.CODEX_CLI_PATH, undefined); assert.deepEqual(f.calls.slice(1), ["unlock"]);
  assert.equal(fs.existsSync(path.join(f.home, "gateway")), false);
});
test("protected startup never starts an already running app, including an intervening launch", async t => {
  const f = fixture(t);
  const active = await launchProtectedCurrentHost({ ...f.options, processes: () => [{ pid: 99 }] }); assert.equal(active.action, "activate-existing"); assert.deepEqual(f.calls, []);
  let probes = 0; const intervening = await launchProtectedCurrentHost({ ...f.options, processes: () => ++probes > 1 ? [{ pid: 98 }] : [] }); assert.equal(intervening.pid, 98); assert.deepEqual(f.calls, ["unlock"]);
});
test("untrusted installations and inherited profile overrides fail before writing state", async t => {
  const f = fixture(t);
  await assert.rejects(launchProtectedCurrentHost({ ...f.options, inspectApplication: () => { throw new Error("signature"); } }), /signature/);
  await assert.rejects(launchProtectedCurrentHost({ ...f.options, inherited: { CODEX_ELECTRON_USER_DATA_PATH: "/other" } }), /profile override/);
  assert.deepEqual(fs.readdirSync(f.home), []); assert.deepEqual(f.calls, []);
});
