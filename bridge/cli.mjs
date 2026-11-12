import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { CODEX_COPILOT_HOME, authMode, logout, resolveToken } from "./auth.mjs";
import { buildCatalog, fetchCopilotModels, formatContextTokens, plainName } from "./catalog.mjs";
import { CATALOG_FILE, writeCatalogSnapshot } from "./catalog-store.mjs";
import { bridgeHealth, stopBridge } from "./control.mjs";
import { openSystemBrowser } from "./desktop-actions.mjs";
import { selectedBridgePort } from "./port-selection.mjs";
import { chooseConfiguredModel } from "./model-selection.mjs";
import { credentialRecoveryHint, formatCredentialDiagnostic } from "./doctor-diagnostics.mjs";
import { fetchCopilotAccount, quotaSnapshotText } from "./copilot-account.mjs";
import { publishAccountSnapshot } from "./account-store.mjs";
import * as autostart from "./autostart.mjs";
import * as useModel from "./use-model.mjs";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const CLI_COMMAND = fs.existsSync(path.join(ROOT, ".ccodex-dev-install.json"))
  ? "ccodex-dev" : "ccodex";
const ENSURE_BRIDGE = path.join(ROOT, "bridge", "ensure.mjs");
const BRIDGE_PORT = selectedBridgePort({ home: CODEX_COPILOT_HOME });
const BRIDGE_ENDPOINT = `http://127.0.0.1:${BRIDGE_PORT}`;
const SETTINGS_SURFACE = process.env.CODEX_COPILOT_SURFACE === "cli" ? "cli" : "desktop";

function usage() {
  process.stdout.write(
    [
      `${CLI_COMMAND} bridge helper`,
      "",
      "  login              Sign in to GitHub with the device flow",
      "  logout             Forget the saved GitHub token",
      "  status             Show the account and Copilot entitlement in use",
      "  account switch     Sign in with a different GitHub account",
      "  models             List the Copilot models exposed to Codex",
      "  use <model> [eff] [context]",
      "                     Make a model, reasoning effort and context tier the default",
      "  context [tier]     Show or change the current default/long_context tier",
      "  credits [--watch]  Verified AI credits; dynamic TTY or static ASCII/JSON",
      "  usage [--json]     Fetch current Copilot usage (also /usage in the CLI)",
      "  sessions <command> Bulk session list, archive, restore and permanent delete (/sessions)",
      "  catalog            Regenerate the Codex model catalog",
      "  doctor             Diagnose installation, account and catalog health",
      "  workiq <command>   Microsoft 365 enterprise tools shared by CLI and Desktop",
      "  history <command>  Local batch session list, preview, apply and Desktop UI",
      "  verify             Show the latest redacted effective upstream request",
      "  export [archive]   Create a credential-free transfer bundle",
      "  autostart on|off   Start the bridge automatically at login",
      "",
    ].join("\n")
  );
}

async function regenerateCatalog(record) {
  const list = await fetchCopilotModels(record.oauth_token, {
    force: true,
    login: record.login,
  });
  const catalog = buildCatalog(list);
  if (catalog.models.length === 0) {
    throw new Error(
      "GitHub returned no Codex-compatible Copilot models. Check the account entitlement and enabled model policies."
    );
  }
  fs.mkdirSync(CODEX_COPILOT_HOME, { recursive: true });
  const published = writeCatalogSnapshot(catalog);
  if (published.changed && !published.cacheInvalidated) {
    process.stderr.write(
      "Catalog changed, but Codex's models_cache.json could not be removed; live clients may refresh on their normal timer.\n"
    );
  }
  const selected = chooseConfiguredModel(catalog, list);
  return { catalog, selected };
}

