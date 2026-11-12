import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolveDesktopMode } from "../bridge/desktop-mode.mjs";
import { validateClaudeApiProfile, writeClaudeApiProfile, readClaudeApiProfile, claudeApiEnvironment } from "../gateway/claude-api-profile.mjs";
import { cliEnvironment } from "../gateway/engines/index.mjs";

const root = path.resolve(import.meta.dirname, "..");
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
function atomic(file, bytes, mode = 0o600) {
  if (fs.existsSync(file) && (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink())) throw new Error("Configuration must be a regular file.");
  const pending = `${file}.${process.pid}.pending`;
  try { fs.writeFileSync(pending, bytes, { flag: "wx", mode }); fs.renameSync(pending, file); }
  finally { fs.rmSync(pending, { force: true }); }
}
function parameters(args) {
  const command = args.shift() ?? "prepare", options = {};
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i];
    if (!["--config", "--instance", "--sdk-path", "--profile", "--engine", "--base-url", "--model", "--api-key-env", "--initial-approval"].includes(name) || options[name] !== undefined || !args[i + 1]) throw new Error("Unknown, duplicate or incomplete option.");
    options[name] = args[i + 1];
  }
  if (!["prepare", "configure", "status", "check"].includes(command)) throw new Error("Use prepare, configure, status or check.");
  const configFile = path.resolve(options["--config"] ?? path.join(os.homedir(), ".mycodex/development/ccodex-current-mac.json"));
  const selection = resolveDesktopMode({ arguments: ["--config", configFile, ...(options["--instance"] ? ["--instance", options["--instance"]] : [])], inherited: process.env });
  if (selection.mode !== "app-server-gateway") throw new Error("Claude requires an existing gateway instance.");
  const engineId = options["--engine"] ?? "claude";
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(engineId) || ["codex-copilot", "codex-gemini"].includes(engineId)) throw new Error("Invalid Claude engine ID.");
  const currentEngine = selection.gateway.engines.find(e => e.id === engineId);
  if (currentEngine && currentEngine.adapter !== "claude-code") throw new Error("The engine ID belongs to another configuration.");
  const initialApprovalMode = options["--initial-approval"] ?? currentEngine?.initialApprovalMode ?? "ask";
  if (!["ask", "auto", "deny"].includes(initialApprovalMode)) throw new Error("Choose ask, auto or deny for the initial approval mode.");
  const profile = path.resolve(options["--profile"] ?? currentEngine?.cliHome ?? path.join(selection.home, "engines", engineId));
  if (currentEngine?.cliHome && currentEngine.cliHome !== profile) throw new Error("The engine already belongs to a different Claude profile.");
  const original = path.join(os.homedir(), ".claude");
  if (profile === original || profile.startsWith(original + path.sep) || profile.startsWith(root + path.sep)) throw new Error("Choose an isolated profile outside the source checkout and original Claude profile.");
  const sdkPath = path.resolve(options["--sdk-path"] ?? currentEngine?.sdkPath ?? path.join(os.homedir(), ".cache/ccodex-development/gateway-sdk/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs"));
  if (!fs.statSync(sdkPath).isFile()) throw new Error("Install the official Claude Agent SDK and pass --sdk-path.");
  const previous = fs.existsSync(path.join(profile, "credentials.json")) && ["configure", "prepare"].includes(command)
    ? readClaudeApiProfile(profile).profile : {};
  const settings = validateClaudeApiProfile({ schemaVersion: 1, ...previous,
    ...(options["--base-url"] ? { baseUrl: options["--base-url"] } : {}), ...(options["--model"] ? { model: options["--model"] } : {}) });
  return { command, options, selection, configFile, engineId, profile, sdkPath, settings, initialApprovalMode, executable: currentEngine?.executable };
}
export async function configureClaude(args) {
  const p = parameters([...args]), { command, options, selection, configFile, engineId, profile, sdkPath, settings, initialApprovalMode, executable } = p;
  if (command === "prepare") {
    fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(profile);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== "win32" && (stat.uid !== process.getuid() || (stat.mode & 0o077)))) throw new Error("Claude profile must be private and owned.");
    const launcher = path.join(selection.home, "configure-claude");
    const argv = ["--config", configFile,
      "--instance", selection.id, "--engine", engineId, "--profile", profile, "--sdk-path", sdkPath, "--initial-approval", initialApprovalMode,
      ...(settings.baseUrl ? ["--base-url", settings.baseUrl] : []), ...(settings.model ? ["--model", settings.model] : [])];
    if (fs.existsSync(launcher) && !fs.readFileSync(launcher, "utf8").startsWith("#!/bin/sh\n# MyCodex Claude API setup")) throw new Error("The setup launcher belongs to another task.");
    atomic(launcher, '#!/bin/sh\n# MyCodex Claude API setup v1\nclaude_setup_action=configure\ncase "${1-}" in check|status) claude_setup_action="$1"; shift;; esac\nexec '
      + [process.execPath, path.join(root, "tools/configure-claude.mjs")].map(quote).join(" ") + ' "$claude_setup_action" ' + argv.map(quote).join(" ") + ' "$@"\n', 0o700);
    return { prepared: true, launcher, profile, engineId, credentialEntered: false, desktopConfigurationChanged: false };
  }
  if (command === "status") {
    let configured = false, details;
    try { const account = readClaudeApiProfile(profile); configured = true; details = { baseUrl: account.profile.baseUrl ?? "https://api.anthropic.com", model: account.profile.model ?? null }; } catch {}
    return { configured, engineId, profile, ...details, accountInferenceVerified: null, accountCheck: "not_performed_by_status" };
  }
  if (command === "check") {
    const account = readClaudeApiProfile(profile), temporary = fs.mkdtempSync(path.join(os.tmpdir(), "cc-claude-check-"));
    let query, release, timer;
    try {
      writeClaudeApiProfile(temporary, account.profile, account.apiKey);
      const sdk = await import(pathToFileURL(sdkPath).href), env = claudeApiEnvironment(temporary, cliEnvironment());
      const hold = new Promise(resolve => { release = resolve; });
      const discovery = new AbortController();timer = setTimeout(() => discovery.abort(), 30000);
      query = sdk.query({ prompt: (async function* () { await hold; })(), options: { env, ...(executable ? { pathToClaudeCodeExecutable: executable } : {}), cwd: temporary, settingSources: [], persistSession: false, abortController: discovery, stderr() {} } });
      const models = await query.supportedModels(), auth = await query.accountInfo();
      clearTimeout(timer);release(); query.close(); await query.return?.();
      if (auth.apiKeySource !== "ANTHROPIC_API_KEY") throw new Error("Claude did not select the configured API key.");
      const model = options["--model"] ?? account.profile.model ?? models[0]?.value; if (!model) throw new Error("No native Claude models were advertised.");
      const abortController = new AbortController(); timer = setTimeout(() => abortController.abort(), 90000);
      query = sdk.query({ prompt: "Reply exactly CLAUDE_API_OK. Do not use any tools, files, shell, search, or agents.",
        options: { env, model, ...(executable ? { pathToClaudeCodeExecutable: executable } : {}), cwd: temporary, settingSources: [], persistSession: false, tools: [], maxTurns: 1, abortController, stderr() {} } });
      let completed = false;
      for await (const event of query) if (event.type === "result") {
        if (event.is_error || event.subtype !== "success") {
          const detail = event.errors?.filter(value => typeof value === "string").join("\n") || (typeof event.result === "string" ? event.result : "");
          throw new Error(detail || "The configured key or model did not complete inference.");
        }
        completed = event.result?.trim() === "CLAUDE_API_OK";
      }
      if (!completed) throw new Error("Claude account check did not return the expected completed response.");
      return { accountInferenceVerified: true, apiKeySource: auth.apiKeySource, model, temporaryProfile: true };
    } catch (error) {
      let message = error instanceof Error ? error.message : "Claude check failed.";
      for (const secret of new Set([account.apiKey, encodeURIComponent(account.apiKey), JSON.stringify(account.apiKey).slice(1, -1)]))
        message = message.split(secret).join("[redacted]");
      throw Object.assign(new Error(message), { publicMessage: message });
    }
    finally {
      clearTimeout(timer); release?.();
      try { query?.close(); await query?.return?.(); } catch { /* No SDK error may echo a credential during cleanup. */ }
      await fs.promises.rm(temporary, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 });
    }
  }
  fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
  if (options["--api-key-env"]) {
    const variable = options["--api-key-env"];
    if (!/^[A-Z_][A-Z0-9_]*$/.test(variable) || !process.env[variable]) throw new Error("The selected API key environment variable is empty.");
    writeClaudeApiProfile(profile, settings, process.env[variable]);
  } else {
    if (!process.stdin.isTTY || !process.stderr.isTTY) throw new Error("Run the prepared launcher in your local terminal for hidden key input; do not paste a key into chat.");
    console.error("Claude API 服务地址：" + (settings.baseUrl ?? "https://api.anthropic.com"));
    const child = spawnSync(process.platform === "win32" ? "python" : "/usr/bin/python3", [path.join(root, "tools/claude-api-key.py"), profile, JSON.stringify(settings)], { stdio: "inherit" });
    if (child.status !== 0) throw new Error("API key entry was cancelled or failed; no engine configuration was changed.");
  }
  readClaudeApiProfile(profile);
  // Reload after interactive input to preserve concurrent, unrelated edits.
  const current = fs.readFileSync(configFile, "utf8"), config = JSON.parse(current);
  const instance = config.instances.find(item => item.id === selection.id);
  const existing = instance.gateway.engines.find(item => item.id === engineId);
  if (existing && (existing.adapter !== "claude-code" || (existing.cliHome && existing.cliHome !== profile))) throw new Error("The engine ID belongs to another configuration.");
  const engine = { id: engineId, adapter: "claude-code", sdkPath, cliHome: profile, initialApprovalMode };
  const topologyChanged = !existing || Object.entries(engine).some(([key, value]) => existing[key] !== value);
  if (existing) Object.assign(existing, engine); else instance.gateway.engines.push(engine);
  // The strict existing decoder validates a candidate without touching the live config.
  const candidate = `${configFile}.${process.pid}.candidate`;
  try {
    fs.writeFileSync(candidate, JSON.stringify(config), { flag: "wx", mode: 0o600 });
    resolveDesktopMode({ arguments: ["--config", candidate, "--instance", selection.id], inherited: process.env });
  } finally { fs.rmSync(candidate, { force: true }); }
  if (fs.readFileSync(configFile, "utf8") !== current) throw new Error("Desktop configuration changed concurrently; the key was saved, but the engine was not attached. Run configure again.");
  atomic(configFile, JSON.stringify(config, null, 2) + "\n");
  return { configured: true, engineId, profile, baseUrl: settings.baseUrl ?? "https://api.anthropic.com", model: settings.model ?? null,
    accountInferenceVerified: false, existingDesktopProcessesRestarted: false,
    restartRequiredForNewEngine: topologyChanged,
    nextStep: topologyChanged ? "Run the check command to validate the real account. The added engine loads after a normal coordinated client restart; active chats were preserved."
      : "The updated key is read by the next Claude request. Run the check command to validate the real account; active queries were preserved." };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await configureClaude(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(error?.publicMessage ?? "Claude configuration/check did not finish. Verify the non-secret paths and provider settings locally; no API key was displayed. For hidden key entry, run the prepared launcher in a terminal."); process.exitCode = 1; }
}
