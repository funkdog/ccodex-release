const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const nodePtyRoot = [
  process.env.CCODEX_NODE_PTY,
  path.resolve(__dirname, "..", "bin", "node-pty"),
  path.join(process.env.LOCALAPPDATA || "", "CodexCopilot", "bin", "node-pty"),
].find((candidate) => candidate && fs.existsSync(candidate));
if (!nodePtyRoot) throw new Error("node-pty is required; set CCODEX_NODE_PTY.");
let xtermRoot = [
  process.env.CCODEX_XTERM_HEADLESS,
  path.join(os.tmpdir(), "copilot-xterm-node", "node_modules", "@xterm", "headless"),
].find((candidate) => candidate && fs.existsSync(candidate));
if (!xtermRoot) {
  const prefix = path.join(os.tmpdir(), "copilot-xterm-node");
  execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", [
    "install", "--prefix", prefix, "@xterm/headless@latest", "--no-audit", "--no-fund",
  ], { stdio: "ignore" });
  xtermRoot = path.join(prefix, "node_modules", "@xterm", "headless");
}

const nodePty = require(nodePtyRoot);
const { Terminal } = require(xtermRoot);
const launcher = process.env.CCODEX_LIVE_LAUNCHER || path.join(
  process.env.USERPROFILE,
  "bin",
  "ccodex.cmd",
);
const liveCore = process.env.CCODEX_LIVE_CORE || null;
const modelRenderRounds = Math.max(1, Number(process.env.CCODEX_MODEL_RENDER_ROUNDS) || 12);
const skipClipboardMutation = process.env.CCODEX_SKIP_CLIPBOARD_MUTATION === "1";
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-mouse-smoke-"));
const originalClipboardText = path.join(workspace, "original-clipboard.txt");
const originalClipboardImage = path.join(workspace, "original-clipboard.png");
const originalClipboardFiles = path.join(workspace, "original-clipboard-files.txt");
const originalClipboardAudio = path.join(workspace, "original-clipboard-audio.bin");
let originalClipboardKind = null;
const codexCopilotHome = process.env.CODEX_COPILOT_HOME || path.join(
  process.env.USERPROFILE,
  ".codex-copilot",
);
const modelManager = path.resolve(__dirname, "..", "bridge", "cli.mjs");

function readModelSelection() {
  const configPath = path.join(codexCopilotHome, "config.toml");
  if (!fs.existsSync(configPath)) return null;
  const config = fs.readFileSync(configPath, "utf8");
  const value = (name) => config.match(new RegExp(`^${name}\\s*=\\s*"([^"]+)"`, "m"))?.[1] || null;
  const model = value("model");
  const effort = value("model_reasoning_effort");
  if (!model || !effort) return null;
  return {
    model,
    effort,
    contextTier: value("service_tier") === "context-long" ? "long_context" : "default",
  };
}

const originalModelSelection = readModelSelection();

function restoreModelSelection() {
  if (!originalModelSelection) return;
  const current = readModelSelection();
  if (JSON.stringify(current) === JSON.stringify(originalModelSelection)) return;
  execFileSync(process.execPath, [
    modelManager,
    "use",
    originalModelSelection.model,
    originalModelSelection.effort,
    originalModelSelection.contextTier,
  ], {
    env: { ...process.env, CODEX_COPILOT_HOME: codexCopilotHome },
    stdio: "ignore",
    windowsHide: true,
  });
}

function psQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function runClipboardPowerShell(script) {
  let lastError;
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    try {
      return execFileSync("powershell.exe", [
        "-NoLogo", "-NoProfile", "-STA", "-Command", script,
      ], { encoding: "utf8", windowsHide: true }).trim();
    } catch (error) {
      lastError = error;
      if (attempt < 10) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
      }
    }
  }
  throw lastError;
}

