// Native terminal plus a deterministic loopback provider. No paid requests or real clipboard I/O.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const packageRoot = path.resolve(__dirname, "..");
const nodePty = require(process.env.CCODEX_NODE_PTY || path.join(packageRoot, "bin/node-pty"));
const { Terminal } = require(process.env.CCODEX_XTERM_HEADLESS);
const core = process.env.CCODEX_LIVE_CORE;
assert(core && fs.existsSync(core), "Supply the built native core.");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-stream-test-"));
const profile = path.join(root, "profile");
const workspace = path.join(root, "workspace");
const temporary = path.join(root, "tmp");
for (const directory of [profile, workspace, temporary]) fs.mkdirSync(directory);
execFileSync("git", ["init", "--quiet", workspace], { windowsHide: true });
process.env.CODEX_COPILOT_HOME = profile;
fs.writeFileSync(path.join(profile, "account-generation.json"),
  JSON.stringify({ generation: "fixture-account", login: "fixture-user" }));

const terminal = new Terminal({ cols: 120, rows: 38, allowProposedApi: true });
const report = {
  core, sha256: crypto.createHash("sha256").update(fs.readFileSync(core)).digest("hex"),
  isolatedProfile: true, loopbackProvider: true, paidRequests: false,
  clipboardMutation: false, checks: [],
};
let child, activeResponse, audit, server, startAudit;
let exited = false, exitEvent, exitPromise, completeText = "", raw = "", responseClosed = false;
const requests = [];
const delay = (milliseconds) => new Promise(resolve => setTimeout(resolve, milliseconds));
const flush = () => new Promise(resolve => terminal.write("", resolve));
function winKeyRecord(vk, scan, unicode, keyDown, controlState = 0) {
  return `\x1b[${vk};${scan};${unicode};${keyDown ? 1 : 0};${controlState};1_`;
}
function pressWinKey(vk, scan, unicode, controlState = 0) {
  child.write(winKeyRecord(vk, scan, unicode, false));
  child.write(winKeyRecord(vk, scan, unicode, true, controlState));
  child.write(winKeyRecord(vk, scan, unicode, false, controlState));
  if ((controlState & 16) !== 0) child.write(winKeyRecord(16, 42, 0, false));
}
function pressControlKey(vk, scan, unicode) {
  pressWinKey(vk, scan, unicode, 8);
  child.write(winKeyRecord(17, 29, 0, false));
}
const pressEnter = () => pressWinKey(13, 28, 13);
function rows() {
  const buffer = terminal.buffer.active;
  return Array.from({ length: terminal.rows }, (_, row) =>
    buffer.getLine(buffer.viewportY + row)?.translateToString(true, 0, terminal.cols) || "");
}
function historyTop() {
  const buffer = terminal.buffer.active;
  return Array.from({ length: 6 }, (_, row) =>
    buffer.getLine(buffer.viewportY + row)?.translateToString(true, 0, terminal.cols - 1) || "");
}
const visible = () => rows().join("\n");
function frame() {
  return { cols: terminal.cols, rows: terminal.rows, screen: rows(), buffer: terminal.buffer.active.type };
}
async function waitFor(predicate, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await flush();
    if (predicate()) return;
    if (exited) throw new Error(`Native core exited: ${JSON.stringify(exitEvent)}`);
    await delay(40);
  }
  throw new Error(`Timeout: ${label}\n${visible()}`);
}
async function check(name, action) {
  try {
    await action();
    report.checks.push({ name, passed: true, frame: frame() });
    console.log(`PASS ${name}`);
  } catch (error) {
    report.checks.push({ name, passed: false, error: error.message, frame: frame() });
    throw error;
  }
}
function send(event) {
  assert(activeResponse, "Native provider request has not started.");
  activeResponse.write(`data: ${JSON.stringify(event)}\n\n`);
}
function delta(text) {
  completeText += text;
  send({ type: "response.output_text.delta", delta: text });
}
function markers(first, last) {
  for (let number = first; number <= last; number += 1) {
    delta(`STREAM_ROW_${String(number).padStart(2, "0")} output remains ordered.\n\n`);
  }
}
function assertBottom() {
  const screen = rows();
  assert(screen.findLastIndex(line => line.trim()) >= terminal.rows - 2, "Footer is not bottom-pinned.");
  assert(/Cache/.test(screen.slice(-6).join("\n")), "Status bar is missing.");
}
async function wheelUp(count) {
  for (let index = 0; index < count; index += 1) {
    child.write("\x1b[<64;10;5M");
    await delay(40);
  }
  await delay(180);
  await flush();
}

