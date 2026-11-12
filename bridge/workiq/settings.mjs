import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
export { atomicWrite } from "../atomic-file.mjs";
import { atomicWrite } from "../atomic-file.mjs";

export const ENDPOINT = "https://workiq.svc.cloud.microsoft/mcp";
export const RESOURCE_METADATA = "https://workiq.svc.cloud.microsoft/.well-known/oauth-protected-resource/mcp";
export const CLIENT_ID = "ba081686-5d24-4bc6-a0d6-d034ecffed87";
export const OAUTH_CALLBACK_PORT = 12798;
export const SCOPES = ["fdcc1f02-fc51-4226-8753-f668596af7f7/WorkIQAgent.Ask"];
export const SERVER_NAME = "workiq";
export const START_MARKER = "# BEGIN CCODEX MANAGED WORKIQ";
export const END_MARKER = "# END CCODEX MANAGED WORKIQ";
export const DATA_NOTICE =
  "Work IQ results enter this Codex conversation and may be sent to the selected model provider " +
  "(currently the GitHub Copilot bridge). Microsoft 365 service protections do not automatically " +
  "extend to that downstream processing. Enable only if your organization permits it. " +
  "No mail, meeting, Teams, or document content is fetched by setup.";

export const KNOWN_TOOLS = Object.freeze({
  ask: "Semantic search and synthesis over authorized workplace knowledge, with source references",
  list_agents: "Discover the agents exposed to the signed-in user by this Work IQ interface",
  fetch: "Exact, bounded reads of mail, calendar, Teams, people, files, and exposed business records",
  search_paths: "Discover the connected tenant's exposed entity paths",
  get_schema: "Discover request and response schemas for available operations",
  call_function: "Read-only functions such as search and delta queries",
  fetch_blob: "Binary downloads where exposed by the service",
  create_entity: "Create drafts, events, tasks, folders, and other supported records",
  update_entity: "Update supported records",
  delete_entity: "Delete supported records",
  do_action: "Actions such as send, reply, forward, schedule, and exposed business workflows",
});

export function paths(profile = process.env.CODEX_COPILOT_HOME || path.join(os.homedir(), ".codex-copilot")) {
  const home = path.resolve(profile);
  const state = path.join(home, "workiq");
  return {
    home,
    state,
    config: path.join(home, "config.toml"),
    settings: path.join(state, "settings.json"),
    runtime: path.join(state, "runtime"),
    cache: path.join(state, "msal.cache.dpapi"),
    capabilities: path.join(state, "capabilities.json"),
  };
}

export function validateTenant(value) {
  if (value === "organizations") return value;
  if (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value || "")) return value;
  if (/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(value || "")) {
    return value;
  }
  throw new Error("Tenant must be 'organizations', an Entra tenant UUID, or a tenant domain.");
}

export function canonicalTenantId(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("The selected Microsoft identity must include its actual Entra tenant UUID.");
  }
  return value.toLowerCase();
}

export function identityBindingFingerprint(settings) {
  if (!settings.selectedAccountId || !settings.selectedTenantId) return null;
  return createHash("sha256").update(JSON.stringify([
    CLIENT_ID, ENDPOINT, settings.tenant.toLowerCase(),
    settings.selectedAccountId, canonicalTenantId(settings.selectedTenantId),
  ])).digest("hex");
}

