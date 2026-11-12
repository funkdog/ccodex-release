// R0 compatibility probe, not a production Desktop launcher.
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { inspectOfficialDesktop } from "../bridge/desktop-runtime.mjs";
import { connectCdp } from "../bridge/desktop-cdp.mjs";

const fixture = fileURLToPath(new URL("../tests/fixtures/desktop-app-server-probe.mjs", import.meta.url));
const quoteSh = value => "'" + value.replaceAll("'", "'\\''") + "'";

export function isOwnedCdpListener(output, pid, groupMembers = []) {
  const fields = output.trim().split(/\r?\n/).filter(Boolean);
  if (!fields.every(field => /^[pf]\d+$/.test(field))) return false;
  const owners = new Set(fields.filter(field => field.startsWith("p")).map(field => Number(field.slice(1))));
  const allowed = new Set([pid, ...groupMembers]);
  return owners.has(pid) && [...owners].every(owner => allowed.has(owner));
}

export function probeEnvironment(root, inherited = process.env) {
  if (!path.isAbsolute(root)) throw new Error("Probe root must be absolute");
  const env = Object.fromEntries(["HOME", "USER", "LOGNAME", "PATH", "TMPDIR", "LANG", "SHELL"]
    .filter(key => typeof inherited[key] === "string").map(key => [key, inherited[key]]));
  return { ...env, CODEX_HOME: path.join(root, "profile"),
    CODEX_ELECTRON_USER_DATA_PATH: path.join(root, "user-data"),
    CODEX_CLI_PATH: path.join(root, "fixture-cli"),
    CCODEX_APP_SERVER_PROBE_ROOT: root, CODEX_APP_SERVER_FORCE_CLI: "1",
    CODEX_ELECTRON_DISABLE_QUIT_CONFIRMATION: "1" };
}

export function summarizeTrace(entries) {
  const methods = new Map();
  const connections = new Set();
  let startupConfigCalls = 0;
  let completions = 0;
  for (const entry of entries) {
    if (entry.kind === "launch" && entry.flags.includes("--print-startup-config")) startupConfigCalls++;
    if (entry.kind === "rpc") {
      if (entry.method === "initialize") connections.add(entry.pid);
      const method = methods.get(entry.method) || { method: entry.method, count: 0, paramKeys: new Set() };
      method.count++;
      for (const key of entry.paramKeys) method.paramKeys.add(key);
      methods.set(entry.method, method);
    }
    if (entry.kind === "notification" && entry.method === "turn/completed") completions++;
  }
  return { startupConfigCalls, initializedProcesses: connections.size,
    syntheticCompletions: completions,
    methods: [...methods.values()].map(m => ({ ...m, paramKeys: [...m.paramKeys].sort() }))
      .sort((a, b) => a.method.localeCompare(b.method)) };
}

async function hashFile(file) {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export async function inspectProbeTarget(appPath) {
  const app = path.resolve(appPath);
  const resources = path.join(app, "Contents", "Resources");
  const archive = path.join(resources, "app.asar");
  const info = inspectOfficialDesktop(archive);
  const executableName = execFileSync("/usr/bin/plutil", ["-extract", "CFBundleExecutable", "raw", "-o", "-",
    path.join(app, "Contents", "Info.plist")], { encoding: "utf8" }).trim();
  if (!executableName || path.basename(executableName) !== executableName) throw new Error("Invalid app executable");
  const cliRelative = ["codex-cli/CodexCLI.app/Contents/MacOS/codex", "codex"]
    .find(relative => fs.existsSync(path.join(resources, relative)));
  if (!cliRelative) throw new Error("Bundled CLI was not found");
  return { app, executableName, cliRelative, desktop: info,
    archiveSha256: await hashFile(archive), cliSha256: await hashFile(path.join(resources, cliRelative)) };
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function stopOwned(child, exited) {
  if (!child?.pid) return;
  // A detached child owns this process group. Never search/kill by app name.
  try { process.kill(-child.pid, "SIGTERM"); } catch (e) { if (e.code !== "ESRCH") throw e; }
  let timer;
  try {
    await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => {
      try { process.kill(-child.pid, "SIGKILL"); } catch (e) { if (e.code !== "ESRCH") throw e; }
      resolve();
    }, 5000); })]);
    await exited;
  } finally { clearTimeout(timer); }
}

function ownedProcesses(root) {
  const roots = [root, fs.realpathSync(root)].map(p => p + path.sep);
  return execFileSync("/bin/ps", ["-axo", "pid=,lstart=,comm="], { encoding: "utf8" }).split("\n")
    .map(line => /^\s*(\d+)\s+((?:\S+\s+){4}\S+)\s+(.+)$/.exec(line))
    .filter(match => match && roots.some(prefix => match[3].startsWith(prefix)))
    .map(match => ({ pid: Number(match[1]), start: match[2], executable: match[3] }));
}

