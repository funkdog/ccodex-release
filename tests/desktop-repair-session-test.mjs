import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import test from "node:test";
import { queueDesktopRepairSession, latestDesktopRepairSession } from "../bridge/desktop-repair-session.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mycodex-repair-test-"));
  const home = path.join(root, "private"); fs.mkdirSync(home, { mode: 0o700 });
  const cli = path.join(root, "codex"); fs.writeFileSync(cli, "fixture-cli");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const run = (executable, args, options) => {
    calls.push({ executable, args, options });
    const child = new EventEmitter(); child.pid = process.pid; child.unref = () => {};
    queueMicrotask(() => child.emit("spawn")); return child;
  };
  const options = { root, home, application: "/fixture/ChatGPT.app", category: "protocol", reason: "provider changed",
    inspect: () => ({ application: "/fixture/ChatGPT.app", nativeCli: cli }), run };
  return { root, home, cli, calls, options };
}

test("one compatibility incident creates one isolated repair task and retains its prompt privately", async t => {
  const f = fixture(t);
  const first = await queueDesktopRepairSession({ ...f.options, git: () => "" });
  const second = await queueDesktopRepairSession({ ...f.options, git: () => "" });
  assert.equal(first.action, "queued"); assert.equal(second.action, "already-queued");
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].executable, f.cli);
  assert.ok(f.calls[0].args.includes("--worktree")); assert.ok(f.calls[0].args.includes("--approve-for-me"));
  assert.equal(f.calls[0].args.at(-1), "-");
  assert.equal(fs.statSync(first.stateFile).mode & 0o077, 0);
  assert.equal(JSON.parse(fs.readFileSync(first.stateFile, "utf8")).mode, "isolated-worktree");
  assert.deepEqual(latestDesktopRepairSession(f.home), { action: "launching", mode: "isolated-worktree" });
  fs.writeFileSync(first.stateFile.replace(/\.json$/, ".jsonl"), '{"type":"thread.started","thread_id":"thread_fixture_123"}\n');
  assert.deepEqual(latestDesktopRepairSession(f.home), { action: "created", mode: "isolated-worktree", threadId: "thread_fixture_123" });
  assert.match(fs.readFileSync(first.stateFile.replace(/\.json$/, ".prompt.txt"), "utf8"), /AGENTS\.md/);
});

test("dirty source creates a read-only diagnostic thread without concurrent edits", async t => {
  const f = fixture(t);
  const result = await queueDesktopRepairSession({ ...f.options, git: () => " M unrelated-file\n" });
  assert.equal(result.mode, "read-only-diagnosis");
  assert.ok(!f.calls[0].args.includes("--worktree"));
  assert.ok(f.calls[0].args.includes("read-only"));
  assert.deepEqual(latestDesktopRepairSession(f.home), { action: "launching", mode: "read-only-diagnosis" });
});
