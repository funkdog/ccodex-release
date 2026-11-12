import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { seedDesktopPreferences } from "../release/desktop-ui-settings.mjs";
import { readSetting } from "../tools/config-document.mjs";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-ui-defaults-"));
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

test("new Desktop profile shows permission choices without selecting or granting full access", () => {
  assert.equal(seedDesktopPreferences(home), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, ".codex-global-state.json"), "utf8")), {
    "electron-persisted-atom-state": { "composer-permission-mode-visibility": true },
  });
  const seed = fs.readFileSync(path.resolve(import.meta.dirname, "../profile-seed/config.toml"), "utf8");
  assert.equal(readSetting(seed, ["desktop"], "localeOverride"), "zh-CN");
});

test("repeat preparation preserves destination visibility, language and permission selections", () => {
  const file = path.join(home, ".codex-global-state.json");
  const existing = JSON.stringify({
    "electron-persisted-atom-state": {
      "composer-permission-mode-visibility": false,
      "permission-selection-by-host-id:local": { kind: "agent-mode", agentMode: "read-only" },
    },
  });
  fs.writeFileSync(file, existing);
  assert.equal(seedDesktopPreferences(home), false);
  assert.equal(fs.readFileSync(file, "utf8"), existing);
});
