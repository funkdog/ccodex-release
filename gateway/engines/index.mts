import "../../tools/typescript-runtime.mjs";
import type { EngineConfig, EngineAdapter } from "../contracts.mjs";
import type { ClaudeSdk, CopilotSdk } from "../sdk-contracts.mjs";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { claudeCodeEngine } from "./claude-code.mjs";
import { copilotEngine } from "./github-copilot.mjs";
import { codexCopilotCatalog, codexCopilotEngineId } from "../copilot-provider.mjs";
import { geminiCliEngine } from "./gemini-cli.mjs";
import { codexGoogleEngine } from "../google-provider.mjs";
import { antigravityEngine } from "./antigravity.mjs";
import { claudeApiEnvironment } from "../claude-api-profile.mjs";

const definitions = new Map<string, { package: string; entry: string }>([
  ["claude-code", { package: "@anthropic-ai/claude-agent-sdk", entry: "sdk.mjs" }],
  ["github-copilot", { package: "@github/copilot-sdk", entry: "dist/index.js" }],
]);

export function cliEnvironment(inherited = process.env) {
  const env = { ...inherited };
  for (const name of Object.keys(env)) if (/^(?:CODEX_|CCODEX_|ELECTRON_|NODE_REPL_|SKY_CUA_|BROWSER_USE_)/.test(name) || name === "NODE_OPTIONS") delete env[name];
  return env;
}

export async function createEngines(configs: EngineConfig[], { env = cliEnvironment(), requireSelection = false } = {}) {
  const engines = new Map<string, EngineAdapter>();
  for (const config of configs) {
    if (requireSelection && !config.enabledModels?.length) {
      if (engines.has(config.id)) throw new Error("Duplicate gateway engine ID.");
      engines.set(config.id, { adapter: config.adapter, displayName: config.id, models: async () => [],
        run: async () => { throw new Error("This CLI has no enabled model. Configure and verify a model first."); } });
      continue;
    }
    if (config.adapter === "antigravity-acp") {
      if (engines.has(config.id)) throw new Error("Duplicate Antigravity engine ID.");
      for (const field of ["executable", "harnessPath"] as const)
        if (!path.isAbsolute(config[field] || "") || !fs.statSync(config[field]).isFile()) throw new Error(`Antigravity ${field} is unavailable.`);
      engines.set(config.id, { adapter: config.adapter, ...antigravityEngine({ ...config, env }) });
      continue;
    }
    if (config.adapter === "gemini-cli" || config.adapter === "codex-gemini") {
      if (engines.has(config.id)) throw new Error("Duplicate Google engine ID.");
      const field = config.adapter === "gemini-cli" ? "executable" : "sdkPath";
      const entry = config.adapter === "gemini-cli" ? config.executable : config.sdkPath;
      if (!path.isAbsolute(entry || "") || !fs.statSync(entry).isFile()) throw new Error(`Google ${field} is unavailable.`);
      engines.set(config.id, { adapter: config.adapter, ...(config.adapter === "gemini-cli"
        ? geminiCliEngine({ ...config, env }) : codexGoogleEngine(config)) });
      continue;
    }
    if (config.adapter === "codex-copilot") {
      if (config.id !== codexCopilotEngineId || engines.has(config.id)) throw new Error("Codex + Copilot must use its reserved engine ID.");
      engines.set(config.id, codexCopilotCatalog(config));
      continue;
    }
    const definition = definitions.get(config.adapter);
    if (!definition || engines.has(config.id)) throw new Error("Unknown or duplicate gateway adapter.");
    if (config.executable && (!path.isAbsolute(config.executable) || !fs.statSync(config.executable).isFile())) throw new Error(`CLI executable is unavailable: ${config.id}`);
    // Packaged dependencies remain in the existing runtime tree. A source
    // checkout can explicitly point at an installed, pinned SDK entry file.
    const sdkPath = config.sdkPath || path.resolve(import.meta.dirname, "../../runtime/gateway/node_modules", definition.package, definition.entry);
    if (!path.isAbsolute(sdkPath) || !fs.statSync(sdkPath).isFile()) throw new Error(`SDK entry is unavailable for ${config.id}. Configure sdkPath or install the packaged runtime.`);
    const sdk = await import(pathToFileURL(sdkPath).href);
    if (config.adapter === "claude-code" && typeof sdk.query !== "function") throw new Error("The configured Claude Agent SDK has no query contract.");
    engines.set(config.id, { adapter: config.adapter, ...(config.adapter === "claude-code" && config.initialApprovalMode ? { initialApprovalMode: config.initialApprovalMode } : {}), ...(config.adapter === "claude-code" ? claudeCodeEngine({ sdk: sdk as ClaudeSdk, executable: config.executable, env,
      ...(config.cliHome ? { credentialProfile: config.cliHome, environment: () => claudeApiEnvironment(config.cliHome!, env) } : {}) }) : copilotEngine({ sdk: sdk as CopilotSdk, executable: config.executable, env })) });
  }
  for (const config of configs) {
    if (!requireSelection && config.enabledModels === undefined) continue;
    const selected = new Set(config.enabledModels ?? []);
    const engine = engines.get(config.id)!;
    const filtered: EngineAdapter = Object.create(engine);
    filtered.models = async () => selected.size ? (await engine.models()).filter(model => selected.has(model.id)) : [];
    filtered.run = context => {
      if (!selected.has(context.model)) return Promise.reject(new Error("This model is not enabled for the selected CLI."));
      return engine.run(context);
    };
    engines.set(config.id, filtered);
  }
  return engines;
}
