/**
 * Generates `%USERPROFILE%\.codex-copilot\config.toml`.
 *
 * The file is derived from the user's existing Codex config so that every native
 * capability (plugins, computer use, MCP servers, sandbox policy, trusted projects,
 * desktop preferences) is preserved verbatim. Only the model source and the paths
 * that point at the original CODEX_HOME are rewritten.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { configEntries, editSettings, removeTables, readSetting, stringArray } from "./config-document.mjs";
import { selectedBridgePort } from "../bridge/port-selection.mjs";
import { DEFAULT_CONTEXT_SUFFIX, LONG_CONTEXT_SUFFIX } from "../bridge/catalog.mjs";
import { CLI_STATUS_ITEMS } from "../bridge/surface-settings.mjs";
import {
  atomicWrite,
  paths as workIqPaths,
  publicStatus as workIqStatus,
  readSettings as readWorkIqSettings,
  renderManagedConfig as renderWorkIqConfig,
  stripManagedBlock as stripWorkIqBlock,
} from "../bridge/workiq/settings.mjs";

const SOURCE_HOME = process.env.CODEX_COPILOT_SOURCE_HOME || path.join(os.homedir(), ".codex");
const TARGET_HOME = process.env.CODEX_COPILOT_HOME || path.join(os.homedir(), ".codex-copilot");
const BRIDGE_PORT = selectedBridgePort({ home: TARGET_HOME });
const DEFAULT_MODEL = process.env.CODEX_COPILOT_DEFAULT_MODEL || null;

const STRIP_KEYS = new Set([
  "model",
  "model_provider",
  "model_catalog_json",
  "model_reasoning_effort",
  "service_tier",
  "preferred_auth_method",
  "check_for_update_on_startup",
]);

export function stripManagedSettings(text) {
  return removeTables(
    editSettings(text, [], Object.fromEntries([...STRIP_KEYS].map(key => [key, null]))),
    ["model_providers", "github-copilot"],
  );
}

function rewriteHomePaths(text, sourceHome, targetHome) {
  const variants = [
    sourceHome,
    sourceHome.replace(/\\/g, "\\\\"),
    sourceHome.replace(/\\/g, "/"),
    sourceHome.toLowerCase(),
    sourceHome.toLowerCase().replace(/\\/g, "/"),
  ];
  const targets = [
    targetHome,
    targetHome.replace(/\\/g, "\\\\"),
    targetHome.replace(/\\/g, "/"),
    targetHome.toLowerCase(),
    targetHome.toLowerCase().replace(/\\/g, "/"),
  ];
  let out = text;
  variants.forEach((variant, index) => {
    out = out.split(variant).join(targets[index]);
  });
  return out;
}

function tomlPath(p) {
  return JSON.stringify(p);
}

export function setMcpEnabled(text, name, enabled, comment = null) {
  const lines = text.split("\n");
  const header = `[mcp_servers.${name}]`;
  const start = lines.findIndex((line) => line.trim() === header);
  if (start < 0) return text;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\s*\[/.test(lines[index])) {
      end = index;
      break;
    }
  }
  const section = lines.slice(start + 1, end);
  const enabledAt = section.findIndex((line) => /^\s*enabled\s*=/.test(line));
  const value = `enabled = ${enabled ? "true" : "false"}`;
  if (enabledAt >= 0) section[enabledAt] = value;
  else section.push(value);
  if (comment && !enabled) {
    const commentLine = `# ${comment}`;
    if (!section.includes(commentLine)) section.push(commentLine);
  }
  return [...lines.slice(0, start + 1), ...section, ...lines.slice(end)].join("\n");
}

async function applyRemoteMcpAvailability(text) {
  if (process.env.CODEX_COPILOT_OPENAI_DOCS_MCP === "enabled") {
    return setMcpEnabled(text, "openaiDeveloperDocs", true);
  }
  if (!text.includes("[mcp_servers.openaiDeveloperDocs]")) return text;
  try {
    const response = await fetch("https://developers.openai.com/mcp", {
      signal: AbortSignal.timeout(5000),
    });
    await response.body?.cancel();
    if (
      response.status === 403 &&
      response.headers.get("x-vercel-mitigated") === "deny"
    ) {
      return setMcpEnabled(
        text,
        "openaiDeveloperDocs",
        false,
        "Disabled in the Copilot profile because the remote endpoint denied this network. Run codex-copilot repair to retry.",
      );
    }
  } catch {
    /* Keep the inherited setting when availability cannot be determined. */
  }
  return text;
}

/**
 * The desktop model controls only offer the reasoning efforts listed in the `[desktop]`
 * `enabled-reasoning-efforts` setting, which defaults to low/medium/high/xhigh/ultra. Copilot
 * models also advertise `max` (and some `none`/`minimal`), so opt those in - otherwise the
 * picker silently drops them.
 */
const DESKTOP_SETTINGS = {
  conversationDetailMode: '"STEPS_EXECUTION"',
};
const COPILOT_REASONING_EFFORTS = [
  "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
];