async function printStatus() {
  const record = await resolveToken();
  if (!record) {
    process.stdout.write(`Not signed in. Run \`${CLI_COMMAND} login\`.\n`);
    process.exitCode = 1;
    return null;
  }
  const liveModels = await fetchCopilotModels(record.oauth_token, {
    login: record.login,
  });
  const catalog = buildCatalog(liveModels);
  const usable = new Set(catalog.models.map((model) => model.copilot?.base_model || model.slug)).size;
  const details = await fetchCopilotAccount({ token: record.oauth_token, login: record.login });
  publishAccountSnapshot({
    login: record.login, source: record.source, models: catalog.models.length,
    returnedModels: liveModels.length, selectedModel: chooseConfiguredModel(catalog, liveModels),
    ...details,
  });
  const quotas = details.quota.snapshots.map(snapshot =>
    `${snapshot.label.padEnd(15)}: ${quotaSnapshotText(snapshot)}`);
  process.stdout.write(
    [
      `GitHub account : ${record.login || "(unknown)"}`,
      `Account name   : ${details.profile.name || record.login || "(unknown)"}`,
      `Copilot plan   : ${details.plan || "(not reported)"}`,
      ...quotas,
      ...(quotas.length ? [] : [`Copilot quota  : unavailable (${details.quota.reason || "not reported"})`]),
      ...(details.quota.resetAt ? [`Quota resets   : ${details.quota.resetAt}`] : []),
      `Quota checked  : ${details.quota.updatedAt}`,
      `Credential     : ${record.source}`,
      `Auth mode      : ${authMode()}`,
      `Copilot models : ${usable} usable / ${liveModels.length} returned`,
      `Codex home     : ${CODEX_COPILOT_HOME}`,
      `Autostart      : ${autostart.isEnabled() ? "on (starts at login)" : "off (starts on demand)"}`,
      "",
    ].join("\n")
  );
  return record;
}

export async function signIn({ force = false, login = null, onProgress, signal } = {}) {
  const existing = await resolveToken();
  if (existing && !force && !login) {
    process.stdout.write(
      `Already signed in as ${existing.login || "(unknown)"} (${existing.source}).\nUse \`${CLI_COMMAND} login --force\` to sign in with a different account.\n`
    );
    return existing;
  }
  try {
    execFileSync(process.execPath, [ENSURE_BRIDGE], {
      cwd: ROOT,
      env: { ...process.env, CODEX_COPILOT_HOME },
      stdio: "ignore",
      windowsHide: true,
      timeout: 30000,
    });
  } catch {
    throw new Error("The account bridge could not start.");
  }

  const accountRequest = async (route, options = {}) => {
    const response = await fetch(BRIDGE_ENDPOINT + route, {
      ...options,
      signal: AbortSignal.timeout(20000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body.error || `Account request failed: HTTP ${response.status}`);
    }
    return body;
  };

  let state = await accountRequest("/account/switch", {
    method: "POST",
    ...(login ? {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ login }),
    } : {}),
  });
  let announcedCode = null;
  let interrupted = false;
  const onInterrupt = () => {
    interrupted = true;
  };
  process.once("SIGINT", onInterrupt);
  try {
    for (;;) {
      if (interrupted || signal?.aborted) {
        await accountRequest(`/account/switch/${state.id}/cancel`, { method: "POST" }).catch(
          () => {},
        );
        process.exitCode = 130;
        return null;
      }
      if (state.userCode && state.userCode !== announcedCode) {
        announcedCode = state.userCode;
        onProgress?.({
          userCode: state.userCode, verificationUri: state.verificationUri,
          verificationUriComplete: state.verificationUriComplete,
        });
        const verificationUri =
          state.verificationUriComplete || state.verificationUri;
        if (
          process.env.CODEX_COPILOT_NO_BROWSER !== "1" &&
          verificationUri
        ) {
          try {
            openSystemBrowser(verificationUri);
          } catch {
            /* Keep the printed URL as the fallback. */
          }
        }
        process.stdout.write(
          `\n  Open ${state.verificationUri}\n  Enter code: ${state.userCode}\n\nWaiting for GitHub authorization...\n`,
        );
      }
      if (state.status === "complete") break;
      if (state.status === "error" || state.status === "cancelled") {
        throw new Error(state.error || `Account switch ${state.status}.`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
      state = await accountRequest(`/account/switch/${state.id}`);
    }
  } finally {
    process.removeListener("SIGINT", onInterrupt);
  }

  process.stdout.write(
    `\nSigned in as ${state.login || "(unknown)"}; wrote ${state.models || 0} models.\n` +
      `${CLI_COMMAND} CLI and its own Desktop share this bridge account; other installations are unchanged.\n`,
  );
  return state;
}

async function doctor() {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  add(
    "platform",
    ["win32", "darwin", "linux"].includes(process.platform),
    `${process.platform}-${process.arch}`,
  );
  add("config", fs.existsSync(useModel.CONFIG_FILE), useModel.CONFIG_FILE);

  let catalog = [];
  try {
    catalog = JSON.parse(fs.readFileSync(CATALOG_FILE, "utf8")).models || [];
    add("catalog", catalog.length > 0, `${catalog.length} models`);
  } catch (error) {
    add("catalog", false, error.message);
  }

  let current = null;
  try {
    current = useModel.current().model;
    add("selected model", Boolean(current && catalog.some((model) => model.slug === current)), current || "(unset)");
  } catch (error) {
    add("selected model", false, error.message);
  }

  const authDiagnostics = [];
  let record = null;
  try {
    record = await resolveToken({ diagnostics: authDiagnostics });
  } catch {
    // Auth resolution keeps its original error propagation for other callers.
    // Doctor reports only classified diagnostics, never a raw secret-bearing
    // provider or filesystem exception.
    if (!authDiagnostics.length) authDiagnostics.push({ category: "unknown" });
  }
  add(
    "credential",
    Boolean(record),
    record ? `${record.login || "(unknown)"} via ${record.source}`
      : formatCredentialDiagnostic(authDiagnostics)
  );
  if (record) {
    try {
      // Resolution already sampled the provider. Use that same fresh result,
      // not a second request batch or the stabilized on-disk model history.
      const liveModels = record.validatedModels;
      if (!Array.isArray(liveModels)) throw new Error("fresh validation result unavailable");
      const liveCatalog = buildCatalog(liveModels);
      add(
        "live models",
        liveCatalog.models.length === catalog.length,
        `${liveCatalog.models.length} eligible / ${liveModels.length} returned; ${catalog.length} cached`
      );
    } catch {
      add("live models", false, "validated model catalog could not be built");
    }
  }

  const health = await bridgeHealth();
  add("bridge", true, health ? `running (pid ${health.pid})` : "stopped (starts on demand)");

  for (const check of checks) {
    process.stdout.write(`${check.ok ? "OK" : "FAIL"}  ${check.name}: ${check.detail}\n`);
  }
  const failed = checks.filter((check) => !check.ok);
  if (failed.length) {
    process.exitCode = 1;
    process.stdout.write("\n" + (!record
      ? credentialRecoveryHint(authDiagnostics)
      : "Inspect the failed profile/catalog check; a healthy running bridge is not proof of current cold validation.")
      + "\n");
  }
}

function exportBundle() {
  const requested = process.argv.slice(3).find((argument) => !argument.startsWith("-"));
  if (process.platform !== "win32") {
    const script = path.join(ROOT, "tools", "export-bundle.mjs");
    const args = [script];
    if (requested) args.push(requested);
    if (process.argv.includes("--force")) args.push("--force");
    execFileSync(process.execPath, args, {
      stdio: "inherit",
      windowsHide: true,
    });
    return;
  }
  const output = path.resolve(
    requested || path.join(process.cwd(), `codex-copilot-transfer-${new Date().toISOString().slice(0, 10)}.zip`)
  );
  const script = path.join(ROOT, "tools", "New-TransferBundle.ps1");
  const target = process.arch === "arm64" ? "windows-arm64" : "windows-x64";
  const args = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    script,
    "-OutputPath",
    output,
    "-Target",
    target,
  ];
  if (process.argv.includes("--force")) args.push("-Force");
  execFileSync("powershell.exe", args, { stdio: "inherit", windowsHide: true });
}