function captureClipboard() {
  originalClipboardKind = runClipboardPowerShell(`
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    if ([Windows.Forms.Clipboard]::ContainsImage()) {
      $image = [Windows.Forms.Clipboard]::GetImage()
      try { $image.Save(${psQuote(originalClipboardImage)}, [Drawing.Imaging.ImageFormat]::Png) }
      finally { $image.Dispose() }
      [Console]::Write('image')
    } elseif ([Windows.Forms.Clipboard]::ContainsFileDropList()) {
      [IO.File]::WriteAllLines(
        ${psQuote(originalClipboardFiles)},
        [Windows.Forms.Clipboard]::GetFileDropList(),
        [Text.UTF8Encoding]::new($false)
      )
      [Console]::Write('files')
    } elseif ([Windows.Forms.Clipboard]::ContainsAudio()) {
      $input = [Windows.Forms.Clipboard]::GetAudioStream()
      $output = [IO.File]::Create(${psQuote(originalClipboardAudio)})
      try { $input.CopyTo($output) }
      finally { $output.Dispose(); $input.Dispose() }
      [Console]::Write('audio')
    } elseif ([Windows.Forms.Clipboard]::ContainsText()) {
      [IO.File]::WriteAllText(
        ${psQuote(originalClipboardText)},
        [Windows.Forms.Clipboard]::GetText(),
        [Text.UTF8Encoding]::new($false)
      )
      [Console]::Write('text')
    } else {
      $data = [Windows.Forms.Clipboard]::GetDataObject()
      if ($null -ne $data -and $data.GetFormats().Count -gt 0) {
        [Console]::Write('unsupported')
      } else {
        [Console]::Write('empty')
      }
    }
  `);
}

function setClipboardText(value) {
  runClipboardPowerShell(`
    Add-Type -AssemblyName System.Windows.Forms
    [Windows.Forms.Clipboard]::SetText(${psQuote(value)})
  `);
}

function setClipboardImage() {
  runClipboardPowerShell(`
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $bitmap = [Drawing.Bitmap]::new(3, 2)
    try {
      $bitmap.SetPixel(0, 0, [Drawing.Color]::DodgerBlue)
      [Windows.Forms.Clipboard]::SetImage($bitmap)
    } finally {
      $bitmap.Dispose()
    }
  `);
}

function restoreClipboard() {
  if (originalClipboardKind === null) return;
  if (originalClipboardKind === "unsupported") return;
  if (originalClipboardKind === "text") {
    runClipboardPowerShell(`
      Add-Type -AssemblyName System.Windows.Forms
      $text = [IO.File]::ReadAllText(${psQuote(originalClipboardText)}, [Text.Encoding]::UTF8)
      [Windows.Forms.Clipboard]::SetText($text)
    `);
  } else if (originalClipboardKind === "image") {
    runClipboardPowerShell(`
      Add-Type -AssemblyName System.Windows.Forms
      Add-Type -AssemblyName System.Drawing
      $source = [Drawing.Image]::FromFile(${psQuote(originalClipboardImage)})
      try { $copy = [Drawing.Bitmap]::new($source) } finally { $source.Dispose() }
      try { [Windows.Forms.Clipboard]::SetImage($copy) } finally { $copy.Dispose() }
    `);
  } else if (originalClipboardKind === "files") {
    runClipboardPowerShell(`
      Add-Type -AssemblyName System.Windows.Forms
      $files = [Collections.Specialized.StringCollection]::new()
      [void]$files.AddRange([IO.File]::ReadAllLines(
        ${psQuote(originalClipboardFiles)},
        [Text.Encoding]::UTF8
      ))
      [Windows.Forms.Clipboard]::SetFileDropList($files)
    `);
  } else if (originalClipboardKind === "audio") {
    runClipboardPowerShell(`
      Add-Type -AssemblyName System.Windows.Forms
      [Windows.Forms.Clipboard]::SetAudio([IO.File]::ReadAllBytes(${psQuote(originalClipboardAudio)}))
    `);
  } else {
    runClipboardPowerShell(`
      Add-Type -AssemblyName System.Windows.Forms
      [Windows.Forms.Clipboard]::Clear()
    `);
  }
}

