import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { atomicWrite } from "../bridge/workiq/settings.mjs";
import { readProcessIdentity, sameProcessLifetime } from "../bridge/desktop-process.mjs";
import { assertRegularPath, boundedJson, acquireFileLock } from "./paths.mjs";

export const desktopGlobalCommands = [
  "hotkeyWindow", "openAvatarOverlay", "globalDictationHold",
  "globalDictationSingleTap", "realtimeVoice", "meetings.takeNotes",
];
const candidates = [...Array.from({ length: 17 }, (_, i) => i + 8),
  ...Array.from({ length: 7 }, (_, i) => i + 1)].map(i => `Control+Alt+Shift+F${i}`);
const key = value => typeof value === "string" ? value.toLowerCase().split(/[ +]+/)
  .map(part => ({ ctrl: "control", cmdorctrl: "control", win: "super" })[part] || part).sort().join("+") : value;

function availableKeys(root) {
  const binary = assertRegularPath(path.join(root, "bin", "ccodex-release-hotkeys.exe"), { allowMissing: false });
  const result = spawnSync(binary, [], { windowsHide: true, encoding: "utf8", timeout: 15000 });
  if (result.error || result.status !== 0) throw result.error || new Error("Desktop shortcut availability could not be checked.");
  const value = JSON.parse(result.stdout);
  if (!Array.isArray(value.available) || value.available.some(value => !candidates.includes(value)) ||
      new Set(value.available).size !== value.available.length) {
    throw new Error("Invalid private Desktop shortcut availability result.");
  }
  return value.available;
}

/** Select distinct defaults, preserving explicit user keybindings and all app state. */
export function prepareDesktopHotkeys(root, home, { probe = availableKeys, inspect = readProcessIdentity } = {}) {
  const receiptFile = path.join(home, "desktop-instance.json");
  if (fs.existsSync(receiptFile)) {
    const receipt = boundedJson(receiptFile, 256 * 1024);
    if (sameProcessLifetime(receipt.identity, inspect(receipt.identity?.pid,
      { expectedLifetime: receipt.identity?.lifetime }))) {
      return { changed: false, deferredForRunningDesktop: true };
    }
  }
  const unlock = acquireFileLock(path.join(home, ".release-hotkeys.lock"));
  try {
    const bindingsFile = assertRegularPath(path.join(home, "keybindings.json"));
    const stateFile = assertRegularPath(path.join(home, ".codex-global-state.json"));
    const markerFile = assertRegularPath(path.join(home, ".release-hotkeys.json"));
    const beforeBindings = fs.existsSync(bindingsFile) ? fs.readFileSync(bindingsFile, "utf8") : null;
    const beforeState = fs.existsSync(stateFile) ? fs.readFileSync(stateFile, "utf8") : null;
    const bindings = beforeBindings === null ? [] : boundedJson(bindingsFile);
    const state = beforeState === null ? {} : boundedJson(stateFile, 8 * 1024 * 1024);
    const previous = fs.existsSync(markerFile) ? boundedJson(markerFile) : { schemaVersion: 1, commands: {}, appshotHotkey: undefined };
    if (!Array.isArray(bindings) || bindings.some(row => !row || typeof row.command !== "string" ||
        !(row.key === null || typeof row.key === "string")) ||
        !state || Array.isArray(state) || typeof state !== "object" ||
        previous.schemaVersion !== 1 || !previous.commands || typeof previous.commands !== "object") {
      throw new Error("Unrecognized Desktop keybinding or state format; user data was not overwritten.");
    }
    const free = new Set(probe(root));
    const used = new Set(bindings.filter(row => {
      const rows = bindings.filter(candidate => candidate.command === row.command);
      return !desktopGlobalCommands.includes(row.command) || rows.length !== 1 ||
        row.key !== previous.commands[row.command];
    }).map(row => key(row.key)));
    if (Object.hasOwn(state, "appshotHotkey") && state.appshotHotkey !== previous.appshotHotkey) {
      used.add(key(state.appshotHotkey));
    }
    const owned = {};
    let changed = false;
    const choose = existing => {
      if (free.has(existing) && !used.has(key(existing))) {
        used.add(key(existing));
        return existing;
      }
      const selected = candidates.find(value => free.has(value) && !used.has(key(value)));
      if (!selected) throw new Error("No private Desktop shortcut is available. Free a Control+Alt+Shift+function-key combination, then retry.");
      used.add(key(selected));
      return selected;
    };
    for (const command of desktopGlobalCommands) {
      const rows = bindings.filter(row => row.command === command);
      const prior = previous.commands?.[command];
      if (rows.length && (rows.length !== 1 || rows[0].key !== prior)) {
        for (const row of rows) used.add(key(row.key));
        continue;
      }
      const selected = choose(rows[0]?.key);
      owned[command] = selected;
      if (!rows.length) { bindings.push({ command, key: selected }); changed = true; }
      else if (rows[0].key !== selected) { rows[0].key = selected; changed = true; }
    }
    let appshotHotkey;
    if (!Object.hasOwn(state, "appshotHotkey") || state.appshotHotkey === previous.appshotHotkey) {
      appshotHotkey = choose(state.appshotHotkey);
      if (state.appshotHotkey !== appshotHotkey) { state.appshotHotkey = appshotHotkey; changed = true; }
    }
    if ((fs.existsSync(bindingsFile) ? fs.readFileSync(bindingsFile, "utf8") : null) !== beforeBindings ||
        (fs.existsSync(stateFile) ? fs.readFileSync(stateFile, "utf8") : null) !== beforeState) {
      throw new Error("Desktop settings changed concurrently; no shortcut selection was written.");
    }
    if (changed) {
      atomicWrite(bindingsFile, JSON.stringify(bindings, null, 2) + "\n");
      atomicWrite(stateFile, JSON.stringify(state, null, 2) + "\n");
    }
    atomicWrite(markerFile, JSON.stringify({ schemaVersion: 1, commands: owned, appshotHotkey }, null, 2) + "\n");
    return { changed, commands: owned, appshotHotkey: appshotHotkey ?? null };
  } finally { unlock(); }
}
