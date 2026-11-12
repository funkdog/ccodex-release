import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { cliUpdateCommand } from "../bridge/cli-update.mjs";
import { desktopUpdateCommand } from "../bridge/desktop-update-cli.mjs";

const root = path.resolve(import.meta.dirname, "..");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-maintenance-"));
test.after(() => fs.rmSync(temporary, { recursive: true, force: true }));

test("immutable release rejects partial CLI updates before preparation or writes", async () => {
  await assert.rejects(cliUpdateCommand({
    root, home: temporary, args: ["prepare", "unused-candidate"], output: () => {},
  }), /immutable/);
  assert.equal(fs.readdirSync(temporary).length, 0);
});

test("immutable release rejects partial Desktop updates before preparation or writes", async () => {
  await assert.rejects(desktopUpdateCommand({
    root, home: temporary, args: ["prepare"], output: () => {},
  }), /immutable/);
  assert.equal(fs.readdirSync(temporary).length, 0);
});

test("uninstaller preserves only the credential-free marker needed for external-profile reinstall", () => {
  const source = fs.readFileSync(path.join(root, "release", "uninstall.ps1"), "utf8");
  const removals = source.match(/foreach \(\$relative in @\(([^)]+)\)\)/)?.[1];
  assert(removals);
  assert(!removals.includes(".ccodex-release-install.json"));
  assert(!removals.includes("uninstall.cmd"));
  assert.match(source, /uninstalled=\$true/);
  assert.match(source, /installRoot=\$root;profile=\$profile/);
  assert.match(source, /\$settings\.profile/);
});

test("uninstall entry remains readable and validates ownership on repeat removal", () => {
  const source = fs.readFileSync(path.join(root, "release", "uninstall.cmd"), "utf8");
  assert.match(source, /goto :already_uninstalled/);
  assert.match(source, /\$m\.product -ne 'CCodexRelease'/);
  assert.match(source, /\$m\.uninstalled -ne \$true/);
  assert.match(source, /exit \/b %errorlevel%/);
});
