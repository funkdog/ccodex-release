#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { CliInputRouter, SHIFT_ENTER_INPUT } = require("./ccodex-input.cjs");
const { ComposerScreen } = require("./ccodex-composer.cjs");

const EMPTY_BRACKETED_PASTE = "\u001b[200~\u001b[201~";
const CODEX_IMAGE_PASTE_KEY = "\u0016";
const PREFIX_FLUSH_MS = 30;
const configuredOutputFlushMs = Number(process.env.CCODEX_OUTPUT_FLUSH_MS ?? 4);
const OUTPUT_FLUSH_MS = Number.isFinite(configuredOutputFlushMs)
  ? Math.max(0, configuredOutputFlushMs)
  : 4;
const TERMINAL_INPUT_RESET = "\x1b[?1000;1002;1003;1004;1006;1015;1016l";

const target = process.argv[2];
const targetArgs = process.argv.slice(3);

if (!target && require.main === module) {
  process.stderr.write("ccodex-smart-paste: missing Codex executable path\n");
  process.exit(2);
}

function decodeWindowsKey(match) {
  const virtualKey = Number(match[1]);
  const unicode = Number(match[3]);
  const keyDown = match[4] === "1";
  const controlState = Number(match[5]) || 0;
  const repeat = Math.max(1, Number(match[6]) || 1);
  if (!keyDown) return "";
  // ConPTY represents a raw LF as VK_RETURN with CTRL held. Keep it as LF
  // until the input router can distinguish a newline key from pasted text.
  if (unicode === 10) return "\n".repeat(repeat);
  const shiftPressed = (controlState & 0x10) !== 0;
  const altPressed = (controlState & 0x03) !== 0;
  const controlPressed = (controlState & 0x0c) !== 0;
  if ((virtualKey === 13 || unicode === 13) && shiftPressed) return SHIFT_ENTER_INPUT.repeat(repeat);
  if (virtualKey === 9 && shiftPressed) return "\x1b[Z".repeat(repeat);
  if (altPressed || (controlPressed && (unicode === 0 || virtualKey === 13 || virtualKey === 8))) {
    const presses = virtualKey === 8 || virtualKey === 46 ? 1 : repeat;
    const down = `\x1b[${virtualKey};${match[2]};${unicode};1;${controlState};1_`;
    const up = `\x1b[${virtualKey};${match[2]};${unicode};0;0;1_`;
    return (down + up).repeat(presses);
  }
  // ConPTY can coalesce a single short Backspace/Delete press into a record whose
  // repeat count is greater than one. Treat destructive editing records as one
  // logical keypress; held keys still arrive as subsequent records.
  if (virtualKey === 8 || unicode === 8 || unicode === 127) return "\x7f";
  if (virtualKey === 46) return "\x1b[3~";
  if (unicode > 0) return String.fromCodePoint(unicode).repeat(repeat);
  const sequence = new Map([
    [33, "\x1b[5~"], [34, "\x1b[6~"], [35, "\x1b[F"], [36, "\x1b[H"],
    [37, "\x1b[D"], [38, "\x1b[A"], [39, "\x1b[C"], [40, "\x1b[B"],
    [45, "\x1b[2~"],
  ]).get(virtualKey);
  return sequence ? sequence.repeat(repeat) : "";
}

