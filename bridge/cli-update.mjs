import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { assertPrivateDesktopHome, runtimePath, fileSha256 } from "./desktop-runtime.mjs";
import { desktopExtensionFiles } from "./desktop-extension-files.mjs";
import { sourceFingerprint } from "./update-state.mjs";
import { copyCliComponents, nativeBinaryTarget, verifyCliComponents } from "./cli-components.mjs";

export const OFFICIAL_CLI_RELEASE = "https://api.github.com/repos/openai/codex/releases/latest";
export const CLI_UPDATE_FACTS = Object.freeze([
  "contextSelectionVerified", "nativeInputVerified", "nativeStatusVerified",
  "transcriptAndAttachmentsVerified", "upstreamFeaturesVerified",
  "creditsVerified",
]);
const VERSION = /^\d+\.\d+\.\d+$/;
const ID = /^\d+\.\d+\.\d+-[a-f0-9]{12}$/;
const MAX_METADATA = 1024 * 1024;

function json(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_METADATA) {
    throw new Error("CLI update metadata must be a bounded regular file.");
  }
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

function bytes(file, optional = false) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_METADATA) {
      throw new Error("CLI selection must be a bounded regular file.");
    }
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if (optional && error.code === "ENOENT") return null;
    throw error;
  }
}

function atomic(file, text) {
  bytes(file, true);
  const pending = `${file}.${randomUUID()}.pending`;
  fs.writeFileSync(pending, text, { flag: "wx", mode: 0o600 });
  try { fs.renameSync(pending, file); }
  finally { if (fs.existsSync(pending)) fs.unlinkSync(pending); }
}

function directory(root, relative) {
  runtimePath(root, relative);
  function rejectLinks() {
    let current = root;
    for (const part of relative.split(/[\\/]/)) {
      current = path.join(current, part);
      if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
        throw new Error("CLI update directories cannot be linked.");
      }
    }
  }
  rejectLinks();
  const destination = path.join(root, relative);
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  runtimePath(root, relative);
  rejectLinks();
  return destination;
}

function versionCompare(left, right) {
  if (!VERSION.test(left || "") || !VERSION.test(right || "")) throw new Error("Invalid CLI update version.");
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  if (![...a, ...b].every(Number.isSafeInteger)) throw new Error("CLI update version exceeds its numeric bound.");
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

function coreMetadata(root, relative, target, { legacyManifestRoot } = {}) {
  const core = runtimePath(root, relative);
  const stat = fs.lstatSync(core);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 1024 * 1024 * 1024) {
    throw new Error("An enhanced CLI core must be a private regular executable.");
  }
  const actualTarget = nativeBinaryTarget(core);
  if (actualTarget !== target) throw new Error("CLI executable architecture differs from its target.");
  let manifestFile = runtimePath(root,
    path.join(path.dirname(relative), "codex-copilot-core.manifest.json"));
  if (!fs.existsSync(manifestFile) && legacyManifestRoot && target.startsWith("windows-")) {
    manifestFile = runtimePath(legacyManifestRoot,
      `bin/runtimes/${target.split("-")[1]}/codex-copilot-core.manifest.json`);
  }
  const manifest = json(manifestFile);
  if (manifest.schemaVersion !== 1 || manifest.target !== target ||
      !VERSION.test(manifest.packageVersion || "") ||
      !/^codex-cli \d+\.\d+\.\d+$/.test(manifest.coreVersion || "") ||
      !/^[a-f0-9]{40}$/i.test(manifest.sourceRevision || "") ||
      !/^[a-f0-9]{40}$/i.test(manifest.patchedTree || "") ||
      !/^[a-f0-9]{64}$/i.test(manifest.sha256 || "") ||
      manifest.sha256.toLowerCase() !== fileSha256(core)) {
    throw new Error("The selected CLI core does not match its private build manifest.");
  }
  verifyCliComponents({ core, manifest, target });
  return { core, manifest, relative };
}

