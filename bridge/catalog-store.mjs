import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CODEX_COPILOT_HOME } from "./auth.mjs";
import { buildDesktopCatalog } from "./catalog.mjs";
import { atomicWrite } from "./atomic-file.mjs";
export { atomicWrite } from "./atomic-file.mjs";

export const CATALOG_FILE = path.join(CODEX_COPILOT_HOME, "models.json");
export const DESKTOP_CATALOG_FILE = path.join(CODEX_COPILOT_HOME, "models-desktop.json");
export const CATALOG_GENERATION_FILE = path.join(
  CODEX_COPILOT_HOME,
  "catalog-generation.json",
);

const CODEX_MODELS_CACHE_FILE = path.join(CODEX_COPILOT_HOME, "models_cache.json");

function generationFor(catalog, desktopCatalog) {
  return createHash("sha256")
    .update(JSON.stringify([catalog, desktopCatalog]))
    .digest("hex");
}

function matchesFile(file, content) {
  try {
    return fs.readFileSync(file, "utf8") === content;
  } catch {
    return false;
  }
}

export function catalogFilesHealthy(catalog) {
  return matchesFile(CATALOG_FILE, JSON.stringify(catalog, null, 1)) &&
    matchesFile(DESKTOP_CATALOG_FILE, JSON.stringify(buildDesktopCatalog(catalog), null, 1));
}

function readCatalogState() {
  try {
    return JSON.parse(fs.readFileSync(CATALOG_GENERATION_FILE, "utf8"));
  } catch {
    return null;
  }
}

export function readCatalogGeneration() {
  return readCatalogState()?.generation || null;
}

export function writeCatalogSnapshot(catalog) {
  const desktopCatalog = buildDesktopCatalog(catalog);
  const catalogText = JSON.stringify(catalog, null, 1);
  const desktopText = JSON.stringify(desktopCatalog, null, 1);
  const digest = generationFor(catalog, desktopCatalog);
  const previous = readCatalogState();
  const previousDigest = previous?.digest || previous?.generation;
  const changed =
    previousDigest !== digest ||
    !matchesFile(CATALOG_FILE, catalogText) ||
    !matchesFile(DESKTOP_CATALOG_FILE, desktopText);
  // Repairing a damaged catalog with the same model digest must still notify
  // an already-running Desktop renderer to reload its model state.
  const generation = changed
    ? previousDigest === digest
      ? `${digest}-${randomUUID()}`
      : digest
    : previous.generation;
  let cacheInvalidated = true;

  if (changed) {
    atomicWrite(DESKTOP_CATALOG_FILE, desktopText);
    atomicWrite(CATALOG_FILE, catalogText);
    try {
      fs.rmSync(CODEX_MODELS_CACHE_FILE, { force: true });
    } catch {
      cacheInvalidated = false;
    }
    atomicWrite(
      CATALOG_GENERATION_FILE,
      JSON.stringify(
        {
          generation,
          digest,
          models: catalog.models?.length || 0,
          desktopModels: desktopCatalog.models.length,
          updated_at: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
  }

  return { changed, generation, cacheInvalidated };
}
