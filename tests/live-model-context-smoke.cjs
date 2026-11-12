// Real native core + background ConPTY. Never touches the user's profile.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const packageRoot = process.env.CCODEX_PACKAGE_ROOT || path.resolve(__dirname, "..");
const core = process.env.CCODEX_LIVE_CORE;
assert(core && fs.existsSync(core), "CCODEX_LIVE_CORE must name the candidate core");
const nodePty = require(process.env.CCODEX_NODE_PTY || path.join(packageRoot, "bin", "node-pty"));
const { Terminal } = require(process.env.CCODEX_XTERM_HEADLESS
  || path.join(os.tmpdir(), "copilot-xterm-node", "node_modules", "@xterm", "headless"));

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-context-flow-"));
const profile = path.join(root, "profile");
const workspace = path.join(root, "workspace");
const isolatedTemp = path.join(root, "tmp");
fs.mkdirSync(profile);
fs.mkdirSync(workspace);
fs.mkdirSync(isolatedTemp);
const alternateScreen = process.env.CCODEX_TUI_ALTERNATE_SCREEN || "never";
const namedProfile = process.env.CCODEX_TEST_PROFILE || null;
fs.writeFileSync(path.join(profile, "config.toml"), `
model = "gpt-5.6-sol"
model_provider = "context-flow-test"
check_for_update_on_startup = false
ephemeral = true
disable_paste_burst = true

[model_providers.context-flow-test]
name = "Isolated context flow test"
base_url = "http://127.0.0.1:1"
wire_api = "responses"
requires_openai_auth = false
request_max_retries = 0
stream_max_retries = 0

[tui]
alternate_screen = "${alternateScreen}"
status_line = ["model-with-reasoning", "context-used", "context-window-size"]

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
const originalSharedConfig = fs.readFileSync(path.join(profile, "config.toml"), "utf8");
if (namedProfile) {
  assert.match(namedProfile, /^[a-z][a-z0-9_-]*$/);
  fs.writeFileSync(path.join(profile, `${namedProfile}.config.toml`),
    'model = "gpt-5.6-sol"\n');
}

const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (/^(CODEX|CCODEX|OPENAI|GITHUB|COPILOT)_/.test(key)) delete env[key];
}
Object.assign(env, {
  CODEX_HOME: profile,
  CODEX_COPILOT_HOME: profile,
  CODEX_COPILOT_CATALOG_FILE: path.join(profile, "models.json"),
  CODEX_COPILOT_SELECTION_FILE: path.join(profile, "selection-generation.json"),
  CCODEX_NO_CD: "1",
  TERM: "xterm-256color",
  COLORTERM: "truecolor",
  FORCE_COLOR: "3",
  SSH_TTY: "isolated-context-flow-test",
  TEMP: isolatedTemp,
  TMP: isolatedTemp,
});
delete env.NO_COLOR;
if (namedProfile) delete env.CODEX_COPILOT_SELECTION_FILE;

const terminal = new Terminal({ cols: 100, rows: 32, allowProposedApi: true });
const child = nodePty.spawn(core, [
  ...(namedProfile ? ["--profile", namedProfile] : []), "-C", workspace,
], {
  cols: terminal.cols, rows: terminal.rows, cwd: workspace, env,
});
let raw = "";
let exited = false;
let exitEvent;
child.onData((data) => { raw += data; terminal.write(data); });
terminal.onData((data) => child.write(data));
const exitPromise = new Promise((resolve) => child.onExit((event) => {
  exited = true;
  exitEvent = event;
  resolve(event);
}));
const report = {
  core,
  sha256: crypto.createHash("sha256").update(fs.readFileSync(core)).digest("hex"),
  pid: child.pid,
  isolatedProfile: true,
  alternateScreen,
  temporaryRoot: root,
  checks: [],
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const flush = () => new Promise((resolve) => terminal.write("", resolve));
function rows() {
  const buffer = terminal.buffer.active;
  return Array.from({ length: terminal.rows }, (_, row) =>
    buffer.getLine(buffer.viewportY + row)?.translateToString(true, 0, terminal.cols) || "");
}
const visible = () => rows().join("\n");
const snapshot = () => ({
  cols: terminal.cols,
  rows: terminal.rows,
  buffer: terminal.buffer.active.type,
  screen: rows(),
});
async function waitFor(predicate, label, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await flush();
    if (predicate()) return;
    if (exited) throw new Error(`Core exited (${JSON.stringify(exitEvent)}): ${visible()}`);
    await delay(50);
  }
  throw new Error(`Timeout: ${label}\n${visible()}`);
}
async function check(name, run) {
  await run();
  report.checks.push({ name, passed: true, frame: snapshot() });
  process.stdout.write(`PASS ${name}\n`);
}
async function paste(text) {
  child.write(`\x1b[200~${text}\x1b[201~`);
  await waitFor(() => visible().includes(text), `input ${JSON.stringify(text)}`);
}
const readConfig = () => fs.readFileSync(path.join(profile,
  namedProfile ? `${namedProfile}.config.toml` : "config.toml"), "utf8");
function assertSelectionUncommitted() {
  const config = readConfig();
  assert.match(config, /^model\s*=\s*"gpt-5\.6-sol"/m);
  assert.doesNotMatch(config, /^service_tier\s*=/m);
  assert.doesNotMatch(config, /^model_reasoning_effort\s*=/m);
}
function selectedRowIncludes(label) {
  return rows().some((line) => /^\s*›/u.test(line) && line.includes(label));
}
async function selectRow(label) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await flush();
    if (selectedRowIncludes(label)) return;
    child.write("\x1b[B");
    await delay(80);
  }
  throw new Error(`Could not select ${JSON.stringify(label)}\n${visible()}`);
}
async function exerciseSelectedEffort() {
  if (!selectedRowIncludes("High")) return;
  for (const [label, key] of [["Low", "\x1b[A"], ["High", "\x1b[B"]]) {
    let stable = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      assert.match(visible(), /Select Reasoning Level for gpt-5\.4/);
      child.write(key);
      await delay(200);
      await flush();
      if (!selectedRowIncludes(label)) continue;
      await delay(200);
      await flush();
      if (selectedRowIncludes(label)) {
        stable = true;
        break;
      }
    }
    assert(stable, `Effort selection did not settle on ${label}\n${visible()}`);
  }
}
async function confirmPopup(title, label) {
  const enterUp = "\x1b[13;28;13;0;0;1_";
  const enterKeys = [
    `\x1b[13;28;13;1;0;1_${enterUp}`,
    `\r${enterUp}`,
    "\x1b[13;1u",
  ];
  child.write(enterUp);
  await delay(100);
  let lastError;
  for (const key of enterKeys) {
    child.write(key);
    try {
      await waitFor(() => !title.test(visible()), label, 5000);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
async function publishCatalog() {
  const { buildCatalog } = await import(
    pathToFileURL(path.join(packageRoot, "bridge", "catalog.mjs")).href
  );
  const catalog = buildCatalog([{
    id: "gpt-5.4",
    name: "GPT-5.4",
    vendor: "OpenAI",
    model_picker_enabled: true,
    supported_endpoints: ["/responses"],
    default_reasoning_effort: "high",
    capabilities: {
      type: "chat",
      family: "gpt-5.4",
      supports: { reasoning_effort: ["low", "high"], parallel_tool_calls: true },
      limits: {
        max_prompt_tokens: 922000,
        max_context_window_tokens: 1050000,
        max_output_tokens: 128000,
      },
    },
    codex_copilot_context: {
      default_prompt_tokens: 272000,
      long_context_prompt_tokens: 922000,
    },
  }]);
  assert.equal(catalog.models.length, 1);
  assert.equal(catalog.models[0].service_tiers[0].description, "400K");
  assert.equal(catalog.models[0].service_tiers[0].name, "1.1M");
  fs.writeFileSync(path.join(profile, "models.json"), JSON.stringify(catalog));
  fs.writeFileSync(path.join(profile, "catalog-generation.json"), `${Date.now()}\n`);
  await delay(2500);
}
async function stop() {
  if (!exited) {
    child.write("\x03");
    await delay(250);
    child.write("\x04");
    await Promise.race([exitPromise, delay(8000)]);
  }
  if (!exited) child.kill();
  await Promise.race([exitPromise, delay(2500)]);
}

async function run() {
  process.stdout.write(`Core PID ${child.pid}; SHA256 ${report.sha256}\n`);
  await waitFor(() => rows().some((line) => /^\s*[›❯]/u.test(line)), "initial composer", 30000);
  report.pid = child.pid;
  assert(Number.isSafeInteger(report.pid) && report.pid > 0, "The actual fixture core PID must be known.");
  await publishCatalog();
  // The native catalog watcher polls every 500ms; do not open an old picker
  // before the generated fixture catalog has reached its committed state.
  await delay(1200);
  await paste("/model");
  child.write("\r");
  await waitFor(() => /Select Model/.test(visible()) && /gpt-5\.4/.test(visible()), "model step");
  await check("model step has no independent Context row", async () => {
    assert(!rows().some((line) => /^\s*(?:›\s*)?\d+\.\s+Context(?:\s|$)/u.test(line)));
    assertSelectionUncommitted();
  });
  child.write("\r");
  await waitFor(() => /Select Context Window for gpt-5\.4/.test(visible()), "context step");
  await check("context step shows Copilot 400K and 1.1M tiers", async () => {
    assert(visible().includes("400K"));
    assert(visible().includes("1.1M"));
    assertSelectionUncommitted();
  });
  await selectRow("1.1M");
  child.write("\r");
  await waitFor(() => /Select Reasoning Level for gpt-5\.4/.test(visible()), "effort step");
  await check("effort step follows Context without an early commit", async () => {
    assert(visible().includes("Low"));
    assert(visible().includes("High"));
    assertSelectionUncommitted();
  });
  await selectRow("High");
  await exerciseSelectedEffort();
  await confirmPopup(/Select Reasoning Level for gpt-5\.4/, "effort confirmation");
  await waitFor(
    () => /Model changed to gpt-5\.4 with 1\.1M context and high reasoning/.test(visible()),
    "final atomic selection",
    30000,
  );
  await waitFor(() => {
    const config = readConfig();
    return /^model\s*=\s*"gpt-5\.4"/m.test(config)
      && /^model_reasoning_effort\s*=\s*"high"/m.test(config)
      && /^service_tier\s*=\s*"context-long"/m.test(config);
  }, "persisted model, Context and effort", 30000);
  await check("final confirmation atomically persists model, Context and effort", async () => {
    const config = readConfig();
    assert.match(config, /^model\s*=\s*"gpt-5\.4"/m);
    assert.match(config, /^model_reasoning_effort\s*=\s*"high"/m);
    assert.match(config, /^service_tier\s*=\s*"context-long"/m);
    if (namedProfile) {
      assert.equal(fs.readFileSync(path.join(profile, "config.toml"), "utf8"),
        originalSharedConfig, "CLI model/effort/context must not change Desktop defaults");
    }
  });
  await waitFor(
    () => /Context 0\/876K \(0\.0%\)/.test(visible()),
    "selected effective context in status line",
  );
  await check("status line uses the selected effective context without a duplicate tier", async () => {
    const status = rows().find((line) => line.includes("Context 0/876K (0.0%)"));
    assert(status, "status line must show 95% of the selected 922K prompt window");
    assert(!status.includes("Context long"), "the context-tier segment must not be present");
    assert.equal((status.match(/Context /g) || []).length, 1);
  });
  child.resize(48, 46);
  terminal.resize(48, 46);
  await waitFor(
    () => /Context 0\/876K \(0\.0%\)/.test(
      rows().slice(-12).join(" ").replace(/\s+/g, " ")
    ),
    "wrapped selected effective context in narrow status line",
  );
  await check("narrow status wraps without restoring a duplicate Context tier", async () => {
    const footer = rows().slice(-12).join(" ").replace(/\s+/g, " ");
    assert.match(footer, /gpt-5\.4/);
    assert.match(footer, /Context 0\/876K \(0\.0%\)/);
    assert.equal((footer.match(/Context 0\/876K/g) || []).length, 1);
    assert.doesNotMatch(footer, /Context (?:default|long)\s+\(/);
  });
}

run().catch((error) => {
  report.error = error.stack || String(error);
  process.exitCode = 1;
}).finally(async () => {
  await flush();
  report.finalFrame = snapshot();
  report.config = readConfig();
  await stop();
  report.exited = exited;
  report.exitEvent = exitEvent;
  report.rawTail = raw.slice(-16000);
  terminal.dispose();
  let cleanupError;
  for (let attempt = 0; attempt < 6 && fs.existsSync(root); attempt += 1) {
    await delay(1000);
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
    } catch (error) {
      cleanupError = error;
    }
  }
  report.cleaned = !fs.existsSync(root);
  if (!report.cleaned) {
    const error = cleanupError || new Error(`Temporary root remains: ${root}`);
    report.cleaned = false;
    report.cleanupError = error.message;
    process.exitCode = 1;
  }
  if (process.env.CCODEX_TUI_REPORT) {
    fs.writeFileSync(process.env.CCODEX_TUI_REPORT, JSON.stringify(report, null, 2));
  }
  if (report.error) process.stderr.write(`${report.error}\n`);
  process.exit(process.exitCode || 0);
});
