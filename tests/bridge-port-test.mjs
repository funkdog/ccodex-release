import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_BRIDGE_PORT, selectedBridgePort } from "../bridge/port-selection.mjs";

const root = path.resolve(import.meta.dirname, "..");

test("bridge port pointer migrates new sessions while explicit overrides take precedence", t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-bridge-port-"));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(home)), fs.realpathSync(os.tmpdir()));
    fs.rmSync(home, { recursive: true, force: true });
  });
  assert.equal(selectedBridgePort({ home, env: {} }), DEFAULT_BRIDGE_PORT);
  fs.writeFileSync(path.join(home, "bridge-port.txt"), "22691\n");
  assert.equal(selectedBridgePort({ home, env: {} }), 22691);
  fs.writeFileSync(path.join(home, "bridge-port.txt"), "022691\r\n");
  assert.equal(selectedBridgePort({ home, env: {} }), 22691);
  assert.equal(selectedBridgePort({ home, env: { CODEX_COPILOT_BRIDGE_PORT: "22692" } }), 22692);
  for (const value of ["0", "80", "70000", "22691&whoami", "-1", "", " 22691", "22691\n1"]) {
    fs.writeFileSync(path.join(home, "bridge-port.txt"), value);
    assert.throws(() => selectedBridgePort({ home, env: {} }), /port|between/);
  }
  assert.throws(() => selectedBridgePort({
    home, env: { CODEX_COPILOT_BRIDGE_PORT: "" },
  }), /decimal loopback port/);
  assert.throws(() => selectedBridgePort({
    home, env: { CODEX_COPILOT_BRIDGE_PORT: "22691;echo" },
  }), /decimal loopback port/);
});

test("Windows installer rejects an unsafe port pointer before prerequisite checks", {
  skip: process.platform !== "win32",
}, t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-port-installer-"));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(home)), fs.realpathSync(os.tmpdir()));
    fs.rmSync(home, { recursive: true, force: true });
  });
  const pointer = path.join(home, "bridge-port.txt");
  fs.writeFileSync(pointer, "22691\nwhoami\n");
  const result = spawnSync("pwsh.exe", [
    "-NoLogo", "-NoProfile", "-File", path.join(root, "install.ps1"),
    "-PreflightOnly", "-NoPrerequisiteInstall", "-CodexCopilotHome", home,
  ], {
    env: { ...process.env, CODEX_COPILOT_SHOWCASE_URL: "" },
    encoding: "utf8", windowsHide: true, timeout: 10000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Invalid bridge port pointer/);
  assert.equal(fs.readFileSync(pointer, "utf8"), "22691\nwhoami\n");
  assert.equal(fs.existsSync(path.join(home, "config.toml")), false);
});
