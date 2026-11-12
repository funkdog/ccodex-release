// Exercise the direct native input path, not the optional nested PTY proxy.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");

const packageRoot = process.env.CCODEX_PACKAGE_ROOT || path.resolve(__dirname, "..");
const core = process.env.CCODEX_LIVE_CORE;
assert(core && fs.existsSync(core), "CCODEX_LIVE_CORE must name the candidate core");
const nodePty = require(process.env.CCODEX_NODE_PTY || path.join(packageRoot, "bin", "node-pty"));
const { Terminal } = require(process.env.CCODEX_XTERM_HEADLESS ||
  path.join(os.tmpdir(), "copilot-xterm-node", "node_modules", "@xterm", "headless"));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-keyboard-live-"));
const profile = path.join(root, "profile");
const workspace = path.join(root, "workspace");
fs.mkdirSync(profile);
fs.mkdirSync(workspace);
const requests = [];
const server = http.createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  if (req.method === "POST" && req.url.includes("responses")) {
    requests.push(JSON.parse(body));
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "invalid_request", message: "Isolated input captured." } }));
  } else {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  }
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { schemaVersion: 1, core, pid: null, passed: false, directNativeInput: true,
  isolatedProfile: true, externalRequests: false, temporaryRoot: root,
  forcedCleanup: false, checks: [] };
