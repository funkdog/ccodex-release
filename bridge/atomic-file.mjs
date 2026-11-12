import fs from "node:fs";
import path from "node:path";
import { randomInt, randomUUID } from "node:crypto";

const delay = new Int32Array(new SharedArrayBuffer(4));
const busy = new Set(["EACCES", "EBUSY", "EPERM"]);

/** Never remove the destination to work around a Windows sharing violation. */
export function atomicWrite(file, contents, { expectedContents, timeoutMs = 10000 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const checkExpected = () => {
    if (expectedContents === undefined) return;
    let current = null;
    try { current = fs.readFileSync(file, "utf8"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (current !== expectedContents) {
      throw new Error("Configuration changed concurrently; the newer file was not overwritten.");
    }
  };
  try {
    checkExpected();
    fs.writeFileSync(temporary, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    const deadline = Date.now() + timeoutMs;
    let waitMs = 5;
    for (;;) {
      checkExpected();
      try {
        fs.renameSync(temporary, file);
        return;
      } catch (error) {
        if (process.platform !== "win32" || !busy.has(error.code) || Date.now() >= deadline) throw error;
        // Frequent jittered retries avoid synchronizing with Windows watchers.
        Atomics.wait(delay, 0, 0, Math.min(randomInt(1, waitMs + 1),
          Math.max(1, deadline - Date.now())));
        waitMs = Math.min(waitMs * 2, 25);
      }
    }
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
