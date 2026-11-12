import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { CODEX_COPILOT_HOME } from "./auth.mjs";

const CACHE_FILE = path.join(CODEX_COPILOT_HOME, "copilot-cli-models.json");
const LOG_FILE = path.join(CODEX_COPILOT_HOME, "bridge.log");
const CACHE_TTL_MS = Number(process.env.CODEX_COPILOT_CONTEXT_METADATA_TTL_MS || 10 * 60 * 1000);

let memoryCache = null;

function log(message) {
  try {
    fs.mkdirSync(CODEX_COPILOT_HOME, { recursive: true });
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} copilot-cli-models ${message}\n`, "utf8");
  } catch {
    // Metadata diagnostics must not break the bridge.
  }
}

function readCache({ allowStale = false } = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    if (!Array.isArray(parsed?.models)) return null;
    const fetchedAt = Date.parse(parsed.fetched_at || "");
    if (!allowStale && (!Number.isFinite(fetchedAt) || Date.now() - fetchedAt > CACHE_TTL_MS)) return null;
    return new Map(parsed.models.map((model) => [model.id, model]));
  } catch {
    return null;
  }
}

function writeCache(models) {
  fs.mkdirSync(CODEX_COPILOT_HOME, { recursive: true });
  fs.writeFileSync(
    CACHE_FILE,
    JSON.stringify({ fetched_at: new Date().toISOString(), models: [...models.values()] }, null, 2),
    "utf8"
  );
}

function sdkCandidates() {
  const candidates = [];
  const bundled = path.resolve(import.meta.dirname, "..", "runtime", "copilot",
    "node_modules", "@github", `copilot-${process.platform}-${process.arch}`, "copilot-sdk", "index.js");
  if (fs.existsSync(bundled)) return [bundled];
  if (process.env.CODEX_COPILOT_CLI_SDK) candidates.push(process.env.CODEX_COPILOT_CLI_SDK);
  try {
    const saved = fs
      .readFileSync(path.join(CODEX_COPILOT_HOME, "copilot-cli-sdk-path.txt"), "utf8")
      .trim();
    if (saved) candidates.push(saved);
  } catch {
    // A custom path is optional; continue with standard installation roots.
  }

  const moduleRoots = [];
  if (process.platform === "win32") {
    moduleRoots.push(path.join(process.env.APPDATA || "", "npm", "node_modules"));
  }
  for (const root of [
    path.join(os.homedir(), ".local", "lib", "node_modules"),
    path.join(os.homedir(), ".npm-global", "lib", "node_modules"),
    "/usr/local/lib/node_modules",
    "/opt/homebrew/lib/node_modules",
  ]) {
    moduleRoots.push(root);
  }
  try {
    moduleRoots.unshift(
      execFileSync("npm", ["root", "-g"], {
        encoding: "utf8",
        timeout: 10000,
      }).trim(),
    );
  } catch {
    /* npm is optional */
  }

  for (const moduleRoot of new Set(moduleRoots.filter(Boolean))) {
    const githubRoot = path.join(
      moduleRoot,
      "@github",
      "copilot",
      "node_modules",
      "@github",
    );
    try {
      const preferred = `copilot-${process.platform}-${process.arch}`;
      const names = fs
        .readdirSync(githubRoot)
        .filter((name) => name.startsWith("copilot-"))
        .sort((a, b) => Number(b === preferred) - Number(a === preferred));
      for (const name of names) {
        candidates.push(path.join(githubRoot, name, "copilot-sdk", "index.js"));
      }
    } catch {
      // Copilot CLI is optional; callers fall back to raw CAPI model limits.
    }
  }

  return [...new Set(candidates.map((candidate) => path.resolve(candidate)))].filter((candidate) =>
    fs.existsSync(candidate)
  );
}

async function withTimeout(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function normalizeModels(models) {
  const normalized = new Map();
  for (const model of models) {
    const prices = model.billing?.tokenPrices;
    const defaultPromptTokens = positiveInteger(prices?.maxPromptTokens ?? prices?.contextMax);
    const longPromptTokens = positiveInteger(
      prices?.longContext?.maxPromptTokens ?? prices?.longContext?.contextMax
    );
    normalized.set(model.id, {
      id: model.id,
      default_prompt_tokens: defaultPromptTokens,
      long_context_prompt_tokens: longPromptTokens,
    });
  }
  return normalized;
}

async function stopClient(client) {
  try {
    await withTimeout(client.stop(), 5000, "Copilot CLI SDK shutdown");
  } catch (error) {
    log(`graceful shutdown failed: ${error.message}`);
    try {
      await client.forceStop();
    } catch (forceError) {
      log(`forced shutdown failed: ${forceError.message}`);
    }
  }
}

/**
 * Reads the same tiered-pricing model metadata that powers Copilot CLI's Context
 * column. Only token limits are cached; no credential is written to disk.
 */
export async function fetchCopilotCliModelMetadata(gitHubToken, { force = false } = {}) {
  if (!force && memoryCache?.token === gitHubToken) return memoryCache.models;
  if (!force && !memoryCache) {
    const cached = readCache();
    if (cached) {
      memoryCache = { token: gitHubToken, models: cached };
      return cached;
    }
  }

  const sdkFile = sdkCandidates()[0];
  if (!sdkFile) {
    const stale = readCache({ allowStale: true });
    if (stale) {
      log("Copilot CLI SDK not found; using stale context metadata");
      memoryCache = { token: gitHubToken, models: stale };
      return stale;
    }
    log("Copilot CLI SDK not found; context tiers are unavailable");
    return new Map();
  }

  let client = null;
  try {
    const { CopilotClient, RuntimeConnection } = await import(pathToFileURL(sdkFile).href);
    const bundledCli = path.resolve(path.dirname(sdkFile), "..", "copilot.exe");
    const privateCli = fs.existsSync(path.resolve(import.meta.dirname, "..", "release.json"));
    client = new CopilotClient({
      gitHubToken,
      logLevel: "error",
      workingDirectory: process.cwd(),
      ...(privateCli ? {
        connection: RuntimeConnection.forStdio({ path: bundledCli, args: ["--no-auto-update"] }),
        baseDirectory: path.join(CODEX_COPILOT_HOME, "copilot"),
        useLoggedInUser: false,
        env: { ...process.env, COPILOT_CLI_PATH: bundledCli,
          COPILOT_CLI_DIST_DIR: path.dirname(bundledCli),
          COPILOT_AUTO_UPDATE: "false", COPILOT_HOME: path.join(CODEX_COPILOT_HOME, "copilot"),
          COPILOT_DISABLE_KEYTAR: "1",
          COPILOT_PKG_CACHE_HOME: path.join(CODEX_COPILOT_HOME, "copilot-cache"),
          COPILOT_CACHE_HOME: path.join(CODEX_COPILOT_HOME, "copilot-cache") },
      } : {}),
    });
    await withTimeout(client.start(), 30000, "Copilot CLI SDK startup");
    const models = await withTimeout(client.listModels(), 30000, "Copilot CLI model listing");
    const normalized = normalizeModels(models);
    writeCache(normalized);
    memoryCache = { token: gitHubToken, models: normalized };
    log(`refreshed ${normalized.size} model records`);
    return normalized;
  } catch (error) {
    const stale = readCache({ allowStale: true });
    if (stale) {
      log(`refresh failed (${error.message}); using stale context metadata`);
      memoryCache = { token: gitHubToken, models: stale };
      return stale;
    }
    log(`refresh failed: ${error.stack || error.message}`);
    return new Map();
  } finally {
    if (client) await stopClient(client);
  }
}
