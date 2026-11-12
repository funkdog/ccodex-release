import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CODEX_COPILOT_HOME } from "./auth.mjs";
import { atomicWrite } from "./catalog-store.mjs";
import { creditsView } from "./copilot-credits.mjs";

export const ACCOUNT_GENERATION_FILE = path.join(
  CODEX_COPILOT_HOME,
  "account-generation.json",
);

export function readAccountSnapshot() {
  try {
    return JSON.parse(fs.readFileSync(ACCOUNT_GENERATION_FILE, "utf8"));
  } catch {
    return null;
  }
}

export function readAccountGeneration() {
  return readAccountSnapshot()?.generation || null;
}

export function publishAccountSnapshot({
  login,
  source,
  models,
  returnedModels,
  selectedModel,
  profile,
  plan,
  quota,
}, { forceNew = false } = {}) {
  const previous = readAccountSnapshot();
  const identityChanged =
    previous?.login !== (login || null) ||
    previous?.source !== (source || null);
  const generation =
    forceNew || identityChanged || !previous?.generation
      ? randomUUID()
      : previous.generation;
  const snapshot = {
    generation,
    login: login || null,
    source: source || null,
    models: models ?? null,
    returnedModels: returnedModels ?? null,
    selectedModel: selectedModel || null,
    profile: profile === undefined ? (!identityChanged ? previous?.profile || null : null) : profile,
    plan: plan === undefined ? (!identityChanged ? previous?.plan || null : null) : plan,
    quota: quota === undefined ? (!identityChanged ? previous?.quota || null : null) : quota,
    updatedAt: new Date().toISOString(),
  };
  snapshot.credits = {
    ...creditsView(snapshot.quota?.credits), accountGeneration: generation,
  };
  const changed = previous?.generation !== generation;
  atomicWrite(ACCOUNT_GENERATION_FILE, JSON.stringify(snapshot, null, 2));
  return { changed, generation, snapshot };
}
