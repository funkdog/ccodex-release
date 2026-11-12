import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { HISTORY_KIT_FILES, syncHistoryKit } from "../tools/sync-history-kit.mjs";
import { nativeRepairInventory } from "../tools/native-repair-inventory.mjs";
import { desktopExtensionFiles } from "../bridge/desktop-extension-files.mjs";

const root = path.resolve(import.meta.dirname, "..");
const hash = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

test("complete shared history kit is shipped, fingerprinted and matches its authoritative source when present", () => {
  const source = path.resolve(root, "../copilot-cli-enhancements/history");
  const repairs = new Set(nativeRepairInventory(root));
  const updates = new Set(desktopExtensionFiles(root));
  assert.equal(HISTORY_KIT_FILES.length, 7);
  for (const name of HISTORY_KIT_FILES) {
    const relative = "tools/history/" + name;
    const destination = path.join(root, relative);
    assert(fs.lstatSync(destination).isFile());
    assert(repairs.has(relative), relative);
    assert(updates.has(relative), relative);
    if (fs.existsSync(source)) assert.equal(hash(destination), hash(path.join(source, name)), name);
  }
});

test("history synchronization copies only the explicit seven-file inventory and verifies every hash", async t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-history-kit-"));
  t.after(() => fs.promises.rm(folder, { recursive: true, force: true }));
  const source = path.join(folder, "source");
  const destination = path.join(folder, "copy");
  fs.mkdirSync(source);
  for (const name of HISTORY_KIT_FILES) fs.writeFileSync(path.join(source, name), "Synthetic " + name);
  fs.writeFileSync(path.join(source, "private-not-an-input.txt"), "Must not be copied.");
  const result = syncHistoryKit({ source, destination });
  assert.deepEqual(fs.readdirSync(destination).sort(), [...HISTORY_KIT_FILES].sort());
  assert.equal(result.files.length, 7);
  for (const file of result.files) assert.equal(file.sha256, hash(path.join(destination, file.name)));
});

test("Windows history wrapper dispatch is independent of the bridge port, model config and authentication", async t => {
  const wrapper = fs.readFileSync(path.join(root, "bin", "codex-copilot.cmd"), "utf8");
  assert(wrapper.indexOf('goto :run_history') < wrapper.indexOf('bridge\\port-selection.mjs'));
  const unix = fs.readFileSync(path.join(root, "platforms", "unix", "bin", "codex-copilot"), "utf8");
  assert(unix.indexOf('"$COMMAND" == "history"') < unix.indexOf('source "$ROOT/bin/bridge-port.sh"'));
  assert.match(unix, /CODEX_COPILOT_INSTALL_ROOT="\$ROOT"/);
  if (process.platform !== "win32") return;
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-history-wrapper-"));
  t.after(() => fs.promises.rm(folder, { recursive: true, force: true }));
  fs.mkdirSync(path.join(folder, "bin"));
  fs.cpSync(path.join(root, "tools", "history"), path.join(folder, "tools", "history"), { recursive: true });
  const entry = path.join(folder, "bin", "codex-copilot.cmd");
  fs.copyFileSync(path.join(root, "bin", "codex-copilot.cmd"), entry);
  const output = execFileSync(process.env.ComSpec || "cmd.exe", ["/d", "/c", "bin\\codex-copilot.cmd", "history", "help"], {
    cwd: folder, encoding: "utf8", windowsHide: true, timeout: 15000,
    env: { ...process.env, CODEX_COPILOT_HOME: path.join(folder, "no-profile"),
      CODEX_COPILOT_BRIDGE_PORT: "invalid-on-purpose",
      PATH: path.dirname(process.execPath) + path.delimiter + process.env.PATH },
  });
  assert.match(output, /history list/);
  assert.match(output, /history preview/);
  assert.equal(fs.existsSync(path.join(folder, "no-profile")), false);
});

test("history-only installation remains full-gate-bound and does not regenerate native configuration", () => {
  const source = fs.readFileSync(path.join(root, "tools", "Install-NativeRepair.ps1"), "utf8");
  assert.match(source, /\[switch\]\$HistoryOnly/);
  assert.match(source, /if \(-not \$HistoryOnly -and -not \$ExtensionsOnly\) \{\s*& node \(Join-Path \$install 'tools\\gen-config\.mjs'\)/);
  assert.match(source, /The passing full gate does not bind every history installation input/);
  assert.match(source, /Codex \(Copilot\) History\.lnk/);
  assert.match(source, /profileConfigurationChanged = -not \(\[bool\]\$HistoryOnly -or \[bool\]\$ExtensionsOnly\)/);
});
