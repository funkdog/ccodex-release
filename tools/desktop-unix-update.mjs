import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import {
  assertPrivateDesktopHome, desktopSnapshot, fileSha256, inspectOfficialDesktop,
  runtimePath,
} from "../bridge/desktop-runtime.mjs";
import { DESKTOP_DOWNLOADS, sourceFingerprint } from "../bridge/update-state.mjs";
import { desktopExtensionFiles } from "../bridge/desktop-extension-files.mjs";
import { verifyLinuxDesktopPackage } from "./linux-desktop-repository.mjs";

function command(program, args, options = {}) {
  const result = spawnSync(program, args, {
    encoding: "utf8", timeout: 60000, maxBuffer: 4 * 1024 * 1024, ...options,
  });
  if (result.error || result.status !== 0) {
    throw result.error || new Error(`Private Desktop command failed: ${program}`);
  }
  return result.stdout;
}

function atomic(file, value) {
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) {
    throw new Error("Private Desktop metadata cannot be linked.");
  }
  const temporary = `${file}.${randomUUID()}.pending`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  try { fs.renameSync(temporary, file); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

function privateDirectory(root, relative) {
  const directory = path.resolve(root, relative);
  const tail = path.relative(path.resolve(root), directory);
  if (tail === ".." || tail.startsWith(`..${path.sep}`) || path.isAbsolute(tail)) {
    throw new Error("Private Desktop directory escaped its state root.");
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  runtimePath(root, relative);
  if (fs.lstatSync(directory).isSymbolicLink()) throw new Error("Private Desktop state cannot be linked.");
  return directory;
}

async function download(url, destination, request = fetch) {
  const response = await request(url, { redirect: "error", signal: AbortSignal.timeout(600000) });
  if (!response.ok) throw new Error(`Official Desktop download returned ${response.status}.`);
  const maximum = 2 * 1024 * 1024 * 1024;
  if (Number(response.headers.get("content-length")) > maximum) throw new Error("Official package exceeds size bound.");
  let bytes = 0;
  const measured = async function* () {
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > maximum) throw new Error("Official package exceeds size bound.");
      yield chunk;
    }
  };
  await pipeline(Readable.from(measured()), fs.createWriteStream(destination, { flags: "wx", mode: 0o600 }));
  return bytes;
}

async function linuxPayload(packageFile, staging, root, arch) {
  const verified = await verifyLinuxDesktopPackage(packageFile, staging, { arch });
  const archive = path.join(staging, "data.tar");
  const output = fs.openSync(archive, "wx", 0o600);
  try {
    const child = spawn("dpkg-deb", ["--fsys-tarfile", packageFile], {
      stdio: ["ignore", output, "pipe"],
    });
    let error = "";
    child.stderr.on("data", chunk => { if (error.length < 8192) error += chunk; });
    await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", code => code === 0 ? resolve() :
        reject(new Error(`Private Debian payload read failed (${code}); maintainer scripts were not executed.`)));
    });
  } finally { fs.closeSync(output); }
  if (fs.statSync(archive).size > 4 * 1024 * 1024 * 1024) throw new Error("Private Debian payload exceeds size bound.");
  const app = path.join(staging, "app");
  const extraction = JSON.parse(command("python3", [
    path.join(root, "tools", "safe-desktop-tar.py"), archive, app, "usr/lib/chatgpt",
  ], { timeout: 600000 }));
  const executable = path.join(app, "ChatGPT");
  const fd = fs.openSync(executable, "r");
  const header = Buffer.alloc(20);
  try { fs.readSync(fd, header, 0, header.length, 0); } finally { fs.closeSync(fd); }
  if (header.subarray(0, 4).toString("hex") !== "7f454c46" || header[5] !== 1 ||
      header.readUInt16LE(18) !== (arch === "arm64" ? 183 : 62)) {
    throw new Error("Official Desktop ELF architecture does not match its signed package.");
  }
  return { app, executableRelative: "app/ChatGPT", resourcesRelative: "app/resources",
    verified, extraction };
}