export function cliCoreSelection({ root, home, platform = process.platform, arch = process.arch }) {
  root = path.resolve(root);
  home = assertPrivateDesktopHome(home);
  if (!["win32", "linux", "darwin"].includes(platform) || !["arm64", "x64"].includes(arch)) {
    throw new Error("Unsupported CLI update platform.");
  }
  const target = `${platform === "win32" ? "windows" : platform === "darwin" ? "macos" : "linux"}-${arch}`;
  const stateRoot = platform === "win32" ? root : home;
  const pointerRelative = platform === "win32" ? "bin/core-current.txt" : "cli-updates/core-current.txt";
  const pointer = runtimePath(stateRoot, pointerRelative);
  const selected = bytes(pointer, true);
  if (selected !== null) {
    const core = selected.trim();
    if (!path.isAbsolute(core)) throw new Error("CLI core pointer must be absolute.");
    const relative = path.relative(stateRoot, core);
    runtimePath(stateRoot, relative);
    if (!(relative.replaceAll("\\", "/").startsWith(platform === "win32" ? "bin/cores/" : "cli-updates/cores/"))) {
      throw new Error("CLI update cannot select a stock executable or a foreign installation.");
    }
    return { ...coreMetadata(stateRoot, relative, target, { legacyManifestRoot: root }),
      target, stateRoot, pointer, selected };
  }
  const releaseFile = path.join(root, "release.json");
  const relative = platform === "win32" && fs.existsSync(releaseFile)
    ? json(releaseFile).corePath
    : platform === "win32"
      ? `bin/runtimes/${arch}/codex-copilot-core.exe` : "bin/codex-copilot-core";
  return { ...coreMetadata(root, relative, target), target, stateRoot, pointer, selected };
}

export async function officialCliRelease({ request = fetch } = {}) {
  const response = await request(OFFICIAL_CLI_RELEASE, {
    redirect: "error", signal: AbortSignal.timeout(20000),
    headers: { accept: "application/vnd.github+json", "user-agent": "CodexCopilot-update-check" },
  });
  if (!response.ok) throw new Error(`Official CLI release metadata returned HTTP ${response.status}.`);
  if (Number(response.headers.get("content-length")) > MAX_METADATA) throw new Error("Official CLI metadata exceeds its bound.");
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_METADATA) throw new Error("Official CLI metadata exceeds its bound.");
    chunks.push(Buffer.from(chunk));
  }
  const release = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const version = release.tag_name?.match(/^rust-v(\d+\.\d+\.\d+)$/)?.[1];
  if (!version || release.draft !== false || release.prerelease !== false ||
      !Number.isFinite(Date.parse(release.published_at))) {
    throw new Error("Official CLI metadata is not one published stable release.");
  }
  return { version, tag: release.tag_name, publishedAt: release.published_at, source: OFFICIAL_CLI_RELEASE };
}

function verifyCompatibility(validation, manifest, generation, target) {
  if (validation.schemaVersion !== 1 || validation.kind !== "native-runtime" ||
      validation.passed !== true || validation.target !== target ||
      validation.extensionGeneration !== generation ||
      validation.coreSha256?.toLowerCase() !== manifest.sha256.toLowerCase() ||
      validation.sourceRevision !== manifest.sourceRevision ||
      validation.patchedTree !== manifest.patchedTree ||
      CLI_UPDATE_FACTS.some(fact => validation.facts?.[fact] !== true)) {
    throw new Error("Candidate lacks validation of every native enhancement against the current extension source.");
  }
}

function runHeavyCliUpdate({ root, home, args }) {
  const moduleFile = path.join(root, "bridge", "cli-update.mjs");
  const payload = Buffer.from(JSON.stringify({ root, home, args })).toString("base64");
  const script = 'import {pathToFileURL} from "node:url";' +
    'const api=await import(pathToFileURL(process.argv[1]));' +
    'await api.cliUpdateCommand(JSON.parse(Buffer.from(process.argv[2],"base64").toString("utf8")));';
  let result;
  if (process.platform === "win32") {
    const quote = value => `'${value.replaceAll("'", "''")}'`;
    const command = `& ${quote(process.execPath)} --input-type=module -e ${quote(script)} ` +
      `${quote(moduleFile)} ${quote(payload)}; exit $LASTEXITCODE`;
    result = spawnSync("pwsh.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-File",
      path.join(root, "tools", "Invoke-HeavyTask.ps1"), command],
    { cwd: root, stdio: "inherit", windowsHide: true });
  } else {
    result = spawnSync("bash", [path.join(root, "tools", "Invoke-HeavyTask.sh"),
      process.execPath, "--input-type=module", "-e", script, moduleFile, payload],
    { cwd: root, stdio: "inherit" });
  }
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("The scheduled CLI update failed; the old selection was preserved.");
}