async function stopDetachedHelpers(root) {
  // Crashpad starts its own group. Match the unique snapshot/profile path and
  // recheck process identity immediately before signaling; never match by name.
  const owned = ownedProcesses(root);
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    const current = ownedProcesses(root);
    for (const entry of owned) {
      if (!current.some(p => p.pid === entry.pid && p.start === entry.start && p.executable === entry.executable)) continue;
      try { process.kill(entry.pid, signal); } catch (e) { if (e.code !== "ESRCH") throw e; }
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (ownedProcesses(root).length) throw new Error("Owned probe processes did not exit; retaining their files");
}

// Electron can create read-only runtime directories inside its private profile.
// Do not follow links while making the owned temporary tree removable.
async function removeOwnedTree(file) {
  const stat = await fsp.lstat(file).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  if (!stat) return;
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    if (stat.uid !== process.getuid()) throw new Error("Probe cleanup encountered a directory owned by another user");
    if ((stat.mode & 0o700) !== 0o700) await fsp.chmod(file, stat.mode | 0o700);
    for (const name of await fsp.readdir(file)) await removeOwnedTree(path.join(file, name));
    await fsp.rmdir(file);
  } else await fsp.unlink(file);
}

async function exerciseNativeComposer({ root, child, port, deadline, signal }) {
  let cdp;
  async function until(check) {
    while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
      signal?.throwIfAborted();
      const value = await check();
      if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    throw new Error("Native fixture UI did not become ready before the probe deadline");
  }
  try {
    const target = await until(async () => {
      let owners;
      try {
        owners = execFileSync("/usr/sbin/lsof", ["-a", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      } catch { return null; }
      // Chromium helpers can inherit the listening FD. Accept only the root
      // process and members of the private process group we created for it.
      const members = execFileSync("/bin/ps", ["-axo", "pid=,pgid="], { encoding: "utf8" }).split("\n")
        .map(line => line.trim().split(/\s+/).map(Number)).filter(([, group]) => group === child.pid).map(([pid]) => pid);
      if (!isOwnedCdpListener(owners, child.pid, members)) throw new Error("CDP listener is not the owned probe process");
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) })).json();
      return targets.find(t => t.type === "page" && t.url === "app://-/index.html");
    });
    const ws = new URL(target.webSocketDebuggerUrl);
    if (ws.hostname !== "127.0.0.1" || ws.port !== String(port)) throw new Error("Unexpected probe CDP target");
    cdp = await connectCdp(ws.href, { timeoutMs: 5000, signal });
    await until(() => cdp.evaluate(`document.body?.innerText.includes('R0 fixture (no model calls)') &&
      !![...document.querySelectorAll('[role=button]')].find(e=>e.innerText.trim()==='R0 isolated gateway probe')`));
    await cdp.evaluate(`[...document.querySelectorAll('[role=button]')].find(e=>e.innerText.trim()==='R0 isolated gateway probe').click()`);
    await until(() => cdp.evaluate(`!!document.querySelector('[contenteditable=true][data-codex-composer]') &&
      document.body?.innerText.includes('R0 fixture (no model calls)') && !/正在加载聊天|Loading chat/.test(document.body?.innerText)`));
    await cdp.evaluate(`document.querySelector('[contenteditable=true][data-codex-composer]').focus()`);
    await cdp.send("Input.insertText", { text: "CCODEX_R0_SYNTHETIC_PING" });
    await until(() => cdp.evaluate(`!![...document.querySelectorAll('button')].find(b=>/^(发送|Send)$/.test(b.getAttribute('aria-label')) && !b.disabled)`));
    await cdp.evaluate(`[...document.querySelectorAll('button')].find(b=>/^(发送|Send)$/.test(b.getAttribute('aria-label')) && !b.disabled).click()`);
    await until(() => cdp.evaluate(`document.body?.innerText.includes('CCODEX_R0_SYNTHETIC_OK')`));
    await until(async () => (await fsp.readFile(path.join(root, "rpc-shapes.jsonl"), "utf8"))
      .split("\n").filter(Boolean).map(JSON.parse).some(entry => entry.kind === "notification" && entry.method === "turn/completed"));
    const screenshot = await cdp.send("Page.captureScreenshot", {});
    await fsp.writeFile(path.join(root, "synthetic-turn.png"), Buffer.from(screenshot.data, "base64"), { mode: 0o600 });
    return { syntheticAnswerVisible: true, interaction: "Native history/composer/Send via CDP; no response DOM injection" };
  } catch (error) {
    if (cdp) {
      try {
        const screenshot = await cdp.send("Page.captureScreenshot", {});
        await fsp.writeFile(path.join(root, "failed-turn.png"), Buffer.from(screenshot.data, "base64"), { mode: 0o600 });
        await fsp.writeFile(path.join(root, "failed-ui.txt"), String(await cdp.evaluate("document.body?.innerText")), { mode: 0o600 });
      } catch {}
    }
    throw error;
  } finally { cdp?.close(); }
}

