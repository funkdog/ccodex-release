const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const packageRoot = process.env.CCODEX_PACKAGE_ROOT || path.resolve(__dirname, "..");
const core = process.env.CCODEX_LIVE_CORE;
const probe = process.env.CCODEX_CONSOLE_RECOVERY_PROBE;
assert(core && fs.existsSync(core), "The actual candidate core is required.");
assert(probe && fs.existsSync(probe), "Compile the checked-in parent-console probe first.");
const pty = require(process.env.CCODEX_NODE_PTY || path.join(packageRoot, "bin", "node-pty"));
const { Terminal } = require(process.env.CCODEX_XTERM_HEADLESS ||
  path.join(os.tmpdir(), "copilot-xterm-node", "node_modules", "@xterm", "headless"));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-terminal-recovery-"));
const profile = path.join(root, "profile");
const workspace = path.join(root, "workspace");
fs.mkdirSync(profile);
fs.mkdirSync(workspace);
const report = {
  schemaVersion: 1, kind: "live-parent-console-recovery", core,
  coreSha256: crypto.createHash("sha256").update(fs.readFileSync(core)).digest("hex"),
  probeSourceSha256: crypto.createHash("sha256").update(fs.readFileSync(
    path.join(packageRoot, "tests", "fixtures", "windows-console-recovery.cs"))).digest("hex"),
  passed: false, isolatedProfile: true, externalRequests: false, processes: [], checks: [],
};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let active;

async function close(state) {
  if (!state || state.closed) return;
  state.child.kill();
  await Promise.race([state.exitPromise, delay(10000)]);
  await delay(250);
  state.record.exited = state.exited;
  state.terminal.dispose();
  state.closed = true;
}

async function check(mode) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^(CODEX|CCODEX|OPENAI|GITHUB|COPILOT)_/.test(name) ||
        /(?:TOKEN|SECRET|PASSWORD|API_KEY|AUTHORIZATION)/i.test(name)) delete env[name];
  }
  Object.assign(env, { CODEX_HOME: profile, CODEX_COPILOT_HOME: profile,
    TERM: "xterm-256color", COLORTERM: "truecolor", SSH_TTY: "isolated-recovery-test" });
  const terminal = new Terminal({ cols: 100, rows: 32, allowProposedApi: true });
  const child = pty.spawn(probe, [core, workspace, mode],
    { cols: terminal.cols, rows: terminal.rows, cwd: workspace, env });
  const record = { mode, parentPid: null, corePid: null, exited: false };
  report.processes.push(record);
  const state = { child, terminal, record, raw: "", exited: false };
  active = state;
  child.onData(data => { state.raw += data; terminal.write(data); });
  terminal.onData(data => child.write(data));
  state.exitPromise = new Promise(resolve => child.onExit(event => {
    state.exited = true; record.exitCode = event.exitCode; resolve();
  }));
  async function wait(predicate, label) {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      await new Promise(resolve => terminal.write("", resolve));
      if (predicate()) return;
      if (state.exited) throw new Error(`Parent probe exited during ${label}.\n${state.raw.slice(-2000)}`);
      await delay(50);
    }
    throw new Error(`Timeout: ${label}\n${state.raw.slice(-2000)}`);
  }
  try {
    await wait(() => /RECOVERY_CORE_PID=\d+/.test(state.raw) &&
      /gpt-5\.6-sol/.test(state.raw), "native composer startup");
    record.parentPid = child.pid;
    record.corePid = Number(state.raw.match(/RECOVERY_CORE_PID=(\d+)/)[1]);
    assert(record.parentPid > 0 && record.corePid > 0 && record.parentPid !== record.corePid);
    child.write("/quit\r");
    await wait(() => /RECOVERY before=\d+ after=\d+ exit=\d+ core=\d+/.test(state.raw),
      "same-console mode observation after graceful native exit");
    const values = state.raw.match(/RECOVERY before=(\d+) after=(\d+) exit=(\d+) core=(\d+)/);
    record.inputBefore = Number(values[1]);
    record.inputAfter = Number(values[2]);
    record.coreExitCode = Number(values[3]);
    assert.equal(Number(values[4]), record.corePid);
    assert.equal(record.coreExitCode, 0);
    assert.equal(record.inputAfter, record.inputBefore, "The native core must restore every parent input flag.");
    await wait(() => state.raw.includes("RECOVERY_READ_READY"), "unrepaired parent cooked input");
    child.write("PARENT-AFTER-QUIT\r");
    await wait(() => state.raw.includes("RECOVERY_PASSED"), "plain Enter read by the actual parent");
    await Promise.race([state.exitPromise, delay(5000)]);
    assert.equal(state.exited, true);
    assert.equal(record.exitCode, 0);
    report.checks.push({ name: `${mode}: original input flags and parent plain Enter restored`, passed: true });
  } finally {
    record.outputTail = state.raw.slice(-1200);
    await close(state);
  }
}

async function main() {
  fs.writeFileSync(path.join(profile, "config.toml"), `
model = "gpt-5.6-sol"
model_provider = "isolated-recovery"
check_for_update_on_startup = false
disable_paste_burst = true
[model_providers.isolated-recovery]
name = "No network recovery test"
base_url = "http://127.0.0.1:9"
wire_api = "responses"
requires_openai_auth = false
[tui]
alternate_screen = "always"
[analytics]
enabled = false
[features]
plugins = false
[projects.${JSON.stringify(workspace)}]
trust_level = "trusted"
`.trimStart());
  await check("records");
  await check("vt");
  report.passed = true;
}
main().catch(error => { report.error = error.message; process.exitCode = 1; })
  .finally(async () => {
    await close(active);
    report.testProcessesExited = report.processes.every(record => record.exited);
    if (process.env.CCODEX_RECOVERY_REPORT) {
      fs.writeFileSync(process.env.CCODEX_RECOVERY_REPORT, `${JSON.stringify(report, null, 2)}\n`);
    }
    if (report.testProcessesExited) {
      assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
      assert.match(path.basename(root), /^ccodex-terminal-recovery-/);
      fs.rmSync(root, { recursive: true, force: true });
    }
    process.stdout.write(`${JSON.stringify({ passed: report.passed, checks: report.checks,
      coreSha256: report.coreSha256, error: report.error })}\n`);
  });