export function verifyCliCandidate({ root, candidateRoot, target, generation }) {
  const version = bytes(runtimePath(candidateRoot, "VERSION")).trim();
  const revision = bytes(runtimePath(candidateRoot, "CODEX-SOURCE-REVISION")).trim();
  const chain = json(runtimePath(candidateRoot, "NATIVE_PATCH_CHAIN.json"));
  const relative = target.startsWith("windows")
    ? `bin/runtimes/${target.split("-")[1]}/codex-copilot-core.exe` : "bin/codex-copilot-core";
  const current = coreMetadata(candidateRoot, relative, target);
  const { manifest } = current;
  const validation = json(runtimePath(candidateRoot,
    path.join(path.dirname(relative), "cli-update-compatibility.json")));
  if (version !== manifest.packageVersion || revision !== manifest.sourceRevision ||
      chain.schemaVersion !== 1 || chain.sourceRevision !== revision ||
      chain.patchedTree !== manifest.patchedTree || manifest.runtimeVerified !== true ||
      !Array.isArray(chain.patches) || !chain.patches.length ||
      new Set(chain.patches).size !== chain.patches.length ||
      JSON.stringify(chain.patches) !== JSON.stringify(manifest.patches?.map(item => item.name))) {
    throw new Error("Candidate lacks matching enhanced-core and patch-chain provenance.");
  }
  for (const patch of manifest.patches) {
    if (!/^[a-z0-9-]+\.patch$/.test(patch.name || "") ||
        !/^[a-f0-9]{64}$/i.test(patch.sha256 || "") ||
        fileSha256(runtimePath(candidateRoot, `patches/${patch.name}`)) !== patch.sha256.toLowerCase()) {
      throw new Error("Candidate native patch provenance changed.");
    }
  }
  verifyCompatibility(validation, manifest, generation, target);
  if (sourceFingerprint(root, desktopExtensionFiles(root)) !== generation) {
    throw new Error("Current extensions changed while the CLI update was checked.");
  }
  return { ...current, validation, chain, version };
}

