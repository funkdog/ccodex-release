import path from "node:path";
import { spawn } from "node:child_process";
import { nativeAdapterCommand } from "./native-adapter.mjs";

export async function verifyDesktopBackend({
  root, home, runtime, env, timeoutMs = 30000, shutdownMs = 10000,
  start = spawn, command = nativeAdapterCommand,
}) {
  if (!root || !home || !runtime?.resources || !env ||
      !Number.isFinite(timeoutMs) || timeoutMs <= 0 ||
      !Number.isFinite(shutdownMs) || shutdownMs <= 0) {
    throw new Error("Invalid private Desktop backend validation parameters.");
  }
  const executable = path.join(runtime.resources, "codex.exe");
  const target = command(root, executable, [
    "-c", "features.code_mode_host=true", "app-server",
  ]);
  const child = start(target.file, target.args, {
    env: { ...env, LOG_FORMAT: "json", RUST_LOG: env.RUST_LOG || "warn",
      CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Codex Desktop" },
    cwd: path.dirname(runtime.resources), windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "", stderr = "", nextId = 0, closed = false, closing = false;
  let exitCode = null;
  let failure;
  const pending = new Map();
  const fail = error => {
    failure ||= error;
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  };
  const close = new Promise(resolve => {
    child.once("close", code => {
      closed = true;
      exitCode = code;
      if (!closing) fail(new Error(stderr.trim() ||
        `Private Desktop backend exited before validation (exit ${code}).`));
      resolve(code);
    });
  });
  child.once("error", fail);
  child.stdin.on("error", fail);
  child.stdout.setEncoding("utf8");
  child.stderr.on("data", bytes => { stderr = (stderr + bytes).slice(-16384); });
  child.stdout.on("data", bytes => {
    buffer += bytes;
    if (buffer.length > 1024 * 1024) {
      fail(new Error("Private Desktop backend returned an oversized response."));
      child.stdin.end();
      return;
    }
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end < 0) break;
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      let message;
      try { message = JSON.parse(line); }
      catch { continue; }
      const entry = pending.get(message.id);
      if (!entry) continue;
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message ||
        "Private Desktop backend rejected state validation."));
      else entry.resolve(message.result);
    }
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    if (failure) { reject(failure); return; }
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
  const deadline = setTimeout(() => {
    fail(new Error("Private Desktop backend state validation timed out."));
    child.stdin.end();
  }, timeoutMs);
  let result;
  let error;
  try {
    const initialized = await request("initialize", {
      clientInfo: { name: "ccodex-release-state-check", version: "1" },
      capabilities: { experimentalApi: true },
    });
    if (typeof initialized?.codexHome !== "string" ||
        path.resolve(initialized.codexHome).toLowerCase() !== path.resolve(home).toLowerCase()) {
      throw new Error("Private Desktop backend initialized a different profile.");
    }
    child.stdin.write('{"method":"initialized","params":{}}\n');
    const threads = await request("thread/list", { limit: 1 });
    if (!Array.isArray(threads?.data)) {
      throw new Error("Private Desktop backend did not return a valid state query.");
    }
    result = { sqliteReady: true, profileVerified: true, stateQueryVerified: true,
      modelRequestsSent: false };
  } catch (cause) {
    error = cause;
  } finally {
    clearTimeout(deadline);
    closing = true;
    child.stdin.end();
    if (!closed) {
      let timer;
      await Promise.race([close, new Promise(resolve => {
        timer = setTimeout(resolve, shutdownMs);
      })]);
      clearTimeout(timer);
    }
    if (!closed) {
      // This handle belongs to the wrapper created above, never a discovered user process.
      child.kill();
      error ||= new Error("Private Desktop backend did not finish its validation shutdown.");
    } else if (exitCode !== 0) {
      error ||= new Error(stderr.trim() ||
        `Private Desktop backend validation failed (exit ${exitCode}).`);
    }
  }
  if (error) {
    throw new Error(`Desktop state check failed: ${error.message}\n` +
      "The release launcher did not delete databases or substitute a system profile.", { cause: error });
  }
  return result;
}
