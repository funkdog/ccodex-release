/**
 * Read-only smoke test through the installed official node_repl MCP host.
 * No helper protocol, browser profile, app permissions or real session is edited.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { nativeLaunch } from "../bridge/native-mcp-relay.mjs";
import { atomicWrite } from "../bridge/workiq/settings.mjs";

const [sourceHome, reportFile, capture] = process.argv.slice(2);
if (!sourceHome || !reportFile) throw new Error("Usage: Test-NativeChannel.mjs <source-profile> <report.json>");
if (process.env.CARGO_BUILD_JOBS !== "6") throw new Error("Run through run-heavy-build.ps1.");
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-native-channel-"));
const report = { startedAt: new Date().toISOString(), isolatedProfile: profile, actions: "read-only", noFormChanges: true };
let child;
let closed;
const pending = new Map();
let nextId = 0;
let errors = "";
try {
  const launch = nativeLaunch(sourceHome);
  const env = { ...launch.env, CODEX_HOME: profile, CODEX_COPILOT_HOME: profile };
  for (const key of Object.keys(env)) {
    if (/(?:^|_)(?:TOKEN|SECRET|PASSWORD|API_KEY)(?:$|_)/i.test(key)) delete env[key];
  }
  env.NODE_REPL_TRUSTED_CODE_PATHS = [profile, env.NODE_REPL_NODE_MODULE_DIRS].filter(Boolean).join(path.delimiter);
  const useRelay = process.argv.includes("--relay");
  if (useRelay) {
    const nativeEnv = Object.fromEntries(Object.entries(env).filter(([key]) =>
      /^(?:NODE_REPL_|BROWSER_USE_|SKY_CUA_)/.test(key) || key === "CODEX_CLI_PATH" || key === "CODEX_HOME"));
    fs.writeFileSync(path.join(profile, "config.toml"),
      `[mcp_servers.node_repl]\ncommand = ${JSON.stringify(launch.command)}\nargs = []\n[mcp_servers.node_repl.env]\n`
      + Object.entries(nativeEnv).map(([key, value]) => `${key} = ${JSON.stringify(value)}\n`).join(""));
  }
  child = spawn(useRelay ? process.execPath : launch.command,
    useRelay ? [path.resolve(import.meta.dirname, "../bridge/native-mcp-relay.mjs")] : launch.args,
    { cwd: profile, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  report.hostPid = child.pid;
  report.host = launch.command;
  report.relayEnabled = useRelay;
  console.log(`Read-only native smoke PID ${child.pid}; isolated home ${profile}`);
  closed = new Promise(resolve => child.once("close", resolve));
  child.stderr.on("data", chunk => { errors = (errors + chunk).slice(-8000); });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.method === "elicitation/create") {
      report.authorizationRequired = true;
      report.elicitation = message.params;
      // This smoke test must never approve access or change privacy settings.
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { action: "decline" } })}\n`);
      return;
    }
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
    else waiter.resolve(message.result);
  });
  child.on("error", error => { for (const waiter of pending.values()) waiter.reject(error); });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}`)); }, 45000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  report.initialize = await request("initialize", {
    protocolVersion: "2025-03-26", capabilities: { elicitation: { form: {} } },
    clientInfo: { name: "ccodex-native-readonly-smoke", version: "1.0.0" },
  });
  child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  const tools = await request("tools/list", {});
  report.tools = tools.tools.map(tool => tool.name);
  if (!report.tools.includes("js")) throw new Error("Official native host did not advertise js.");
  report.windowDiscovery = await request("tools/call", {
    name: "js",
    arguments: {
      code: 'if (!globalThis.sky) { const { sky } = await import("@oai/sky"); globalThis.sky = sky; }\nglobalThis.smokeWindows = await sky.list_windows();\nnodeRepl.write(JSON.stringify(smokeWindows.filter(window => /msedge|ceac/i.test(`${window.app} ${window.title || ""}`))));',
      title: "Read-only native window discovery",
      timeout_ms: 30000,
    },
  });
  const text = JSON.stringify(report.windowDiscovery);
  report.passed = !report.windowDiscovery.isError && !/native pipe is unavailable|Error:|denied|blocked/i.test(text);
  console.log(JSON.stringify({ tools: report.tools, passed: report.passed, result: report.windowDiscovery }));
  if (report.passed && capture === "--capture-ceac") {
    report.ceacObservation = await request("tools/call", {
      name: "js",
      arguments: {
        code: 'globalThis.ceacCandidates = smokeWindows.filter(window => window.app === "MSEdge" && /^(Attention Required!|请稍候|CEAC|Consular Electronic)/i.test(window.title || ""));\nif (ceacCandidates.length !== 1) throw new Error(`Expected one returned CEAC test window, found ${ceacCandidates.length}`);\nglobalThis.ceacWindow = await sky.get_window({ id: ceacCandidates[0].id, app: ceacCandidates[0].app });\nglobalThis.ceacState = await sky.get_window_state({ window: ceacWindow, include_screenshot: false, include_text: true });\nnodeRepl.write(JSON.stringify({ window: ceacState.window, accessibility: ceacState.accessibility }));',
        title: "Observe the CEAC public test window without input",
        timeout_ms: 30000,
      },
    });
    const observed = JSON.stringify(report.ceacObservation);
    report.urlDetectionPassed = !report.ceacObservation.isError
      && !/could not determine|cannot determine|无法.*(?:识别|网址)|native pipe is unavailable|Error:/i.test(observed);
    report.passed = report.passed && report.urlDetectionPassed;
    console.log(JSON.stringify({ urlDetectionPassed: report.urlDetectionPassed, result: report.ceacObservation }));
  }
  if (report.passed && capture?.startsWith("--window-title-prefix=")) {
    const title = capture.slice("--window-title-prefix=".length);
    report.windowObservation = await request("tools/call", {
      name: "js",
      arguments: {
        code: `globalThis.candidates = smokeWindows.filter(window => window.app === "MSEdge" && (window.title || "").startsWith(${JSON.stringify(title)}));\nif (candidates.length !== 1) throw new Error(\`Expected one observed test window, found \${candidates.length}\`);\nglobalThis.observedWindow = await sky.get_window({ id: candidates[0].id, app: candidates[0].app });\nglobalThis.observation = await sky.get_window_state({ window: observedWindow, include_screenshot: false, include_text: true });\nnodeRepl.write(JSON.stringify({ window: observation.window, readable: observation.accessibility !== null, characterCount: (observation.accessibility?.tree || observation.accessibility?.document_text || "").length }));`,
        title: "Read-only browser window capability verification",
        timeout_ms: 30000,
      },
    });
    report.urlDetectionPassed = !report.windowObservation.isError;
    report.passed = report.passed && report.urlDetectionPassed;
    console.log(JSON.stringify({ urlDetectionPassed: report.urlDetectionPassed, result: report.windowObservation }));
  }
} catch (error) {
  report.passed = false;
  report.error = error.message;
  console.error(error.message);
} finally {
  if (child) {
    child.stdin.end();
    let timer;
    try {
      await Promise.race([closed, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Native smoke host did not exit; preserving its profile.")), 30000);
      })]);
      report.hostExited = true;
    } catch (error) {
      report.passed = false;
      report.cleanupError = error.message;
    } finally { clearTimeout(timer); }
  }
  if (!child || report.hostExited) {
    if (path.dirname(fs.realpathSync(profile)) !== fs.realpathSync(os.tmpdir()) || !path.basename(profile).startsWith("ccodex-native-channel-")) {
      throw new Error("Refusing cleanup outside owned smoke profile.");
    }
    await fs.promises.rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    report.profileRemoved = true;
  }
  report.finishedAt = new Date().toISOString();
  if (errors) report.diagnostics = errors;
  atomicWrite(path.resolve(reportFile), `${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.passed ? 0 : 1;
}