const terminal = new Terminal({ cols: 140, rows: 46, allowProposedApi: true });
const coreArgs = [
  "-c", "ephemeral=true",
  "-m", "gpt-5.6-sol",
  "-C", workspace,
];
const liveEnv = {
  ...process.env,
  TERM: "xterm-256color",
  COLORTERM: "truecolor",
  FORCE_COLOR: "3",
  CCODEX_NO_CD: "1",
  CCODEX_SMART_PASTE: process.env.CCODEX_SMART_PASTE ?? "1",
  CODEX_HOME: codexCopilotHome,
  CODEX_COPILOT_HOME: codexCopilotHome,
  CODEX_COPILOT_CATALOG_FILE: path.join(codexCopilotHome, "models.json"),
  CODEX_COPILOT_SELECTION_FILE: path.join(codexCopilotHome, "selection-generation.json"),
  ...(skipClipboardMutation ? { SSH_TTY: "ccodex-live-verification" } : {}),
};
delete liveEnv.CCODEX_MOUSE_CAPTURE;
const child = nodePty.spawn(
  liveCore || process.env.ComSpec || "cmd.exe",
  liveCore ? coreArgs : ["/d", "/c", launcher, ...coreArgs],
  {
  cols: 140,
  rows: 46,
  cwd: workspace,
  env: liveEnv,
  },
);

let raw = "";
let exited = false;
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
child.onData((chunk) => {
  raw += chunk;
  terminal.write(chunk);
});
terminal.onData((chunk) => child.write(chunk));
const exitPromise = new Promise((resolve) => child.onExit((event) => {
  exited = true;
  resolve(event);
}));

async function flushTerminal() {
  await new Promise((resolve) => terminal.write("", resolve));
}

function screenText() {
  const buffer = terminal.buffer.active;
  const lines = [];
  for (let row = 0; row < buffer.length; row += 1) {
    lines.push(buffer.getLine(row)?.translateToString(true) || "");
  }
  return lines.join("\n");
}

function visibleScreenRows() {
  const buffer = terminal.buffer.active;
  return Array.from({ length: terminal.rows }, (_, row) => {
    const bufferRow = buffer.viewportY + row;
    return {
      row,
      bufferRow,
      text: buffer.getLine(bufferRow)?.translateToString(true) || "",
    };
  });
}

async function clickComposerAtTextOffset(text, offset) {
  await flushTerminal();
  const match = visibleScreenRows().reverse().find((line) => line.text.includes(text));
  if (!match) {
    throw new Error(`Could not find ${JSON.stringify(text)} in the visible composer.`);
  }
  const column = match.text.indexOf(text) + offset;
  child.write(`\x1b[<0;${column + 1};${match.row + 1}M`);
  child.write(`\x1b[<0;${column + 1};${match.row + 1}m`);
  await delay(250);
}

async function dragComposerTextRange(text, startOffset, endOffset) {
  await flushTerminal();
  const match = visibleScreenRows().reverse().find((line) => line.text.includes(text));
  if (!match) throw new Error(`Could not find ${JSON.stringify(text)} for composer drag selection.`);
  const textColumn = match.text.indexOf(text);
  const startColumn = textColumn + startOffset + 1;
  const endColumn = textColumn + endOffset + 1;
  const row = match.row + 1;
  child.write(`\x1b[<0;${startColumn};${row}M`);
  child.write(`\x1b[<32;${endColumn};${row}M`);
  child.write(`\x1b[<0;${endColumn};${row}m`);
  await delay(250);
}

