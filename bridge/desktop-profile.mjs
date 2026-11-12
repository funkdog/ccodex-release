import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { editSettings, readSetting } from "../tools/config-document.mjs";
import {
  DEFAULT_CONTEXT_SUFFIX,
  LONG_CONTEXT_SUFFIX,
} from "./catalog.mjs";
import { selectedBridgePort } from "./port-selection.mjs";
import { atomicWrite } from "./workiq/settings.mjs";

export function normalizeDesktopConfig(text, desktopCatalog) {
  const model = readSetting(text, [], "model");
  const tier = readSetting(text, [], "service_tier");
  if (typeof model !== "string" || !model ||
    (tier && !["context-long", "default"].includes(tier))) {
    return { config: text, model: null };
  }

  const alreadyAlias =
    model.endsWith(DEFAULT_CONTEXT_SUFFIX) || model.endsWith(LONG_CONTEXT_SUFFIX);
  const alias = alreadyAlias
    ? model
    : `${model}${tier === "context-long"
      ? LONG_CONTEXT_SUFFIX
      : DEFAULT_CONTEXT_SUFFIX}`;
  const supported = desktopCatalog?.models?.some(
    (entry) => entry.slug === alias &&
      entry.visibility === "list" &&
      entry.copilot?.context_tier ===
        (alias.endsWith(LONG_CONTEXT_SUFFIX) ? "long_context" : "default"),
  );
  if (!supported) return { config: text, model: null };

  const config = editSettings(text, [], {
    model: JSON.stringify(alias),
    service_tier: null,
  });
  return { config, model: alias };
}

export async function applyDesktopProfile({
  home,
  port = selectedBridgePort({ home }),
  refresh = fetch,
} = {}) {
  const desktopFile = path.join(home, "models-desktop.json");
  // An already published catalog is usable immediately; the bridge refreshes
  // it independently. First login still requires a successful authorized fetch.
  let published;
  try { published = JSON.parse(fs.readFileSync(desktopFile, "utf8")); }
  catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
  if (!Array.isArray(published?.models) || !published.models.length) {
    const response = await refresh(`http://127.0.0.1:${port}/catalog/refresh?max_age_ms=900000`, {
      method: "POST",
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) {
      throw new Error(`Bridge catalog refresh failed (HTTP ${response.status}).`);
    }
  }
  const desktopCatalog = JSON.parse(fs.readFileSync(desktopFile, "utf8"));
  if (!Array.isArray(desktopCatalog.models) || !desktopCatalog.models.length) {
    throw new Error("Desktop model catalog is missing or empty.");
  }

  const configFile = path.join(home, "config.toml");
  if (fs.lstatSync(configFile).isSymbolicLink()) {
    throw new Error("Refusing to update a linked Desktop profile config.");
  }
  const original = fs.readFileSync(configFile, "utf8");
  const { config, model } = normalizeDesktopConfig(original, desktopCatalog);
  if (config !== original) {
    if (fs.readFileSync(configFile, "utf8") !== original) {
      throw new Error("Desktop profile changed during Context synchronization; retry.");
    }
    atomicWrite(configFile, config, { expectedContents: original });
  }
  return { catalogModels: desktopCatalog.models.length, changed: config !== original, model };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const home = process.env.CODEX_COPILOT_HOME || path.join(os.homedir(), ".codex-copilot");
    const result = await applyDesktopProfile({ home });
    process.stdout.write(
      `Desktop catalog ready (${result.catalogModels} presets)` +
      `${result.changed ? `; Context default synchronized to ${result.model}` : ""}\n`,
    );
  } catch (error) {
    process.stderr.write(`ccodex Desktop profile: ${error.message}\n`);
    process.exitCode = 1;
  }
}