export function readSettings(profile) {
  const defaults = {
    schemaVersion: 1,
    enabled: false,
    dataSharingAcknowledged: false,
    tenant: "organizations",
    selectedAccountId: null,
    selectedTenantId: null,
    lastAuthenticationMethod: null,
  };
  let stored;
  try {
    stored = JSON.parse(fs.readFileSync(paths(profile).settings, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return defaults;
    throw new Error("Work IQ settings are unreadable; refusing to guess an account or authorization policy.");
  }
  if (
    stored?.schemaVersion !== 1 ||
    typeof stored.enabled !== "boolean" ||
    typeof stored.dataSharingAcknowledged !== "boolean" ||
    (stored.selectedAccountId != null && typeof stored.selectedAccountId !== "string")
  ) {
    throw new Error("Unsupported or invalid Work IQ settings.");
  }
  validateTenant(stored.tenant);
  const result = { ...defaults, ...stored };
  if (result.lastAuthenticationMethod != null &&
      !["device_code", "authorization_code"].includes(result.lastAuthenticationMethod)) {
    throw new Error("Unsupported Work IQ authentication method.");
  }
  if (result.selectedTenantId != null) {
    result.selectedTenantId = canonicalTenantId(result.selectedTenantId);
    if (!result.selectedAccountId) throw new Error("A Work IQ tenant binding requires an explicitly selected account.");
  }
  return result;
}

export function writeSettings(settings, profile) {
  validateTenant(settings.tenant);
  if (settings.selectedTenantId != null) {
    settings = { ...settings, selectedTenantId: canonicalTenantId(settings.selectedTenantId) };
    if (!settings.selectedAccountId) throw new Error("A Work IQ tenant binding requires an explicitly selected account.");
  }
  if (settings.enabled && !settings.dataSharingAcknowledged) {
    throw new Error("Acknowledge enterprise data processing before enabling Work IQ.");
  }
  atomicWrite(paths(profile).settings, `${JSON.stringify(settings, null, 2)}\n`);
}

export function stripManagedBlock(text) {
  const starts = [...text.matchAll(/^# BEGIN CCODEX MANAGED WORKIQ\r?$/gm)];
  const ends = [...text.matchAll(/^# END CCODEX MANAGED WORKIQ\r?$/gm)];
  if (starts.length === 0 && ends.length === 0) return text;
  if (starts.length !== 1 || ends.length !== 1 || starts[0].index >= ends[0].index) {
    throw new Error("Malformed managed Work IQ config block; no configuration was changed.");
  }
  const end = ends[0].index + ends[0][0].length;
  const start = text.slice(0, starts[0].index).endsWith("\n\n") ? starts[0].index - 2 : starts[0].index;
  return text.slice(0, start) + text.slice(text[end] === "\n" ? end + 1 : end);
}

function hasUnmanagedServer(text) {
  return /^\s*\[\s*mcp_servers\s*\.\s*(?:workiq|"workiq"|'workiq')\s*(?:\.|\])/m.test(text) ||
    /^\s*(?:mcp_servers\s*\.\s*)?(?:workiq|"workiq"|'workiq')\s*=\s*\{/m.test(text) ||
    /^\s*mcp_servers\s*=\s*\{[^}\n]*\bworkiq\s*=/m.test(text);
}

export function renderManagedConfig(text, settings, { profile, node = process.execPath, entry = path.join(import.meta.dirname, "main.mjs") } = {}) {
  const base = stripManagedBlock(text);
  if (hasUnmanagedServer(base)) {
    throw new Error("An unmanaged workiq MCP server already exists. It was not replaced; use another name or migrate it explicitly.");
  }
  const enabled = Boolean(settings.enabled && settings.dataSharingAcknowledged);
  return `${base}\n\n${START_MARKER}
# Shared by ccodex CLI and Desktop; this adapter never opens a login window.
# Enterprise results may be processed by the selected model provider.
[mcp_servers.workiq]
command = ${JSON.stringify(node)}
args = [${JSON.stringify(entry)}, "mcp"]
enabled = ${enabled}
required = false
startup_timeout_sec = 45
tool_timeout_sec = 300
default_tools_approval_mode = "prompt"

[mcp_servers.workiq.env]
CODEX_COPILOT_HOME = ${JSON.stringify(paths(profile).home)}
${END_MARKER}
`;
}

export function configure({ enable = false, acknowledge = false, tenant, profile, node, entry } = {}) {
  const locations = paths(profile);
  const previousSettings = readSettings(profile);
  const settings = {
    ...previousSettings,
    enabled: enable,
    dataSharingAcknowledged: previousSettings.dataSharingAcknowledged || acknowledge,
    tenant: tenant ? validateTenant(tenant) : previousSettings.tenant,
  };
  if (settings.tenant !== previousSettings.tenant) {
    settings.selectedAccountId = null;
    settings.selectedTenantId = null;
  }
  if (settings.enabled && !settings.dataSharingAcknowledged) throw new Error(DATA_NOTICE);
  const before = fs.existsSync(locations.config) ? fs.readFileSync(locations.config, "utf8") : "";
  const after = renderManagedConfig(before, settings, { profile, node, entry });
  // Retain an exact local backup without including it in release artifacts.
  if (before && before !== after) {
    atomicWrite(path.join(locations.state, `config.backup.${Date.now()}.${randomUUID()}.toml`), before);
  }
  writeSettings(settings, profile);
  try {
    const current = fs.existsSync(locations.config) ? fs.readFileSync(locations.config, "utf8") : "";
    if (current !== before) throw new Error("Codex configuration changed concurrently; Work IQ did not overwrite that change.");
    atomicWrite(locations.config, after);
  } catch (error) {
    writeSettings(previousSettings, profile);
    throw error;
  }
  return publicStatus(profile);
}

export function publicStatus(profile) {
  const locations = paths(profile);
  const settings = readSettings(profile);
  let capabilities = null;
  try { capabilities = JSON.parse(fs.readFileSync(locations.capabilities, "utf8")); } catch { /* no successful discovery yet */ }
  const binding = identityBindingFingerprint(settings);
  const discoveryMatchesSelection = Boolean(binding && capabilities?.identityBindingSha256 === binding);
  let configEnabled = false;
  try {
    const config = fs.readFileSync(locations.config, "utf8");
    const section = config.match(/^\s*\[\s*mcp_servers\s*\.\s*(?:workiq|"workiq"|'workiq')\s*\]\s*\r?\n([\s\S]*?)(?=^\s*\[|(?![\s\S]))/m)?.[1] || "";
    configEnabled = /^\s*enabled\s*=\s*true\b/m.test(section);
  } catch { /* Missing config is not an enabled connection. */ }
  return {
    configured: fs.existsSync(locations.settings),
    enabled: settings.enabled && settings.dataSharingAcknowledged && configEnabled,
    settingsEnabled: settings.enabled,
    configEnabled,
    tenant: settings.tenant,
    selectedTenantId: settings.selectedTenantId,
    identityBindingPresent: Boolean(binding),
    endpoint: ENDPOINT,
    dataSharingAcknowledged: settings.dataSharingAcknowledged,
    runtimeInstalled: fs.existsSync(path.join(locations.runtime, "node_modules", "@azure", "msal-node", "package.json")) &&
      fs.existsSync(path.join(locations.runtime, "node_modules", "@modelcontextprotocol", "sdk", "package.json")),
    credentialCachePresent: fs.existsSync(locations.cache),
    lastAuthenticationMethod: settings.lastAuthenticationMethod,
    supportedLoginMethods: ["authorization-code", "device-code"],
    oauthCallbackPort: OAUTH_CALLBACK_PORT,
    // A cache file is NOT proof of valid credentials, license, consent, or data access.
    authentication: "not_checked",
    lastToolDiscovery: discoveryMatchesSelection ? capabilities.observedAt || null : null,
    lastDiscoveredTools: discoveryMatchesSelection && Array.isArray(capabilities?.tools) ? capabilities.tools.map(t => t.name) : [],
    toolDiscoveryNeedsRefresh: Boolean(capabilities && !discoveryMatchesSelection),
    profile: locations.home,
    nextSteps: ["workiq install", "workiq login", "workiq enable --acknowledge-data-sharing", "workiq tools --live"].map(step =>
      `${fs.existsSync(path.resolve(import.meta.dirname, "../../.ccodex-dev-install.json"))
        ? "ccodex-dev" : "ccodex"} ${step}`),
  };
}