async function waitForScreen(pattern, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await flushTerminal();
    if (pattern.test(screenText())) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${pattern}. Screen:\n${screenText().slice(-4_000)}`);
}

function assertConsecutiveModelRows(label) {
  const pickerScreen = screenText();
  const popup = pickerScreen.slice(pickerScreen.lastIndexOf("Select Model and Effort"));
  const numbers = [...popup.matchAll(/^\s*[› ]\s*(\d+)\.\s+\S/gm)].map((match) => Number(match[1]));
  if (numbers.length < 6) {
    throw new Error(`${label} exposed too few visible rows: ${numbers.join(", ")}\n${popup}`);
  }
  for (let index = 1; index < numbers.length; index += 1) {
    if (numbers[index] !== numbers[index - 1] + 1) {
      throw new Error(`${label} lost a row between ${numbers[index - 1]} and ${numbers[index]}.\n${popup}`);
    }
  }
}

async function openModelPicker(round) {
  child.write("/model");
  await waitForScreen(/^›\s*\/model\s*$/m, 3_000);
  let lastError;
  for (const enter of ["\r", "\n", "\r\n"]) {
    child.write(enter);
    try {
      await waitForScreen(/Select Model and Effort/, 3_000);
      return;
    } catch (error) {
      lastError = error;
      if (/Select Model and Effort/.test(screenText())) return;
    }
  }
  throw new Error(`Model picker round ${round} did not open after Enter retries. ${lastError?.message || ""}`);
}

async function selectMaxEffortAndAssertAnimation() {
  async function selectMaxAndCapture(label) {
    await openModelPicker(label);
    child.write("\r");
    await waitForScreen(/Select Reasoning Level for gpt-5\.6-sol/, 5_000);
    child.write("\x1b[F");
    await delay(150);
    child.write("\r");
    await waitForScreen(/Advanced Reasoning/, 5_000);
    child.write("\x1b[H");
    await delay(150);

    const animationStart = raw.length;
    child.write("\r");
    await delay(1_600);
    await flushTerminal();
    const animationOutput = raw.slice(animationStart);
    const trueColorSamples = animationOutput.match(
      /\x1b\[(?:38|48);2;\d+;\d+;\d+m/g,
    ) || [];
    if (trueColorSamples.length < 4) {
      throw new Error(
        `${label} emitted only ${trueColorSamples.length} TrueColor animation samples. ` +
        `Output bytes: ${animationOutput.length}. Screen:\n${screenText().slice(-5_000)}`,
      );
    }
    if (/Advanced Reasoning/.test(screenText())) {
      throw new Error(`${label} did not close the effort picker. Screen:\n${screenText().slice(-5_000)}`);
    }
  }

  await selectMaxAndCapture("Selecting Max");
  await selectMaxAndCapture("Reselecting active Max");
}

async function stopChild() {
  if (!exited) {
    child.write("\x03\x03");
    await Promise.race([exitPromise, delay(2_000)]);
  }
  if (!exited) child.kill();
  await Promise.race([exitPromise, delay(2_000)]);
}

(async () => {
  try {
    if (!skipClipboardMutation) {
      captureClipboard();
      if (originalClipboardKind === "unsupported") {
        throw new Error("Clipboard contains an unsupported custom format; refusing to overwrite it.");
      }
    }
    await waitForScreen(/›\s+[^\n]+/, 30_000);
    await delay(5_000);
    await flushTerminal();
    if (!/Context\s+\S+\/\S+\s+\(\d+(?:\.\d+)?%\)/.test(screenText())) {
      throw new Error(`ccodex status line did not show context usage. Screen:\n${screenText().slice(-4_000)}`);
    }
    if (!/Cache\s+(?:\d+(?:\.\d+)?%|--)/.test(screenText())) {
      throw new Error(`ccodex status line did not show cache status. Screen:\n${screenText().slice(-4_000)}`);
    }
    const trackedMouseModes = new Set(["1000", "1002", "1003", "1006"]);
    const enabledMouseModes = [...raw.matchAll(/\x1b\[\?([0-9;]+)h/g)]
      .filter((match) => match[1].split(";").some((mode) => trackedMouseModes.has(mode)))
      .map((match) => JSON.stringify(match[0]));
    if (enabledMouseModes.length === 0
      || terminal.modes.mouseTrackingMode === "none") {
      throw new Error(
        `ccodex did not enable mouse click placement: ` +
        `xterm mode=${terminal.modes.mouseTrackingMode}; modes=${enabledMouseModes.join(", ")}`,
      );
    }

    if (!skipClipboardMutation) {
      setClipboardText("ccodex-text-paste-probe");
      child.write("\x16");
      await waitForScreen(/ccodex-text-paste-probe/, 5_000);
      if (/Failed to paste clipboard|ccodex-image-.*\.png/.test(screenText())) {
        throw new Error(`Text Ctrl+V was routed as an image. Screen:\n${screenText().slice(-4_000)}`);
      }
      child.write("\x03");
      await delay(250);

      setClipboardImage();
      child.write("\x16");
      await waitForScreen(/\[📷 ccodex-image-[^\]\r\n]+\.png\]/, 5_000);
      if (/Failed to paste clipboard/.test(screenText())) {
        throw new Error(`Image Ctrl+V failed. Screen:\n${screenText().slice(-4_000)}`);
      }
      child.write("\x03");
      await delay(250);
    }

    child.resize(48, 46);
    terminal.resize(48, 46);
    await delay(750);
    await flushTerminal();
    const nativeBuffer = terminal.buffer.active;
    if (nativeBuffer.baseY > 0) {
      terminal.scrollLines(-1);
      if (nativeBuffer.viewportY >= nativeBuffer.baseY) {
        throw new Error("Terminal viewport did not move above the newest row.");
      }
      terminal.scrollToBottom();
      if (nativeBuffer.viewportY !== nativeBuffer.baseY) {
        throw new Error(
          `Terminal scrollbar bottom did not reach the newest row: ` +
          `${nativeBuffer.viewportY}/${nativeBuffer.baseY}`,
        );
      }
    }
    const narrowStatus = screenText().replace(/\s+/g, " ");
    if (!/gpt-5\.6-sol/.test(narrowStatus)
      || !/Cache\s+(?:\d+(?:\.\d+)?%|--)/.test(narrowStatus)
      || !/Context\s+(?:default|long)\s+\(\S+\)/.test(narrowStatus)
      || !/\S+\s+window/.test(narrowStatus)) {
      throw new Error(`Narrow status line lost configured fields instead of wrapping. Screen:\n${screenText().slice(-5_000)}`);
    }

    child.write("terminal-selection-probe");
    await waitForScreen(/terminal-selection-probe/, 3_000);
    await flushTerminal();
    if (terminal.modes.mouseTrackingMode === "none") {
      throw new Error(`Terminal mouse mode was lost while editing: ${terminal.modes.mouseTrackingMode}`);
    }
    const selectionLine = visibleScreenRows().reverse()
      .find((line) => line.text.includes("terminal-selection-probe"));
    if (!selectionLine) throw new Error("Could not locate terminal selection probe.");
    const dragCopyStart = raw.length;
    await dragComposerTextRange("terminal-selection-probe", 9, 18);
    child.write("\x03");
    await delay(400);
    await flushTerminal();
    const dragPayloads = [...raw.slice(dragCopyStart).matchAll(
      /\x1b\]52;c;([A-Za-z0-9+/=]+)\x07/g,
    )].map((match) => Buffer.from(match[1], "base64").toString("utf8"));
    if (skipClipboardMutation && !dragPayloads.includes("selection")) {
      throw new Error(`Mouse drag selection emitted OSC52 payloads ${JSON.stringify(dragPayloads)}.`);
    }
    child.write("\x01");
    child.write("\x7f");
    await delay(200);
    child.write("silent-copy-probe");
    await waitForScreen(/silent-copy-probe/, 3_000);
    const silentCopyStart = raw.length;
    child.write("\x01");
    await delay(150);
    child.write("\x03");
    await delay(400);
    await flushTerminal();
    if (raw.slice(silentCopyStart).includes("Copied selected prompt text")) {
      throw new Error("Ctrl+A then Ctrl+C displayed the removed copy notification.");
    }
    if (skipClipboardMutation) {
      const osc52Payloads = [...raw.slice(silentCopyStart).matchAll(
        /\x1b\]52;c;([A-Za-z0-9+/=]+)\x07/g,
      )].map((match) => Buffer.from(match[1], "base64").toString("utf8"));
      if (!osc52Payloads.includes("silent-copy-probe")) {
        throw new Error(`Ctrl+A then Ctrl+C emitted OSC52 payloads ${JSON.stringify(osc52Payloads)}.`);
      }
    } else {
      const copiedPrompt = runClipboardPowerShell(`
        Add-Type -AssemblyName System.Windows.Forms
        if ([Windows.Forms.Clipboard]::ContainsText()) {
          [Console]::Write([Windows.Forms.Clipboard]::GetText())
        }
      `);
      if (copiedPrompt !== "silent-copy-probe") {
        throw new Error(`Ctrl+A then Ctrl+C copied ${JSON.stringify(copiedPrompt)}.`);
      }
    }
    child.write("x");
    await delay(100);
    child.write("\x03");
    child.resize(140, 46);
    terminal.resize(140, 46);
    await waitForScreen(/Context\s+\S+\/\S+/, 5_000);

    for (let round = 1; round <= modelRenderRounds; round += 1) {
      const cols = round % 2 === 0 ? 140 : 96;
      const rows = round % 3 === 0 ? 24 : 46;
      child.resize(cols, rows);
      terminal.resize(cols, rows);
      await delay(150);
      await openModelPicker(round);
      await delay(250);
      await flushTerminal();
      assertConsecutiveModelRows(`Model picker round ${round} initial frame`);
      child.write("\x1b[F");
      await delay(300);
      await flushTerminal();
      assertConsecutiveModelRows(`Model picker round ${round} end frame`);
      child.write("\x1b");
      await delay(200);
    }
    child.resize(140, 46);
    terminal.resize(140, 46);
    await delay(300);

    await selectMaxEffortAndAssertAnimation();

    child.write("abcdef");
    await waitForScreen(/abcdef/, 3_000);
    await clickComposerAtTextOffset("abcdef", 3);
    child.write("X");
    await waitForScreen(/abcXdef/, 3_000);
    child.write("\x03");
    await delay(250);

    child.write("abcdef");
    await delay(300);
    child.write("\x1b[8;14;8;1;0;3_");
    await delay(400);
    await flushTerminal();
    if (!/abcde/.test(screenText()) || /abc\s*$/.test(screenText())) {
      throw new Error(`A coalesced Backspace record removed more than one character. Screen:\n${screenText().slice(-4_000)}`);
    }

    child.write("\x03");
    await delay(250);
    await stopChild();
    process.stdout.write(
      `ccodex ${modelRenderRounds}-round model rendering, silent prompt copy, ` +
      `${skipClipboardMutation ? "OSC52 copy" : "text/image Ctrl+V"}, click placement, Shift-native selection, ` +
      `repeated max animation, context/cache status, and Backspace passed.\n`,
    );
  } finally {
    await stopChild().catch(() => {});
    let modelRestoreError = null;
    try { restoreModelSelection(); } catch (error) { modelRestoreError = error; }
    let clipboardRestoreError = null;
    try { restoreClipboard(); } catch (error) { clipboardRestoreError = error; }
    terminal.dispose();
    try { fs.rmSync(workspace, { recursive: true, force: true }); } catch {}
    if (modelRestoreError) throw modelRestoreError;
    if (clipboardRestoreError) throw clipboardRestoreError;
  }
})().then(() => process.exit(0)).catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  try { process.stderr.write(screenText().slice(-8_000)); } catch {}
  process.exit(1);
});
