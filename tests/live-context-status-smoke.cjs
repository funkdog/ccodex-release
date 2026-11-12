// Exercise persisted successful compactions and quota snapshots through the real TUI.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const packageRoot = process.env.CCODEX_PACKAGE_ROOT || path.resolve(__dirname, "..");
const core = process.env.CCODEX_LIVE_CORE;
assert(core && fs.existsSync(core), "CCODEX_LIVE_CORE must name the candidate core");
const recoveryProbe = process.env.CCODEX_CONSOLE_RECOVERY_PROBE;
if (process.platform === "win32") {
  assert(recoveryProbe && fs.existsSync(recoveryProbe),
    "Compile the same-console parent recovery probe before the Windows live test.");
}
const pty = require(process.env.CCODEX_NODE_PTY || path.join(packageRoot, "bin", "node-pty"));
const { Terminal } = require(process.env.CCODEX_XTERM_HEADLESS ||
  path.join(os.tmpdir(), "copilot-xterm-node", "node_modules", "@xterm", "headless"));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-context-status-live-"));
const profile = path.join(root, "profile");
const workspace = path.join(root, "workspace");
fs.mkdirSync(profile);
fs.mkdirSync(workspace);
const report = { schemaVersion: 1, core, coreSha256: crypto.createHash("sha256")
  .update(fs.readFileSync(core)).digest("hex"), passed: false,
  directNativeInput: true, isolatedProfile: true, externalRequests: false,
  temporaryRoot: root, processes: [], checks: [] };
let failedCompact = false;
let calls = 0;
let live;
let projectCredits;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function completedTurns() {
  const sessions = path.join(profile, "sessions");
  if (!fs.existsSync(sessions)) return 0;
  let count = 0;
  const queue = [sessions];
  while (queue.length) {
    for (const entry of fs.readdirSync(queue.pop(), { withFileTypes: true })) {
      const file = path.join(entry.parentPath, entry.name);
      if (entry.isDirectory()) queue.push(file);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        assert(fs.statSync(file).size <= 2 * 1024 * 1024);
        for (const line of fs.readFileSync(file, "utf8").split("\n")) {
          try {
            const record = JSON.parse(line);
            if (record.type === "event_msg" &&
                ["task_complete", "turn_complete"].includes(record.payload?.type)) count++;
          } catch { /* The recorder may currently be appending its last line. */ }
        }
      }
    }
  }
  return count;
}

function completion(id, text) {
  const item = { id: `message-${id}`, type: "message", role: "assistant",
    status: "completed", phase: "final_answer",
    content: [{ type: "output_text", text, annotations: [] }] };
  const events = [
    { type: "response.created", response: { id, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
    { type: "response.content_part.added", output_index: 0, content_index: 0,
      item_id: item.id, part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", output_index: 0, content_index: 0,
      item_id: item.id, delta: text },
    { type: "response.output_text.done", output_index: 0, content_index: 0,
      item_id: item.id, text },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id, status: "completed", output: [item],
      usage: { input_tokens: 64, output_tokens: 16, total_tokens: 80,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 } } } },
  ];
  return events.map((event, index) =>
    `data: ${JSON.stringify({ ...event, sequence_number: index })}\n\n`).join("");
}

const server = http.createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 2 * 1024 * 1024) throw new Error("Synthetic request exceeded bound.");
  }
  if (request.method === "POST" && request.url.includes("responses")) {
    calls++;
    if (failedCompact) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "invalid_request",
        message: "Synthetic compaction rejected." } }));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    response.end(completion(`synthetic-${calls}`, calls === 1
      ? "Synthetic first turn completed." : "Synthetic compacted thread summary."));
  } else {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  }
});

function quota({ premiumAt = new Date().toISOString(), login = "quota-fixture", creditsUsed = 2612 } = {}) {
  const observedAt = new Date().toISOString();
  fs.writeFileSync(path.join(profile, "account-generation.json"), JSON.stringify({
    generation: login, login, quota: { status: "available", updatedAt: new Date().toISOString(),
      snapshots: [
        { id: "premium_interactions", updatedAt: premiumAt, remaining: 90, entitlement: 100 },
        { id: "chat", updatedAt: new Date().toISOString(), unlimited: true },
      ] },
    credits: { ...projectCredits({ status: "available", unit: "credits",
      used: creditsUsed, allowance: 1000000, updatedAt: observedAt }),
      accountGeneration: login },
  }));
}