async function run() {
  ({ startRequestAudit: startAudit } = await import(pathToFileURL(path.join(packageRoot, "bridge/request-audit.mjs")).href));
  server = http.createServer(async (request, response) => {
    if (!request.url.endsWith("/responses") || request.method !== "POST") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ models: [] }));
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push({ headers: request.headers, body });
    activeResponse = response;
    response.once("close", () => { responseClosed = true; });
    audit = startAudit({
      surface: "native-test", account: "fixture-user", accountGeneration: "fixture-account",
      threadId: request.headers["thread-id"], requestedModel: body.model, upstreamModel: body.model,
      contextTier: "default", endpoint: "/responses", request: body,
    });
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    send({ type: "response.created", response: { id: "resp-stream-test" } });
    send({ type: "response.output_item.added", output_index: 0,
      item: { type: "message", role: "assistant", id: "msg-stream-test", content: [] } });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  let config = fs.readFileSync(path.join(__dirname, "fixtures/tui-layout/config.toml"), "utf8")
    .replaceAll("layout-test", "github-copilot")
    .replace("http://127.0.0.1:1", `http://127.0.0.1:${server.address().port}`)
    .replace('alternate_screen = "never"', 'alternate_screen = "always"\nraw_output_mode = false')
    .replace(/^status_line = .*$/m,
      'status_line = ["copilot-account", "model-with-reasoning", "request-state", "last-request-usage", "cache-hit"]');
  config = `model_reasoning_effort = "high"\n${config}`;
  fs.writeFileSync(path.join(profile, "config.toml"),
    `${config}\n[projects.${JSON.stringify(workspace)}]\ntrust_level = "trusted"\n`);
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(CODEX|CCODEX|OPENAI|GITHUB|COPILOT)_/.test(key)) delete env[key];
  }
  Object.assign(env, {
    CODEX_HOME: profile, CODEX_COPILOT_HOME: profile, CCODEX_NO_CD: "1",
    CODEX_COPILOT_CATALOG_FILE: path.join(profile, "models.json"),
    CODEX_COPILOT_SELECTION_FILE: path.join(profile, "selection-generation.json"),
    TEMP: temporary, TMP: temporary, TERM: "xterm-256color", COLORTERM: "truecolor",
    FORCE_COLOR: "3", SSH_TTY: "isolated-stream-test",
  });
  delete env.NO_COLOR;
  child = nodePty.spawn(core, ["-C", workspace], {
    cols: terminal.cols, rows: terminal.rows, cwd: workspace, env,
  });
  child.onData(data => { raw += data; terminal.write(data); });
  terminal.onData(data => child.write(data));
  exitPromise = new Promise(resolve => child.onExit(event => {
    exited = true; exitEvent = event; resolve();
  }));
  await waitFor(() => visible().includes("GitHub @fixture-user")
    && visible().includes("Pending first request") && !rows().slice(0, 10).join("\n").includes("loading"),
    "configured startup", 45000);
  report.pid = child.pid;
  child.write("\x1b[200~STREAM_PROBE\x1b[201~");
  await waitFor(() => visible().includes("STREAM_PROBE"), "draft");
  pressEnter();
  await check("request state is scoped to the actual native thread", async () => {
    await waitFor(() => requests.length === 1 && visible().includes("Request in flight"),
      "in-flight status", 60000);
    assert(requests[0].headers["thread-id"], "Native request did not supply a thread id.");
    assert.equal(requests[0].body.reasoning.effort, "high");
  });
  await check("streamed table and code are rich before any mouse input", async () => {
    delta("# Stream proof\n\n| Item | Result |\n| --- | --- |\n| Alpha | Ready |\n| Beta | Ready |\n\n```rust\nlet sample = 42;\n```\n\n");
    await waitFor(() => visible().includes("let sample = 42;"), "streamed code");
    assert(!visible().includes("| --- |"), "Raw Markdown table delimiter reached the visible transcript.");
    const row = rows().findIndex(line => line.includes("let sample"));
    const line = terminal.buffer.active.getLine(terminal.buffer.active.viewportY + row);
    assert(Array.from({ length: terminal.cols }, (_, x) => line.getCell(x))
      .some(cell => cell && cell.getChars().trim() && !cell.isFgDefault()), "Code syntax lost its colors.");
    assertBottom();
  });
  await check("live output follows new stream rows automatically", async () => {
    markers(1, 25);
    await waitFor(() => visible().includes("STREAM_ROW_25"), "automatic live following");
    assertBottom();
  });
  await check("new stream data does not move a manually paused viewport", async () => {
    await wheelUp(8);
    const before = historyTop();
    child.write("\x1b[200~draft survives\x1b[201~");
    await waitFor(() => visible().includes("draft survives"), "paused draft");
    markers(26, 45);
    await delay(900);
    await flush();
    assert.deepEqual(historyTop(), before);
    assert(visible().includes("Scrolled"));
    assertBottom();
  });
  await check("wheel-extended output selection copies while the agent keeps streaming", async () => {
    pressWinKey(40, 80, 0, 256);
    await waitFor(() => visible().includes("STREAM_ROW_45"), "selection starting at the live tail");
    await wheelUp(12);
    const screen = rows();
    const anchorRow = screen.findIndex((line, index) => index > 1 && /STREAM_ROW_\d+/.test(line));
    assert(anchorRow >= 0, "No output marker is available for selection.");
    const anchorColumn = screen[anchorRow].indexOf("STREAM_ROW_");
    const firstMarker = screen[anchorRow].match(/STREAM_ROW_\d+/)[0];
    const promptRow = screen.findLastIndex(line => /^\s*[›❯]/u.test(line));
    const pointerRow = Math.min(anchorRow + 8, promptRow - 3);
    const pointerColumn = terminal.cols - 3;
    child.write(`\x1b[<0;${anchorColumn + 1};${anchorRow + 1}M`);
    await delay(60);
    child.write(`\x1b[<32;${pointerColumn + 1};${pointerRow + 1}M`);
    await delay(60);
    for (let index = 0; index < 12; index += 1) {
      child.write(`\x1b[<65;${pointerColumn + 1};${pointerRow + 1}M`);
      await delay(60);
    }
    child.write(`\x1b[<0;${pointerColumn + 1};${pointerRow + 1}m`);
    await waitFor(() => visible().includes("Selection paused"), "extended selection");
    const before = historyTop();
    markers(46, 55);
    await delay(600);
    await flush();
    assert.deepEqual(historyTop(), before, "Live stream data moved the selected document.");
    const start = raw.length;
    pressControlKey(67, 46, 3);
    const copies = () => [...raw.slice(start).matchAll(/\x1b\]52;c;([A-Za-z0-9+/=]+)\x07/g)]
      .map(match => Buffer.from(match[1], "base64").toString("utf8"));
    await waitFor(() => copies().length === 1, "cross-screen selection copy");
    const copied = copies()[0];
    assert(copied.startsWith(firstMarker), "Copy did not preserve the selection anchor.");
    assert(copied.split("\n").length > terminal.rows, "Selection did not extend beyond a full screen.");
    const numbers = [...copied.matchAll(/STREAM_ROW_(\d+)/g)].map(match => Number(match[1]));
    assert(numbers.length > 15, "Cross-screen output markers were lost.");
    assert.deepEqual(numbers, Array.from({ length: numbers.length }, (_, index) => numbers[0] + index));
    assert(!copied.includes("STREAM_ROW_46"), "Stream updates rewrote the frozen selection.");
    child.write("\x1b[<2;10;5M\x1b[<2;10;5m");
    await waitFor(() => copies().length === 2, "right-click while streaming");
    assert.equal(copies()[1], copied);
    assert(!responseClosed, "Copy interrupted the in-flight provider request.");
    assert(visible().includes("Request in flight"));
    assert(visible().includes("draft survives"));
    assert.equal(requests.length, 1, "Copy caused a provider retry.");
  });
  await check("one Down reaches the new tail without changing the draft", async () => {
    pressWinKey(40, 80, 0, 256);
    await waitFor(() => visible().includes("STREAM_ROW_55")
      && !visible().includes("Scrolled") && !visible().includes("Selection paused"), "Down to live tail");
    assert(visible().includes("draft survives"));
  });
  await check("completion preserves rendered output and reports actual usage", async () => {
    send({ type: "response.output_item.done", item: {
      type: "message", role: "assistant", id: "msg-stream-test",
      content: [{ type: "output_text", text: completeText }],
    } });
    const usage = {
      input_tokens: 1000, input_tokens_details: { cached_tokens: 750 },
      output_tokens: 250, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 1250,
    };
    send({ type: "response.completed", response: { id: "resp-stream-test", usage } });
    audit.complete({ status: "complete", httpStatus: 200, usage });
    activeResponse.end();
    await waitFor(() => visible().includes("Request verified") && visible().includes("250 out"), "completed usage");
    assert.match(visible(), /Last 1K in \/ 250 out/);
    assert.match(visible(), /Cache 75\.0% \(750 read\)/);
    assert(visible().includes("STREAM_ROW_55"));
    assert.equal(requests.length, 1, "Native core retried or replayed the completed turn.");
    assertBottom();
  });
  await check("completed status fields survive a narrow resize", async () => {
    terminal.resize(68, 26);
    child.resize(68, 26);
    await delay(600);
    await flush();
    const text = visible().replace(/\s+/g, " ");
    for (const field of ["GitHub @fixture-user", "Request verified", "Last 1K in / 250 out", "750 read"]) {
      assert(text.includes(field), `Missing ${field}`);
    }
    assertBottom();
  });
}

run().catch(error => {
  report.error = error.stack || String(error);
  process.exitCode = 1;
}).finally(async () => {
  if (child && !exited) {
    child.write("\x01\x7f");
    await delay(100);
    child.write("\x03");
    await delay(150);
    child.write("\x04");
    await Promise.race([exitPromise, delay(8000)]);
  }
  report.exited = exited;
  report.exitEvent = exitEvent;
  if (!exited && child) {
    report.shutdownError = "Isolated native core did not exit after shutdown keys.";
    process.exitCode = 1;
  }
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await flush();
  report.finalFrame = frame();
  terminal.dispose();
  if (report.error) console.error(report.error);
  if (exited || !child) {
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    report.cleaned = true;
  }
  if (process.env.CCODEX_TUI_REPORT) fs.writeFileSync(process.env.CCODEX_TUI_REPORT, JSON.stringify(report, null, 2));
  if (exited || !child) process.exit(process.exitCode || 0);
});
