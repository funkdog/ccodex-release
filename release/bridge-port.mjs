import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { createHash } from "node:crypto";
import { atomicWrite } from "../bridge/workiq/settings.mjs";
import { editSettings } from "../tools/config-document.mjs";
import { bridgeSourceGeneration } from "../bridge/runtime-generation.mjs";
import { acquireFileLock, assertRegularPath } from "./paths.mjs";

export function profileIdentity(home) {
  return createHash("sha256").update(path.resolve(home).toLowerCase()).digest("hex");
}

async function portAvailable(port) {
  const server = net.createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
    const selected = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return selected;
  } catch (error) {
    if (["EADDRINUSE", "EACCES"].includes(error.code)) return null;
    throw error;
  }
}

export async function ensureReleasePort(home, root, { probe = fetch } = {}) {
  const pointer = path.join(home, "bridge-port.txt");
  assertRegularPath(pointer);
  const selected = fs.existsSync(pointer) ? fs.readFileSync(pointer, "utf8").trim() : "";
  if (selected && (!/^\d+$/.test(selected) || +selected < 1024 || +selected > 65535)) {
    throw new Error("Invalid release bridge pointer; it was preserved for inspection.");
  }
  if (selected) {
    try {
      const response = await probe(`http://127.0.0.1:${selected}/health`, {
        signal: AbortSignal.timeout(1500),
      });
      const health = response.ok && await response.json();
      if (health?.bridge === "codex-copilot" &&
          health.runtime?.releaseProfileIdentity === profileIdentity(home)) {
        const generation = bridgeSourceGeneration(path.join(root, "bridge"));
        if (health.runtime.sourceGeneration === generation) return +selected;
        // Existing sessions keep their older bridge. The new generation receives
        // a new loopback port; no process or in-flight request is terminated.
      }
    } catch {
      if (await portAvailable(+selected)) return +selected;
    }
  }
  const unlock = acquireFileLock(path.join(home, ".release-port.lock"));
  try {
    const current = fs.existsSync(pointer) ? fs.readFileSync(pointer, "utf8").trim() : "";
    if (current !== selected) return +current;
    const port = await portAvailable(0);
    const configFile = path.join(home, "config.toml");
    if (fs.existsSync(configFile)) {
      assertRegularPath(configFile);
      const original = fs.readFileSync(configFile, "utf8");
      const next = editSettings(original, ["model_providers", "github-copilot"], {
        base_url: JSON.stringify(`http://127.0.0.1:${port}`),
      });
      if (fs.readFileSync(configFile, "utf8") !== original) {
        throw new Error("Configuration changed while selecting a bridge port; retry.");
      }
      atomicWrite(configFile, next);
    }
    atomicWrite(pointer, `${port}\n`);
    return port;
  } finally { unlock(); }
}