async function start(args = []) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^(CODEX|CCODEX|OPENAI|GITHUB|COPILOT)_/.test(name) ||
        /(?:TOKEN|SECRET|PASSWORD|API_KEY|AUTHORIZATION)/i.test(name)) delete env[name];
  }
  Object.assign(env, { CODEX_HOME: profile, CODEX_COPILOT_HOME: profile,
    TERM: "xterm-256color", COLORTERM: "truecolor", SSH_TTY: "isolated-context-status-test" });
  const terminal = new Terminal({ cols: 120, rows: 36, allowProposedApi: true });
  const child = pty.spawn(recoveryProbe || core, recoveryProbe
    ? [core, workspace, "records", ...args] : [...args, "-C", workspace],
    { cols: terminal.cols, rows: terminal.rows, cwd: workspace, env });
  const processReport = { pid: child.pid, exited: false, graceful: false };
  report.processes.push(processReport);
  const state = { child, terminal, processReport, raw: "", exited: false };
  state.exitPromise = new Promise(resolve => child.onExit(event => {
    state.exited = true; processReport.exited = true; processReport.exitCode = event.exitCode; resolve();
  }));
  child.onData(data => { state.raw += data; terminal.write(data); });
  terminal.onData(data => child.write(data));
  state.screen = () => {
    const buffer = terminal.buffer.active;
    return Array.from({ length: terminal.rows }, (_, row) =>
      buffer.getLine(buffer.viewportY + row)?.translateToString(true, 0, terminal.cols) || "").join("\n");
  };
  state.wait = async (predicate, label, timeout = 20000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      await new Promise(resolve => terminal.write("", resolve));
      if (predicate()) return;
      if (state.exited) throw new Error(`Native core exited while waiting for ${label}.`);
      await delay(50);
    }
    throw new Error(`Timeout: ${label}\n${state.screen()}`);
  };
  live = state;
  await state.wait(() => /gpt-5\.6-sol/.test(state.screen()), "composer startup");
  if (recoveryProbe) {
    await state.wait(() => /RECOVERY_CORE_PID=\d+/.test(state.raw), "actual native child identity");
    processReport.parentPid = child.pid;
    processReport.pid = Number(state.raw.match(/RECOVERY_CORE_PID=(\d+)/)[1]);
  } else processReport.pid = child.pid;
  assert(Number.isSafeInteger(processReport.pid) && processReport.pid > 0,
    "The actual test core PID must be known.");
  return state;
}