const DESKTOP_DEFAULTS = {
  "show-ultra-in-model-picker-slider": "true",
};

const TUI_SETTINGS = {
  status_line: JSON.stringify(CLI_STATUS_ITEMS),
  raw_output_mode: "false",
  alternate_screen: '"always"',
};

const COPILOT_SELECTION_FILE = path.join(TARGET_HOME, "desktop-selection-generation.json");

function ensureTableSettings(text, table, settings) {
  return editSettings(text, [table], settings);
}

export function ensureManagedUiSettings(text) {
  const effortPath = ["desktop", "enabled-reasoning-efforts"];
  const existing = configEntries(text).find(entry =>
    JSON.stringify([...entry.table, ...(entry.key || [])]) === JSON.stringify(effortPath));
  const efforts = [...new Set([
    ...(existing ? stringArray(existing.value) : []), ...COPILOT_REASONING_EFFORTS,
  ])];
  return ensureTableSettings(
    editSettings(ensureTableSettings(text, "desktop", {
      ...DESKTOP_SETTINGS, "enabled-reasoning-efforts": JSON.stringify(efforts),
    }),
      ["desktop"], DESKTOP_DEFAULTS, { onlyMissing: true }),
    "tui",
    TUI_SETTINGS,
  );
}

export function ensureChildIsolationSettings(text) {
  const table = ["shell_environment_policy"];
  const entry = configEntries(text).find(item =>
    JSON.stringify([...item.table, ...(item.key || [])]) ===
      JSON.stringify([...table, "exclude"]));
  let existing = [];
  if (entry) {
    existing = stringArray(entry.value);
  }
  const excluded = [...new Set([...existing, "CODEX_HOME", "CODEX_CLI_PATH",
    "CODEX_COPILOT_*", "CODEX_ELECTRON_USER_DATA_PATH", "CODEX_ELECTRON_RESOURCES_PATH",
    "CODEX_WINDOWS_REGISTERED_CORE", "CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY",
    "NODE_REPL_*", "SKY_CUA_*", "BROWSER_USE_*"])];
  return editSettings(text, table, { exclude: JSON.stringify(excluded) });
}

