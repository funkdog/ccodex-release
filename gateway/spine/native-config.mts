import fs from "node:fs";
import path from "node:path";
import type { ConnectionConfig, RpcMessage, AppParams } from "../contracts.mjs";
import { privateDirectory } from "./storage.mjs";

function tomlString(value: string) { return JSON.stringify(value); }
/** Configuration is argv-local. No writes to the user's native config.toml. */
export function spineNativeArguments(config: ConnectionConfig, connectionFile: string, node = process.execPath) {
  if (!config.spine?.mcp) return [];
  for (const file of [node, connectionFile, path.join(import.meta.dirname, "mcp-server.mjs")]) {
    if (!path.isAbsolute(file) || !fs.statSync(file).isFile()) throw new Error("MCP requires absolute existing executables/configuration.");
  }
  return ["-c", `mcp_servers.mycodex={command=${tomlString(node)},args=[${tomlString(path.join(import.meta.dirname, "mcp-server.mjs"))},${tomlString(connectionFile)}],startup_timeout_sec=15,tool_timeout_sec=20}`];
}
/** Desktop's metadata/preflight requests replace a configured server with an
 * enabled-only disabled table. The installed CLI still validates its transport.
 * Supply its own explicit disabled-stdio shape, never re-enable or retain an
 * executable for a request which intentionally disabled MyCodex. */
export function spineNativeRequest<T>(message: RpcMessage<AppParams, T>): RpcMessage<AppParams, T> {
  if (!["thread/start", "thread/resume", "thread/fork"].includes(message.method ?? "")) return message;
  const config = message.params?.config;
  if (!config || typeof config !== "object" || Array.isArray(config)) return message;
  const disabled = (value: unknown): boolean => value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === 1 && (value as Record<string, unknown>).enabled === false;
  const nested = config.mcp_servers;
  const table = nested && typeof nested === "object" && !Array.isArray(nested) ? nested as Record<string, unknown> : null;
  const directDisabled = disabled(config["mcp_servers.mycodex"]), nestedDisabled = disabled(table?.mycodex);
  if (!directDisabled && !nestedDisabled) return message;
  return { ...message, params: { ...message.params, config: { ...config,
    ...(directDisabled ? { "mcp_servers.mycodex": { command: "", enabled: false } } : {}),
    ...(nestedDisabled ? { mcp_servers: { ...table, mycodex: { command: "", enabled: false } } } : {}),
  } } };
}
export function withSpinePath(env: NodeJS.ProcessEnv, directory?: string) {
  if (!directory) return { ...env };
  if (!path.isAbsolute(directory)) throw new Error("Spine shim PATH must be absolute.");
  privateDirectory(directory, false);
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid()) || (process.platform !== "win32" && (stat.mode & 0o077))) throw new Error("Spine shim PATH must be owned and private.");
  return { ...env, PATH: `${directory}${path.delimiter}${env.PATH ?? ""}` };
}