function decodeWindowsInputPrefix(value) {
  const pattern = /^\x1b\[(\d+);(\d+);(\d+);(\d+);(\d+);(\d+)_/;
  const sgrMousePattern = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/;
  const events = [];
  let offset = 0;
  while (offset < value.length) {
    const remaining = value.slice(offset);
    const mouse = remaining.match(sgrMousePattern);
    if (mouse) {
      offset += mouse[0].length;
      const code = Number(mouse[1]);
      const isButtonlessMotion = (code & 32) !== 0 && (code & 3) === 3;
      if (!isButtonlessMotion) events.push(mouse[0]);
      continue;
    }
    const match = remaining.match(pattern);
    if (!match) {
      if (/^\x1b\[[0-?]*[ -/]*[@-~]/.test(remaining)) return null;
      if (remaining.startsWith("\x1b[")) {
        return { raw: value.slice(0, offset), events, pending: remaining };
      }
      return null;
    }
    offset += match[0].length;
    const text = decodeWindowsKey(match);
    if (text) events.push(text);
  }
  return { raw: value, events, pending: "" };
}

const diagnosticLog = process.env.CCODEX_SMART_PASTE_LOG;
function logDiagnostic(event, details = {}) {
  if (!diagnosticLog) return;
  try {
    fs.appendFileSync(
      diagnosticLog,
      `${JSON.stringify({ at: new Date().toISOString(), event, ...details })}\n`,
    );
  } catch {
    // Diagnostics must never interfere with the terminal session.
  }
}

function runDirect() {
  logDiagnostic("direct_start", { target, argumentCount: targetArgs.length });
  let child;
  try {
    child = spawn(target, targetArgs, {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
      windowsHide: false,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logDiagnostic("direct_start_failed", { message });
    process.stderr.write(`ccodex-smart-paste: ${message}\n`);
    process.exitCode = 1;
    return;
  }

  child.on("error", (error) => {
    process.stderr.write(`ccodex-smart-paste: ${error.message}\n`);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    logDiagnostic("direct_exit", { code, signal });
    process.exitCode = Number.isInteger(code) ? code : 1;
  });
}

function findCodexSubcommand(args) {
  const commands = new Set([
    "exec",
    "e",
    "review",
    "login",
    "logout",
    "mcp",
    "plugin",
    "mcp-server",
    "app-server",
    "remote-control",
    "app",
    "completion",
    "update",
    "doctor",
    "sandbox",
    "debug",
    "apply",
    "resume",
    "archive",
    "delete",
    "unarchive",
    "fork",
    "cloud",
    "exec-server",
  ]);
  const optionsWithOneValue = new Set([
    "-c",
    "--config",
    "--enable",
    "--disable",
    "--remote",
    "--remote-auth-token-env",
    "-i",
    "--image",
    "-m",
    "--model",
    "--local-provider",
    "-p",
    "--profile",
    "-s",
    "--sandbox",
    "-C",
    "--cd",
    "--add-dir",
    "-a",
    "--ask-for-approval",
  ]);

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (optionsWithOneValue.has(argument)) {
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) continue;
    const normalized = argument.toLowerCase();
    return commands.has(normalized) ? normalized : null;
  }
  return null;
}

function shouldUsePty() {
  if (process.env.CCODEX_SMART_PASTE === "0") return false;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  if (targetArgs.some((argument) => ["-h", "--help", "-V", "--version"].includes(argument))) {
    return false;
  }

  const codexArgs = path.basename(target || "").toLowerCase() === "ccodex-release-native.exe"
    ? targetArgs.slice(1) : targetArgs;
  const command = findCodexSubcommand(codexArgs);
  const nonInteractiveCommands = new Set([
    "exec",
    "e",
    "review",
    "login",
    "logout",
    "mcp",
    "plugin",
    "mcp-server",
    "app-server",
    "remote-control",
    "app",
    "completion",
    "update",
    "doctor",
    "sandbox",
    "debug",
    "apply",
    "archive",
    "delete",
    "unarchive",
    "exec-server",
  ]);

  return !command || !nonInteractiveCommands.has(command);
}

function loadNodePty() {
  const candidates = [
    path.join(__dirname, "node-pty"),
    path.join(__dirname, "vendor", "node-pty"),
  ];
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch (error) {
      logDiagnostic("node_pty_candidate_failed", {
        candidate,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return null;
}

function longestSuffixThatIsPatternPrefix(value, pattern) {
  const limit = Math.min(value.length, pattern.length - 1);
  for (let length = limit; length > 0; length -= 1) {
    if (value.endsWith(pattern.slice(0, length))) return length;
  }
  return 0;
}

function runWithPty(nodePty) {
  process.stdout.write(TERMINAL_INPUT_RESET);
  const columns = Math.max(1, process.stdout.columns || 80);
  const rows = Math.max(1, process.stdout.rows || 24);
  const child = nodePty.spawn(target, targetArgs, {
    name: process.env.TERM || "xterm-256color",
    cols: columns,
    rows,
    cwd: process.cwd(),
    env: process.env,
    useConpty: true,
  });

  logDiagnostic("pty_start", { target, argumentCount: targetArgs.length, columns, rows });

  const stdinWasRaw = Boolean(process.stdin.isRaw);
  let pendingInput = "";
  let prefixTimer = null;
  let pendingOutput = "";
  let outputTimer = null;
  let outputBlocked = false;
  let pendingExitCode = null;
  let finished = false;
  let windowsInputPending = "";
  const composer = new ComposerScreen(columns, rows);
  const inputRouter = new CliInputRouter({
    readLocalCommand: () => composer.readLocalCommand(),
    onRoute: details => logDiagnostic("local_command_route", {
      ...details,
      ...(diagnosticLog ? composer.inspectLocalCommandFrame() : {}),
    }),
    onSubmit: command => {
      if (!/^\/(?:new|resume|fork)(?:\s|$)/.test(command)) return;
      const home = process.env.CODEX_COPILOT_HOME;
      const clientId = process.env.CCODEX_SESSION_CLIENT_ID;
      if (!home || !/^[a-f0-9-]{36}$/i.test(clientId || "")) return;
      const file = path.join(home, "cli-session-leases", clientId + ".json");
      try {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096 ||
            fs.lstatSync(path.dirname(file)).isSymbolicLink()) return;
        const lease = JSON.parse(fs.readFileSync(file, "utf8"));
        if (lease.ownerPid !== Number(process.env.CCODEX_SESSION_OWNER_PID)) return;
        // Session-switch menus are unresolved until the next native request.
        fs.writeFileSync(file, JSON.stringify({ ...lease, currentThreadId: null }) + "\n");
      } catch (error) { logDiagnostic("cli_ownership_update_failed", { message: error.message }); }
    },
  });
  let escapeTimer = null;
  let inputQueue = Promise.resolve();

  function clearPrefixTimer() {
    if (prefixTimer !== null) {
      clearTimeout(prefixTimer);
      prefixTimer = null;
    }
  }

  function writeToChild(value) {
    if (value) child.write(value);
  }

  function flushPendingInput() {
    clearPrefixTimer();
    if (escapeTimer !== null) {
      clearTimeout(escapeTimer);
      escapeTimer = null;
    }
    pendingInput += inputRouter.flush();
    if (pendingInput) {
      writeToChild(pendingInput);
      pendingInput = "";
    }
  }

  function processPendingInput() {
    clearPrefixTimer();

    while (pendingInput) {
      const matchIndex = pendingInput.indexOf(EMPTY_BRACKETED_PASTE);
      if (matchIndex >= 0) {
        writeToChild(pendingInput.slice(0, matchIndex));
        writeToChild(CODEX_IMAGE_PASTE_KEY);
        logDiagnostic("empty_paste_mapped_to_image_paste");
        pendingInput = pendingInput.slice(matchIndex + EMPTY_BRACKETED_PASTE.length);
        continue;
      }

      const keepLength = longestSuffixThatIsPatternPrefix(
        pendingInput,
        EMPTY_BRACKETED_PASTE,
      );
      const emitLength = pendingInput.length - keepLength;
      if (emitLength > 0) {
        writeToChild(pendingInput.slice(0, emitLength));
        pendingInput = pendingInput.slice(emitLength);
      }
      break;
    }

    if (pendingInput) {
      prefixTimer = setTimeout(flushPendingInput, PREFIX_FLUSH_MS);
      prefixTimer.unref?.();
    }
  }

  function restoreTerminal() {
    clearPrefixTimer();
    if (escapeTimer !== null) clearTimeout(escapeTimer);
    try {
      if (process.stdin.isTTY && !stdinWasRaw) process.stdin.setRawMode(false);
    } catch {
      // Best effort during shutdown.
    }
    process.stdin.pause();
    process.stdout.write(TERMINAL_INPUT_RESET);
  }

  function flushOutput() {
    if (outputTimer !== null) {
      clearTimeout(outputTimer);
      outputTimer = null;
    }
    if (outputBlocked || !pendingOutput) return;
    const output = pendingOutput;
    pendingOutput = "";
    if (!process.stdout.write(output)) {
      outputBlocked = true;
      process.stdout.once("drain", () => {
        outputBlocked = false;
        flushOutput();
        maybeExit();
      });
    } else {
      maybeExit();
    }
  }

  function queueOutput(data) {
    composer.write(data);
    pendingOutput += data;
    if (outputTimer !== null || outputBlocked) return;
    if (OUTPUT_FLUSH_MS === 0) {
      flushOutput();
      return;
    }
    outputTimer = setTimeout(flushOutput, OUTPUT_FLUSH_MS);
  }

  function maybeExit() {
    if (
      pendingExitCode === null ||
      outputBlocked ||
      pendingOutput ||
      outputTimer !== null
    ) {
      return;
    }
    const exitCode = pendingExitCode;
    pendingExitCode = null;
    setImmediate(() => process.exit(exitCode));
  }

  function finish(code, signal) {
    if (finished) return;
    finished = true;
    composer.dispose();
    restoreTerminal();
    logDiagnostic("pty_exit", { code, signal });
    const exitCode = Number.isInteger(code) ? code : 1;
    process.exitCode = exitCode;
    pendingExitCode = exitCode;
    pendingOutput += TERMINAL_INPUT_RESET;
    flushOutput();
    maybeExit();
  }

  process.stdin.setEncoding("utf8");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  function queueInput(data) {
    if (escapeTimer !== null) { clearTimeout(escapeTimer); escapeTimer = null; }
    pendingInput += inputRouter.transform(data);
    processPendingInput();
    if (inputRouter.pending) {
      escapeTimer = setTimeout(() => {
        escapeTimer = null;
        pendingInput += inputRouter.flush();
        processPendingInput();
      }, PREFIX_FLUSH_MS);
    }
  }

  function deliverInput(data) {
    inputQueue = inputQueue.then(async () => {
      let start = 0;
      for (let index = 0; index < data.length; index++) {
        if (data[index] !== "\r") continue;
        queueInput(data.slice(start, index));
        if (!inputRouter.pasting && !inputRouter.pending) {
          // Let the native composer commit typing before inspecting it. This
          // also covers pasted "/usage<Enter>" arriving in one input chunk.
          await new Promise(resolve => setTimeout(resolve, 60));
          if (finished) return;
          await composer.flush();
          const deadline = Date.now() + 1000;
          while (inputRouter.needsComposerConfirmation() && Date.now() < deadline && !finished) {
            await new Promise(resolve => setTimeout(resolve, 20));
            await composer.flush();
          }
        }
        queueInput("\r");
        start = index + 1;
      }
      queueInput(data.slice(start));
    }).catch(error => {
      logDiagnostic("input_router_failed", { message: error.message });
      process.stderr.write(`ccodex input adapter: ${error.message}\n`);
    });
  }

  process.stdin.on("data", (data) => {
    if (process.platform !== "win32") {
      deliverInput(data);
      return;
    }
    windowsInputPending += data;
    const decoded = decodeWindowsInputPrefix(windowsInputPending);
    if (decoded) {
      windowsInputPending = decoded.pending;
      for (const event of decoded.events) deliverInput(event);
      return;
    }
    const raw = windowsInputPending;
    windowsInputPending = "";
    deliverInput(raw);
  });
  process.stdin.on("end", () => {
    flushPendingInput();
    try {
      child.kill();
    } catch {
      // Child may already be gone.
    }
  });

  child.onData(queueOutput);
  child.onExit(({ exitCode, signal }) => finish(exitCode, signal));

  process.stdout.on("resize", () => {
    try {
      composer.resize(
        Math.max(1, process.stdout.columns || 80),
        Math.max(1, process.stdout.rows || 24),
      );
      child.resize(
        Math.max(1, process.stdout.columns || 80),
        Math.max(1, process.stdout.rows || 24),
      );
    } catch (error) {
      logDiagnostic("resize_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  process.on("exit", restoreTerminal);
  for (const signal of ["SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      flushPendingInput();
      try {
        child.kill();
      } catch {
        // Child may already be gone.
      }
    });
  }
}

if (require.main === module) {
  if (!shouldUsePty()) {
    runDirect();
  } else {
    const nodePty = loadNodePty();
    if (!nodePty) {
      process.stderr.write(
        "ccodex-smart-paste: node-pty is unavailable; starting Codex without smart clipboard support\n",
      );
      runDirect();
    } else {
      try {
        runWithPty(nodePty);
      } catch (error) {
        const message = error instanceof Error ? error.stack || error.message : String(error);
        logDiagnostic("pty_start_failed", { message });
        process.stderr.write(`ccodex-smart-paste: PTY startup failed: ${message}\n`);
        runDirect();
      }
    }
  }
}

module.exports = { decodeWindowsInputPrefix };
