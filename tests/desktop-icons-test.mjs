import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import fs from "node:fs";
import { createDesktopIconController } from "../tools/desktop-icons.mjs";

function fixture(options = {}) {
  let clock = 0;
  const calls = [];
  const stopped = [];
  const controller = createDesktopIconController({
    root: "C:\\Private Runtime", home: "C:\\Private Profile",
    helperToken: "fixture-token", helperPid: 123, platform: "win32",
    assertOwned: async () => {}, now: () => clock,
    start(file, args, settings) {
      const child = new EventEmitter();
      child.stdin = new EventEmitter();
      child.stdin.end = value => stopped.push(value);
      calls.push({ file, args, settings, child });
      return child;
    },
    ...options,
  });
  return { controller, calls, stopped, advance: value => { clock += value; } };
}

test("the icon worker is private, hidden and uses existing Windows assemblies without a build", async () => {
  const f = fixture();
  assert.equal(await f.controller.refresh(), true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].settings.windowsHide, true);
  assert.equal(f.calls[0].settings.detached, undefined);
  assert(f.calls[0].args.includes("-NoProfile"));
  assert(f.calls[0].args.includes("-File"));
  assert(f.calls[0].args.includes("fixture-token"));
  assert(f.calls[0].args.includes("123"));
  assert(!f.calls[0].args.includes("-ExecutionPolicy"));
  const script = fs.readFileSync(new URL("../tools/desktop-icons.ps1", import.meta.url), "utf8");
  assert.match(script, /Add-Type -AssemblyName System.Windows.Forms/);
  assert.doesNotMatch(script, /Add-Type\s+(?:-TypeDefinition|-MemberDefinition)|Set-ExecutionPolicy/);
  assert.match(script, /SendMessageTimeout/);
  assert.match(script, /Private Desktop endpoint ownership changed/);
  assert.match(script, /SHGetPropertyStoreForWindow/);
  assert.match(script, /AppUserModel_RelaunchIconResource/);
  assert.match(script, /AppUserModel_RelaunchCommand/);
  assert.match(script, /\$appId = 'CodexCopilot.Desktop'/);
  assert.match(script, /CCodexRelease\.Desktop\.' \+ \$identity/);
  assert.match(script, /AppUserModel_ID = \$appId/);
});

test("repeated polls do not create duplicate icon workers", async () => {
  const f = fixture();
  await f.controller.refresh();
  assert.equal(await f.controller.refresh(), false);
  assert.equal(f.calls.length, 1);
});

test("concurrent ownership checks still create only one icon worker", async () => {
  const f = fixture();
  assert.deepEqual(await Promise.all([
    f.controller.refresh(), f.controller.refresh(),
  ]), [true, false]);
  assert.equal(f.calls.length, 1);
});

test("failed ownership never launches or changes a native window", async () => {
  const f = fixture({ assertOwned: async () => { throw new Error("superseded"); } });
  await assert.rejects(f.controller.refresh(), /superseded/);
  assert.equal(f.calls.length, 0);
});

test("worker exits use a bounded retry rather than an immediate spawn loop", async () => {
  const f = fixture();
  await f.controller.refresh();
  f.calls[0].child.emit("exit", 1);
  assert.equal(await f.controller.refresh(), false);
  f.advance(30000);
  assert.equal(await f.controller.refresh(), true);
  assert.equal(f.calls.length, 2);
});

test("closing sends graceful shutdown and prevents another worker", async () => {
  const f = fixture();
  await f.controller.refresh();
  f.controller.close();
  assert.deepEqual(f.stopped, ["stop\n"]);
  f.calls[0].child.emit("exit", 0);
  f.advance(60000);
  assert.equal(await f.controller.refresh(), false);
});

test("non-Windows Desktop uses its native icon without a Windows worker", async () => {
  const f = fixture({ platform: "linux" });
  assert.equal(await f.controller.refresh(), false);
  assert.equal(f.calls.length, 0);
});

test("developer sync registers the renamed shortcut with the window's application identity", () => {
  const shortcut = fs.readFileSync(new URL("../tools/desktop-shortcut.ps1", import.meta.url), "utf8");
  const installer = fs.readFileSync(new URL("../developer/install-dev.ps1", import.meta.url), "utf8");
  assert.match(shortcut, /\.ccodex-dev-install\.json/);
  assert.match(shortcut, /'Ccodex Dev Desktop'/);
  assert.match(shortcut, /'Codex \(Copilot\)'/);
  assert.match(shortcut, /GetFolderPath\('Programs'\)/);
  assert.match(shortcut, /\$variant\.SetValue\('CodexCopilot\.Desktop'\)/);
  assert.match(installer, /tools\\desktop-shortcut\.ps1'\) -Apply/);
  assert(installer.indexOf("tools\\desktop-shortcut.ps1") > installer.indexOf("$link.Save()"));
});