export function inheritedConfig({ existing, source, sourceHome, targetHome }) {
  // A repair is a migration, not a reset. Desktop, plugins and users own all
  // settings outside the bridge provider. Stock settings only seed a new home.
  let baseline = existing ?? rewriteHomePaths(source || "", sourceHome, targetHome);
  if (existing != null && !stripWorkIqBlock(existing).replace(/^\s*#.*$/gm, "").trim()) {
    baseline = `${rewriteHomePaths(source || "", sourceHome, targetHome).trimEnd()}\n${existing}`;
  }
  if (existing != null) {
    const marker = "# ---------------------------- inherited ----------------------------";
    if (baseline.startsWith("# GitHub Copilot powered Codex profile") && baseline.includes(marker)) {
      baseline = baseline.replace(/^# GitHub Copilot powered Codex profile[^\n]*\n(?:#[^\n]*\n)*/, "")
        .replace(marker, "").trimStart();
    }
  }
  baseline = baseline.replace(/\n# -+\n# Model source: the local GitHub Copilot bridge\.[\s\S]*?(?=\[model_providers\.github-copilot\])/, "\n");
  return stripManagedSettings(baseline);
}

/** Keep the most recently applied model selection across profile regenerations. */
function existingSelection(targetFile) {
  let configured = null;
  try {
    const text = fs.readFileSync(targetFile, "utf8");
    const model = readSetting(text, [], "model");
    const effort = readSetting(text, [], "model_reasoning_effort");
    const serviceTier = readSetting(text, [], "service_tier");
    const explicitLong = model?.endsWith(LONG_CONTEXT_SUFFIX) || false;
    const explicitDefault = model?.endsWith(DEFAULT_CONTEXT_SUFFIX) || false;
    configured = {
      model: explicitLong
        ? model.slice(0, -LONG_CONTEXT_SUFFIX.length)
        : explicitDefault
          ? model.slice(0, -DEFAULT_CONTEXT_SUFFIX.length)
          : model || null,
      effort: effort || null,
      serviceTier: explicitLong ? "context-long" : explicitDefault ? null : serviceTier || null,
      explicitDefault,
      modifiedAt: fs.statSync(targetFile).mtimeMs,
    };
  } catch {
    // A new profile has no configuration to preserve.
  }
  try {
    const shared = JSON.parse(fs.readFileSync(COPILOT_SELECTION_FILE, "utf8"));
    if (shared?.schemaVersion === 1 && shared.model) {
      const selected = {
        model: shared.model,
        effort: shared.effort || null,
        serviceTier: shared.contextTier === "long_context" ? "context-long" : null,
      };
      const publishedAt = Date.parse(shared.updatedAt);
      // Desktop and /model can update the actual config after a management-CLI
      // snapshot. A subsequent repair must not roll that live selection back.
      if (
        configured?.model &&
        (!Number.isFinite(publishedAt) || configured.modifiedAt > publishedAt) &&
        (configured.model !== selected.model ||
          configured.effort !== selected.effort ||
          configured.serviceTier !== selected.serviceTier)
      ) {
        return configured;
      }
      return { ...selected, explicitDefault: configured?.explicitDefault || false };
    }
  } catch {
    // Migrate the previous config-only selection below.
  }
  return configured || { model: null, effort: null };
}

async function main() {
  fs.mkdirSync(TARGET_HOME, { recursive: true });
  const target = path.join(TARGET_HOME, "config.toml");
  const originalConfig = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;
  const previous = existingSelection(target);
  const model = previous.model || DEFAULT_MODEL;
  let hasStandardAlias = false;
  try {
    const desktopCatalog = JSON.parse(
      fs.readFileSync(path.join(TARGET_HOME, "models-desktop.json"), "utf8"),
    );
    hasStandardAlias = desktopCatalog.models?.some(
      (entry) => entry.slug === `${model}${DEFAULT_CONTEXT_SUFFIX}`,
    ) || false;
  } catch {
    // A new profile gets its aliases when the bridge publishes its first catalog.
  }
  const selectedAlias = model && (
    previous.serviceTier === "context-long"
      ? `${model}${LONG_CONTEXT_SUFFIX}`
      : previous.explicitDefault || hasStandardAlias
        ? `${model}${DEFAULT_CONTEXT_SUFFIX}`
        : null
  );
  const modelLine = model ? `model = ${JSON.stringify(selectedAlias || model)}\n` : "";
  const serviceTierLine = !selectedAlias && previous.serviceTier
    ? `service_tier = ${JSON.stringify(previous.serviceTier)}\n`
    : "";

  const sourceFile = path.join(SOURCE_HOME, "config.toml");
  const inheritedSource = inheritedConfig({
    existing: originalConfig,
    source: fs.existsSync(sourceFile) ? fs.readFileSync(sourceFile, "utf8") : "",
    sourceHome: SOURCE_HOME,
    targetHome: TARGET_HOME,
  });
  const inherited = await applyRemoteMcpAvailability(inheritedSource);

  const header = `# GitHub Copilot powered Codex profile -- generated by codex-copilot.
# New profiles are seeded from ${sourceFile}. Repair preserves current user,
# Desktop and plugin settings; only bridge-owned settings are regenerated.
# Native runtime settings belong to the Desktop version that supplies them.
#
# Switch model, reasoning and context tier with \`codex-copilot use\`. Context
# uses the catalog's default/max windows so Codex applies the matching compaction limit.

model_provider = "github-copilot"
model_catalog_json = ${JSON.stringify(path.join(TARGET_HOME, "models-desktop.json"))}
check_for_update_on_startup = false
${modelLine}${previous.effort ? `model_reasoning_effort = ${JSON.stringify(previous.effort)}\n` : ""}${serviceTierLine}
`;

  const provider = `

# ---------------------------------------------------------------------------
# Model source: the local GitHub Copilot bridge. It authenticates with GitHub,
# forwards Responses-API traffic to api.githubcopilot.com unchanged for models
# that speak it natively, and adapts the rest from Chat Completions.
# ---------------------------------------------------------------------------
[model_providers.github-copilot]
name = "GitHub Copilot"
base_url = "http://127.0.0.1:${BRIDGE_PORT}"
wire_api = "responses"
requires_openai_auth = false
http_headers = { "X-Codex-Copilot-Surface" = "codex" }
request_max_retries = 4
stream_max_retries = 5
stream_idle_timeout_ms = 300000

[model_providers.github-copilot.auth]
command = ${tomlPath(process.execPath)}
args = [${tomlPath(path.join(import.meta.dirname, "..", "bridge", "provider-auth.mjs"))}]
timeout_ms = 10000
refresh_interval_ms = 300000
cwd = ${tomlPath(path.resolve(import.meta.dirname, ".."))}
`;

  const body = `${header}\n# ---------------------------- inherited ----------------------------\n${inherited.trim()}\n${provider}`;
  let generated = ensureChildIsolationSettings(
    ensureManagedUiSettings(body.replace(/\n{3,}/g, "\n\n")));
  if (fs.existsSync(workIqPaths(TARGET_HOME).settings)) {
    const settings = readWorkIqSettings(TARGET_HOME);
    // A user may disable the server from native Desktop MCP settings. Repair
    // must not silently re-enable it from an older integration setting.
    generated = renderWorkIqConfig(generated, {
      ...settings,
      enabled: settings.enabled && workIqStatus(TARGET_HOME).configEnabled,
    }, { profile: TARGET_HOME });
  }
  const currentConfig = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;
  if (currentConfig !== originalConfig) throw new Error("Configuration changed during repair; retry instead of overwriting newer settings.");
  atomicWrite(target, generated);
  process.stdout.write(`wrote ${target} (model: ${model || "live Copilot default"})\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exit(1);
  });
}