export async function cliUpdateCommand({
  root = path.resolve(import.meta.dirname, ".."),
  home = process.env.CODEX_COPILOT_HOME || path.join(os.homedir(), ".codex-copilot"),
  platform = process.platform, arch = process.arch, args = [], request = fetch,
  output = value => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`),
} = {}) {
  root = path.resolve(root);
  home = assertPrivateDesktopHome(home);
  const selected = cliCoreSelection({ root, home, platform, arch });
  const action = args[0] === "--check" ? "check" : args[0] || "check";
  if (fs.existsSync(path.join(root, "release.json")) && !["status", "check"].includes(action)) {
    throw new Error("This team release is immutable. Install a verified CCodex Release setup package to update all pinned resources together.");
  }
  if (action === "status" || action === "check") {
    if (args.length > 1) throw new Error("CLI update check does not accept an arbitrary download URL.");
    const upstream = action === "check" ? await officialCliRelease({ request }) : null;
    const result = { schemaVersion: 1, surface: "copilot-cli", target: selected.target,
      selectedCore: selected.manifest.coreVersion, packageVersion: selected.manifest.packageVersion,
      upstream, officialUpdateAvailable: upstream
        ? versionCompare(upstream.version, selected.manifest.coreVersion.slice(10)) > 0 : null,
      stockCliModified: false, desktopSelectionModified: false,
      commands: ["update check", "update prepare <verified-release-directory>", "update apply <candidate-id>"],
      compatibilityPolicy: "Only runtime-verified patched cores retaining all current native enhancements may be selected.",
    };
    output(result);
    return result;
  }
  if (process.env.CARGO_BUILD_JOBS !== "6" ||
      os.getPriority(process.pid) < os.constants.priority.PRIORITY_BELOW_NORMAL) {
    if (!["prepare", "apply"].includes(action)) {
      throw new Error("Use update check, prepare <verified-release-directory> or apply <candidate-id>.");
    }
    return runHeavyCliUpdate({ root, home, args });
  }
  const generation = sourceFingerprint(root, desktopExtensionFiles(root));
  const preparedRoot = directory(home, "cli-updates/prepared");
  if (action === "prepare") {
    if (args.length !== 2) throw new Error("Use update prepare <verified-release-directory>.");
    const candidateRoot = fs.realpathSync(path.resolve(args[1]));
    const candidate = verifyCliCandidate({ root, candidateRoot, target: selected.target, generation });
    if (versionCompare(candidate.manifest.coreVersion.slice(10), selected.manifest.coreVersion.slice(10)) < 0 ||
        versionCompare(candidate.version, selected.manifest.packageVersion) <= 0) {
      throw new Error("CLI update refuses a downgrade or an already selected release.");
    }
    const id = `${candidate.version}-${candidate.manifest.sha256.slice(0, 12).toLowerCase()}`;
    const slotRelative = `${platform === "win32" ? "bin/cores" : "cli-updates/cores"}/${id}`;
    const slot = directory(selected.stateRoot, slotRelative);
    const coreName = platform === "win32" ? "codex-copilot-core.exe" : "codex-copilot-core";
    const core = path.join(slot, coreName);
    if (fs.existsSync(core)) {
      const stat = fs.lstatSync(core);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Prepared CLI core cannot be linked.");
    } else {
      fs.copyFileSync(candidate.core, core, fs.constants.COPYFILE_EXCL);
      if (platform !== "win32") {
        const fd = fs.openSync(core, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        try { fs.fchmodSync(fd, 0o700); } finally { fs.closeSync(fd); }
      }
    }
    if (fileSha256(core) !== candidate.manifest.sha256.toLowerCase()) throw new Error("Prepared CLI core checksum mismatch.");
    copyCliComponents({
      sourceCore: candidate.core, destinationCore: core,
      manifest: candidate.manifest, target: selected.target,
    });
    const manifestFile = path.join(slot, "codex-copilot-core.manifest.json");
    const manifestText = `${JSON.stringify(candidate.manifest, null, 2)}\n`;
    if (fs.existsSync(manifestFile) && bytes(manifestFile) !== manifestText) throw new Error("An immutable CLI candidate slot already differs.");
    if (!fs.existsSync(manifestFile)) fs.writeFileSync(manifestFile, manifestText, { flag: "wx", mode: 0o600 });
    verifyCliCandidate({ root, candidateRoot, target: selected.target, generation });
    const receipt = { schemaVersion: 1, id, status: "prepared", target: selected.target,
      extensionGeneration: generation, core, manifest: candidate.manifest,
      validation: candidate.validation, previousPointer: selected.selected,
      previousCoreSha256: selected.manifest.sha256, preparedAt: new Date().toISOString(),
      stockCliModified: false, desktopSelectionModified: false };
    atomic(path.join(preparedRoot, `${id}.json`), `${JSON.stringify(receipt, null, 2)}\n`);
    output(receipt);
    return receipt;
  }
  if (action !== "apply" || args.length !== 2 || !ID.test(args[1] || "")) {
    throw new Error("Use update check, prepare <verified-release-directory> or apply <candidate-id>.");
  }
  const file = runtimePath(home, `cli-updates/prepared/${args[1]}.json`);
  const receipt = json(file);
  const expectedRelative = `${platform === "win32" ? "bin/cores" : "cli-updates/cores"}/${args[1]}/` +
    (platform === "win32" ? "codex-copilot-core.exe" : "codex-copilot-core");
  const candidate = coreMetadata(selected.stateRoot, expectedRelative, selected.target);
  verifyCompatibility(receipt.validation || {}, candidate.manifest, generation, selected.target);
  if (receipt.schemaVersion !== 1 || receipt.id !== args[1] || receipt.status !== "prepared" ||
      receipt.target !== selected.target || receipt.extensionGeneration !== generation ||
      receipt.core !== candidate.core || JSON.stringify(receipt.manifest) !== JSON.stringify(candidate.manifest) ||
      candidate.manifest.runtimeVerified !== true ||
      receipt.previousPointer !== selected.selected ||
      receipt.previousCoreSha256 !== selected.manifest.sha256) {
    throw new Error("Prepared CLI update is stale, changed or does not retain the current native enhancements.");
  }
  directory(selected.stateRoot, path.dirname(path.relative(selected.stateRoot, selected.pointer)));
  if (bytes(selected.pointer, true) !== selected.selected ||
      sourceFingerprint(root, desktopExtensionFiles(root)) !== generation) {
    throw new Error("CLI selection or extensions changed concurrently; no update was applied.");
  }
  const promoted = `${candidate.core}\n`;
  atomic(selected.pointer, promoted);
  const result = { ...receipt, status: "promoted", completedAt: new Date().toISOString(),
    existingProcessesPreserved: true, nextLaunchUsesNewCore: true };
  try { atomic(file, `${JSON.stringify(result, null, 2)}\n`); }
  catch (error) {
    if (bytes(selected.pointer, true) === promoted) {
      if (selected.selected === null) fs.unlinkSync(selected.pointer);
      else atomic(selected.pointer, selected.selected);
    }
    throw error;
  }
  output(result);
  return result;
}

const evaluating = process.execArgv.some(value =>
  ["-e", "--eval", "-p", "--print"].includes(value) || /^(?:--eval|--print)=/.test(value));
if (!evaluating && process.argv[1] &&
    import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  try { await cliUpdateCommand({ args: args[0] === "update" ? args.slice(1) : args }); }
  catch (error) { console.error(`CodexCopilot CLI update: ${error.message}`); process.exitCode = 1; }
}
