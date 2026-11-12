import fs from "node:fs";
import path from "node:path";
import { configEntries, editSettings, readSetting, removeTables } from "../tools/config-document.mjs";
import { atomicWrite } from "./catalog-store.mjs";
import { DEFAULT_CONTEXT_SUFFIX, LONG_CONTEXT_SUFFIX } from "./catalog.mjs";

export const CLI_PROFILE = "ccodex";
export const CLI_STATUS_ITEMS = [
  "model-with-reasoning", "request-state", "context-used",
  "last-request-usage", "cache-hit", "used-tokens",
  "compaction-count", "post-compaction-usage", "raw-output",
];

export function surfaceConfigFile(home, surface = "desktop") {
  return path.join(home, surface === "cli" ? `${CLI_PROFILE}.config.toml` : "config.toml");
}

export function cliSelection(text) {
  const configured = readSetting(text, [], "model");
  if (typeof configured !== "string" || !configured) return null;
  const long = configured.endsWith(LONG_CONTEXT_SUFFIX);
  const standard = configured.endsWith(DEFAULT_CONTEXT_SUFFIX);
  const model = long ? configured.slice(0, -LONG_CONTEXT_SUFFIX.length)
    : standard ? configured.slice(0, -DEFAULT_CONTEXT_SUFFIX.length) : configured;
  return {
    model,
    effort: readSetting(text, [], "model_reasoning_effort") || null,
    serviceTier: long ? "context-long" : standard ? "default"
      : readSetting(text, [], "service_tier") || "default",
  };
}

export function initializeCliSettings(shared, existing = "") {
  let result = existing;
  const sharedEntries = configEntries(shared);
  const existingEntries = configEntries(existing);
  const contextSettings = {};
  for (const key of ["model_context_window", "model_auto_compact_token_limit", "compact_prompt"]) {
    const at = (entry, table) =>
      JSON.stringify([...(entry.table || []), ...(entry.key || [])]) ===
        JSON.stringify([...table, key]);
    if (existingEntries.some(entry => at(entry, []))) continue;
    const inherited = sharedEntries.find(entry => at(entry, ["profiles", CLI_PROFILE])) ||
      sharedEntries.find(entry => at(entry, []));
    if (inherited) contextSettings[key] = inherited.value;
  }
  result = editSettings(result, [], contextSettings);
  if (!readSetting(result, [], "model")) {
    const legacy = ["profiles", CLI_PROFILE];
    const model = readSetting(shared, legacy, "model") || readSetting(shared, [], "model");
    if (!model) throw new Error("The shared provider has no model to seed the CLI profile.");
    result = editSettings(result, [], {
      model: JSON.stringify(model),
      model_reasoning_effort: JSON.stringify(
        readSetting(shared, legacy, "model_reasoning_effort") ||
        readSetting(shared, [], "model_reasoning_effort") || "medium"),
      service_tier: JSON.stringify(readSetting(shared, legacy, "service_tier") ||
        readSetting(shared, [], "service_tier") || "default"),
    });
  }
  const selection = cliSelection(result);
  result = editSettings(result, [], {
    model: JSON.stringify(selection.model),
    service_tier: JSON.stringify(selection.serviceTier),
  });
  const status = configEntries(result).find(entry =>
    JSON.stringify([...(entry.table || []), ...(entry.key || [])]) ===
      JSON.stringify(["tui", "status_line"]));
  if (!status || /"copilot-(?:credits|quota|account)"/.test(status.value)) {
    result = editSettings(result, ["tui"], {
      status_line: JSON.stringify(CLI_STATUS_ITEMS),
    });
  }
  return result;
}

export function prepareCliSettings(home) {
  const sharedFile = surfaceConfigFile(home);
  const file = surfaceConfigFile(home, "cli");
  if (fs.lstatSync(sharedFile).isSymbolicLink() ||
      (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink())) {
    throw new Error("Refusing to change a linked CLI configuration.");
  }
  const shared = fs.readFileSync(sharedFile, "utf8");
  const original = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const updated = initializeCliSettings(shared, original);
  if (updated !== original) {
    if (fs.existsSync(file) && fs.readFileSync(file, "utf8") !== original) {
      throw new Error("Configuration changed while isolating CLI settings; retry.");
    }
    atomicWrite(file, updated);
  }
  const migrated = removeTables(shared, ["profiles", CLI_PROFILE]);
  if (migrated !== shared) {
    if (fs.readFileSync(sharedFile, "utf8") !== shared) {
      throw new Error("Shared configuration changed during CLI profile migration; retry.");
    }
    atomicWrite(sharedFile, migrated);
  }
  return cliSelection(updated);
}