async function close(state) {
  if (!state || state.closed) return;
  if (!state.exited) {
    state.child.write("/quit\r");
    if (recoveryProbe) {
      const deadline = Date.now() + 20000;
      while (!state.exited && !state.raw.includes("RECOVERY_READ_READY") &&
          Date.now() < deadline) await delay(50);
      if (state.raw.includes("RECOVERY_READ_READY")) state.child.write("PARENT-AFTER-QUIT\r");
    }
    await Promise.race([state.exitPromise, delay(10000)]);
  }
  if (!state.exited) await Promise.race([state.exitPromise, delay(3000)]);
  if (!state.exited) {
    state.processReport.forcedCleanup = true;
    state.child.kill();
    await Promise.race([state.exitPromise, delay(10000)]);
  }
  await delay(250);
  if (recoveryProbe) {
    const modes = state.raw.match(/RECOVERY before=(\d+) after=(\d+) exit=(\d+) core=(\d+)/);
    state.processReport.inputModeBefore = modes ? Number(modes[1]) : null;
    state.processReport.inputModeAfter = modes ? Number(modes[2]) : null;
    state.processReport.coreExitCode = modes ? Number(modes[3]) : null;
    state.processReport.terminalModesRestored = Boolean(modes &&
      Number(modes[4]) === state.processReport.pid && modes[1] === modes[2] &&
      modes[3] === "0" && state.raw.includes("RECOVERY_PASSED") &&
      state.processReport.exitCode === 0 && !state.processReport.forcedCleanup);
  } else {
    state.processReport.terminalModesRestored = state.exited && state.processReport.exitCode === 0;
  }
  state.processReport.graceful = state.exited && state.processReport.terminalModesRestored;
  // node-pty's Windows agent also owns its pseudo-console after the child exits.
  state.child.kill();
  state.processReport.win32ReportingRestored = state.raw.includes("\x1b[?9001l");
  state.processReport.win32ReportingRequested = state.raw.includes("\x1b[?9001h");
  state.processReport.modeSequences = state.raw.match(/\x1b\[\?9001[hl]/g) || [];
  state.processReport.outputTail = state.raw.slice(-1024);
  state.terminal.dispose();
  state.closed = true;
}

async function main() {
  const { pathToFileURL } = require("node:url");
  projectCredits = (await import(pathToFileURL(path.join(packageRoot, "bridge", "copilot-credits.mjs")).href)).creditsView;
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  fs.writeFileSync(path.join(profile, "config.toml"), `
model = "gpt-5.6-sol"
model_provider = "github-copilot"
check_for_update_on_startup = false
disable_paste_burst = true
approval_policy = "on-request"
sandbox_mode = "read-only"
[model_providers.github-copilot]
name = "Isolated context status fixture"
base_url = "http://127.0.0.1:${port}"
wire_api = "responses"
requires_openai_auth = false
request_max_retries = 0
stream_max_retries = 0
[tui]
alternate_screen = "always"
status_line = ["copilot-account", "copilot-credits", "copilot-quota", "compaction-count"]
[notice]
hide_full_access_warning = true
hide_rate_limit_model_nudge = true
[analytics]
enabled = false
[features]
plugins = false
[projects.${JSON.stringify(workspace)}]
trust_level = "trusted"
`.trimStart());
  quota();
  live = await start();
  await live.wait(() => /Compact \u00d70/.test(live.screen()) &&
    /Copilot 90\/100 left/.test(live.screen()), "initial count and current quota");
  report.checks.push({ name: "real native status shows zero successes and same-profile quota", passed: true });
  await live.wait(() => /2,612 \/ 1,000,000 AI credits/.test(live.screen()) &&
    /0\.3% used/.test(live.screen()), "projected native AI credits and exact shared percentage");
  report.checks.push({ name: "native credits use exact shared credit units and percentage", passed: true });
  quota({ creditsUsed: 900000 });
  await live.wait(() => /900,000 \/ 1,000,000 AI credits/.test(live.screen()) &&
    /90\.0% used/.test(live.screen()), "changed native AI-credit usage");
  report.checks.push({ name: "native credits update dynamically without changing old quota or compaction state", passed: true });
  quota({ login: "new-credit-fixture", creditsUsed: 0 });
  await live.wait(() => /0 \/ 1,000,000 AI credits/.test(live.screen()) &&
    /0\.0% used/.test(live.screen()) && !live.screen().includes("900,000"), "new account clears old AI credits");
  report.checks.push({ name: "native credit account switch cannot retain another account's balance", passed: true });
  report.creditsVerified = true;
  report.creditChecks = 3;
  quota({ premiumAt: new Date(Date.now() - 16 * 60000).toISOString() });
  await live.wait(() => live.screen().includes("Copilot quota unavailable"),
    "expired premium bucket despite fresh chat bucket");
  quota({ login: "other-fixture" });
  await live.wait(() => live.screen().includes("@other-fixture") &&
    live.screen().includes("Copilot 90/100 left"), "updated current account quota");
  report.checks.push({ name: "quota follows account identity and its own bucket freshness", passed: true });

  live.child.write("Synthetic context status prompt.\r");
  await live.wait(() => live.screen().includes("Synthetic first turn completed."), "first completed turn");
  await live.wait(() => completedTurns() >= 1, "persisted first turn completion", 30000);
  await delay(500);
  const before = calls;
  live.child.write("/compact\r");
  await live.wait(() => calls > before && /Compact \u00d71/.test(live.screen()),
    "successful manual compaction", 30000);
  await live.wait(() => completedTurns() >= 2, "persisted compaction turn completion", 30000);
  await delay(500);
  report.checks.push({ name: "one actual completed compaction increments count once", passed: true });
  failedCompact = true;
  const afterSuccess = calls;
  live.child.write("/compact\r");
  await live.wait(() => calls > afterSuccess && live.screen().includes("Synthetic compaction rejected."),
    "failed manual compaction", 30000);
  assert.match(live.screen(), /Compact \u00d71/);
  assert.doesNotMatch(live.screen(), /Compact \u00d72/);
  report.checks.push({ name: "failed compaction does not increment successful count", passed: true });
  report.beforeResumeFrame = live.screen().split("\n");
  await close(live);
  assert.equal(live.processReport.exited, true);
  assert.equal(live.processReport.graceful, true, "resume requires the original test lifetime to exit");
  failedCompact = false;
  live = await start(["resume", "--last"]);
  await live.wait(() => /Compact \u00d71/.test(live.screen()), "successful compaction count after resume");
  report.afterResumeFrame = live.screen().split("\n");
  report.checks.push({ name: "native resume reconstructs persisted successful compaction count", passed: true });
  await close(live);
  assert.equal(live.processReport.graceful, true);
  // ConPTY consumes ?9001l locally; test the real unrepaired parent's modes/read instead.
  assert.ok(report.processes.every(process => process.exited && process.terminalModesRestored));
  report.passed = true;
}

main().catch(error => {
  report.error = error.message;
  process.exitCode = 1;
}).finally(async () => {
  await close(live);
  await new Promise(resolve => server.close(resolve));
  report.testProcessesExited = report.processes.every(process => process.exited);
  report.providerRequests = calls;
  if (process.env.CCODEX_CONTEXT_REPORT) fs.writeFileSync(process.env.CCODEX_CONTEXT_REPORT,
    `${JSON.stringify(report, null, 2)}\n`);
  if (report.testProcessesExited) {
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
    assert.match(path.basename(root), /^ccodex-context-status-live-/);
    fs.rmSync(root, { recursive: true, force: true });
  }
  process.stdout.write(`${JSON.stringify({ passed: report.passed, coreSha256: report.coreSha256,
    checks: report.checks, error: report.error })}\n`);
});