function macPayload(packageFile, staging) {
  const mount = path.join(staging, "mount");
  fs.mkdirSync(mount, { mode: 0o700 });
  command("/usr/bin/hdiutil", ["verify", packageFile]);
  command("/usr/bin/hdiutil", ["attach", "-readonly", "-nobrowse", "-noautoopen",
    "-mountpoint", mount, packageFile], { timeout: 600000 });
  try {
    const apps = fs.readdirSync(mount).filter(name => /^(?:ChatGPT|Codex)\.app$/.test(name));
    if (apps.length !== 1) throw new Error("Official disk image does not contain one recognized app bundle.");
    const source = path.join(mount, apps[0]);
    command("/usr/bin/codesign", ["--verify", "--deep", "--strict", source]);
    command("/usr/sbin/spctl", ["--assess", "--type", "execute", source]);
    const displayed = spawnSync("/usr/bin/codesign", ["--display", "--verbose=4", source], { encoding: "utf8" });
    const signer = displayed.stderr;
    if (displayed.status !== 0 || !/^Authority=Developer ID Application: OpenAI[^\n]*$/m.test(signer)) {
      throw new Error("macOS Desktop signer does not match OpenAI.");
    }
    const executableName = command("/usr/libexec/PlistBuddy",
      ["-c", "Print:CFBundleExecutable", path.join(source, "Contents", "Info.plist")]).trim();
    if (!["ChatGPT", "Codex"].includes(executableName)) throw new Error("Unrecognized signed app executable.");
    const app = path.join(staging, "app");
    fs.cpSync(source, app, { recursive: true, dereference: false, verbatimSymlinks: true,
      errorOnExist: true, force: false });
    return { app, executableRelative: `app/Contents/MacOS/${executableName}`,
      resourcesRelative: "app/Contents/Resources",
      verified: { signatureVerified: true, signer, diskImageVerified: true,
        maintainerScriptsExecuted: false, systemRepositoryModified: false } };
  } finally { command("/usr/bin/hdiutil", ["detach", mount]); }
}

function snapshotInventory(directory) {
  const files = [];
  function visit(relative) {
    const file = runtimePath(directory, relative);
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) {
      const target = fs.readlinkSync(file);
      if (path.isAbsolute(target)) throw new Error("Snapshot symlink must remain relative.");
      runtimePath(directory, path.relative(directory, fs.realpathSync(file)));
      files.push({ path: relative.replaceAll("\\", "/"), link: target });
    } else if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file).sort()) visit(`${relative}/${name}`);
    } else if (stat.isFile()) {
      files.push({ path: relative.replaceAll("\\", "/"), size: stat.size, sha256: fileSha256(file) });
    } else throw new Error("Snapshot contains a special filesystem entry.");
  }
  visit("app");
  return files;
}

export function seedInstalledUnixDesktop({
  root,
  home,
  appPath,
  platform = process.platform,
  arch = process.arch,
}) {
  if (!["linux", "darwin"].includes(platform) || !["arm64", "x64"].includes(arch)) {
    throw new Error("Unsupported Unix Desktop platform/architecture.");
  }
  home = assertPrivateDesktopHome(home);
  const desktop = privateDirectory(home, "desktop");
  const pointer = path.join(desktop, "current.json");
  if (fs.existsSync(pointer)) {
    return desktopSnapshot(root, { stateRoot: home, platform, arch });
  }
  let candidate = appPath;
  if (!candidate) {
    const saved = path.join(home, "desktop-app-path.txt");
    if (fs.existsSync(saved)) candidate = fs.readFileSync(saved, "utf8").trim();
  }
  if (!candidate || !fs.existsSync(candidate)) {
    throw new Error("Official ChatGPT/Codex Desktop path is not configured; run 'codex-copilot setup' or 'ccodex desktop update'.");
  }
  const resolved = fs.realpathSync(candidate);
  const id = randomUUID();
  const staging = privateDirectory(home, `desktop/seed-staging-${id}`);
  try {
    const appDest = path.join(staging, "app");
    let executableRelative;
    let resourcesRelative;
    if (platform === "darwin") {
      const bundle = resolved.endsWith(".app") ? resolved : path.resolve(resolved, "../../..");
      const executableName = fs.existsSync(path.join(bundle, "Contents", "MacOS", "Codex")) ? "Codex" : "ChatGPT";
      fs.cpSync(bundle, appDest, { recursive: true, dereference: false, verbatimSymlinks: true });
      executableRelative = `app/Contents/MacOS/${executableName}`;
      resourcesRelative = "app/Contents/Resources";
    } else {
      const sourceDir = fs.statSync(resolved).isDirectory() ? resolved : path.dirname(resolved);
      fs.cpSync(sourceDir, appDest, { recursive: true, dereference: false, verbatimSymlinks: true });
      executableRelative = `app/${path.basename(resolved)}`;
      resourcesRelative = "app/resources";
    }
    const resources = path.join(staging, resourcesRelative);
    const asar = path.join(resources, "app.asar");
    const contract = inspectOfficialDesktop(asar);
    const vendorVersion = contract.version;
    const asarHash = fileSha256(asar);
    const version = `${vendorVersion}-${asarHash.slice(0, 12)}`;
    const versions = privateDirectory(home, "desktop/versions");
    const destination = path.join(versions, version);
    const manifest = {
      schemaVersion: 1,
      version,
      vendorVersion,
      applicationVersion: contract.version,
      platform: platform === "darwin" ? "macos" : "linux",
      arch,
      executable: executableRelative,
      resources: resourcesRelative,
      preparedAt: new Date().toISOString(),
      copiedWithoutCodeChanges: true,
      isolationContract: contract,
      files: snapshotInventory(staging),
    };
    atomic(path.join(staging, "snapshot.json"), manifest);
    if (!fs.existsSync(destination)) {
      const complete = path.join(staging, "complete");
      fs.mkdirSync(complete);
      fs.renameSync(appDest, path.join(complete, "app"));
      fs.renameSync(path.join(staging, "snapshot.json"), path.join(complete, "snapshot.json"));
      fs.renameSync(complete, destination);
    }
    if (!fs.existsSync(pointer)) {
      atomic(pointer, { schemaVersion: 1, version, selectedAt: new Date().toISOString() });
    }
    return desktopSnapshot(root, { stateRoot: home, version, platform, arch });
  } finally {
    if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
  }
}

