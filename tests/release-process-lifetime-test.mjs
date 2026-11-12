import assert from "node:assert/strict";
import test from "node:test";
import { readProcessIdentity, sameProcessLifetime } from "../bridge/desktop-process.mjs";

test("Windows lifetime is checked before requesting executable access for a reused PID", () => {
  const expectedLifetime = "windows:1234";
  const result = readProcessIdentity(31415, { platform: "win32", expectedLifetime,
    invoke(_program, args) {
      const script = args.at(-1);
      assert(script.indexOf(`$lifetime -cne '${expectedLifetime}'`) <
        script.indexOf("$p.ExecutablePath"));
      assert(script.includes("$after.CreationDate -ne $p.CreationDate"));
      assert(script.includes("$attempt -lt 3"));
      return { status: 0, stdout: "null\n" };
    } });
  assert.equal(result, null);
});

test("an unreadable matching live process stays fail-closed", () => {
  assert.throws(() => readProcessIdentity(31415, {
    platform: "win32", expectedLifetime: "windows:1234",
    invoke: () => ({ status: 1, stdout: "", stderr: "Process identity is unreadable" }),
  }), /could not be established/);
});

test("invalid recorded process lifetimes never become executable shell input", () => {
  let invoked = false;
  assert.throws(() => readProcessIdentity(31415, {
    platform: "win32", expectedLifetime: "windows:1';exit 0;",
    invoke: () => { invoked = true; },
  }), /Invalid expected/);
  assert.equal(invoked, false);
});

test("actual Windows process reuse check ignores a different lifetime, not the live owner", {
  skip: process.platform !== "win32",
}, () => {
  const mine = readProcessIdentity(process.pid);
  assert(mine);
  assert.equal(readProcessIdentity(process.pid, { expectedLifetime: "windows:1" }), null);
  assert(sameProcessLifetime(mine, readProcessIdentity(process.pid,
    { expectedLifetime: mine.lifetime })));
});
