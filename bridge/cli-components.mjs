import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fileSha256, runtimePath } from "./desktop-runtime.mjs";

const TARGET = /^(?:windows|linux|macos)-(?:arm64|x64)$/;
const HASH = /^[a-f0-9]{64}$/i;

export function nativeBinaryTarget(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 20 || stat.size > 1024 ** 3) {
    throw new Error("A native runtime component must be a bounded regular executable.");
  }
  const header = Buffer.alloc(Math.min(stat.size, 64 * 1024));
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try { fs.readSync(fd, header, 0, header.length, 0); }
  finally { fs.closeSync(fd); }
  if (header.length >= 64 && header.readUInt16LE(0) === 0x5a4d) {
    const offset = header.readUInt32LE(0x3c);
    if (offset + 6 <= header.length && header.readUInt32LE(offset) === 0x00004550) {
      return { 0xaa64: "windows-arm64", 0x8664: "windows-x64" }[header.readUInt16LE(offset + 4)] || null;
    }
  } else if (header.readUInt32LE(0) === 0x464c457f && header[4] === 2 && header[5] === 1) {
    return { 183: "linux-arm64", 62: "linux-x64" }[header.readUInt16LE(18)] || null;
  } else if (header.readUInt32LE(0) === 0xfeedfacf) {
    return { 0x0100000c: "macos-arm64", 0x01000007: "macos-x64" }[header.readUInt32LE(4)] || null;
  }
  return null;
}

export function requiredCliComponentFiles(target, coreVersion) {
  if (!TARGET.test(target)) throw new Error("Unknown native runtime target.");
  const match = /^codex-cli (\d+)\.(\d+)\.(\d+)$/.exec(coreVersion || "");
  if (!match) throw new Error("Native runtime version is unavailable.");
  const [, major, minor] = match.map(Number);
  if (major === 0 && minor < 160) return [];
  const windows = target.startsWith("windows");
  return [
    `codex-code-mode-host${windows ? ".exe" : ""}`,
    `codex-path/rg${windows ? ".exe" : ""}`,
    ...(windows ? [
      "codex-resources/codex-command-runner.exe",
      "codex-resources/codex-windows-sandbox-setup.exe",
    ] : []),
    ...(target.startsWith("linux") ? ["codex-resources/bwrap"] : []),
  ];
}

export function verifyCliComponents({ core, manifest, target = manifest?.target }) {
  const required = requiredCliComponentFiles(target, manifest?.coreVersion);
  if (manifest.components === undefined && !required.length) return [];
  if (!Array.isArray(manifest.components) || manifest.components.length > 32) {
    throw new Error("The current CLI requires a source-bound native companion inventory.");
  }
  const root = path.dirname(core);
  const names = new Set();
  const rows = manifest.components.map(component => {
    if (!component || typeof component.file !== "string" ||
        !/^(?:(?:codex-path|codex-resources)\/)?[a-z0-9][a-z0-9._-]{0,95}$/.test(component.file) ||
        component.file === path.basename(core) || names.has(component.file) ||
        !HASH.test(component.sha256 || "") || component.target !== target ||
        component.sourceRevision !== manifest.sourceRevision ||
        component.patchedTree !== manifest.patchedTree) {
      throw new Error("Native companion inventory is duplicate, unsafe or bound to different source.");
    }
    names.add(component.file);
    const file = runtimePath(root, component.file);
    if (nativeBinaryTarget(file) !== target || fileSha256(file) !== component.sha256.toLowerCase()) {
      throw new Error(`Native companion architecture/hash mismatch: ${component.file}`);
    }
    return { ...component, path: file };
  });
  for (const file of required) {
    if (!names.has(file)) throw new Error(`Required native CLI companion is missing: ${file}`);
  }
  return rows;
}

export function copyCliComponents({ sourceCore, destinationCore, manifest, target = manifest?.target }) {
  const rows = verifyCliComponents({ core: sourceCore, manifest, target });
  const destination = path.dirname(destinationCore);
  if (!fs.statSync(destination).isDirectory() || fs.lstatSync(destination).isSymbolicLink()) {
    throw new Error("Native companions need an owned regular core directory.");
  }
  for (const component of rows) {
    const file = runtimePath(destination, component.file);
    if (fs.existsSync(file)) {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || fileSha256(file) !== component.sha256.toLowerCase()) {
        throw new Error("An immutable native companion slot already differs.");
      }
    } else {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.copyFileSync(component.path, file, fs.constants.COPYFILE_EXCL);
      if (!target.startsWith("windows")) fs.chmodSync(file, 0o700);
    }
  }
  verifyCliComponents({ core: destinationCore, manifest, target });
  return rows.map(({ path: _path, ...component }) => component);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [action, sourceCore, destinationCore, manifestFile] = process.argv.slice(2);
    if (action !== "copy" || !sourceCore || !destinationCore || !manifestFile || process.argv.length !== 6) {
      throw new Error("Usage: cli-components.mjs copy <source-core> <destination-core> <manifest>");
    }
    const stat = fs.lstatSync(manifestFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) {
      throw new Error("Native companion metadata must be a bounded regular file.");
    }
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8").replace(/^\uFEFF/, ""));
    console.log(JSON.stringify(copyCliComponents({ sourceCore, destinationCore, manifest })));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
