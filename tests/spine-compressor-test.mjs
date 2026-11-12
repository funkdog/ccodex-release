import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compressOutput, compressLayer1 } from "../gateway/spine/compressor.mjs";
import { SpilloverStore } from "../gateway/spine/storage.mjs";
import { prepareCommandShims } from "../gateway/spine/command-shim.mjs";
import { withSpinePath } from "../gateway/spine/native-config.mjs";
import { spawnSync } from "node:child_process";

function fixture(t) {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "spine-log-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, store: new SpilloverStore(home) };
}
function bytes(read) { return Buffer.from(read.content, read.encoding === "base64" ? "base64" : "utf8"); }
test("green tests, ANSI, progress and repeated lines are folded with byte-exact originals", async t => {
  const { store } = fixture(t);
  const raw = Buffer.from("\x1b[32mok 1 - alpha\x1b[0m\nok 2 - beta\n10%\r20%\r100%\nready\nready\nready\n# fail 0\n");
  const r = compressOutput({ raw, store });
  assert.match(r.output, /2 passing test verdicts/); assert.match(r.output, /2 additional identical/);
  assert.doesNotMatch(r.layer1, /\x1b/); assert.match(r.layer1, /100%/); assert.doesNotMatch(r.layer1, /10%/);
  assert.deepEqual(bytes(await store.read({ id: r.pointer.id, startLine: 1, endLine: r.pointer.endLine })), raw);
  assert.match(r.output, /mycodex.read_log/);
});
test("failure assertions, repeated errors, stack and CR context survive L1 completely", () => {
  const raw = "ok 1 - passed\nnot ok 2 - broken\nAssertionError: expected 1\n  actual: 2\n  at fixture (test.mjs:3:4)\nError: repeated\nError: repeated\ncontext\rimportant\n";
  assert.equal(compressLayer1(raw, 1), raw);
  assert.equal(compressLayer1(raw, 0), raw);
  assert.equal(compressLayer1("test a ... ok\nstack unknown\n", 7), "test a ... ok\nstack unknown\n");
});
test("lockfile folding retains next diff and all raw bytes; failing diff is never folded", async t => {
  const { store } = fixture(t);
  const raw = Buffer.from('diff --git a/package-lock.json b/package-lock.json\n--- a/package-lock.json\n+++ b/package-lock.json\n+"noise"\ndiff --git a/src/a.ts b/src/a.ts\n+real change\n');
  const r = compressOutput({ raw, store });
  assert.match(r.layer1, /4 lockfile diff lines/); assert.match(r.layer1, /\+real change/); assert.doesNotMatch(r.layer1, /"noise"/);
  assert.deepEqual(bytes(await store.read({ id: r.pointer.id, startLine: 1, endLine: r.pointer.endLine })), raw);
  assert.equal(compressLayer1(raw.toString(), 1), raw.toString());
});
test("oversized error logs and giant/invalid UTF8 lines have explicit exact continuations", async t => {
  const { store } = fixture(t);
  const raw = Buffer.concat([Buffer.from("Error: "), Buffer.alloc(200000, 120), Buffer.from([0xff, 10]), Buffer.from("tail\r\n")]);
  const r = compressOutput({ raw, store, thresholdBytes: 512 });
  assert.equal(r.omitted, true); assert.match(r.output, /including all failure details/);
  let offset = 0, output = [];
  for (;;) {
    const read = await store.read({ id: r.pointer.id, startLine: 1, endLine: 2, byteOffset: offset, maxBytes: 4096 }); output.push(bytes(read));
    if (read.complete) { assert.equal(read.nextByteOffset, null); break; }
    assert.ok(read.nextByteOffset > offset); offset = read.nextByteOffset;
  }
  assert.deepEqual(Buffer.concat(output), raw);
  assert.deepEqual(bytes(await store.read({ id: r.pointer.id, startLine: 2, endLine: 2 })), Buffer.from("tail\r\n"));
});
test("small unchanged logs need no spill; private storage rejects traversal, links, ranges and duplicates", async t => {
  const { home, store } = fixture(t);
  assert.equal(compressOutput({ raw: Buffer.from("plain\n"), store }).pointer, undefined);
  const p = store.save(Buffer.from("one\ntwo\n"), "session", "call");
  assert.throws(() => store.save(Buffer.from("x"), "session", "call"), /EEXIST/);
  for (const range of [{ id: "../call", startLine: 1, endLine: 1 }, { id: p.id, startLine: 0, endLine: 1 }, { id: p.id, startLine: 1, endLine: 3 }, { id: p.id, startLine: 1, endLine: 1, maxBytes: 200000 }]) await assert.rejects(store.read(range));
  const file = path.join(home, "gateway/spillover/session/call.log"); fs.renameSync(file, file + ".original"); fs.symlinkSync(file + ".original", file);
  await assert.rejects(store.read({ id: p.id, startLine: 1, endLine: 1 }));
  const outside = path.join(home, "outside"); fs.mkdirSync(outside, { mode: 0o700 }); fs.symlinkSync(outside, path.join(home, "gateway/spillover/linked"));
  assert.throws(() => store.save(Buffer.from("x"), "linked", "call"), /Linked/); assert.deepEqual(fs.readdirSync(outside), []);
});
test("selected PATH shims preserve args, stdin, exit status, failures and unmodified parent PATH", async t => {
  const { home, store } = fixture(t);
  const directory = prepareCommandShims(home, { noisy: process.execPath }, "shim-session");
  const inherited = { PATH: process.env.PATH, HOME: home }, env = withSpinePath(inherited, directory);
  assert.equal(inherited.PATH, process.env.PATH); assert.equal(env.PATH.startsWith(directory + path.delimiter), true);
  const script = "let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{console.log('Error: '+JSON.stringify([s,process.argv.slice(1)]));console.error(' at fixture:7:9');process.exitCode=7;});";
  const result = spawnSync(path.join(directory, "noisy"), ["-e", script, "--", "literal $(noop)", "a b"], { input: "input\n", env, encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 7, result.stderr); assert.match(result.stdout, /Error:/); assert.match(result.stderr, / at fixture:7:9/); assert.doesNotMatch(result.stdout, / at fixture/);
  const match = result.stdout.match(/"id":"([^"]+)"/); assert.ok(match, result.stdout);
  const read = await store.read({ id: match[1], startLine: 1, endLine: 1 });
  assert.match(read.content, /literal \$\(noop\)/); assert.match(read.content, /input/);
});
test("unfinished captures are unavailable and same-size rewrites cannot masquerade as originals", async t => {
  const { home, store } = fixture(t), capture = store.begin("session", "partial"); capture.append(Buffer.from("original\n"));
  await assert.rejects(store.read({ id: capture.id, startLine: 1, endLine: 1 })); capture.abort();
  const p = store.save(Buffer.from("original\n"), "session", "complete");
  const file = path.join(home, "gateway/spillover/session/complete.log"); fs.writeFileSync(file, "replaced\n"); fs.utimesSync(file, new Date(0), new Date(0));
  await assert.rejects(store.read({ id: p.id, startLine: 1, endLine: 1 }), /changed after capture/);
});
