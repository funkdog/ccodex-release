import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { initializeCliSettings, cliSelection } from "../bridge/surface-settings.mjs";
import { cliSessionArguments, cliSessionEnvironment } from "../bridge/cli-session.mjs";
import { readSetting } from "../tools/config-document.mjs";
import { creditsView } from "../bridge/copilot-credits.mjs";
import { formatUsage, runUsage } from "../bridge/usage-cli.mjs";
import { createDesktopOwnershipGuard } from "../bridge/desktop-ownership.mjs";
import { desktopEndpointOwner } from "../bridge/desktop-process.mjs";

const require = createRequire(import.meta.url);
const { CliInputRouter, SHIFT_ENTER_INPUT } = require("../bin/ccodex-input.cjs");
const { decodeWindowsInputPrefix } = require("../bin/ccodex-smart-paste.cjs");
const { ComposerScreen } = require("../bin/ccodex-composer.cjs");

test("Desktop defaults cannot replace an initialized CLI model, effort or context", () => {
  const first = initializeCliSettings(
    'model="gpt-test--long-context"\nmodel_reasoning_effort="max"\n[tui]\n' +
    'status_line=["copilot-quota","copilot-credits"]\n');
  assert.deepEqual(cliSelection(first), {
    model: "gpt-test", effort: "max", serviceTier: "context-long",
  });
  const desktopChanged =
    'model="gpt-test--long-context"\nmodel_reasoning_effort="max"\n'
    .replace('model="gpt-test--long-context"', 'model="other--default-context"')
    .replace('model_reasoning_effort="max"', 'model_reasoning_effort="low"');
  const second = initializeCliSettings(desktopChanged, first);
  assert.deepEqual(cliSelection(second), cliSelection(first));
  assert.equal(readSetting(desktopChanged, [], "model"), "other--default-context");
  assert.equal(initializeCliSettings(desktopChanged, second), second);
  assert.doesNotMatch(second, /"copilot-(?:credits|quota|account)"/);
});

test("CLI startup uses its profile/catalog and never inherits the Desktop watcher", () => {
  const home = String.raw`C:\Private profile`;
  const args = cliSessionArguments(home, ["exec", "--json"]);
  assert.deepEqual(args.slice(0, 2), ["--profile", "ccodex"]);
  assert.equal(args.at(-1), "--json");
  assert.ok(args[3].includes("models.json"));
  const custom = cliSessionArguments(home, ["-p", "mine"]);
  assert.equal(custom.filter(arg => arg === "--profile").length, 0);
  const inherited = { KEEP: "yes", CODEX_COPILOT_SELECTION_FILE: "desktop.json" };
  const env = cliSessionEnvironment(inherited);
  assert.equal(env.CODEX_COPILOT_SELECTION_FILE, undefined);
  assert.equal(env.KEEP, "yes");
  assert.equal(inherited.CODEX_COPILOT_SELECTION_FILE, "desktop.json");
});

test("/usage becomes a local shell query regardless of input chunk boundaries", () => {
  const command = "/usage\r";
  for (let at = 0; at <= command.length; at++) {
    const router = new CliInputRouter();
    const output = router.transform(command.slice(0, at)) +
      router.transform(command.slice(at));
    assert.equal(output, "/usage\x01\x7f!ccodex usage\r");
  }
  assert.equal(new CliInputRouter().transform("/usage --json\r"),
    "/usage --json\x01\x7f!ccodex usage --json\r");
});

test("/usage remains available after cancelling a native menu with Escape", () => {
  const router = new CliInputRouter({ readUsageCommand: () => "/usage" });
  router.transform("/model\r");
  router.transform("\x1b");
  router.flush();
  assert.match(router.transform("/usage\r"), /!ccodex usage\r$/);
});