async function main() {
  const command = process.argv[2] || "status";

  if (command === "sessions") {
    const { runSessions } = await import("./sessions-cli.mjs");
    await runSessions(process.argv.slice(3), { home: CODEX_COPILOT_HOME, port: BRIDGE_PORT });
    return;
  }

  if (command === "usage") {
    const { runUsage } = await import("./usage-cli.mjs");
    await runUsage(process.argv.slice(3), { endpoint: BRIDGE_ENDPOINT });
    return;
  }

  if (command === "credits") {
    execFileSync(process.execPath, [ENSURE_BRIDGE], { cwd: ROOT,
      env: { ...process.env, CODEX_COPILOT_HOME }, windowsHide: true, stdio: "ignore", timeout: 30000 });
    const { runCredits } = await import("./credits-cli.mjs");
    await runCredits(process.argv.slice(3), { endpoint: BRIDGE_ENDPOINT });
    return;
  }

  if (command === "history") {
    const { runHistory } = await import("../tools/history/cli.mjs");
    const args = process.argv.slice(3);
    if (!args.includes("--product")) args.push("--product", "ccodex");
    await runHistory(args);
    return;
  }

  if (command === "workiq") {
    const { runWorkIq } = await import("./workiq/main.mjs");
    await runWorkIq(process.argv.slice(3));
    return;
  }

  if (command === "login") {
    await signIn({ force: process.argv.includes("--force") });
    return;
  }

  if (command === "logout") {
    await stopBridge({ quiet: true });
    process.stdout.write(
      logout()
        ? "Saved device-flow credential removed. Auto mode may still use Windows Credential Manager.\n"
        : "No saved device-flow credential.\n"
    );
    return;
  }

  if (command === "account") {
    const subcommand = (process.argv[3] || "show").toLowerCase();
    if (subcommand === "show" || subcommand === "status") {
      await printStatus();
      return;
    }
    if (subcommand === "switch" || subcommand === "use") {
      const targetLogin = process.argv[4] && !process.argv[4].startsWith("-") ? process.argv[4] : null;
      await signIn({ force: true, login: targetLogin });
      return;
    }
    throw new Error(`Usage: ${CLI_COMMAND} account [show|switch [login]]`);
  }

  if (command === "use") {
    const slug = process.argv[3];
    if (!slug) {
      const now = useModel.current({ surface: SETTINGS_SURFACE });
      process.stdout.write(
        `Current model: ${now.baseModel || "(unset)"}${now.effort ? ` (${now.effort})` : ""}, context=${now.contextTier}` +
          `${now.contextWindow ? ` (${formatContextTokens(now.contextWindow)})` : ""}\n` +
          `Usage: ${CLI_COMMAND} use <model> [reasoning-effort] [default|long_context]\n`
      );
      return;
    }
    const fourth = process.argv[4];
    const fifth = process.argv[5];
    const fourthIsContext = /^(default|long(?:-|_)context|long)$/i.test(fourth || "");
    const result = useModel.use(
      slug,
      fourthIsContext ? undefined : fourth,
      fourthIsContext ? fourth : fifth,
      { surface: SETTINGS_SURFACE },
    );
    process.stdout.write(
      `Default model is now ${result.display} (${result.baseModel}${result.effort ? `, ${result.effort}` : ""}, context=${result.contextTier}) via ${result.route === "responses" ? "the native Responses API" : "the chat adapter"}.\n` +
        `Only ${SETTINGS_SURFACE === "cli" ? `${CLI_COMMAND} CLI` : "Desktop"} defaults changed. Start a new conversation to pick them up.\n`
    );
    return;
  }

  if (command === "context") {
    const now = useModel.current({ surface: SETTINGS_SURFACE });
    const tier = process.argv[3];
    if (!tier) {
      process.stdout.write(
        `Current context: ${now.contextTier}${now.contextWindow ? ` (${formatContextTokens(now.contextWindow)} total)` : ""}\n` +
          `Usage: ${CLI_COMMAND} context <default|long_context>\n`
      );
      return;
    }
    if (!now.baseModel) throw new Error("No model is selected.");
    const result = useModel.use(now.baseModel, now.effort, tier, { surface: SETTINGS_SURFACE });
    process.stdout.write(
      `Default context is now ${result.contextTier} for ${result.baseModel}` +
        `${result.contextWindow ? ` (${formatContextTokens(result.contextWindow)} total)` : ""}.\n` +
        "Restart Codex (Copilot) or start a new conversation to pick it up.\n"
    );
    return;
  }

  if (command === "autostart") {
    const arg = (process.argv[3] || "").toLowerCase();
    if (arg === "on" || arg === "enable") {
      process.stdout.write(`Bridge autostart enabled:\n  ${autostart.enable()}\n`);
      return;
    }
    if (arg === "off" || arg === "disable") {
      process.stdout.write(autostart.disable() ? "Bridge autostart disabled.\n" : "Bridge autostart was not enabled.\n");
      return;
    }
    process.stdout.write(
      `Bridge autostart is ${autostart.isEnabled() ? "ON" : "OFF"}.\nUse \`${CLI_COMMAND} autostart on\` or \`${CLI_COMMAND} autostart off\`.\n`
    );
    return;
  }

  if (command === "status") {
    await printStatus();
    return;
  }

  if (command === "models" || command === "catalog") {
    const sub = (process.argv[3] || "").toLowerCase();
    if (command === "models" && (sub === "enable" || sub === "disable")) {
      const modelId = process.argv[4];
      if (!modelId) {
        throw new Error(`Usage: ${CLI_COMMAND} models ${sub} <model-id>`);
      }
      execFileSync(process.execPath, [ENSURE_BRIDGE], {
        cwd: ROOT,
        env: { ...process.env, CODEX_COPILOT_HOME },
        stdio: "ignore",
        windowsHide: true,
        timeout: 30000,
      });
      const res = await fetch(`${BRIDGE_ENDPOINT}/models/policy`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: modelId, state: sub === "enable" ? "enabled" : "disabled" }),
        signal: AbortSignal.timeout(30000),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Failed to ${sub} model ${modelId}: HTTP ${res.status}`);
      process.stdout.write(
        `Model '${modelId}' is now ${body.state} (${body.models} models active; catalogGeneration=${String(body.catalogGeneration || "").slice(0, 12)}).\n`
      );
      return;
    }
    const record = await resolveToken();
    if (!record) {
      process.stdout.write(`Not signed in. Run \`${CLI_COMMAND} login\`.\n`);
      process.exitCode = 1;
      return;
    }
    const { catalog, selected } = await regenerateCatalog(record);
    if (command === "catalog") {
      process.stdout.write(
        `Wrote ${catalog.models.length} models to ${CATALOG_FILE}${selected ? ` (selected ${selected})` : ""}\n`
      );
      return;
    }
    if (catalog.models.length === 0) {
      process.stdout.write("No compatible Copilot models are enabled for this account.\n");
      process.exitCode = 1;
      return;
    }
    const width = Math.max(...catalog.models.map((m) => m.slug.length));
    const nameWidth = Math.max(...catalog.models.map((m) => plainName(m.display_name).length));
    const active = useModel.current().model;
    process.stdout.write(`Models available to Codex through GitHub Copilot (${catalog.models.length}):\n\n`);
    for (const m of catalog.models) {
      const efforts = (m.supported_reasoning_levels || []).map((l) => l.effort).join("/");
      const contexts = [
        formatContextTokens(m.copilot.default_context_window_tokens),
        m.copilot.long_context_window_tokens
          ? formatContextTokens(m.copilot.long_context_window_tokens)
          : null,
      ]
        .filter(Boolean)
        .join("/");
      process.stdout.write(
        `  ${m.slug === active ? "*" : " "} ${m.slug.padEnd(width)}  ${plainName(m.display_name).padEnd(nameWidth)}  ` +
          `${m.copilot.route === "responses" ? "responses (native)" : "chat (adapted)  "}  ` +
          `context=${contexts.padEnd(12)}  ${efforts}\n`
      );
    }
    process.stdout.write(
      `\n  * = current default. Switch with \`${CLI_COMMAND} use <model> [effort] [default|long_context]\`.\n\n`
    );
    return;
  }

  if (command === "doctor") {
    await doctor();
    return;
  }

  if (command === "verify" || command === "inspect-request") {
    const response = await fetch(`${BRIDGE_ENDPOINT}/diagnostics/effective`);
    const audit = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(
        audit.error === "no_audited_request"
          ? "No audited request exists yet. Send one prompt through ccodex, then run this command again."
          : `Request diagnostics failed: HTTP ${response.status}`,
      );
    }
    const usage = audit.usage || {};
    const cached = Number(
      usage.input_tokens_details?.cached_tokens ??
        usage.prompt_tokens_details?.cached_tokens ??
        usage.cache_read_input_tokens ??
        0,
    );
    const input = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0);
    const hitRate = input + cached > 0 ? `${((cached / (input + cached)) * 100).toFixed(1)}%` : "not supplied";
    process.stdout.write([
      `Audit id       : ${audit.id}`,
      `Completed      : ${audit.completedAt || audit.startedAt}`,
      `Surface        : ${audit.surface}`,
      `GitHub account : ${audit.account || "(unknown)"}`,
      `Model          : ${audit.requestedModel} -> ${audit.upstreamModel}`,
      `Endpoint       : ${audit.endpoint}`,
      `Context        : ${audit.contextTier} (${audit.effectiveContextWindow || "not supplied"} prompt tokens)`,
      `Effort         : ${audit.serializedEffort || "not supplied"}${audit.serializedEffortPath ? ` at ${audit.serializedEffortPath}` : ""}`,
      `Provider IDs   : ${audit.providerRequestId || "not supplied"} / ${audit.serviceRequestId || "not supplied"}`,
      `Usage          : input=${usage.input_tokens ?? usage.prompt_tokens ?? "not supplied"} output=${usage.output_tokens ?? usage.completion_tokens ?? "not supplied"}`,
      `Cache hit      : ${hitRate}`,
      "",
      "The audit intentionally excludes prompts, messages, tools, image bytes, and credentials.",
      "",
    ].join("\n"));
    return;
  }

  if (command === "export") {
    exportBundle();
    return;
  }

  if (command === "release-update") {
    const { runReleaseUpdateCli } = await import("./release-update.mjs");
    await runReleaseUpdateCli(process.argv.slice(3), { home: CODEX_COPILOT_HOME });
    return;
  }

  usage();
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
