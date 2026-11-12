import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { assertRegularPath, boundedJson } from "./paths.mjs";
import { sha256File } from "./integrity.mjs";
import { readProcessIdentity, sameProcessLifetime } from "../bridge/desktop-process.mjs";

const prefix = "runtime/primary/codex-primary-runtime/";

export function renamePrivateResource(from, to, {
  rename = fs.renameSync, platform = process.platform, now = () => performance.now(),
  sleep = milliseconds => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds),
  timeoutMs = 30000,
} = {}) {
  const deadline = now() + timeoutMs;
  for (;;) {
    assertRegularPath(from, { allowMissing: false });
    assertRegularPath(to);
    try { rename(from, to); return; }
    catch (error) {
      // Windows scanners can briefly hold a freshly copied resource directory.
      if (platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(error.code) ||
          now() >= deadline) throw error;
      sleep(Math.min(100, Math.max(1, deadline - now())));
    }
  }
}

function assertIdleRuntime(home, inspect) {
  const receiptFile = path.join(home, "desktop-instance.json");
  if (!fs.existsSync(receiptFile)) return;
  const receipt = boundedJson(receiptFile, 256 * 1024);
  if ([receipt.identity, receipt.helperIdentity].filter(Boolean).some(identity =>
    sameProcessLifetime(identity, inspect(identity.pid, { expectedLifetime: identity.lifetime })))) {
    throw new Error("Close this release Desktop before refreshing pinned document runtimes. No process was stopped.");
  }
}

/** Replace only the private resource cache when its vendor bundle drifted. */
export function restorePinnedPrimaryRuntime(root, home, inspect = readProcessIdentity, renameOptions) {
  const source = assertRegularPath(path.join(root, "runtime", "primary", "codex-primary-runtime"), { allowMissing: false });
  const target = assertRegularPath(path.join(home, "host-profile", ".cache", "codex-runtimes", "codex-primary-runtime"));
  const expected = boundedJson(path.join(source, "runtime.json"));
  let actual;
  try { actual = boundedJson(path.join(target, "runtime.json")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (actual?.bundleVersion === expected.bundleVersion &&
      actual.targetArch === expected.targetArch && actual.artifactToolVersion === expected.artifactToolVersion) {
    return { changed: false, bundleVersion: expected.bundleVersion };
  }
  assertIdleRuntime(home, inspect);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const pending = assertRegularPath(`${target}.release-${randomUUID()}`);
  const backup = assertRegularPath(`${target}.previous-${randomUUID()}`);
  let saved = false;
  try {
    fs.cpSync(source, pending, { recursive: true, filter(from) {
      if (fs.lstatSync(from).isSymbolicLink()) throw new Error("Pinned runtime resources cannot contain links.");
      return true;
    } });
    assertIdleRuntime(home, inspect);
    if (fs.existsSync(target)) { renamePrivateResource(target, backup, renameOptions); saved = true; }
    try { renamePrivateResource(pending, target, renameOptions); }
    catch (error) { if (saved) renamePrivateResource(backup, target, renameOptions); throw error; }
  } finally {
    if (fs.existsSync(pending)) fs.rmSync(assertRegularPath(pending), { recursive: true });
  }
  if (saved) fs.rmSync(assertRegularPath(backup), { recursive: true });
  return { changed: true, bundleVersion: expected.bundleVersion };
}

/** Update only pinned runtime resources, never destination credentials or settings. */
export function synchronizePrimaryOverrides(root, home, inspect = readProcessIdentity, renameOptions) {
  const source = path.join(root, "runtime", "primary", "codex-primary-runtime");
  const destination = path.join(home, "host-profile", ".cache", "codex-runtimes", "codex-primary-runtime");
  const overrides = boundedJson(path.join(root, "release", "runtime-overrides.json"));
  const plans = [];
  const filePlan = relative => {
    if (!relative.startsWith(prefix) || relative.split("/").some(part => !part || part === ".." || part === ".")) {
      throw new Error("Invalid pinned primary-runtime override path.");
    }
    const local = relative.slice(prefix.length);
    const from = assertRegularPath(path.join(source, local), { allowMissing: false });
    const to = assertRegularPath(path.join(destination, local));
    return { from, to };
  };
  for (const change of overrides.changes) {
    if (change.name === "skia-canvas") {
      for (const location of change.locations) {
        const files = [...change.sourceFiles, { path: "lib/skia.node", sha256: change.nativeSha256 }];
        const entries = files.map(file => {
          const plan = filePlan(`${location}/${file.path}`);
          if (sha256File(plan.from) !== file.sha256) throw new Error("Pinned Skia override is damaged.");
          return { ...plan, sha256: file.sha256 };
        });
        if (entries.some(file => !fs.existsSync(file.to) || sha256File(file.to) !== file.sha256)) {
          plans.push({ type: "directory", ...filePlan(location) });
        }
      }
    } else if (change.name === "pdfkit-standard-fonts") {
      for (const location of change.locations) {
        for (const file of change.files) {
          const plan = filePlan(`${location}/runtime-standard-fonts/${file.path}`);
          if (sha256File(plan.from) !== file.sha256) throw new Error("Pinned PDF font is damaged.");
          if (!fs.existsSync(plan.to) || sha256File(plan.to) !== file.sha256) plans.push({ type: "file", ...plan });
        }
        const plan = filePlan(`${location}/package.json`);
        if (!fs.existsSync(plan.to) || sha256File(plan.to) !== sha256File(plan.from)) plans.push({ type: "file", ...plan });
      }
    } else if (/^@napi-rs\/canvas-win32-(arm64|x64)-msvc$/.test(change.name)) {
      const plan = filePlan(change.file);
      if (sha256File(plan.from) !== change.sha256) throw new Error("Pinned canvas ICU data is damaged.");
      if (!fs.existsSync(plan.to) || sha256File(plan.to) !== change.sha256) plans.push({ type: "file", ...plan });
    } else if (change.name === "windows-document-paths") {
      for (const file of change.files) {
        const plan = filePlan(file.path);
        if (sha256File(plan.from) !== file.sha256) throw new Error("Pinned document path fix is damaged.");
        if (!fs.existsSync(plan.to) || sha256File(plan.to) !== file.sha256) plans.push({ type: "file", ...plan });
      }
    } else {
      throw new Error("Unrecognized primary-runtime override.");
    }
  }
  if (!plans.length) return { changed: 0 };
  assertIdleRuntime(home, inspect);
  for (const plan of plans) {
    fs.mkdirSync(path.dirname(plan.to), { recursive: true });
    const pending = `${plan.to}.release-${randomUUID()}`;
    const backup = `${plan.to}.previous-${randomUUID()}`;
    assertRegularPath(pending);
    fs.cpSync(plan.from, pending, { recursive: plan.type === "directory" });
    let saved = false;
    try {
      assertIdleRuntime(home, inspect);
      if (fs.existsSync(plan.to)) { renamePrivateResource(plan.to, backup, renameOptions); saved = true; }
      try { renamePrivateResource(pending, plan.to, renameOptions); }
      catch (error) {
        if (saved) renamePrivateResource(backup, plan.to, renameOptions);
        throw error;
      }
    } finally {
      if (fs.existsSync(pending)) fs.rmSync(assertRegularPath(pending), { recursive: plan.type === "directory" });
    }
    if (saved) fs.rmSync(assertRegularPath(backup), { recursive: plan.type === "directory" });
  }
  return { changed: plans.length };
}