test("lagging screen confirmation is requested only for an uncertain local command", () => {
  let visible = null;
  const router = new CliInputRouter({ readLocalCommand: () => visible });
  router.transform("\x1b");
  router.flush();
  router.transform("/usage");
  assert.equal(router.needsComposerConfirmation(), true);
  visible = "/usage";
  assert.equal(router.needsComposerConfirmation(), false);
  const other = new CliInputRouter();
  other.transform("\x1b");
  other.flush();
  other.transform("ordinary text");
  assert.equal(other.needsComposerConfirmation(), false);
});

test("a confirmed native command clears the whole selection rather than a cursor prefix", () => {
  const router = new CliInputRouter({ readUsageCommand: () => "/usage" });
  router.transform("/usage\x1b[D\x1b[D");
  assert.equal(router.transform("\r"), "\x01\x7f!ccodex usage\r");
});

test("screen-confirmed routing recovers from native clear/edit operations without trusting stale tracking", () => {
  const router = new CliInputRouter({ readUsageCommand: () => "/usage" });
  router.transform("old draft\x01\x7f/usage");
  assert.equal(router.transform("\r"), "\x01\x7f!ccodex usage\r");
  const uncertain = new CliInputRouter({ readUsageCommand: () => null });
  uncertain.transform("\x1b");
  uncertain.flush();
  assert.equal(uncertain.transform("/usage\r"), "/usage\r");
});

test("composer inspection requires the active cursor row and rejects multiline/menu content", async () => {
  const screen = new ComposerScreen(80, 12);
  try {
    screen.write("\x1b[2J\x1b[10;1H\u203a /usage\x1b[10;9H");
    await screen.flush();
    assert.equal(screen.readUsageCommand(), "/usage");
    screen.write("\x1b[11;1Han unsent second line\x1b[10;9H");
    await screen.flush();
    assert.equal(screen.readUsageCommand(), null);
    screen.write("\x1b[2J\x1b[10;1H\u203a 1. model\x1b[10;10H");
    await screen.flush();
    assert.equal(screen.readUsageCommand(), null);
  } finally {
    screen.dispose();
  }
});

test("usage routing does not execute pasted commands, multiline drafts or edited other text", () => {
  for (const input of [
    "\x1b[200~/usage\r\x1b[201~",
    "hello /usage\r",
    "/usage\n\r",
    "/usage\x1b[A\r",
    "/usage --delete\r",
  ]) assert.doesNotMatch(new CliInputRouter().transform(input), /!ccodex usage/);
  assert.equal(new CliInputRouter().transform("/usagx\x7fe\r"),
    "/usagx\x7fe\x01\x7f!ccodex usage\r");
});

test("Shift+Enter inserts a newline for Win32 records and fragmented CSI-u", () => {
  assert.deepEqual(decodeWindowsInputPrefix("\x1b[13;28;13;1;16;1_").events, [SHIFT_ENTER_INPUT]);
  assert.deepEqual(decodeWindowsInputPrefix("\x1b[13;28;10;1;8;1_").events, ["\n"]);
  assert.equal(new CliInputRouter().transform("\x1b[200~first\nsecond\x1b[201~"),
    "\x1b[200~first\nsecond\x1b[201~");
  const sequence = "\x1b[13;2u";
  for (let at = 0; at <= sequence.length; at++) {
    const router = new CliInputRouter();
    assert.equal(router.transform(sequence.slice(0, at)) +
      router.transform(sequence.slice(at)), SHIFT_ENTER_INPUT);
  }
});

test("the CLI adapter retains Ctrl/Alt editing and navigation modifiers", () => {
  for (const record of [
    "\x1b[37;75;0;1;8;1_",
    "\x1b[38;72;0;1;8;1_",
    "\x1b[8;14;8;1;2;1_",
    "\x1b[13;28;13;1;8;1_",
  ]) assert.ok(decodeWindowsInputPrefix(record).events[0].startsWith(record));
});

