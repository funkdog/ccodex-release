import fs from "node:fs";
import path from "node:path";
import { assertRegularPath } from "./paths.mjs";

export function desktopStartupStatus({ home, receipt }) {
  if (!Number.isSafeInteger(receipt?.pid) || receipt.pid <= 0 ||
      !Number.isFinite(Date.parse(receipt.launchedAt))) {
    throw new Error("Desktop backend readiness requires a verified launch receipt.");
  }
  const date = new Date(receipt.launchedAt);
  const logs = assertRegularPath(path.join(home, "host-profile", "AppData", "Local", "Codex", "Logs",
    String(date.getUTCFullYear()), String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0")));
  let files;
  try { files = fs.readdirSync(logs); }
  catch (error) {
    if (error.code === "ENOENT") return { ready: false };
    throw error;
  }
  const own = files.filter(name => name.includes(`-${receipt.pid}-t`) && name.endsWith(".log"));
  if (own.length > 128) throw new Error("Too many private Desktop startup log segments.");
  let ready = false;
  for (const name of own) {
    const file = path.join(logs, name);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("Desktop startup log must be a regular, private file.");
    }
    if (stat.mtimeMs < Date.parse(receipt.launchedAt) - 30000) continue;
    const fd = fs.openSync(file, "r");
    let text;
    try {
      const first = Buffer.alloc(Math.min(stat.size, 256 * 1024));
      fs.readSync(fd, first, 0, first.length, 0);
      text = first.toString("utf8");
      if (stat.size > first.length) {
        const last = Buffer.alloc(Math.min(stat.size - first.length, 256 * 1024));
        fs.readSync(fd, last, 0, last.length, stat.size - last.length);
        text += "\n" + last.toString("utf8");
      }
    } finally { fs.closeSync(fd); }
    if (/Desktop bootstrap failed to start the main app/.test(text) ||
        /app_server_connection\.closed[^\n]*hostKind=local[^\n]*failed to initialize sqlite/.test(text)) {
      throw new Error("The actual Desktop backend failed to initialize its private state. " +
        "The enhanced helper was not started; the profile was preserved.");
    }
    if (/app_server_connection\.state_changed[^\n]*hostId=local[^\n]*initialized=true[^\n]*next=connected/.test(text)) {
      ready = true;
    }
  }
  return ready ? { ready: true, desktopBackendVerified: true } : { ready: false };
}

export async function awaitDesktopBackend({
  home, receipt, assertIdentity, timeoutMs = 30000,
  status = desktopStartupStatus, pause = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = Date.now,
}) {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const state = status({ home, receipt });
    if (state.ready) {
      await assertIdentity();
      return { desktopBackendVerified: true };
    }
    await assertIdentity();
    await pause(200);
  }
  throw new Error("The actual Desktop backend did not become ready. " +
    "No enhanced helper was started and no existing user process was stopped.");
}
