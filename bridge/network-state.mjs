import { createHash } from "node:crypto";
import dns from "node:dns";
import os from "node:os";

const DISPATCHER_SYMBOL = Symbol.for("undici.globalDispatcher.1");
let previousSignature = null;
let generation = 0;

export function currentNetworkSignature() {
  const interfaces = [];
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.internal) continue;
      interfaces.push(`${name}|${address.family}|${address.address}|${address.scopeid || 0}`);
    }
  }
  const proxies = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"].map(
    (name) => `${name}=${process.env[name] || ""}`,
  );
  let dnsServers = [];
  try {
    dnsServers = dns.getServers().sort();
  } catch {
    /* A transient DNS reconfiguration still changes the interface signature. */
  }
  return JSON.stringify({
    interfaces: interfaces.sort(),
    dns: dnsServers,
    proxies,
  });
}

function resetFetchConnections() {
  const current = globalThis[DISPATCHER_SYMBOL];
  if (!current || typeof current.constructor !== "function") return false;
  try {
    globalThis[DISPATCHER_SYMBOL] = new current.constructor();
    Promise.resolve(current.close?.()).catch(() => current.destroy?.());
    return true;
  } catch {
    return false;
  }
}

function signatureId(signature) {
  return createHash("sha256").update(signature).digest("hex").slice(0, 12);
}

export function observeNetworkState(signature = currentNetworkSignature()) {
  if (previousSignature === null) {
    previousSignature = signature;
    return { changed: false, generation, id: signatureId(signature), connectionsReset: false };
  }
  if (signature === previousSignature) {
    return { changed: false, generation, id: signatureId(signature), connectionsReset: false };
  }
  previousSignature = signature;
  generation += 1;
  return {
    changed: true,
    generation,
    id: signatureId(signature),
    connectionsReset: resetFetchConnections(),
  };
}

export function startNetworkMonitor(onChange, intervalMs = 2000) {
  observeNetworkState();
  const timer = setInterval(() => {
    const event = observeNetworkState();
    if (event.changed) onChange(event);
  }, intervalMs);
  timer.unref?.();
  return timer;
}

export function resetNetworkStateForTests() {
  previousSignature = null;
  generation = 0;
}
