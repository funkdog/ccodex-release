import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

export const LINUX_REPOSITORY = "https://persistent.oaistatic.com/codex-app-prod/linux/deb";
// Read from the official HTTPS package, then independently checked with gpg.
export const LINUX_SIGNING_FINGERPRINT = "3BFA0E4AE8B8CC16A2D9BA684A3B4A566C4660E4";

function command(program, args) {
  const result = spawnSync(program, args, {
    encoding: "utf8", timeout: 30000, maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw result.error || new Error(`Private package verification command failed: ${program}`);
  }
  return result.stdout;
}

const hash = bytes => createHash("sha256").update(bytes).digest("hex");

export async function repositoryBytes(relative, {
  request = fetch, maximum = 4 * 1024 * 1024,
} = {}) {
  if (typeof relative !== "string" || !relative ||
      relative.startsWith("/") || relative.split("/").some(part => !part || part === "." || part === "..") ||
      /[\\?#:]/.test(relative)) throw new Error("Invalid official repository path.");
  const response = await request(`${LINUX_REPOSITORY}/${relative}`, {
    redirect: "error", signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`Official repository metadata returned ${response.status}.`);
  const advertised = Number(response.headers.get("content-length"));
  if (advertised > maximum) throw new Error("Official repository metadata is too large.");
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > maximum) throw new Error("Official repository metadata exceeded its bound.");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export function parseReleaseIndex(release, indexPath) {
  const shaSection = release.split(/^SHA256:\s*$/m)[1]?.split(/^[A-Za-z0-9-]+:\s*$/m)[0];
  const matches = (shaSection || "").split("\n").map(line =>
    /^\s+([a-f0-9]{64})\s+(\d+)\s+(\S+)\s*$/i.exec(line))
    .filter(item => item?.[3] === indexPath);
  if (matches.length !== 1 || Number(matches[0][2]) > 4 * 1024 * 1024) {
    throw new Error("Signed release lacks one bounded package index.");
  }
  return { sha256: matches[0][1].toLowerCase(), size: Number(matches[0][2]) };
}

export function parseDesktopPackageIndex(text, arch) {
  const expected = arch === "x64" ? "amd64" : arch;
  const packages = text.split(/\n\s*\n/).map(block => {
    const entry = {};
    for (const line of block.split("\n")) {
      const item = /^([A-Za-z0-9-]+):\s*(.*)$/.exec(line);
      if (item) {
        if (Object.hasOwn(entry, item[1])) throw new Error("Duplicate package index field.");
        entry[item[1]] = item[2].trim();
      }
    }
    return entry;
  }).filter(item => item.Package === "chatgpt" && item.Architecture === expected);
  if (packages.length !== 1) throw new Error("Repository does not identify one official Desktop package.");
  const item = packages[0];
  if (!/^\d+(?:\.\d+){2,3}$/.test(item.Version || "") ||
      !/^[a-f0-9]{64}$/i.test(item.SHA256 || "") ||
      !/^pool\/main\/c\/chatgpt\/chatgpt_[\d.]+_(?:arm64|amd64)\.deb$/.test(item.Filename || "") ||
      !Number.isSafeInteger(Number(item.Size)) || Number(item.Size) <= 0 ||
      Number(item.Size) > 2 * 1024 * 1024 * 1024) {
    throw new Error("Signed Desktop package identity/path is invalid.");
  }
  return { version: item.Version, architecture: expected,
    filename: item.Filename, size: Number(item.Size), sha256: item.SHA256.toLowerCase() };
}

export async function verifyLinuxDesktopPackage(packageFile, staging, {
  arch = process.arch, request = fetch, invoke = command,
} = {}) {
  if (!["arm64", "x64"].includes(arch)) throw new Error("Unsupported Linux Desktop architecture.");
  const stat = fs.lstatSync(packageFile);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Desktop package must be a regular file.");
  const gpgHome = path.join(staging, "gpg");
  fs.mkdirSync(gpgHome, { mode: 0o700 });
  // Read the maintainer script as data; never source or execute it.
  const script = invoke("bash", ["-c",
    'set -o pipefail; dpkg-deb --ctrl-tarfile "$1" | tar -xOf - ./postinst',
    "ccodex-read-maintainer-data", packageFile]);
  const keyMatches = [...script.matchAll(/^SIGNING_KEY_BASE64='([A-Za-z0-9+/=]+)'$/gm)];
  if (keyMatches.length !== 1) throw new Error("Official package repository key is unavailable.");
  const key = path.join(staging, "repository-key.gpg");
  fs.writeFileSync(key, Buffer.from(keyMatches[0][1], "base64"), { flag: "wx", mode: 0o600 });
  const fingerprints = invoke("gpg", [
    "--batch", "--no-options", "--homedir", gpgHome, "--with-colons", "--show-keys", key,
  ]).split("\n").filter(line => line.startsWith("fpr:")).map(line => line.split(":")[9]);
  if (fingerprints.length !== 1 || fingerprints[0] !== LINUX_SIGNING_FINGERPRINT) {
    throw new Error("Linux Desktop repository key does not match the pinned official fingerprint.");
  }
  const inRelease = await repositoryBytes("dists/stable/InRelease", { request });
  const releaseFile = path.join(staging, "InRelease");
  const clearRelease = path.join(staging, "Release");
  fs.writeFileSync(releaseFile, inRelease, { flag: "wx", mode: 0o600 });
  invoke("gpgv", ["--homedir", gpgHome, "--keyring", key,
    "--output", clearRelease, releaseFile]);
  const architecture = arch === "x64" ? "amd64" : arch;
  const indexPath = `main/binary-${architecture}/Packages`;
  const expectation = parseReleaseIndex(fs.readFileSync(clearRelease, "utf8"), indexPath);
  const index = await repositoryBytes(`dists/stable/${indexPath}`, { request });
  if (index.length !== expectation.size || hash(index) !== expectation.sha256) {
    throw new Error("Linux Desktop package index does not match the signed release.");
  }
  const metadata = parseDesktopPackageIndex(index.toString("utf8"), arch);
  const identity = invoke("dpkg-deb", ["--field", packageFile,
    "Package", "Version", "Architecture"]);
  const fields = Object.fromEntries(identity.trim().split("\n").map(line => {
    const at = line.indexOf(":");
    return [line.slice(0, at), line.slice(at + 1).trim()];
  }));
  if (fields.Package !== "chatgpt" || fields.Version !== metadata.version ||
      fields.Architecture !== metadata.architecture || stat.size !== metadata.size) {
    throw new Error("Downloaded Desktop package does not match signed identity/size.");
  }
  const fd = fs.openSync(packageFile, "r");
  const digest = createHash("sha256");
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    let count;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null))) digest.update(buffer.subarray(0, count));
  } finally { fs.closeSync(fd); }
  if (digest.digest("hex") !== metadata.sha256) {
    throw new Error("Downloaded Desktop package checksum differs from signed metadata.");
  }
  return { ...metadata, signatureVerified: true, keyFingerprint: fingerprints[0],
    inReleaseSha256: hash(inRelease), indexSha256: hash(index),
    maintainerScriptsExecuted: false, systemRepositoryModified: false };
}
