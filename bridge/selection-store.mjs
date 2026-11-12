import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CODEX_COPILOT_HOME } from "./auth.mjs";
import { atomicWrite } from "./catalog-store.mjs";

export const SELECTION_FILE = path.join(CODEX_COPILOT_HOME, "desktop-selection-generation.json");

export function readSelectionSnapshot({ surface = "desktop" } = {}) {
  try {
    const file = surface === "cli"
      ? path.join(CODEX_COPILOT_HOME, "cli-selection-generation.json") : SELECTION_FILE;
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value?.schemaVersion === 1 ? value : null;
  } catch {
    return null;
  }
}

export function publishSelectionSnapshot(selection, {
  updatedBy = "bridge", forceNew = false, surface = "desktop",
} = {}) {
  const previous = readSelectionSnapshot({ surface });
  const normalized = {
    model: selection?.model || null,
    effort: selection?.effort || null,
    contextTier: selection?.contextTier || "default",
    contextWindow: selection?.contextWindow || null,
  };
  const previousSelection = previous
    ? {
        model: previous.model,
        effort: previous.effort,
        contextTier: previous.contextTier,
        contextWindow: previous.contextWindow,
      }
    : null;
  const changed = JSON.stringify(previousSelection) !== JSON.stringify(normalized);
  const snapshot = {
    schemaVersion: 1,
    generation:
      forceNew || changed || !previous?.generation ? randomUUID() : previous.generation,
    updatedAt: changed || forceNew ? new Date().toISOString() : previous?.updatedAt,
    updatedBy: changed || forceNew ? updatedBy : previous?.updatedBy || updatedBy,
    ...normalized,
  };
  const file = surface === "cli"
    ? path.join(CODEX_COPILOT_HOME, "cli-selection-generation.json") : SELECTION_FILE;
  atomicWrite(file, `${JSON.stringify(snapshot, null, 2)}\n`);
  return { changed, snapshot };
}
