import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { assertPrivateDesktopHome, desktopSnapshot, desktopStateRoot, prospectivePath } from "./desktop-runtime.mjs";
import { desktopEndpointOwner, desktopProcessMatches, readProcessIdentity, sameProcessLifetime } from "./desktop-process.mjs";
import { awaitDesktopRenderer } from "./desktop-readiness.mjs";

const MAX_METADATA = 256 * 1024;
const token = value => typeof value === "string" &&
  /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const equalPath = (left, right) => {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const normalized = value => process.platform === "win32" ? value.toLowerCase() : value;
  return normalized(prospectivePath(left)) === normalized(prospectivePath(right));
};

function regularBytes(file, optional = false) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_METADATA) {
      throw new Error("Desktop instance state must be a bounded private regular file.");
    }
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if (optional && error.code === "ENOENT") return null;
    throw error;
  }
}

export function readDesktopInstance(home) {
  assertPrivateDesktopHome(home);
  const text = regularBytes(path.join(home, "desktop-instance.json"), true);
  return text === null ? null : JSON.parse(text.replace(/^\uFEFF/, ""));
}

export function writeDesktopInstance(home, receipt) {
  assertPrivateDesktopHome(home);
  const file = path.join(home, "desktop-instance.json");
  regularBytes(file, true);
  const pending = path.join(home, `desktop-instance-${randomUUID()}.pending`);
  fs.writeFileSync(pending, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  try { fs.renameSync(pending, file); }
  finally { if (fs.existsSync(pending)) fs.unlinkSync(pending); }
}

export function publicProcessIdentity(identity) {
  if (!identity || !Number.isSafeInteger(identity.pid) || identity.pid <= 0 ||
      !["win32", "linux", "darwin"].includes(identity.platform) ||
      typeof identity.lifetime !== "string" || !identity.lifetime ||
      typeof identity.executable !== "string" || !path.isAbsolute(identity.executable)) {
    throw new Error("Desktop process lifetime is unavailable.");
  }
  return { pid: identity.pid, platform: identity.platform,
    lifetime: identity.lifetime, executable: identity.executable };
}

export function bindDesktopInstance({
  root, home, receipt = readDesktopInstance(home),
  inspectProcess = readProcessIdentity,
  snapshot = desktopSnapshot,
  owner = desktopEndpointOwner,
  readiness = awaitDesktopRenderer,
  selection,
}) {
  assertPrivateDesktopHome(home);
  if (receipt === null) return null;
  const gateway = receipt?.schemaVersion === 3 && receipt.mode === "app-server-gateway";
  const validMode = gateway ? receipt.bridgePort === null && /^[a-f0-9]{64}$/.test(receipt.configGeneration || "")
    : receipt?.schemaVersion === 2 && (!receipt.mode || receipt.mode === "provider-bridge") &&
      Number.isInteger(receipt.bridgePort) && receipt.bridgePort >= 1024 && receipt.bridgePort <= 65535;
  if (!validMode || !token(receipt.instanceToken) ||
      !Number.isSafeInteger(receipt.pid) || receipt.pid <= 0 ||
      !Number.isInteger(receipt.debugPort) || receipt.debugPort < 1024 || receipt.debugPort > 65535 ||
      !equalPath(receipt.installRoot, root) || !equalPath(receipt.profile, home) ||
      !equalPath(receipt.runtimeStateRoot, desktopStateRoot({ root, home })) ||
      !equalPath(receipt.userData, path.join(home, "desktop-data")) ||
      !Array.isArray(receipt.launchArgs) || receipt.launchArgs.length > 256 ||
      receipt.launchArgs.some(arg => typeof arg !== "string" || arg.length > 64 * 1024)) {
    throw new Error("Desktop receipt is legacy, unrelated or unverified; no running window was borrowed.");
  }
  const runtime = snapshot(root, { version: receipt.snapshotVersion, stateRoot: receipt.runtimeStateRoot });
  if (!equalPath(receipt.executable, runtime.executable) ||
      !equalPath(receipt.resources, runtime.resources) ||
      receipt.identity?.pid !== receipt.pid ||
      !equalPath(receipt.identity?.executable, runtime.executable)) {
    throw new Error("Desktop receipt does not bind the private vendor snapshot.");
  }
  const expected = { executable: runtime.executable, userData: receipt.userData,
    port: receipt.debugPort, launchArgs: receipt.launchArgs };
  const identity = inspectProcess(receipt.pid, { expectedLifetime: receipt.identity.lifetime });
  if (identity === null) return null;
  if (selection && receipt && ((receipt.mode || "provider-bridge") !== selection.mode ||
      (receipt.configGeneration ?? null) !== selection.generation)) throw new Error("Desktop instance mode/configuration changed; close this instance before applying it.");

  if (!sameProcessLifetime(receipt.identity, identity) ||
      !desktopProcessMatches(identity, expected)) {
    throw new Error("Desktop PID was reused or belongs to a different executable/profile; no extension was attached.");
  }
  const assertIdentity = () => {
    const current = inspectProcess(receipt.pid, { expectedLifetime: identity.lifetime });
    if (!sameProcessLifetime(identity, current) || !desktopProcessMatches(current, expected)) {
      throw new Error("The private Desktop lifetime ended or changed; no other process was used.");
    }
  };
  const assertOwned = () => {
    assertIdentity();
    if (owner(receipt.debugPort, { pid: receipt.pid }) !== receipt.pid) {
      throw new Error("The private Desktop endpoint changed owner; no extension was attached.");
    }
    assertIdentity();
  };
  return {
    receipt, runtime, identity, assertIdentity, assertOwned,
    awaitReady: () => readiness({
      pid: receipt.pid, port: receipt.debugPort, assertIdentity,
      owner: port => owner(port, { pid: receipt.pid }),
    }),
  };
}

export function helperProcessMatches(identity, {
  script, receiptFile, helperToken,
}) {
  if (!identity || !token(helperToken)) return false;
  const expected = [script, "--instance", receiptFile, "--token", helperToken];
  if (Array.isArray(identity.args)) {
    return identity.args.length === expected.length + 1 &&
      identity.args.slice(1).every((arg, index) => arg === expected[index]);
  }
  return identity.platform === "darwin" &&
    identity.commandLine === [identity.executable, ...expected].join(" ");
}

/** Per-profile launch serialization. It never waits on or stops a user process. */
export function acquireDesktopStartLock(home, {
  inspectProcess = readProcessIdentity, pid = process.pid,
} = {}) {
  assertPrivateDesktopHome(home);
  const file = path.join(home, "desktop-launch.lock");
  const mine = {
    schemaVersion: 1, namespace: "codex-copilot/desktop-start",
    token: randomUUID(), identity: publicProcessIdentity(inspectProcess(pid)),
    createdAt: new Date().toISOString(),
  };
  const bytes = `${JSON.stringify(mine)}\n`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, bytes, { flag: "wx", mode: 0o600 });
      return () => {
        if (regularBytes(file) !== bytes) {
          throw new Error("Desktop launch lock changed ownership; it was not removed.");
        }
        fs.unlinkSync(file);
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const previous = regularBytes(file);
      const owner = JSON.parse(previous);
      if (owner.schemaVersion !== 1 || owner.namespace !== mine.namespace ||
          !token(owner.token) || !Number.isSafeInteger(owner.identity?.pid) ||
          owner.identity.pid <= 0 ||
          !["win32", "linux", "darwin"].includes(owner.identity.platform) ||
          typeof owner.identity.executable !== "string" || !path.isAbsolute(owner.identity.executable) ||
          typeof owner.identity?.lifetime !== "string" || !owner.identity.lifetime) {
        throw new Error("Desktop launch lock is unrecognized; it was not removed.");
      }
      const active = inspectProcess(owner.identity.pid, { expectedLifetime: owner.identity.lifetime });
      if (sameProcessLifetime(owner.identity, active)) {
        throw new Error("This private Desktop profile is already starting; retry when startup completes. No process was stopped.");
      }
      if (regularBytes(file) !== previous) {
        throw new Error("Desktop launch lock changed concurrently; it was not removed.");
      }
      fs.unlinkSync(file);
    }
  }
  throw new Error("Desktop launch lock could not be acquired.");
}
