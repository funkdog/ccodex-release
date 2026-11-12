import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_BRIDGE_PORT = 22690;

function parsePort(value, source) {
  if (!/^[0-9]{1,16}$/.test(String(value))) {
    throw new Error(`${source} must contain only a decimal loopback port.`);
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`${source} must be between 1024 and 65535.`);
  }
  return port;
}

/** A profile pointer selects new sessions without changing existing processes. */
export function selectedBridgePort({
  home = process.env.CODEX_COPILOT_HOME || process.env.CODEX_HOME || path.join(os.homedir(), ".codex-copilot"),
  env = process.env,
} = {}) {
  if (env.CODEX_COPILOT_BRIDGE_PORT != null) {
    return parsePort(env.CODEX_COPILOT_BRIDGE_PORT, "CODEX_COPILOT_BRIDGE_PORT");
  }
  const pointer = path.join(home, "bridge-port.txt");
  let value;
  try {
    const stat = fs.lstatSync(pointer);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32) {
      throw new Error(`Bridge port pointer must be a small regular file: ${pointer}`);
    }
    value = fs.readFileSync(pointer, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return DEFAULT_BRIDGE_PORT;
    throw error;
  }
  const match = value.match(/^([0-9]{1,16})(?:\r?\n)?$/);
  if (!match || match[0].length !== value.length) {
    throw new Error(`Bridge port pointer must contain exactly one decimal line: ${pointer}`);
  }
  return parsePort(match[1], pointer);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    if (process.argv[2] !== "--print") throw new Error("Expected --print.");
    process.stdout.write(`${selectedBridgePort()}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
