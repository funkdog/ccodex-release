import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { prepareDesktopHotkeys, desktopGlobalCommands } from "../release/desktop-hotkeys.mjs";

const root = path.resolve(import.meta.dirname, "..");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-hotkeys-"));
const keys = Array.from({ length: 24 }, (_, i) => `Control+Alt+Shift+F${i + 1}`);
test.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
const home = name => {
  const folder = path.join(temporary, name);
  fs.mkdirSync(folder);
  return folder;
};

test("private defaults use only unoccupied keys and are stable across repairs", () => {
  const profile = home("defaults");
  const available = keys.filter(value => !value.endsWith("+F8"));
  const first = prepareDesktopHotkeys(root, profile, { probe: () => available });
  const chosen = [...Object.values(first.commands), first.appshotHotkey];
  assert.equal(chosen.length, desktopGlobalCommands.length + 1);
  assert.equal(new Set(chosen).size, chosen.length);
  assert(chosen.every(value => available.includes(value)));
  assert.equal(prepareDesktopHotkeys(root, profile, { probe: () => available }).changed, false);
});

test("explicit user bindings and unrelated Desktop state are preserved", () => {
  const profile = home("custom");
  fs.writeFileSync(path.join(profile, "keybindings.json"), JSON.stringify([
    { command: "openAvatarOverlay", key: "Control+Alt+P" }, { command: "newTask", key: "Control+J" },
  ]));
  fs.writeFileSync(path.join(profile, ".codex-global-state.json"), JSON.stringify({
    appshotHotkey: null, "user-owned-preference": { keep: true },
  }));
  prepareDesktopHotkeys(root, profile, { probe: () => keys });
  const bindings = JSON.parse(fs.readFileSync(path.join(profile, "keybindings.json")));
  assert(bindings.some(row => row.command === "openAvatarOverlay" && row.key === "Control+Alt+P"));
  const state = JSON.parse(fs.readFileSync(path.join(profile, ".codex-global-state.json")));
  assert.equal(state.appshotHotkey, null);
  assert.deepEqual(state["user-owned-preference"], { keep: true });
});

test("later competition reallocates only release-managed defaults", () => {
  const profile = home("competition");
  const initial = prepareDesktopHotkeys(root, profile, { probe: () => keys });
  const occupied = initial.commands.openAvatarOverlay;
  const next = prepareDesktopHotkeys(root, profile, { probe: () => keys.filter(value => value !== occupied) });
  assert.notEqual(next.commands.openAvatarOverlay, occupied);
});

test("later custom commands and modifier aliases cannot be assigned to a default", () => {
  const profile = home("custom-order");
  fs.writeFileSync(path.join(profile, "keybindings.json"), JSON.stringify([
    { command: "realtimeVoice", key: "Shift+Alt+Ctrl+F8" },
  ]));
  const selected = prepareDesktopHotkeys(root, profile, { probe: () => keys });
  assert(Object.values(selected.commands).every(value => !value.endsWith("+F8")));
});

test("unrecognized user formats and no available keys fail before data writes", () => {
  const invalid = home("invalid");
  fs.writeFileSync(path.join(invalid, "keybindings.json"), "{}");
  assert.throws(() => prepareDesktopHotkeys(root, invalid, { probe: () => keys }), /Unrecognized/);
  assert.equal(fs.readFileSync(path.join(invalid, "keybindings.json"), "utf8"), "{}");
  const unavailable = home("unavailable");
  assert.throws(() => prepareDesktopHotkeys(root, unavailable, { probe: () => [] }), /No private/);
  assert.equal(fs.existsSync(path.join(unavailable, "keybindings.json")), false);
});
