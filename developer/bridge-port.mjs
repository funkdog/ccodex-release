import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { atomicWrite } from "../bridge/atomic-file.mjs";
import { readProcessIdentity } from "../bridge/desktop-process.mjs";
import { selectedBridgePort } from "../bridge/port-selection.mjs";
import { editSettings } from "../tools/config-document.mjs";

function readPointer(file) {
  try { return fs.readFileSync(file, "utf8"); }
  catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function bridgeHealth(port) {
  const response = await fetch(`http://127.0.0.1:${port}/health`,
    { signal: AbortSignal.timeout(1000) });
  if (!response.ok) throw new Error("Developer bridge health request failed.");
  return response.json();
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

export async function ensureDeveloperBridgePort({
  root, home, generation, ensure,
  health = bridgeHealth, inspectProcess = readProcessIdentity, allocatePort = freePort,
}) {
  const pointer = path.join(home, "bridge-port.txt");
  const before = readPointer(pointer);
  const previous = selectedBridgePort({ home, env: {} });
  let running;
  try { running = await health(previous); }
  catch { running = null; }
  if (running && running.bridge !== "codex-copilot") {
    throw new Error("Developer port is owned by another application.");
  }
  let port = previous;
  if (running && running.runtime?.sourceGeneration !== generation) {
    const identity = inspectProcess(running.pid);
    if (!identity?.args?.includes(path.join(root, "bridge", "server.mjs"))) {
      throw new Error("Older developer bridge is not owned by this installation.");
    }
    port = await allocatePort();
  }
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("Invalid developer bridge port.");
  }

  // A reused Desktop reads config.toml for new threads; never point it at a
  // candidate until that bridge is ready. Older bridges keep active turns.
  await ensure(String(port));
  if (readPointer(pointer) !== before) {
    throw new Error("Developer bridge selection changed concurrently.");
  }
  const configFile = path.join(home, "config.toml");
  const original = fs.readFileSync(configFile, "utf8");
  const config = editSettings(original, ["model_providers", "github-copilot"], {
    base_url: JSON.stringify(`http://127.0.0.1:${port}`),
  });
  if (config !== original) {
    atomicWrite(configFile, config, { expectedContents: original });
  }
  const contents = `${port}\n`;
  if (contents !== before) {
    atomicWrite(pointer, contents, { expectedContents: before });
  }
  return String(port);
}