const transport = process.env.CCODEX_KEYBOARD_TRANSPORT || "windows-record";
report.transport = transport;
let child;
let exited = false;
let exitPromise;
let terminal;
let rawOutput = "";
async function main() {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  fs.writeFileSync(path.join(profile, "config.toml"), `
model = "gpt-5.6-sol"
model_provider = "keyboard-test"
check_for_update_on_startup = false
disable_paste_burst = true
approval_policy = "on-request"
sandbox_mode = "read-only"
[model_providers.keyboard-test]
name = "Isolated keyboard test"
base_url = "http://127.0.0.1:${port}"
wire_api = "responses"
requires_openai_auth = false
request_max_retries = 0
stream_max_retries = 0
[tui]
alternate_screen = "always"
status_line = ["compaction-count"]
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
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(CODEX|CCODEX|OPENAI|GITHUB|COPILOT)_/.test(key) ||
        /(?:TOKEN|SECRET|PASSWORD|API_KEY|AUTHORIZATION)/i.test(key)) delete env[key];
  }
  Object.assign(env, { CODEX_HOME: profile, CODEX_COPILOT_HOME: profile,
    TERM: "xterm-256color", COLORTERM: "truecolor", SSH_TTY: "isolated-keyboard-test" });
  terminal = new Terminal({ cols: 100, rows: 32, allowProposedApi: true });
  child = nodePty.spawn(core, ["-C", workspace], {
    cols: terminal.cols, rows: terminal.rows, cwd: workspace, env,
  });
  report.pid = child.pid;
  report.coreSha256 = crypto.createHash("sha256").update(fs.readFileSync(core)).digest("hex");
  child.onData(data => { rawOutput += data; terminal.write(data); });
  terminal.onData(data => child.write(data));
  exitPromise = new Promise(resolve => child.onExit(event => {
    exited = true;
    report.exitCode = event.exitCode;
    resolve();
  }));
  const flush = () => new Promise(resolve => terminal.write("", resolve));
  const screen = () => {
    const buffer = terminal.buffer.active;
    return Array.from({ length: terminal.rows }, (_, row) =>
      buffer.getLine(buffer.viewportY + row)?.translateToString(true, 0, terminal.cols) || "").join("\n");
  };
  async function waitFor(predicate, label, timeout = 15000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      await flush();
      if (predicate()) return;
      if (exited) throw new Error(`Native core exited while waiting for ${label}.`);
      await delay(50);
    }
    throw new Error(`Timeout: ${label}\n${screen()}`);
  }
  await waitFor(() => /gpt-5\.6-sol|keyboard-test/.test(screen()), "composer startup");
  report.pid = child.pid;
  assert(Number.isSafeInteger(report.pid) && report.pid > 0, "The actual test core PID must be known.");
  await delay(500);
  child.write("FIRST-LINE");
  await waitFor(() => screen().includes("FIRST-LINE"), "first draft line");
  if (transport === "csi-u") {
    child.write("\x1b[13;2u");
  } else {
    await waitFor(() => rawOutput.includes("\x1b[?9001h"), "native Win32 keyboard reporting");
    child.write("\x1b[13;28;13;1;16;1_");
  }
  await delay(200);
  assert.equal(requests.length, 0, "Shift+Enter must never submit the draft");
  child.write("SECOND-LINE");
  await waitFor(() => screen().includes("SECOND-LINE"), "second draft line");
  report.frame = screen().split("\n");
  assert.doesNotMatch(screen(), /\[13;2u/, "CSI-u must not appear as literal draft text");
  child.write("\r");
  await waitFor(() => requests.length > 0, "explicit plain Enter submission");
  const userText = requests.flatMap(request => request.input || [])
    .filter(item => item.role === "user")
    .flatMap(item => typeof item.content === "string" ? [item.content]
      : (item.content || []).map(part => part.text || "")).join("\n");
  assert.match(userText, /FIRST-LINE\nSECOND-LINE/);
  assert.doesNotMatch(userText, /\[13;2u/);
  report.checks.push({ name: "Shift+Enter inserts one newline and only plain Enter submits", passed: true });
  if (transport === "windows-record") {
    const count = requests.length;
    child.write("FALLBACK-FIRST");
    await waitFor(() => screen().includes("FALLBACK-FIRST"), "fallback draft line");
    const encoded = [..."\x1b[13;2u"].map(character =>
      `\x1b[${character === "\x1b" ? 27 : 0};0;${character.codePointAt(0)};1;0;1_`).join("");
    child.write(encoded);
    await delay(200);
    assert.equal(requests.length, count, "fallback CSI-u must not submit the draft");
    child.write("FALLBACK-SECOND");
    await waitFor(() => screen().includes("FALLBACK-SECOND"), "fallback second line");
    child.write("\r");
    await waitFor(() => requests.length > count, "fallback plain Enter submission");
    const text = (requests.at(-1).input || []).filter(item => item.role === "user")
      .flatMap(item => (item.content || []).map(part => part.text || "")).join("\n");
    assert.match(text, /FALLBACK-FIRST\nFALLBACK-SECOND/);
    assert.doesNotMatch(text, /\[13;2u/);
    report.checks.push({ name: "record-delivered CSI-u inserts newline without leaking escape text", passed: true });
  }
  report.passed = true;
}
main().catch(error => {
  report.error = error.message;
  process.exitCode = 1;
}).finally(async () => {
  if (child && !exited) {
    await delay(300);
    child.write("/quit\r");
    await Promise.race([exitPromise, delay(20000)]);
  }
  if (child && !exited) {
    report.forcedCleanup = true;
    report.passed = false;
    report.error ||= "Native keyboard fixture did not exit gracefully.";
    process.exitCode = 1;
    child.kill();
  }
  if (exitPromise) await Promise.race([exitPromise, delay(10000)]);
  if (child && exited) {
    // The native process is already gone; release node-pty's owned pseudo-console and worker.
    child.kill();
  }
  report.win32KeyboardReportingRequested = rawOutput.includes("\x1b[?9001h");
  report.win32KeyboardReportingRestored = rawOutput.includes("\x1b[?9001l");
  report.testProcessExited = !child || exited;
  if (child && report.exitCode !== 0) {
    report.passed = false;
    report.error ||= "Native keyboard fixture did not exit with code zero.";
    process.exitCode = 1;
  }
  await new Promise(resolve => server.close(resolve));
  terminal?.dispose();
  if (report.testProcessExited) {
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
    assert.match(path.basename(root), /^ccodex-keyboard-live-/);
    fs.rmSync(root, { recursive: true, force: true });
    report.cleaned = true;
  } else {
    report.passed = false;
    process.exitCode = 1;
  }
  if (process.env.CCODEX_TUI_REPORT) {
    fs.writeFileSync(process.env.CCODEX_TUI_REPORT, `${JSON.stringify(report, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify({ passed: report.passed, pid: report.pid,
    coreSha256: report.coreSha256, checks: report.checks, error: report.error })}\n`);
});