function account(status = "available") {
  const now = Date.now();
  return {
    status: "authenticated", login: "fixture", plan: "pro", accountGeneration: "same",
    quota: { source: "github-user", reason: null },
    credits: { ...creditsView({
      status, unit: "credits", used: 5066, allowance: 1000000,
      updatedAt: new Date(now).toISOString(),
    }, { now }), accountGeneration: "same" },
  };
}

test("usage reports the complementary used/remaining values with a real timestamp", () => {
  const text = formatUsage(account());
  assert.match(text, /AI credits used: 5,066 \/ 1,000,000/);
  assert.match(text, /AI credits remaining: 994,934/);
  assert.match(text, /Checked: \d{4}-/);
  assert.doesNotMatch(text, /undefined/);
  assert.throws(() => formatUsage(account("stale")), /Cached balances are not shown/);
  const wrong = account();
  wrong.credits.accountGeneration = "another";
  assert.throws(() => formatUsage(wrong), /unavailable/);
});

test("every usage invocation calls the fresh API route instead of account/cache reads", async () => {
  const calls = [];
  let text = "";
  const options = {
    endpoint: "http://127.0.0.1:22691",
    output: { write: chunk => { text += chunk; } },
    request: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, json: async () => account() };
    },
  };
  await runUsage([], options);
  await runUsage(["--json"], options);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.url.endsWith("/account/usage") &&
    call.options.method === "POST" && call.options.headers["cache-control"] === "no-cache"));
  assert.match(text, /AI credits used/);
  await assert.rejects(runUsage(["--watch"], options), /Usage:/);
});

test("Desktop ownership checks coalesce and a superseded receipt is immediately rejected",
  { skip: process.platform !== "win32" }, async () => {
    const receipt = {
      pid: 123, instanceToken: "instance", helperToken: "helper",
      executable: String.raw`C:\Private\ChatGPT.exe`,
      userData: String.raw`C:\Private\data`, debugPort: 5000,
    };
    const identity = {
      pid: 123, platform: "win32", executable: receipt.executable, lifetime: "windows:123",
      endpointOwner: 123,
      args: [receipt.executable, "--user-data-dir=" + receipt.userData,
        "--remote-debugging-port=5000"],
    };
    let current = receipt;
    let calls = 0;
    let time = 100;
    const guard = createDesktopOwnershipGuard({ receipt, identity }, {
      home: "fixture", helperToken: "helper", alive() {},
      receiptReader: () => current, now: () => time,
      inspect: async () => { calls++; await new Promise(resolve => setImmediate(resolve)); return identity; },
    });
    await Promise.all([guard(), guard(), guard()]);
    assert.equal(calls, 1);
    await guard();
    assert.equal(calls, 1);
    time += 2001;
    await guard();
    assert.equal(calls, 2);
    current = { ...receipt, helperToken: "other" };
    await assert.rejects(guard(), /superseded/);
  });

test("Windows endpoint checks use native netstat and require one exact loopback listener", () => {
  const invoke = (program, args) => {
    assert.match(program, /netstat\.exe$/);
    assert.deepEqual(args, ["-ano", "-p", "tcp"]);
    return { status: 0, stdout:
      "  TCP  127.0.0.1:5000  0.0.0.0:0  LISTENING  123\r\n" +
      "  TCP  127.0.0.1:50001  0.0.0.0:0  LISTENING  999\r\n" +
      "  TCP  0.0.0.0:5000  0.0.0.0:0  LISTENING  999\r\n" +
      "  TCP  127.0.0.1:5000  127.0.0.1:9000  ESTABLISHED  456\r\n",
    };
  };
  assert.equal(desktopEndpointOwner(5000, { platform: "win32", invoke }), 123);
  assert.throws(() => desktopEndpointOwner(5000, {
    platform: "win32",
    invoke: () => ({ status: 0, stdout:
      "TCP 127.0.0.1:5000 0.0.0.0:0 LISTENING 123\n" +
      "TCP 127.0.0.1:5000 0.0.0.0:0 LISTENING 456\n" }),
  }), /ambiguous/);
});
