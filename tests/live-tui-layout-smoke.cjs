// Real native core + background ConPTY. Never touches the user's profile or clipboard.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const bundleRoot = path.resolve(__dirname, "..");
const nodePty = require(process.env.CCODEX_NODE_PTY || path.join(bundleRoot, "bin", "node-pty"));
const { Terminal } = require(process.env.CCODEX_XTERM_HEADLESS
  || path.join(os.tmpdir(), "copilot-xterm-node", "node_modules", "@xterm", "headless"));
const core = process.env.CCODEX_LIVE_CORE
  || fs.readFileSync(path.join(process.env.LOCALAPPDATA, "CodexCopilot", "bin", "core-current.txt"), "utf8").trim();
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-tui-layout-"));
const profile = path.join(root, "profile");
const workspace = path.join(root, "workspace");
const isolatedTemp = path.join(root, "tmp");
fs.mkdirSync(profile);
fs.mkdirSync(workspace);
fs.mkdirSync(isolatedTemp);
execFileSync("git", ["init", "--quiet", workspace], { windowsHide: true });
let config = fs.readFileSync(path.join(__dirname, "fixtures", "tui-layout", "config.toml"), "utf8");
if (process.env.CCODEX_TUI_ALTERNATE_SCREEN) {
  assert(["auto", "never", "always"].includes(process.env.CCODEX_TUI_ALTERNATE_SCREEN));
  config = config.replace('alternate_screen = "never"',
    `alternate_screen = "${process.env.CCODEX_TUI_ALTERNATE_SCREEN}"`);
}
if (process.env.CCODEX_CLIPBOARD_TEST_STATION) {
  config = `approval_policy = "never"\nsandbox_mode = "danger-full-access"\n${config}`;
}
fs.writeFileSync(path.join(profile, "config.toml"),
  `${config}\n[projects.${JSON.stringify(workspace)}]\ntrust_level = "trusted"\n`);

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
  // Force OSC52 for copy assertions, so no Windows clipboard reads/writes are involved.
  SSH_TTY: "isolated-layout-test",
  TEMP: isolatedTemp,
  TMP: isolatedTemp,
});
if (process.env.CCODEX_CLIPBOARD_TEST_STATION) {
  env.CCODEX_CLIPBOARD_TEST_STATION = process.env.CCODEX_CLIPBOARD_TEST_STATION;
}
delete env.NO_COLOR;
const terminal = new Terminal({ cols: 120, rows: 38, allowProposedApi: true });
const child = nodePty.spawn(core, ["-C", workspace], {
  cols: terminal.cols, rows: terminal.rows, cwd: workspace, env,
});
const report = {
  core,
  sha256: crypto.createHash("sha256").update(fs.readFileSync(core)).digest("hex"),
  pid: child.pid,
  isolatedProfile: true,
  foregroundInputUsed: false,
  clipboardMutation: false,
  clipboardScope: process.env.CCODEX_CLIPBOARD_TEST_STATION ? "isolated-window-station" : "none",
  realClipboardMutation: false,
  alternateScreen: process.env.CCODEX_TUI_ALTERNATE_SCREEN || "never",
  temporaryRoot: root,
  checks: [],
};
let raw = "";
let exited = false;
let exitEvent;
child.onData((data) => {
  raw += data;
  terminal.write(data);
});
terminal.onData((data) => child.write(data));
const exitPromise = new Promise((resolve) => child.onExit((event) => {
  exited = true;
  exitEvent = event;
  resolve(event);
}));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const flush = () => new Promise((resolve) => terminal.write("", resolve));
function rows() {
  const buffer = terminal.buffer.active;
  return Array.from({ length: terminal.rows }, (_, row) =>
    buffer.getLine(buffer.viewportY + row)?.translateToString(true, 0, terminal.cols) || "");
}
const visible = () => rows().join("\n");
function snapshot() {
  return {
    cols: terminal.cols, rows: terminal.rows, buffer: terminal.buffer.active.type,
    baseY: terminal.buffer.active.baseY, viewportY: terminal.buffer.active.viewportY,
    cursorX: terminal.buffer.active.cursorX, cursorY: terminal.buffer.active.cursorY,
    mouseMode: terminal.modes.mouseTrackingMode, screen: rows(),
    styledCells: styledCells(),
    tailScreen: Array.from({ length: terminal.rows }, (_, row) =>
      terminal.buffer.active.getLine(terminal.buffer.active.baseY + row)?.translateToString(true, 0, terminal.cols) || ""),
  };
}
function styledCells() {
  const buffer = terminal.buffer.active;
  const cells = [];
  for (let y = 0; y < terminal.rows; y += 1) {
    const line = buffer.getLine(buffer.viewportY + y);
    for (let x = 0; x < terminal.cols; x += 1) {
      const cell = line?.getCell(x);
      if (!cell || cell.getWidth() === 0) continue;
      const text = cell.getChars();
      if (!text.trim() && !cell.isInverse() && cell.isBgDefault()) continue;
      cells.push({
        x, y, text, width: cell.getWidth(),
        fgMode: cell.getFgColorMode(), fg: cell.getFgColor(),
        bgMode: cell.getBgColorMode(), bg: cell.getBgColor(),
        bold: Boolean(cell.isBold()), dim: Boolean(cell.isDim()), inverse: Boolean(cell.isInverse()),
        italic: Boolean(cell.isItalic()), underline: Boolean(cell.isUnderline()),
      });
    }
  }
  return cells;
}
function copiesSince(start) {
  return [...raw.slice(start).matchAll(/\x1b\]52;c;([A-Za-z0-9+/=]+)\x07/g)]
    .map((match) => Buffer.from(match[1], "base64").toString("utf8"));
}
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
async function waitFor(predicate, label, timeout = 8000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    await flush();
    if (predicate()) return;
    if (exited) throw new Error(`Core exited (${JSON.stringify(exitEvent)}): ${visible()}`);
    await delay(50);
  }
  throw new Error(`Timeout: ${label}\n${visible()}`);
}
async function check(name, run) {
  try {
    await run();
    report.checks.push({ name, passed: true, frame: snapshot() });
    process.stdout.write(`PASS ${name}\n`);
  } catch (error) {
    report.checks.push({ name, passed: false, error: error.message, frame: snapshot() });
    process.stdout.write(`FAIL ${name}: ${error.message}\n`);
    if (process.env.CCODEX_TUI_PROBE !== "1") throw error;
  }
}
function bottomIsStable() {
  const lines = rows();
  const prompt = lines.findLastIndex((line) => /^\s*[›❯]/u.test(line));
  return lines.findLastIndex((line) => line.trim()) >= terminal.rows - 2
    && prompt >= 0
    && lines.slice(prompt).join("\n").includes("Cache");
}
async function assertBottom() {
  await waitFor(bottomIsStable, "settled composer and status line", 15000);
  const lines = rows();
  const last = lines.findLastIndex((line) => line.trim());
  assert(last >= terminal.rows - 2,
    `Footer ended at row ${last + 1}/${terminal.rows}; ${terminal.rows - last - 1} empty rows below it`);
  const prompt = lines.findLastIndex((line) => /^\s*[›❯]/u.test(line));
  assert(prompt >= 0, "Live composer is missing");
  assert(lines.slice(prompt).join("\n").includes("Cache"), "Live status line is missing");
}
async function clearDraft() {
  pressControlKey(65, 30, 1);
  await delay(70);
  pressWinKey(8, 14, 8);
  await delay(150);
  await flush();
}
async function paste(text) {
  child.write(`\x1b[200~${text}\x1b[201~`);
  await waitFor(() => visible().includes(text.split("\n").at(-1)), `input ${JSON.stringify(text)}`);
  await delay(100);
  await flush();
}
function textLocation(text, cellOffset = 0) {
  const line = rows().findLastIndex((line) => line.includes(text));
  assert(line >= 0, `Visible text not found: ${JSON.stringify(text)}`);
  return { row: line, col: rows()[line].indexOf(text) + cellOffset };
}
async function click(text, cellOffset) {
  const { row, col } = textLocation(text, cellOffset);
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    child.write(`\x1b[<0;${col + 1};${row + 1}M\x1b[<0;${col + 1};${row + 1}m`);
    try {
      await waitFor(() => terminal.buffer.active.cursorX === col
        && terminal.buffer.active.cursorY === row, `cursor at ${col},${row}`, 3000);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
async function dragSelect(row, startCol, endCol) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await flush();
    child.write(`\x1b[<0;${startCol + 1};${row + 1}M`);
    await delay(60);
    child.write(`\x1b[<32;${endCol + 1};${row + 1}M`);
    await delay(60);
    child.write(`\x1b[<0;${endCol + 1};${row + 1}m`);
    try {
      await waitFor(() => styledCells().some((cell) => cell.y === row && cell.inverse),
        "output selection highlight", 3000);
      return;
    } catch (error) {
      if (exited) throw error;
      lastError = error;
      await delay(100);
    }
  }
  throw lastError;
}
async function wheel(direction, count = 1) {
  const button = direction === "up" ? 64 : 65;
  for (let index = 0; index < count; index += 1) {
    child.write(`\x1b[<${button};10;5M`);
    await delay(35);
  }
  await delay(180);
  await flush();
}
async function resize(cols, height) {
  terminal.resize(cols, height);
  child.resize(cols, height);
  await waitFor(bottomIsStable, `settled ${cols}x${height} resize`, 15000);
}
async function openTranscriptPager() {
  const shortcuts = [
    () => pressControlKey(84, 20, 20),
    () => child.write("\x14"),
    () => pressControlKey(84, 20, 20),
  ];
  let lastError;
  for (const sendShortcut of shortcuts) {
    sendShortcut();
    try {
      await waitFor(() => visible().includes("T R A N S C R I P T"), "native transcript pager", 6000);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
async function stop() {
  if (!exited) {
    child.write("\x03");
    await delay(300);
    child.write("\x04");
    await Promise.race([exitPromise, delay(8000)]);
  }
  if (!exited) child.kill();
  await Promise.race([exitPromise, delay(2500)]);
}

async function checkIsolatedClipboard() {
  const helper = path.join(__dirname, "clipboard-station.ps1");
  const station = process.env.CCODEX_CLIPBOARD_TEST_STATION;
  assert(station?.startsWith("ccodex-clipboard-test-"));
  const image = path.join(workspace, "clipboard-image.png");
  const document = path.join(workspace, "clipboard-report.docx");
  fs.writeFileSync(image, Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMIqFgAAAKEAWkyLad+AAAAAElFTkSuQmCC", "base64"));
  fs.writeFileSync(document, "private clipboard fixture");
  const fixture = path.join(root, "clipboard-fixture.json");
  fs.writeFileSync(fixture, JSON.stringify({
    imagePath: image, files: [document, image], text: "isolated clipboard text",
  }));
  const setClipboard = (action) => execFileSync("powershell.exe", [
    "-NoLogo", "-NoProfile", "-STA", "-ExecutionPolicy", "Bypass",
    "-File", helper, "-Action", action, "-Fixture", fixture,
  ], {
    windowsHide: true,
    env: { ...process.env, TEMP: isolatedTemp, TMP: isolatedTemp, CCODEX_CLIPBOARD_FIXTURE_ROOT: workspace },
  });
  await check("clipboard: core and fixture process use the private station", async () => {
    const quote = (value) => `'${value.replaceAll("'", "''")}'`;
    await paste(`!powershell.exe -NoProfile -ExecutionPolicy Bypass -File ${quote(helper)} -Action Probe`);
    pressEnter();
    await waitFor(() => visible().includes(`CCODEX_CLIPBOARD_STATION_OK=${station}`),
      "core descendant private station proof", 30000);
    const proof = setClipboard("Probe").toString("utf8");
    assert(proof.includes(`CCODEX_CLIPBOARD_STATION_OK=${station}`));
    report.clipboardStationVerified = true;
  });
  await check("clipboard: Ctrl+V attaches an actual bitmap", async () => {
    assert(report.clipboardStationVerified, "Never access a clipboard without station proof");
    setClipboard("Image");
    pressControlKey(86, 47, 22);
    await waitFor(() => /\[📷 ccodex-image-[^\]]+\.png\]/u.test(visible()), "bitmap filename label");
    await clearDraft();
  });
  await check("clipboard: empty terminal paste attaches an actual bitmap", async () => {
    setClipboard("Image");
    child.write("\x1b[200~\x1b[201~");
    await waitFor(() => /\[📷 ccodex-image-[^\]]+\.png\]/u.test(visible()), "empty paste bitmap");
    await clearDraft();
  });
  await check("clipboard: Ctrl+V keeps every copied file", async () => {
    setClipboard("Files");
    pressControlKey(86, 47, 22);
    await waitFor(() => visible().includes("[📄 clipboard-report.docx]")
      && visible().includes("[📷 clipboard-image.png]"), "clipboard file list labels");
    await clearDraft();
  });
  await check("clipboard: Ctrl+V still pastes ordinary text", async () => {
    setClipboard("Text");
    pressControlKey(86, 47, 22);
    await waitFor(() => visible().includes("isolated clipboard text"), "clipboard text fallback");
    await clearDraft();
  });
}

async function run() {
  process.stdout.write(`Core PID ${child.pid}; SHA256 ${report.sha256}\n`);
  await waitFor(() => /Cache/.test(visible()), "initial composer and status", 30000);
  report.pid = child.pid;
  await delay(1500);
  await waitFor(() => /Cache/.test(visible()) && rows().some((line) => /^\s*[›❯]/u.test(line)),
    "settled composer after startup history", 15000);
  await waitFor(() => rows().slice(0, 10).some((line) => /OpenAI Codex/.test(line))
    && !rows().slice(0, 10).some((line) => /\bloading\b/i.test(line)),
    "startup header reflects the configured model without mouse input", 60000);
  await flush();
  await check("startup: content above, composer/footer at bottom", async () => {
    await assertBottom();
    const lines = rows();
    const header = lines.findIndex((line) => /OpenAI Codex/.test(line));
    const prompt = lines.findLastIndex((line) => /^\s*[›❯]/u.test(line));
    assert(header >= 0 && header < 10, "Session header should remain near the top");
    assert(lines.slice(header + 5, prompt).some((line) => !line.trim()),
      "Unused space should be between transcript and composer");
  });
  await check("startup stays rich before any mouse input", async () => {
    assert(/[╭╰┌└]/u.test(visible()), "Rich header border disappeared");
    assert(visible().includes("/model to change"), "Header fell back to raw source text");
    assert(styledCells().some((cell) => cell.y < 10 && cell.fgMode !== 0),
      "Startup header lost all foreground styling");
  });
  if (process.env.CCODEX_CLIPBOARD_TEST_STATION) await checkIsolatedClipboard();
  await check("mouse reporting is enabled by default", async () => {
    assert.notEqual(terminal.modes.mouseTrackingMode, "none");
  });
  await paste("abcdef");
  await check("click inserts at exact ASCII position", async () => {
    await click("abcdef", 3);
    pressWinKey(88, 45, 120);
    await waitFor(() => /abcxdef/.test(visible()), "clicked insertion");
  });
  await clearDraft();
  await paste("ab中文cd");
  await check("click uses display columns for Chinese text", async () => {
    await click("ab中文cd", 6);
    pressWinKey(90, 44, 122);
    await waitFor(() => /ab中文zcd/.test(visible()), "Chinese clicked insertion");
  });
  await clearDraft();
  await paste("line-one");
  pressWinKey(13, 28, 13, 16);
  await delay(150);
  await paste("line-two");
  pressWinKey(13, 28, 13, 16);
  await delay(150);
  await paste("line-three");
  await check("click selects the requested multiline row", async () => {
    await click("line-two", 5);
    pressWinKey(88, 45, 120);
    await waitFor(() => /line-xtwo/.test(visible()), "multiline clicked insertion");
    await assertBottom();
  });
  await clearDraft();
  await check("Ctrl+A, OSC52 Ctrl+C, replacement and Ctrl+Z", async () => {
    await paste("copy-中文-proof");
    pressControlKey(65, 30, 1);
    await delay(100);
    const start = raw.length;
    pressControlKey(67, 46, 3);
    await waitFor(() => copiesSince(start).includes("copy-中文-proof"), "OSC52 composer copy", 5000);
    pressWinKey(82, 19, 114);
    await delay(150);
    pressControlKey(90, 44, 26);
    await waitFor(() => visible().includes("copy-中文-proof"), "undo restores selected draft");
  });
  await clearDraft();
  // /status creates native history without making paid requests or contacting a model.
  for (let index = 0; index < 7; index += 1) {
    await paste("/status");
    pressEnter();
    await delay(300);
  }
  await check("history overflow retains bottom composer/footer", async () => {
    await flush();
    await assertBottom();
  });
  await paste("scroll-draft");
  await check("wheel changes history while retaining the editable composer", async () => {
    const before = rows().slice(0, -8).join("\n");
    await wheel("up", 6);
    await assertBottom();
    assert(visible().includes("scroll-draft"), "Scrolling lost the draft");
    assert.notEqual(rows().slice(0, -8).join("\n"), before, "Wheel did not scroll history");
    await click("scroll-draft", 6);
    pressWinKey(81, 16, 113);
    await waitFor(() => visible().includes("scrollq-draft"), "editing while scrolled", 15000);
  });
  await check("output drag and Ctrl+C copy without editing or interrupting", async () => {
    const outputRow = rows().findIndex((line) => line.includes("gpt-5.6-sol"));
    assert(outputRow >= 0 && outputRow < terminal.rows - 8, "Expected model text in output history");
    const column = rows()[outputRow].indexOf("gpt-5.6-sol");
    const expected = "gpt-5.6-sol";
    await dragSelect(outputRow, column, column + expected.length);
    await flush();
    const start = raw.length;
    pressControlKey(67, 46, 3);
    await delay(160);
    await flush();
    assert(copiesSince(start).includes(expected), `Copied ${JSON.stringify(copiesSince(start))}`);
    assert(visible().includes("scrollq-draft"), "Output copy changed the composer");
    assert(!exited, "Output copy terminated the native core");
  });
  await check("right-click copies the output selection", async () => {
    const start = raw.length;
    child.write("\x1b[<2;10;5M\x1b[<2;10;5m");
    await delay(180);
    await flush();
    assert(copiesSince(start).includes("gpt-5.6-sol"));
    assert(visible().includes("scrollq-draft"));
  });
  await check("one Down key returns to the latest output", async () => {
    pressWinKey(40, 80, 0, 256);
    await waitFor(() => !visible().includes("Selection paused") && !visible().includes("Scrolled ·"),
      "Down restores live following");
    await assertBottom();
    assert(visible().includes("scrollq-draft"));
    await wheel("up", 6);
    assert(visible().includes("Scrolled"), "Wheel did not pause live following");
  });
  await check("output scrollbar thumb can be dragged to the top", async () => {
    child.write(`\x1b[<0;${terminal.cols};2M\x1b[<32;${terminal.cols};1M\x1b[<0;${terminal.cols};1m`);
    await delay(250);
    await flush();
    assert(/OpenAI Codex/.test(rows().slice(0, 10).join("\n")), "Scrollbar did not reach the first output rows");
    await assertBottom();
  });
  await check("resize while scrolled preserves draft and footer", async () => {
    await resize(68, 26);
    await assertBottom();
    assert(visible().includes("scrollq-draft"));
    await resize(140, 46);
    await assertBottom();
    await resize(239, 56);
    await assertBottom();
    assert(visible().includes("scrollq-draft"));
    await resize(140, 46);
  });
  await check("return to latest history retains bottom layout", async () => {
    await wheel("down", 60);
    await assertBottom();
    assert(visible().includes("scrollq-draft"));
    assert.equal(terminal.buffer.active.type,
      !process.env.CCODEX_TUI_ALTERNATE_SCREEN || process.env.CCODEX_TUI_ALTERNATE_SCREEN === "never"
        ? "normal" : "alternate");
  });
  await check("transcript pager closes without leaving old chrome over the composer", async () => {
    await openTranscriptPager();
    pressWinKey(81, 16, 113);
    await waitFor(() => !visible().includes("T R A N S C R I P T") && visible().includes("scrollq-draft"),
      "pager returns to the live composer");
    await assertBottom();
  });
  await clearDraft();
  await check("model popup closes without damaging the footer", async () => {
    await paste("/model");
    pressEnter();
    await waitFor(() => /Select Model/.test(visible()), "model picker");
    pressWinKey(27, 1, 27);
    await waitFor(() => !/Select Model and Effort/.test(visible()) && /Cache/.test(visible()),
      "model picker closes");
    await flush();
    await assertBottom();
  });
  await check("short history after Ctrl+L retains top/bottom layout", async () => {
    pressControlKey(76, 38, 12);
    await waitFor(() => /\/model to change/.test(visible()) && /Cache/.test(visible()),
      "clear redraws the session header and composer");
    await delay(200);
    await flush();
    await assertBottom();
    assert(rows().findIndex((line) => /OpenAI Codex/.test(line)) < 10);
  });
  await check("multi-file drops keep filename labels after native submission", async () => {
    const document = path.join(workspace, "report.docx");
    const data = path.join(workspace, "data.csv");
    const image = path.join(workspace, "screen.png");
    fs.writeFileSync(document, "isolated file attachment fixture");
    fs.writeFileSync(data, "a,b\n1,2\n");
    fs.writeFileSync(image, Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMIqFgAAAKEAWkyLad+AAAAAElFTkSuQmCC", "base64"));
    const drop = `\x1b[200~${[document, data, image].map((file) => `"${file}"`).join(" ")}\x1b[201~`;
    let dropError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      child.write(drop);
      try {
        await waitFor(() => visible().includes("[📄 report.docx")
          && visible().includes("[📄 data.csv")
          && visible().includes("[📷 screen.png"), "individual drop labels", 15000);
        dropError = null;
        break;
      } catch (error) {
        dropError = error;
        await clearDraft();
        await delay(500);
      }
    }
    if (dropError) throw dropError;
    assert(visible().includes("[📄 data.csv"));
    pressEnter();
    await waitFor(() => rows().some((line) => /^\s*[›❯]/u.test(line) && line.includes("Ask"))
      || visible().includes("Failed") || visible().includes("error") || visible().includes("Working"),
      "submitted attachment prompt", 10000);
    await delay(400);
    await flush();
    assert(visible().includes("[📄 report.docx") && visible().includes("[📄 data.csv")
      && visible().includes("[📷 screen.png"), "History lost the filename attachment labels");
    assert(!visible().includes("[Image #"), "History exposed protocol-only image labels");
    await assertBottom();
  });
}

run().catch((error) => {
  report.error = error.stack || String(error);
  process.exitCode = 1;
}).finally(async () => {
  await flush();
  report.finalFrame = snapshot();
  await stop();
  report.exited = exited;
  report.exitEvent = exitEvent;
  report.rawTail = raw.slice(-24000);
  if (report.checks.some((check) => !check.passed)) process.exitCode = 1;
  if (report.error) process.stderr.write(`${report.error}\n`);
  terminal.dispose();
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
    report.cleaned = true;
  } catch (error) {
    report.cleaned = false;
    report.cleanupError = error.message;
    process.stderr.write(`Cleanup pending after native process exit: ${root}\n`);
    process.exitCode = 1;
  }
  if (process.env.CCODEX_TUI_REPORT) {
    fs.writeFileSync(process.env.CCODEX_TUI_REPORT, JSON.stringify(report, null, 2));
  }
  process.exit(process.exitCode || 0);
});
