import fs from "node:fs";
import { validateSpineOptions } from "../gateway/spine/config.mjs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { assertPrivateDesktopHome, prospectivePath } from "./desktop-runtime.mjs";

const idPattern = /^[a-z][a-z0-9-]{0,63}$/;
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
function keys(value, allowed, label) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) {
    throw new Error(`Invalid or unknown ${label} fields.`);
  }
}
function absolute(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error(`${label} must be an absolute path.`);
  return path.resolve(value);
}

/** No imports of account, provider configuration, or bridge startup code. */
export function resolveDesktopMode({
  arguments: input = [], inherited = process.env,
  legacyHome = inherited.CODEX_COPILOT_HOME || path.join(os.homedir(), ".codex-copilot"),
  defaultConfig = path.join(os.homedir(), ".mycodex", "config.json"),
} = {}) {
  const args = [];
  let configFile = inherited.CCODEX_DESKTOP_CONFIG || defaultConfig;
  let explicitConfig = Boolean(inherited.CCODEX_DESKTOP_CONFIG);
  let instanceId;
  let inspectOnly = false;
  let prepareOnly = false;
  let activate = false;
  const seen = new Set();
  for (let index = 0; index < input.length; index++) {
    const arg = input[index];
    if (arg === "--") { args.push(...input.slice(index + 1)); break; }
    const option = typeof arg === "string" && arg.split("=")[0];
    if (!["--config", "--instance", "--inspect-only", "--prepare-only", "--activate"].includes(option)) { args.push(arg); continue; }
    if (seen.has(option)) throw new Error(`Duplicate Desktop option: ${option}`);
    seen.add(option);
    if (["--inspect-only", "--prepare-only", "--activate"].includes(option)) {
      if (arg !== option) throw new Error(`${option} takes no value.`);
      if (option === "--inspect-only") inspectOnly = true;
      if (option === "--prepare-only") prepareOnly = true;
      if (option === "--activate") activate = true;
      continue;
    }
    const value = arg.includes("=") ? arg.slice(option.length + 1) : input[++index];
    if (typeof value !== "string" || !value || value.startsWith("--")) throw new Error(`${option} needs a value.`);
    if (option === "--config") { configFile = value; explicitConfig = true; }
    else instanceId = value;
  }
  configFile = path.resolve(configFile);
  if ([inspectOnly, prepareOnly, activate].filter(Boolean).length > 1) throw new Error("Inspect, prepare and activate are separate operations.");
  if (!fs.existsSync(configFile)) {
    if (explicitConfig || instanceId || prepareOnly || activate) throw new Error(`Desktop configuration not found: ${configFile}`);
    return { mode: "provider-bridge", id: null, generation: null, configFile: null,
      home: assertPrivateDesktopHome(legacyHome, { inherited }), arguments: args, inspectOnly };
  }
  const stat = fs.lstatSync(configFile);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) throw new Error("Desktop configuration must be a bounded regular file.");
  const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
  keys(config, ["configVersion", "defaultInstance", "instances"], "Desktop configuration");
  if (config.configVersion !== 1 || !Array.isArray(config.instances) || !config.instances.length || config.instances.length > 64) {
    throw new Error("Unsupported Desktop configuration version or instances.");
  }
  const ids = new Set();
  const homes = new Set();
  const instances = config.instances.map(instance => {
    keys(instance, ["id", "mode", "host", "profile", "desktopApp", "gateway"], "Desktop instance");
    if (typeof instance.id !== "string" || !idPattern.test(instance.id) || ids.has(instance.id)) throw new Error("Invalid or duplicate Desktop instance ID.");
    ids.add(instance.id);
    if (!["provider-bridge", "app-server-gateway"].includes(instance.mode)) throw new Error(`Unknown Desktop mode: ${instance.mode}`);
    if (instance.host !== undefined && !["current", "isolated"].includes(instance.host)) throw new Error("Unknown Desktop host.");
    if (instance.mode === "app-server-gateway" && instance.host === undefined) throw new Error("Gateway mode requires an explicit host: current or isolated; no Desktop profile was selected.");
    if (instance.host === "current" && (instance.mode !== "app-server-gateway" || instance.profile !== undefined || instance.desktopApp === undefined)) {
      throw new Error("Current host requires gateway mode and an explicit desktopApp, and cannot override the Desktop profile.");
    }
    const home = assertPrivateDesktopHome(instance.profile === undefined
      ? path.join(path.dirname(configFile), "instances", instance.id)
      : absolute(instance.profile, "profile"), { inherited });
    const resolved = prospectivePath(home);
    const normalized = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if ([...homes].some(other => other === normalized || other.startsWith(normalized + path.sep) || normalized.startsWith(other + path.sep))) {
      throw new Error("Desktop instances must have disjoint profiles.");
    }
    homes.add(normalized);
    if (instance.desktopApp !== undefined) absolute(instance.desktopApp, "desktopApp");
    if (instance.mode === "provider-bridge" && instance.gateway !== undefined) throw new Error("Provider mode cannot contain gateway configuration.");
    if (instance.mode === "app-server-gateway") {
      keys(instance.gateway, ["defaultEngine", "engines", "spine", "workbench"], "gateway");
      if (instance.gateway.workbench !== undefined && typeof instance.gateway.workbench !== "boolean") throw new Error("workbench must be a boolean.");
      if (instance.gateway.workbench === false && instance.gateway.spine !== undefined) throw new Error("A disabled workbench cannot configure Spine.");
      if (instance.gateway.spine !== undefined) {
        validateSpineOptions(instance.gateway.spine);
      }
      const nativeOnly = instance.host === "current" && instance.gateway.workbench === false && instance.gateway.defaultEngine === null;
      if (!Array.isArray(instance.gateway.engines) || (!nativeOnly && !instance.gateway.engines.length) || instance.gateway.engines.length > 32) throw new Error("Gateway engines are required.");
      if (nativeOnly && instance.gateway.engines.length) throw new Error("A native-only configuration cannot select external engines.");
      const engines = new Set();
      for (const engine of instance.gateway.engines) {
        keys(engine, ["id", "adapter", "executable", "sdkPath", "bridgeHome", "bridgePort", "cliHome", "harnessPath", "initialApprovalMode", "enabledModels"], "gateway engine");
        if (engine.enabledModels !== undefined && (!Array.isArray(engine.enabledModels) || engine.enabledModels.length > 64 ||
            new Set(engine.enabledModels).size !== engine.enabledModels.length || engine.enabledModels.some(model => typeof model !== "string" || !model || model.length > 256 || /\s|\0/.test(model))))
          throw new Error("enabledModels must contain distinct explicit model IDs.");
        if (typeof engine.id !== "string" || !idPattern.test(engine.id) || engines.has(engine.id)) throw new Error("Invalid or duplicate engine ID.");
        engines.add(engine.id);
        if (!["claude-code", "github-copilot", "codex-copilot", "gemini-cli", "codex-gemini", "antigravity-acp"].includes(engine.adapter)) throw new Error(`Unsupported engine adapter: ${engine.adapter}`);
        if (engine.initialApprovalMode !== undefined && (engine.adapter !== "claude-code" || !["ask", "auto", "deny"].includes(engine.initialApprovalMode)))
          throw new Error("An initial Claude approval mode must be ask, auto or deny.");
        if (engine.adapter === "antigravity-acp") {
          assertPrivateDesktopHome(absolute(engine.cliHome, "cliHome"), { inherited });
          absolute(engine.executable, "executable"); absolute(engine.harnessPath, "harnessPath");
          if (engine.sdkPath !== undefined || engine.bridgeHome !== undefined || engine.bridgePort !== undefined || ["codex-copilot", "codex-gemini"].includes(engine.id))
            throw new Error("Antigravity requires a separate subscription ACP engine, not a native provider.");
        } else if (engine.harnessPath !== undefined) throw new Error("harnessPath is only supported by the Antigravity adapter.");
        if (["gemini-cli", "codex-gemini"].includes(engine.adapter)) {
          assertPrivateDesktopHome(absolute(engine.cliHome, "cliHome"), { inherited });
          if (engine.bridgeHome !== undefined || (engine.adapter === "gemini-cli" && (engine.id === "codex-gemini" || engine.sdkPath !== undefined || engine.bridgePort !== undefined)) ||
              (engine.adapter === "codex-gemini" && (engine.id !== "codex-gemini" || instance.host !== "current" || engine.executable !== undefined)))
            throw new Error("Google account engines require separate CLI/native configuration.");
          if (engine.adapter === "gemini-cli") absolute(engine.executable, "executable");
          else {
            absolute(engine.sdkPath, "sdkPath");
            if (!Number.isInteger(engine.bridgePort) || engine.bridgePort < 1024 || engine.bridgePort > 65535) throw new Error("Invalid Google provider port.");
          }
        } else if (engine.adapter === "claude-code") {
          if (engine.cliHome !== undefined) {
            const claudeHome = assertPrivateDesktopHome(absolute(engine.cliHome, "cliHome"), { inherited });
            const original = path.join(os.homedir(), ".claude");
            if (claudeHome === original || claudeHome.startsWith(original + path.sep)) throw new Error("Use an isolated Claude API profile, not the original Claude profile.");
          }
          if (engine.id === "codex-gemini") throw new Error("Google provider settings require a Google adapter.");
        } else if ((engine.cliHome !== undefined && engine.adapter !== "antigravity-acp") || engine.id === "codex-gemini") throw new Error("Google provider settings require a Google adapter.");
        if (engine.adapter === "codex-copilot") {
          if (engine.id !== "codex-copilot" || instance.host !== "current" || engine.sdkPath !== undefined || engine.executable !== undefined)
            throw new Error("Codex + Copilot requires the current native host and its reserved engine ID.");
          assertPrivateDesktopHome(absolute(engine.bridgeHome, "bridgeHome"), { inherited });
          if (!Number.isInteger(engine.bridgePort) || engine.bridgePort < 1024 || engine.bridgePort > 65535) throw new Error("Invalid Copilot bridge port.");
        } else if (engine.id === "codex-copilot" || engine.bridgeHome !== undefined || (engine.bridgePort !== undefined && engine.adapter !== "codex-gemini"))
          throw new Error("Copilot provider settings require the codex-copilot adapter.");
        for (const field of ["executable", "sdkPath"]) if (engine[field] !== undefined) absolute(engine[field], field);
      }
      if (!nativeOnly && !engines.has(instance.gateway.defaultEngine)) throw new Error("Gateway defaultEngine must reference a configured engine.");
    }
    return { ...instance, home };
  });
  if (!ids.has(config.defaultInstance)) throw new Error("defaultInstance must reference a configured instance.");
  const selected = instances.find(instance => instance.id === (instanceId || config.defaultInstance));
  if (!selected) throw new Error(`Unknown Desktop instance: ${instanceId}`);
  if ((prepareOnly || activate) && selected.host !== "current") throw new Error("Prepare/activate options require the current Desktop host.");
  const generation = createHash("sha256").update(JSON.stringify(selected)).digest("hex");
  return { ...selected, generation, configFile, arguments: args, inspectOnly, prepareOnly, activate };
}

/** Called under the existing per-profile launch lock; mode changes need a new profile. */
export function bindDesktopMode(selection) {
  if (!selection.id) return;
  const file = path.join(selection.home, "desktop-mode.json");
  const expected = { schemaVersion: 1, id: selection.id, mode: selection.mode };
  if (fs.existsSync(file)) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096 ||
        JSON.stringify(JSON.parse(fs.readFileSync(file, "utf8"))) !== JSON.stringify(expected)) {
      throw new Error("This Desktop profile is already bound to another instance or mode.");
    }
    return;
  }
  if (selection.mode === "app-server-gateway" && ["config.toml", "github-auth.json", "desktop-instance.json"].some(name => fs.existsSync(path.join(selection.home, name)))) {
    throw new Error("Gateway mode requires a fresh profile; an existing provider profile cannot be reused.");
  }
  fs.writeFileSync(file, JSON.stringify(expected), { flag: "wx", mode: 0o600 });
}