export async function launchProbe(target, { outputParent = os.tmpdir(), durationMs = 45000, skipWelcome = false, exerciseTurn = false, gatewayFixture = false, signal } = {}) {
  if (process.platform !== "darwin") throw new Error("R0 launcher has only been implemented for macOS");
  if (!target.desktop.explicitDataPath || !target.desktop.independentLock) throw new Error("Desktop isolation is unsupported");
  if (!Number.isInteger(durationMs) || durationMs < 1000 || durationMs > 300000) throw new Error("Duration must be 1–300 seconds");
  if (skipWelcome && target.desktop.version !== "26.1023.50603") throw new Error("Welcome seed is only verified for Desktop 26.1023.50603");
  signal?.throwIfAborted();
  const root = await fsp.mkdtemp(path.join(path.resolve(outputParent), "ccodex-app-server-probe-"));
  await fsp.chmod(root, 0o700);
  let child, exited, log, gateway, stopped = false;
  const snapshot = path.join(root, "Probe.app");
  try {
    for (const name of ["profile", "user-data", "workspace"]) await fsp.mkdir(path.join(root, name), { mode: 0o700 });
    await fsp.writeFile(path.join(root, ".ccodex-probe"), "R0 deterministic fixture\n", { mode: 0o600 });
    await fsp.writeFile(path.join(root, "profile", "config.toml"),
      'cli_auth_credentials_store = "file"\ncheck_for_update_on_startup = false\n[analytics]\nenabled = false\n', { mode: 0o600 });
    if (skipWelcome) {
      // Observed in our completed, unauthenticated test profile. This is an
      // internal welcome preference, never an authentication or entitlement.
      await fsp.writeFile(path.join(root, "profile", ".codex-global-state.json"), JSON.stringify({
        "electron-persisted-atom-state": {
          "chatgpt-migration-announcement-completed-v1": true,
          "electron:onboarding-welcome-v2-role-state": {
            completedConversationalOnboarding: true, conversationalOnboardingSkipped: true,
            roles: [], personalizedSuggestionsEnabled: false, workMode: "coding",
          },
          "electron:onboarding-projectless-completed": true,
          "electron:onboarding-hide-first-new-thread-promos": true,
        },
      }), { mode: 0o600 });
    }
    const env = probeEnvironment(root);
    let cli = fixture;
    if (gatewayFixture) {
      const { startGateway } = await import("../gateway/server.mjs");
      const connections = new WeakMap();
      let nextConnection = 1;
      const trace = entry => fs.appendFileSync(path.join(root, "rpc-shapes.jsonl"), JSON.stringify(entry) + "\n", { mode: 0o600 });
      const endpoint = path.join(root, "gw.sock");
      // A short socket path is required on Darwin; put evidence under /tmp.
      if (Buffer.byteLength(endpoint) >= 104) throw new Error("Use --output-parent /tmp for the shared gateway probe.");
      const config = { home: path.join(root, "profile"), endpoint, token: randomUUID(), generation: "probe",
        defaultEngine: "r0", engines: new Map([["r0", {
          models: async () => [{ id: "fixture", name: "R0 fixture (no model calls)" }],
          run: async ({ prompt, onSession, onText }) => {
            if (!prompt.split("\n").some(line => line.trim() === "CCODEX_R0_SYNTHETIC_PING")) throw new Error("Only the probe sentinel is accepted.");
            onSession("synthetic-native-session");
            onText("CCODEX_R0_SYNTHETIC_OK — shared gateway; no model calls.");
          },
        }]]) };
      gateway = await startGateway(config);
      const started = await gateway.protocol.handle("thread/start", { cwd: path.join(root, "workspace") });
      await gateway.protocol.handle("thread/name/set", { threadId: started.thread.id, name: "R0 isolated gateway probe" });
      const originalHandle = gateway.protocol.handle.bind(gateway.protocol);
      gateway.protocol.handle = async (method, params, connection) => {
        if (!connections.has(connection)) connections.set(connection, nextConnection++);
        trace({ kind: "rpc", pid: connections.get(connection), method, paramKeys: Object.keys(params), hasId: true });
        try { return await originalHandle(method, params, connection); }
        catch (error) { trace({ kind: "error", method, message: error.message }); throw error; }
      };
      const notify = gateway.protocol.notify;
      gateway.protocol.notify = (method, params) => { trace({ kind: "notification", method }); notify(method, params); };
      const file = path.join(root, "connection.json");
      await fsp.writeFile(file, JSON.stringify({ endpoint, token: config.token, generation: config.generation }), { mode: 0o600 });
      env.CCODEX_GATEWAY_CONNECTION = file;
      cli = fileURLToPath(new URL("../gateway/stdio.mjs", import.meta.url));
    }
    await fsp.writeFile(path.join(root, "fixture-cli"),
      `#!/bin/sh\nexec ${quoteSh(process.execPath)} ${quoteSh(cli)} "$@"\n`, { mode: 0o700 });
    // Clone the signed app without patching it; updater writes stay in the copy.
    execFileSync("/bin/cp", ["-cR", target.app, snapshot], { timeout: 60000 });
    const port = await reservePort();
    log = await fsp.open(path.join(root, "desktop-output.log"), "wx", 0o600);
    child = spawn(path.join(snapshot, "Contents", "MacOS", target.executableName), [
      `--user-data-dir=${path.join(root, "user-data")}`, "--remote-debugging-address=127.0.0.1",
      `--remote-debugging-port=${port}`,
    ], { env, cwd: root, detached: true, stdio: ["ignore", log.fd, log.fd] });
    exited = new Promise(resolve => { child.once("exit", resolve); child.once("error", resolve); });
    await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    process.stdout.write(JSON.stringify({ probeRoot: root, pid: child.pid, debugPort: port }) + "\n");
    const deadline = Date.now() + durationMs;
    let ui = null;
    if (exerciseTurn) {
      try { ui = await exerciseNativeComposer({ root, child, port, deadline, signal }); }
      catch (error) { ui = { syntheticAnswerVisible: false, error: error.message }; }
    } else {
      while (!signal?.aborted && Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    await stopOwned(child, exited);
    stopped = true;
    const file = path.join(root, "rpc-shapes.jsonl");
    const entries = fs.existsSync(file) ? (await fsp.readFile(file, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse) : [];
    const { app, ...identity } = target;
    const report = { schemaVersion: 1, recordedAt: new Date().toISOString(), platform: process.platform,
      arch: process.arch, target: identity, fixtureOnly: true, sharedGateway: gatewayFixture, welcomeSeeded: skipWelcome, uiTurnVerified: ui?.syntheticAnswerVisible === true, ui,
      note: "RPC completion is not proof of rendering. No real CLI engine or release has been validated.",
      ...summarizeTrace(entries) };
    await fsp.writeFile(path.join(root, "report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    return { root, report };
  } finally {
    if (child && !stopped) await stopOwned(child, exited);
    if (child) await stopDetachedHelpers(root);
    await gateway?.close();
    await log?.close();
    // Keep only the bounded evidence, not third-party binaries or user profiles.
    for (const name of ["Probe.app", "profile", "user-data", "workspace", "fixture-cli", ".ccodex-probe", "connection.json", "gw.sock"]) {
      await removeOwnedTree(path.join(root, name));
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--launch-fixture") options.launch = true;
    else if (args[i] === "--gateway-fixture") options.gatewayFixture = true;
    else if (args[i] === "--skip-welcome") options.skipWelcome = true;
    else if (args[i] === "--exercise-turn") options.exerciseTurn = true;
    else if (["--app", "--seconds", "--output-parent"].includes(args[i]) && args[i + 1]) options[args[i].slice(2)] = args[++i];
    else throw new Error("Usage: node tools/probe-desktop-app-server.mjs --app /path/to/App.app [--launch-fixture --skip-welcome --exercise-turn --seconds 45 --output-parent /existing/directory]");
  }
  if (!options.app) throw new Error("--app is required; no running client is selected implicitly");
  const target = await inspectProbeTarget(options.app);
  if (!options.launch) { const { app, ...report } = target; console.log(JSON.stringify(report, null, 2)); return; }
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    const result = await launchProbe(target, { outputParent: options["output-parent"],
      durationMs: Number(options.seconds ?? 45) * 1000, skipWelcome: options.skipWelcome, exerciseTurn: options.exerciseTurn, gatewayFixture: options.gatewayFixture, signal: controller.signal });
    console.log(JSON.stringify({ report: path.join(result.root, "report.json"),
      initializedProcesses: result.report.initializedProcesses, syntheticCompletions: result.report.syntheticCompletions,
      uiTurnVerified: result.report.uiTurnVerified, ui: result.report.ui }, null, 2));
    if (!result.report.initializedProcesses || (options.exerciseTurn && !result.report.uiTurnVerified)) process.exitCode = 1;
  } finally { process.removeListener("SIGINT", abort); process.removeListener("SIGTERM", abort); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
