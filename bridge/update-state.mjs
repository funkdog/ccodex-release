import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";

export const DESKTOP_DOWNLOADS = Object.freeze({
  "windows-arm64": "https://persistent.oaistatic.com/codex-app-prod/ChatGPT-arm64.msix",
  "windows-x64": "https://persistent.oaistatic.com/codex-app-prod/ChatGPT-x64.msix",
  "macos-arm64": "https://persistent.oaistatic.com/codex-app-prod/ChatGPT.dmg",
  "macos-x64": "https://persistent.oaistatic.com/codex-app-prod/ChatGPT.dmg",
  "linux-arm64": "https://persistent.oaistatic.com/codex-app-prod/linux/deb/latest/chatgpt_arm64.deb",
  "linux-x64": "https://persistent.oaistatic.com/codex-app-prod/linux/deb/latest/chatgpt_amd64.deb",
});

function regular(file, optional = false) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) {
      throw new Error("Update metadata must be a bounded regular file.");
    }
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if (optional && error.code === "ENOENT") return null;
    throw error;
  }
}

function atomic(file, value) {
  const pending = `${file}.${randomUUID()}.pending`;
  fs.writeFileSync(pending, `${JSON.stringify(value, null, 2)}\n`,
    { flag: "wx", mode: 0o600 });
  try { fs.renameSync(pending, file); }
  finally { if (fs.existsSync(pending)) fs.unlinkSync(pending); }
}

function restore(file, bytes) {
  if (bytes === null) {
    fs.unlinkSync(file);
    return;
  }
  const pending = `${file}.${randomUUID()}.rollback`;
  fs.writeFileSync(pending, bytes, { flag: "wx", mode: 0o600 });
  try { fs.renameSync(pending, file); }
  finally { if (fs.existsSync(pending)) fs.unlinkSync(pending); }
}

export function sourceFingerprint(root, relativeFiles) {
  const actualRoot = fs.realpathSync(root);
  const hash = createHash("sha256");
  for (const relative of [...relativeFiles].sort()) {
    if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) {
      throw new Error("Extension source escaped its installation.");
    }
    const file = path.join(root, relative);
    const actual = path.relative(actualRoot, fs.realpathSync(file));
    if (actual === ".." || actual.startsWith(`..${path.sep}`) || path.isAbsolute(actual)) {
      throw new Error("Extension source escaped through a link.");
    }
    hash.update(relative).update("\0").update(regular(file));
  }
  return hash.digest("hex");
}

/** An upstream update is not promoted until the current extension snapshot passes. */
export async function promoteDesktopUpdate({
  root,
  sourceRoot = root,
  candidate,
  extensionFiles,
  validate,
  preparedReceipt,
  assertOwned = () => {},
}) {
  assertOwned();
  if (!/^[\d.]+-[a-f0-9]{12}$/.test(candidate || "")) {
    throw new Error("Invalid candidate Desktop version.");
  }
  const desktop = path.join(root, "desktop");
  if (fs.lstatSync(desktop).isSymbolicLink()) throw new Error("Desktop update root cannot be linked.");
  const pointer = path.join(desktop, "current.json");
  const before = regular(pointer, true);
  const generation = sourceFingerprint(sourceRoot, extensionFiles);
  const attempt = {
    schemaVersion: 1, id: randomUUID(), candidate,
    previous: before ? JSON.parse(before).version : null,
    extensionGeneration: generation, startedAt: new Date().toISOString(),
    status: "validating", originalInstallationModified: false,
  };
  const history = path.join(desktop, "update-history");
  fs.mkdirSync(history, { recursive: true });
  if (fs.lstatSync(history).isSymbolicLink()) throw new Error("Update history cannot be linked.");
  const receipt = path.join(history, `${attempt.id}.json`);
  atomic(receipt, { ...attempt, preparedReceipt });
  let promoted = null;
  try {
    const validation = await validate({ candidate, extensionGeneration: generation });
    assertOwned();
    if (validation?.passed !== true || validation.candidate !== candidate ||
        validation.extensionGeneration !== generation ||
        validation.nativeUiPreserved !== true || validation.contextExtensionVerified !== true) {
      throw new Error("Candidate lacks matching native UI and Context-extension validation.");
    }
    if (sourceFingerprint(sourceRoot, extensionFiles) !== generation) {
      throw new Error("Extensions changed during candidate validation; retry the update.");
    }
    if (regular(pointer, true) !== before) {
      throw new Error("Desktop selection changed concurrently; no update was promoted.");
    }
    assertOwned();
    atomic(pointer, {
      schemaVersion: 1, version: candidate,
      selectedAt: new Date().toISOString(),
      extensionGeneration: generation, updateAttempt: attempt.id,
    });
    promoted = regular(pointer);
    const result = {
      ...attempt, status: "promoted", completedAt: new Date().toISOString(),
      validation, preparedReceipt,
    };
    atomic(receipt, result);
    return { ...result, receipt };
  } catch (error) {
    // A journal-write failure after pointer replacement is not a successful
    // update. Roll back only this attempt; never overwrite a newer selection.
    if (promoted !== null && regular(pointer, true) === promoted) restore(pointer, before);
    const result = {
      ...attempt, status: "rejected", completedAt: new Date().toISOString(),
      error: error.message, preparedReceipt,
    };
    atomic(receipt, result);
    throw Object.assign(error, { updateReceipt: receipt });
  }
}
