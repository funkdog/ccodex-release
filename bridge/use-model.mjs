/**
 * Updates only the selected surface's defaults: config.toml for Desktop,
 * ccodex.config.toml for CLI. Account credentials and catalogs remain shared.
 */
import fs from "node:fs";
import path from "node:path";
import { CODEX_COPILOT_HOME } from "./auth.mjs";
import {
  DEFAULT_CONTEXT_SUFFIX,
  LONG_CONTEXT_SERVICE_TIER,
  LONG_CONTEXT_SUFFIX,
  plainName,
} from "./catalog.mjs";
import { publishSelectionSnapshot } from "./selection-store.mjs";
import { editSettings, readSetting } from "../tools/config-document.mjs";
import { prepareCliSettings, surfaceConfigFile } from "./surface-settings.mjs";
import { atomicWrite } from "./workiq/settings.mjs";

const CONFIG_FILE = path.join(CODEX_COPILOT_HOME, "config.toml");
const CATALOG_FILE = path.join(CODEX_COPILOT_HOME, "models.json");

function readConfig(surface = "desktop") {
  return fs.readFileSync(surfaceConfigFile(CODEX_COPILOT_HOME, surface), "utf8");
}

export function catalog() {
  try {
    return JSON.parse(fs.readFileSync(CATALOG_FILE, "utf8")).models || [];
  } catch {
    return [];
  }
}

export function current({ surface = "desktop" } = {}) {
  if (surface === "cli") prepareCliSettings(CODEX_COPILOT_HOME);
  const text = readConfig(surface);
  const model = readSetting(text, [], "model");
  const effort = readSetting(text, [], "model_reasoning_effort");
  const serviceTier = readSetting(text, [], "service_tier");
  const configuredModel = model || null;
  const explicitLong = configuredModel?.endsWith(LONG_CONTEXT_SUFFIX) || false;
  const explicitDefault = configuredModel?.endsWith(DEFAULT_CONTEXT_SUFFIX) || false;
  const baseModel = explicitLong
    ? configuredModel.slice(0, -LONG_CONTEXT_SUFFIX.length)
    : explicitDefault
      ? configuredModel.slice(0, -DEFAULT_CONTEXT_SUFFIX.length)
      : configuredModel;
  const entry = catalog().find((candidate) => candidate.slug === baseModel);
  const longContext =
    explicitLong || (!explicitDefault && serviceTier === LONG_CONTEXT_SERVICE_TIER);
  return {
    model: baseModel,
    baseModel: entry?.copilot?.base_model || baseModel,
    effort: effort || null,
    serviceTier: serviceTier || null,
    contextTier: longContext ? "long_context" : "default",
    contextWindow: longContext
      ? entry?.copilot?.long_context_window_tokens || null
      : entry?.copilot?.default_context_window_tokens || null,
  };
}

function normalizeContextTier(value) {
  if (!value) return null;
  const normalized = String(value).trim().toLowerCase().replace(/-/g, "_");
  if (normalized === "long") return "long_context";
  if (normalized === "default" || normalized === "long_context") return normalized;
  throw new Error(`Unknown context tier '${value}'. Expected default or long_context.`);
}

function selectEntry(models, slug, contextTier) {
  const requested = String(slug);
  const baseSlug = requested.endsWith(LONG_CONTEXT_SUFFIX)
    ? requested.slice(0, -LONG_CONTEXT_SUFFIX.length)
    : requested.endsWith(DEFAULT_CONTEXT_SUFFIX)
      ? requested.slice(0, -DEFAULT_CONTEXT_SUFFIX.length)
      : requested;
  const entry = models.find(
    (model) => model.slug === baseSlug || model.copilot?.base_model === baseSlug
  );
  if (!entry) return null;
  if (contextTier === "long_context" && !entry.copilot?.long_context_prompt_tokens) {
    return null;
  }
  return entry;
}

export function use(slug, effort, contextTier, { surface = "desktop" } = {}) {
  if (surface === "cli") prepareCliSettings(CODEX_COPILOT_HOME);
  const models = catalog();
  const normalizedContext = normalizeContextTier(contextTier);
  const selectedContext = normalizedContext ||
    (String(slug).endsWith(LONG_CONTEXT_SUFFIX) ? "long_context" : "default");
  const entry = selectEntry(models, slug, selectedContext);
  if (!entry) {
    const contexts = models
      .filter((model) => model.slug === slug || model.copilot?.base_model === slug)
      .flatMap((model) =>
        model.copilot?.long_context_prompt_tokens
          ? ["default", "long_context"]
          : ["default"]
      );
    if (normalizedContext && contexts.length) {
      throw new Error(
        `Model '${slug}' does not support context tier '${normalizedContext}'.\nSupported: ${contexts.join(", ")}`
      );
    }
    const available = [...new Set(models.map((model) => model.copilot?.base_model || model.slug))].join(", ");
    throw new Error(`Unknown model '${slug}'.\nAvailable: ${available}`);
  }

  const levels = (entry.supported_reasoning_levels || []).map((l) => l.effort);
  if (effort && !levels.includes(effort)) {
    throw new Error(`Model '${slug}' does not support reasoning effort '${effort}'.\nSupported: ${levels.join(", ") || "none"}`);
  }

  const original = readConfig(surface);
  let text = original;
  const hasLongContext = Boolean(entry.copilot?.long_context_prompt_tokens);
  const selectedSlug = hasLongContext
    ? `${entry.slug}${selectedContext === "long_context"
      ? LONG_CONTEXT_SUFFIX
      : DEFAULT_CONTEXT_SUFFIX}`
    : entry.slug;
  const currentEffort = readSetting(original, [], "model_reasoning_effort");
  const chosen = effort || (levels.includes(currentEffort) ? currentEffort
    : levels.includes(entry.default_reasoning_level) ? entry.default_reasoning_level : levels[0]);
  text = editSettings(text, [], {
    model: JSON.stringify(surface === "cli" ? entry.slug : selectedSlug),
    model_reasoning_effort: chosen ? JSON.stringify(chosen) : null,
    service_tier: surface === "cli"
      ? JSON.stringify(selectedContext === "long_context" ? LONG_CONTEXT_SERVICE_TIER : "default")
      : null,
  });
  if (text !== original) {
    const file = surfaceConfigFile(CODEX_COPILOT_HOME, surface);
    if (fs.readFileSync(file, "utf8") !== original) {
      throw new Error("Model settings changed concurrently; the newer configuration was not overwritten.");
    }
    atomicWrite(file, text, { expectedContents: original });
  }

  const longContext = selectedContext === "long_context";
  const result = {
    model: entry.slug,
    baseModel: entry.copilot?.base_model || entry.slug,
    effort: chosen,
    contextTier: longContext ? "long_context" : "default",
    contextWindow: longContext
      ? entry.copilot?.long_context_window_tokens || null
      : entry.copilot?.default_context_window_tokens || null,
    display: plainName(entry.display_name),
    route: entry.copilot?.route,
  };
  publishSelectionSnapshot(result, { updatedBy: "management-cli", surface });
  return result;
}

export { CONFIG_FILE };
