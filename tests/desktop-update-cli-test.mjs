import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { desktopUpdateCommand as updateCommand } from "../bridge/desktop-update-cli.mjs";
const desktopUpdateCommand = options => updateCommand({ platform: "win32", ...options });

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-update-cli-"));
  fs.mkdirSync(path.join(root, "desktop"));
  fs.writeFileSync(path.join(root, "desktop", "current.json"),
    '{"version":"26.928.3736.0-0123456789ab"}');
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
    assert.match(path.basename(root), /^ccodex-update-cli-/);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test("Desktop update status is read-only and does not start bridge or a heavy worker", async t => {
  const root = fixture(t);
  const before = fs.readFileSync(path.join(root, "desktop", "current.json"), "utf8");
  let output;
  await desktopUpdateCommand({
    root, output: value => { output = value; },
    runHeavy: () => { throw new Error("status must not start a worker"); },
  });
  assert.equal(output.selectedSnapshot, "26.928.3736.0-0123456789ab");
  assert.equal(output.originalInstallationOwned, false);
  assert.equal(fs.readFileSync(path.join(root, "desktop", "current.json"), "utf8"), before);
});

for (const action of ["check", "--check", "prepare"]) {
  test(`Desktop ${action} runs only the private package preparation backend`, async t => {
    const root = fixture(t);
    const calls = [];
    await desktopUpdateCommand({ root, args: [action],
      runHeavy: (...args) => calls.push(args) });
    assert.deepEqual(calls, [[root, "Prepare-DesktopUpdate.ps1",
      action === "prepare" ? "" : "-CheckOnly"]]);
  });
}

test("Desktop prepare rejects a replacement URL before starting a worker", async t => {
  const root = fixture(t);
  await assert.rejects(desktopUpdateCommand({
    root, args: ["prepare", "https://unrelated.invalid/package"],
    runHeavy: () => assert.fail("must not start a worker"),
  }), /trusted official/);
});

test("Desktop validator rejects malformed or path-traversing versions before worker launch", async t => {
  const root = fixture(t);
  for (const candidate of ["../../stock", "C:\\stock", "latest", "26.930.1"]) {
    await assert.rejects(desktopUpdateCommand({
      root, args: ["validate", candidate],
      runHeavy: () => assert.fail("must not start a worker"),
    }), /validate/);
  }
});

test("packaged Desktop update dispatch never calls stock codex or Store updates", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const windows = fs.readFileSync(path.join(root, "bin", "codex-copilot.cmd"), "utf8");
  const unix = fs.readFileSync(path.join(root, "platforms", "unix", "bin", "codex-copilot"), "utf8");
  assert.match(windows, /"update" goto :run_desktop_update/);
  assert.match(windows, /desktop-update-cli\.mjs/);
  assert.match(unix, /desktop-update-cli\.mjs/);
  const update = fs.readFileSync(path.join(root, "bridge", "desktop-update-cli.mjs"), "utf8");
  assert.doesNotMatch(update, /winget|Add-AppxPackage|codex\.exe.*update|StockCliPath/);
});

test("Unix Desktop update state belongs to its private home, not the system package directory", async t => {
  const root = fixture(t);
  const home = path.join(root, "private-home");
  fs.mkdirSync(path.join(home, "desktop"), { recursive: true });
  fs.writeFileSync(path.join(home, "desktop", "current.json"),
    '{"version":"26.930.1.0-abcdef012345"}');
  const before = fs.readFileSync(path.join(root, "desktop", "current.json"), "utf8");
  let output;
  await updateCommand({ root, home, platform: "linux",
    output: value => { output = value; },
    runHeavy: () => assert.fail("Windows backend must not run on Unix"),
    runUnixHeavy: () => assert.fail("status must not start a worker") });
  assert.equal(output.selectedSnapshot, "26.930.1.0-abcdef012345");
  assert.equal(output.runtimeStateRoot, home);
  assert.equal(fs.readFileSync(path.join(root, "desktop", "current.json"), "utf8"), before);
});

for (const action of ["check", "prepare"]) {
  test(`Unix Desktop ${action} invokes only the own-profile backend`, async t => {
    const root = fixture(t);
    const home = path.join(root, "private-home");
    const calls = [];
    await updateCommand({ root, home, platform: "linux", args: [action],
      runHeavy: () => assert.fail("Windows backend must not run"),
      runUnixHeavy: (...args) => calls.push(args) });
    assert.deepEqual(calls, [[root, home, action]]);
  });
}
