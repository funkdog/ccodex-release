import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function assertRegularPath(value, { allowMissing = true } = {}) {
  const target = path.resolve(value);
  let current = target;
  while (current) {
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        throw new Error("Release-owned paths cannot traverse symbolic links or junctions.");
      }
    } catch (error) {
      if (!allowMissing || error.code !== "ENOENT") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return target;
}

export function contains(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return !relative || (relative !== ".." && !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative));
}

export function assertReleaseProfile(home, root, inherited = process.env) {
  home = assertRegularPath(home);
  const realHome = inherited.CCODEX_REAL_USERPROFILE || inherited.USERPROFILE || os.homedir();
  const realLocal = inherited.CCODEX_REAL_LOCALAPPDATA || inherited.LOCALAPPDATA ||
    path.join(realHome, "AppData", "Local");
  const forbidden = [
    root, path.join(realHome, ".codex"), path.join(realHome, ".copilot"),
    path.join(realHome, ".codex-copilot"),
    path.join(realLocal, "OpenAI"),
    path.join(realLocal, "CodexCopilot"),
  ];
  if (home.toLowerCase() === path.resolve(realHome).toLowerCase() ||
      forbidden.some(directory => contains(directory, home) || contains(home, directory))) {
    throw new Error("Release profile must not overlap an existing product, the user home, or an installation slot.");
  }
  return home;
}

export function boundedJson(file, maximum = 1024 * 1024) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum) {
    throw new Error("Release metadata must be a bounded regular file.");
  }
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

export function acquireFileLock(file, owner = process.pid) {
  assertRegularPath(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let handle;
  try {
    handle = fs.openSync(file, "wx", 0o600);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const previous = boundedJson(file, 4096);
    if (!Number.isInteger(previous.pid) || previous.pid < 1) {
      throw new Error("A malformed preparation lock needs inspection; no state was changed.");
    }
    let alive = true;
    try { process.kill(previous.pid, 0); }
    catch (probe) { if (probe.code === "ESRCH") alive = false; }
    if (alive) throw new Error("Another release operation is active. Retry when it finishes.");
    // A stale lock is removed only after its recorded process no longer exists.
    fs.unlinkSync(file);
    handle = fs.openSync(file, "wx", 0o600);
  }
  fs.writeFileSync(handle, JSON.stringify({ pid: owner, startedAt: new Date().toISOString() }));
  fs.closeSync(handle);
  return () => {
    if (fs.existsSync(file) && boundedJson(file, 4096).pid === owner) fs.unlinkSync(file);
  };
}
