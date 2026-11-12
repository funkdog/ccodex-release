/**
 * Keep the official MCP host in charge of all native calls and security checks.
 * A Desktop restart changes its pipe identity. Refresh the host between calls,
 * invalidate JS bindings explicitly, and never replay an interrupted action.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { configEntries, readSetting } from "../tools/config-document.mjs";

const MCP = ["mcp_servers", "node_repl"];
const ENV = [...MCP, "env"];
export const RESET_MESSAGE = "The Desktop native runtime changed or reconnected. JavaScript bindings were reset. No requested action was executed or replayed. Reinitialize the Browser/Computer Use client and obtain fresh windows/tabs before continuing.";

export function nativeLaunch(home, inheritedEnv = process.env) {
  const text = fs.readFileSync(path.join(home, "config.toml"), "utf8");
  if (readSetting(text, MCP, "enabled") === false) throw new Error("The native MCP server is disabled in this profile.");
  const env = { ...inheritedEnv };
  for (const key of Object.keys(env)) {
    if (/^(?:NODE_REPL_|BROWSER_USE_|SKY_CUA_)/.test(key) || key === "CODEX_CLI_PATH") delete env[key];
  }
  env.CODEX_HOME = home;
  for (const item of configEntries(text)) {
    if (JSON.stringify(item.table) !== JSON.stringify(ENV) || item.key?.length !== 1) continue;
    const key = item.key[0];
    const value = readSetting(text, ENV, key);
    if (typeof value === "string" && key !== "CODEX_WINDOWS_REGISTERED_CORE") env[key] = value;
  }
  const configured = readSetting(text, MCP, "command");
  const command = readSetting(text, ENV, "CCODEX_NODE_REPL_NATIVE_PATH") || configured;
  if (!command || !fs.existsSync(command) || path.basename(command).toLowerCase() !== "node_repl.exe") {
    throw new Error("The profile does not reference an installed official native MCP host. Open Desktop, then run ccodex repair.");
  }
  const tracked = Object.fromEntries(Object.entries(env).filter(([key]) =>
    key === "CODEX_HOME" || key === "CODEX_CLI_PATH" || /^(?:NODE_REPL_|BROWSER_USE_|SKY_CUA_)/.test(key))
    .sort(([a], [b]) => a.localeCompare(b)));
  const stat = fs.statSync(command);
  const fingerprint = createHash("sha256").update(JSON.stringify({ command, size: stat.size, modified: stat.mtimeMs, env: tracked })).digest("hex");
  return { command, args: [], env, fingerprint };
}

export function runRelay({ input = process.stdin, output = process.stdout, resolveLaunch, spawnHost = spawn } = {}) {
  let child = null;
  let current = null;
  let initialized = false;
  let initParams = null;
  let hostExit = null;
  let queue = Promise.resolve();
  let ending = false;
  let resetPending = false;
  let serial = 0;
  const pending = new Map();
  const internal = new Map();
  const write = message => output.write(`${JSON.stringify(message)}\n`);
  const send = message => {
    if (!child || child.exitCode != null) throw new Error("Native MCP host exited; reinitialize the client.");
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  const fail = (message, detail) => {
    if (message.id == null) return;
    if (message.method === "tools/call") write({ jsonrpc: "2.0", id: message.id,
      result: { isError: true, content: [{ type: "text", text: detail }] } });
    else write({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: detail } });
  };
  async function stop() {
    const previous = child;
    if (!previous) return;
    previous.stdin.end();
    let timer;
    try {
      await Promise.race([
        hostExit,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Native host is still stopping; no process was forcibly terminated.")), 20000); }),
      ]);
    } finally { clearTimeout(timer); }
    if (child === previous) child = null;
  }
  async function start(launch, reinitialize) {
    current = launch.fingerprint;
    child = spawnHost(launch.command, launch.args, {
      env: launch.env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    const host = child;
    host.stderr.on("data", chunk => process.stderr.write(chunk));
    hostExit = new Promise(resolve => {
      host.once("error", error => {
        for (const message of pending.values()) fail(message, error.message);
        pending.clear();
        for (const waiter of internal.values()) waiter.reject(error);
        internal.clear();
      });
      host.once("close", () => {
        if (child === host) {
          for (const message of pending.values()) fail(message, "Native host disconnected. The action outcome is unknown; observe fresh state before retrying.");
          pending.clear();
          for (const waiter of internal.values()) waiter.reject(new Error("Native host disconnected during initialization."));
          internal.clear();
        }
        resolve();
      });
    });
    const lines = createInterface({ input: host.stdout, crlfDelay: Infinity });
    lines.on("line", line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      // Client and server requests have independent ID spaces.
      const response = message.method == null && message.id != null;
      const waiter = response && internal.get(message.id);
      if (waiter) {
        internal.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error.message));
        else waiter.resolve(message.result);
        return;
      }
      if (response) pending.delete(message.id);
      write(message);
    });
    host.stdin.on("error", error => {
      for (const message of pending.values()) fail(message, `Native MCP input closed: ${error.message}. No action was replayed.`);
      pending.clear();
    });
    if (reinitialize && initParams) {
      const id = `ccodex-native-init-${++serial}`;
      let timer;
      try {
        await new Promise((resolve, reject) => {
          timer = setTimeout(() => {
            internal.delete(id);
            reject(new Error("Native MCP reinitialization timed out."));
          }, 30000);
          internal.set(id, { resolve, reject });
          send({ jsonrpc: "2.0", id, method: "initialize", params: initParams });
        });
        send({ jsonrpc: "2.0", method: "notifications/initialized" });
        resetPending = true;
      } finally { clearTimeout(timer); }
    }
  }
  async function handle(message) {
    const cleanup = message.method === "notifications/cancelled"
      || (message.method === "tools/call" && message.params?.name === "turn_ended");
    if (message.method === "initialize") {
      initParams = message.params;
      if (!child) await start(resolveLaunch(), false);
    } else if (message.method === "notifications/initialized") {
      initialized = true;
    } else if (message.method && initialized && !cleanup) {
      const launch = resolveLaunch();
      const changed = current !== launch.fingerprint || !child || child.exitCode != null;
      if (changed) {
        if (pending.size) {
          fail(message, "Desktop runtime changed while another call is running. No new action was executed; wait for that call before reconnecting.");
          return;
        }
        await stop();
        await start(launch, true);
      }
    }
    // Discovery or ping may trigger the restart before the next stateful call.
    if (resetPending && message.method === "tools/call" && !cleanup) {
      resetPending = false;
      fail(message, RESET_MESSAGE);
      return;
    }
    if (message.method && message.id != null) pending.set(message.id, message);
    try { send(message); }
    catch (error) { pending.delete(message.id); throw error; }
  }
  const lines = createInterface({ input, crlfDelay: Infinity });
  lines.on("line", line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    queue = queue.then(() => handle(message)).catch(error => fail(message, error.message));
  });
  const finished = new Promise((resolve, reject) => {
    lines.once("close", () => {
      ending = true;
      queue.then(stop).then(resolve, reject);
    });
  });
  return { finished, get ending() { return ending; } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const home = process.env.CODEX_HOME || process.env.CODEX_COPILOT_HOME;
  runRelay({ resolveLaunch: () => nativeLaunch(home) }).finished.catch(error => {
    process.stderr.write(`ccodex native relay: ${error.message}\n`);
    process.exitCode = 1;
  });
}
