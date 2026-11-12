import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { atomicWrite } from "./settings.mjs";
import { windowsSystemEnvironment } from "../windows-system-environment.mjs";

const CACHE_MESSAGES = Object.freeze({
  stale_cache_lock: "An abandoned local credential-cache lock could not be recovered safely. No credential was removed; this is a local cache problem, not a request to sign in again.",
  cache_lock_busy: "Work IQ's local credential cache is busy. Retry after the current operation finishes; no account fallback or sign-in was started.",
  cache_lock_ownership_changed: "The local credential-cache lock changed ownership unexpectedly. The replacement lock was preserved.",
});

export class CacheAccessError extends Error {
  constructor(code) {
    super(CACHE_MESSAGES[code] || "The local Work IQ credential cache is unavailable.");
    this.code = code;
  }
}

const ownedLocks = new Set();
process.once("exit", () => {
  for (const unlock of ownedLocks) {
    try { unlock(); } catch { /* A replacement lock must never be removed. */ }
  }
});

export function recoverAbandonedLock(lock, expectedRecord) {
  if (process.platform !== "win32") return { status: "unavailable" };
  const resolved = path.resolve(lock);
  if (!resolved.endsWith(".lock") || Buffer.byteLength(expectedRecord) > 4096) return { status: "unavailable" };
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  if (!/^[a-z]:\\/i.test(systemRoot)) return { status: "unavailable" };
  const response = spawnSync(path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-File",
    path.join(import.meta.dirname, "recover-lock.ps1"),
    "-LockPath", resolved,
    "-ExpectedSha256", createHash("sha256").update(expectedRecord).digest("hex"),
  ], { windowsHide: true, encoding: "utf8", timeout: 8000, maxBuffer: 16 * 1024,
    env: windowsSystemEnvironment() });
  if (response.error || response.status !== 0) return { status: "unavailable" };
  try { return JSON.parse(response.stdout); } catch { return { status: "unavailable" }; }
}

export function dpapi(operation, value, { purpose = "token-cache" } = {}) {
  if (!["token-cache", "action-record"].includes(purpose)) throw new Error("Unknown Work IQ vault purpose.");
  if (process.platform !== "win32") {
    throw new Error("Persistent Work IQ credentials currently require the Windows current-user vault. No plaintext fallback is allowed.");
  }
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  if (!/^[a-z]:\\/i.test(systemRoot)) throw new Error("A local Windows system directory is required for the credential vault.");
  const powershell = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const child = spawnSync(powershell, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-File",
    path.join(import.meta.dirname, "vault.ps1"), "-Operation", operation, "-Purpose", purpose,
  ], { input: value, encoding: "utf8", windowsHide: true, timeout: 15_000, maxBuffer: 16 * 1024 * 1024,
    env: windowsSystemEnvironment() });
  if (child.error || child.status !== 0 || !child.stdout) {
    throw new Error("Work IQ current-user credential vault is unavailable. No credentials were written as plaintext.");
  }
  return child.stdout;
}

export async function acquireCacheLock(file, { timeoutMs = 12_000, recover = recoverAbandonedLock } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = fs.openSync(lock, "wx", 0o600);
      const record = JSON.stringify({ schemaVersion: 2, pid: process.pid, createdAt: Date.now(), ownerId: randomUUID() });
      let openedStat;
      try {
        openedStat = fs.fstatSync(fd, { bigint: true });
        fs.writeFileSync(fd, record);
      }
      catch (writeError) {
        fs.closeSync(fd);
        try {
          const currentStat = fs.lstatSync(lock, { bigint: true });
          if (openedStat && currentStat.isFile() && currentStat.ino === openedStat.ino && currentStat.dev === openedStat.dev) fs.unlinkSync(lock);
        } catch { /* Preserve an unverified or already-replaced path. */ }
        throw writeError;
      }
      let released = false;
      const unlock = () => {
        if (released) return;
        released = true;
        ownedLocks.delete(unlock);
        fs.closeSync(fd);
        let current;
        try { current = fs.readFileSync(lock, "utf8"); }
        catch { throw new CacheAccessError("cache_lock_ownership_changed"); }
        if (current !== record) throw new CacheAccessError("cache_lock_ownership_changed");
        fs.unlinkSync(lock);
      };
      ownedLocks.add(unlock);
      return unlock;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const stat = fs.lstatSync(lock);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error("Unverifiable lock record.");
        const record = fs.readFileSync(lock, "utf8");
        const owner = JSON.parse(record);
        if (Number.isInteger(owner.pid) && owner.pid > 0) {
          try { process.kill(owner.pid, 0); } catch (probe) {
            if (probe.code === "ESRCH") {
              const recovered = recover(lock, record);
              if (["recovered", "changed"].includes(recovered?.status)) continue;
              if (!["busy", "live"].includes(recovered?.status)) {
                const failure = new CacheAccessError("stale_cache_lock");
                failure.recoveryDiagnostic = {
                  stage: recovered?.stage || null,
                  exceptionType: recovered?.exceptionType || null,
                  hresult: recovered?.hresult || null,
                };
                throw failure;
              }
            }
          }
        }
      } catch (probe) {
        if (probe instanceof CacheAccessError) throw probe;
        /* A live owner may still be writing. Never remove an unverified lock. */
      }
      if (Date.now() >= deadline) throw new CacheAccessError("cache_lock_busy");
      await delay(60);
    }
  }
}

export class SecureCachePlugin {
  constructor(file, { protect = value => dpapi("protect", value), unprotect = value => dpapi("unprotect", value) } = {}) {
    this.file = file;
    this.protect = protect;
    this.unprotect = unprotect;
    this.unlock = null;
  }

  async beforeCacheAccess(context) {
    this.unlock = await acquireCacheLock(this.file);
    try {
      if (fs.existsSync(this.file)) {
        context.tokenCache.deserialize(await this.unprotect(fs.readFileSync(this.file, "utf8")));
      } else {
        context.tokenCache.deserialize("{}");
      }
    } catch {
      this.release();
      throw new Error("Work IQ encrypted cache could not be read. Sign in again using this profile; no other application's credentials were consulted.");
    }
  }

  async afterCacheAccess(context) {
    try {
      if (context.cacheHasChanged) {
        atomicWrite(this.file, await this.protect(context.tokenCache.serialize()));
      }
    } finally {
      this.release();
    }
  }

  release() {
    if (this.unlock) {
      const unlock = this.unlock;
      this.unlock = null;
      unlock();
    }
  }
}
