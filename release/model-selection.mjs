import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { cliSelection, surfaceConfigFile } from "../bridge/surface-settings.mjs";
import { readSetting, editSettings } from "../tools/config-document.mjs";
import { atomicWrite } from "../bridge/workiq/settings.mjs";
import { assertRegularPath } from "./paths.mjs";
import { DEFAULT_CONTEXT_SUFFIX, LONG_CONTEXT_SUFFIX } from "../bridge/catalog.mjs";

export function normalizeCliSelection(home) {
  const file = assertRegularPath(surfaceConfigFile(home, "cli"), { allowMissing: false });
  const original = fs.readFileSync(file, "utf8");
  const selection = cliSelection(original);
  const catalog = JSON.parse(fs.readFileSync(path.join(home, "models.json"), "utf8")).models;
  if (!Array.isArray(catalog) || !catalog.length) {
    throw new Error("No authorized Copilot model is available. Check account and organization permissions.");
  }
  const shared = readSetting(fs.readFileSync(surfaceConfigFile(home), "utf8"), [], "model");
  const sharedBase = shared?.replace(new RegExp(`(?:${DEFAULT_CONTEXT_SUFFIX}|${LONG_CONTEXT_SUFFIX})$`), "");
  const entry = catalog.find(model => model.slug === selection?.model) ||
    catalog.find(model => model.slug === sharedBase) || catalog[0];
  const levels = (entry.supported_reasoning_levels || []).map(level => level.effort);
  const effort = levels.includes(selection?.effort) ? selection.effort :
    levels.includes(entry.default_reasoning_level) ? entry.default_reasoning_level : levels[0];
  const long = entry.slug === selection?.model && selection?.serviceTier === "context-long" &&
    Boolean(entry.copilot?.long_context_prompt_tokens);
  const updated = editSettings(original, [], {
    model: JSON.stringify(entry.slug),
    model_reasoning_effort: effort ? JSON.stringify(effort) : null,
    service_tier: JSON.stringify(long ? "context-long" : "default"),
  });
  if (updated !== original) {
    if (fs.readFileSync(file, "utf8") !== original) {
      throw new Error("CLI model selection changed concurrently; retry instead of overwriting it.");
    }
    atomicWrite(file, updated);
  }
  return { model: entry.slug, effort: effort || null, changed: updated !== original };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    normalizeCliSelection(process.env.CODEX_COPILOT_HOME);
  } catch (error) {
    console.error(`CCodex Release model: ${error.message}`);
    process.exitCode = 1;
  }
}