export async function prepareUnixDesktop({
  root, home, platform = process.platform, arch = process.arch,
  packageFile, checkOnly = false, request = fetch,
}) {
  if (!["linux", "darwin"].includes(platform) || !["arm64", "x64"].includes(arch)) {
    throw new Error("Unsupported Unix Desktop platform/architecture.");
  }
  home = assertPrivateDesktopHome(home);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const desktop = privateDirectory(home, "desktop");
  const pointer = path.join(desktop, "current.json");
  if (fs.existsSync(pointer) && (!fs.lstatSync(pointer).isFile() || fs.lstatSync(pointer).isSymbolicLink())) {
    throw new Error("Private Desktop selection must be a regular file.");
  }
  const before = fs.existsSync(pointer) ? fs.readFileSync(pointer, "utf8") : null;
  const target = `${platform === "darwin" ? "macos" : platform}-${arch}`;
  const url = DESKTOP_DOWNLOADS[target];
  if (checkOnly) {
    const response = await request(url, { method: "HEAD", redirect: "error", signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`Official Desktop metadata returned ${response.status}.`);
    return { schemaVersion: 1, target, source: url, checkedAt: new Date().toISOString(),
      status: "package-metadata", latestVersionVerified: false,
      reason: "HTTP metadata alone does not prove signed package version.",
      etag: response.headers.get("etag"), lastModified: response.headers.get("last-modified"),
      contentLength: response.headers.get("content-length"),
      selectedSnapshot: before ? JSON.parse(before).version : null };
  }
  const id = randomUUID();
  const staging = privateDirectory(home, `desktop/update-staging-${id}`);
  const history = privateDirectory(home, "desktop/prepared-updates");
  const receiptFile = path.join(history, `${id}.json`);
  const receipt = { schemaVersion: 1, attempt: id, target, source: url,
    startedAt: new Date().toISOString(), workerPid: process.pid, status: "preparing",
    originalInstallationModified: false, pointerPromoted: false };
  try {
    const downloaded = path.join(staging, platform === "linux" ? "ChatGPT.deb" : "ChatGPT.dmg");
    if (packageFile) {
      const stat = fs.lstatSync(packageFile);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Local Desktop package must be regular.");
      fs.copyFileSync(packageFile, downloaded, fs.constants.COPYFILE_EXCL);
      receipt.source = "explicit-local-package";
    } else await download(url, downloaded, request);
    receipt.packageSha256 = fileSha256(downloaded);
    const payload = platform === "linux"
      ? await linuxPayload(downloaded, staging, root, arch)
      : macPayload(downloaded, staging);
    const resources = path.join(staging, payload.resourcesRelative);
    const contract = inspectOfficialDesktop(path.join(resources, "app.asar"));
    const vendorVersion = payload.verified.version || contract.version;
    const asarHash = fileSha256(path.join(resources, "app.asar"));
    const version = `${vendorVersion}-${asarHash.slice(0, 12)}`;
    const versions = privateDirectory(home, "desktop/versions");
    const destination = path.join(versions, version);
    const manifest = {
      schemaVersion: 1, version, vendorVersion, applicationVersion: contract.version,
      platform: platform === "darwin" ? "macos" : "linux", arch,
      executable: payload.executableRelative, resources: payload.resourcesRelative,
      preparedAt: new Date().toISOString(), copiedWithoutCodeChanges: true,
      isolationContract: contract, packageVerification: payload.verified,
      files: snapshotInventory(staging),
    };
    atomic(path.join(staging, "snapshot.json"), manifest);
    if (fs.existsSync(destination)) {
      desktopSnapshot(root, { stateRoot: home, version, platform, arch });
    } else {
      // Keep only immutable app bytes and manifest, not the downloaded package/key.
      const complete = path.join(staging, "complete");
      fs.mkdirSync(complete);
      fs.renameSync(payload.app, path.join(complete, "app"));
      fs.renameSync(path.join(staging, "snapshot.json"), path.join(complete, "snapshot.json"));
      fs.renameSync(complete, destination);
    }
    desktopSnapshot(root, { stateRoot: home, version, platform, arch });
    if ((fs.existsSync(pointer) ? fs.readFileSync(pointer, "utf8") : null) !== before) {
      throw new Error("Private Desktop selection changed during preparation; this worker did not promote it.");
    }
    Object.assign(receipt, { candidate: version, vendorVersion,
      packageVerification: payload.verified, extraction: payload.extraction,
      status: "prepared-needs-extension-validation", completedAt: new Date().toISOString() });
    atomic(receiptFile, receipt);
    return { ...receipt, receipt: receiptFile };
  } catch (error) {
    Object.assign(receipt, { status: "rejected", error: error.message, completedAt: new Date().toISOString() });
    atomic(receiptFile, receipt);
    throw Object.assign(error, { updateReceipt: receiptFile });
  } finally {
    const actual = fs.realpathSync(staging);
    if (actual !== staging || path.dirname(actual) !== desktop ||
        path.basename(actual) !== `update-staging-${id}` || fs.lstatSync(staging).isSymbolicLink()) {
      throw new Error("Unexpected private update staging cleanup target.");
    }
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

async function main() {
  const [action, ...values] = process.argv.slice(2);
  const options = {};
  for (let index = 0; index < values.length; index += 2) {
    if (!["--install-root", "--home", "--candidate", "--package-file"].includes(values[index]) ||
        !values[index + 1]) throw new Error("Invalid private Unix update arguments.");
    options[values[index]] = values[index + 1];
  }
  const root = path.resolve(options["--install-root"] || path.resolve(import.meta.dirname, ".."));
  const home = options["--home"] || process.env.CODEX_COPILOT_HOME || path.join(os.homedir(), ".codex-copilot");
  if (action === "check" || action === "prepare") {
    console.log(JSON.stringify(await prepareUnixDesktop({
      root, home, packageFile: options["--package-file"], checkOnly: action === "check",
    }), null, 2));
    return;
  }
  if (action === "validate") {
    const candidate = options["--candidate"];
    if (!/^[\d.]+-[a-f0-9]{12}$/.test(candidate || "")) {
      throw new Error("Use a bounded private snapshot version for Unix validation.");
    }
    desktopSnapshot(root, { stateRoot: assertPrivateDesktopHome(home), version: candidate });
    const generation = sourceFingerprint(root, desktopExtensionFiles(root));
    const report = privateDirectory(home, `desktop/validation/${candidate}`);
    const validation = { schemaVersion: 1, candidate, extensionGeneration: generation,
      passed: false, nativeUiPreserved: false, contextExtensionVerified: false,
      testedAt: new Date().toISOString(),
      remainingGate: "Actual candidate lifecycle and native Context/UI acceptance are required; preparation is not validation." };
    atomic(path.join(report, "candidate-validation.json"), validation);
    console.log(JSON.stringify(validation, null, 2));
    return;
  }
  throw new Error("Use private Unix Desktop check, prepare or validate.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`Private Unix Desktop update: ${error.message}`); process.exitCode = 1; });
}
