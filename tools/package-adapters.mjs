import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { assertTypeScriptBuild, sha256, typescriptInputs, typescriptManifest } from "./typescript-state.mjs";
import { auditSourceFiles, auditPublicText } from "./check-source-publication.mjs";

const root = path.resolve(import.meta.dirname, "..");
export const candidateVersion = "0.2.0-rc.1";
export const candidateName = `mycodex-macos-arm64-${candidateVersion}`;
export const receiptName = "RELEASE-0.2.0-RC1.json";
const sourceRecord = "release/RC-0.2.0-RC1-SOURCE.json";
const commands = ["Install", "Configure", "Diagnose", "Start", "Install-Launcher"];
const aliases = { "README.zh-CN.md": "docs/ADAPTERS-MACOS.zh-CN.md",
  "CODEX-COPILOT-SETUP.zh-CN.md": "docs/CODEX-COPILOT-SETUP.zh-CN.md" };
const tools = new Set(["adapter-connection.mjs", "configure-adapters.mjs", "install-macos-launcher.mjs", "Invoke-HeavyTask.sh",
  "config-document.mjs", "desktop-icons.mjs", "gen-config.mjs", "history/manager.mjs", "history/backends.mjs",
  "typescript-build.mjs", "typescript-task.mjs", "typescript-state.mjs", "typescript-runtime.mjs"]);
const filesAtRoot = ["LICENSE", "package.json", "package-lock.json", "tsconfig.json"];
const inScope = file => /^(?:bridge|gateway|assets|release)\//.test(file) && !/^release\/RC.*-SOURCE\.json$/.test(file) ||
  filesAtRoot.includes(file) || Object.values(aliases).includes(file) || file.startsWith("tools/") && tools.has(file.slice("tools/".length));
const git = (base, ...args) => execFileSync("git", args, { cwd: base, encoding: "utf8" });
const digest = (dir, relative) => sha256(fs.readFileSync(path.join(dir, relative)));
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });

export function sourceBinding(base = root) {
  const files = git(base, "ls-files", "--cached", "-z").split("\0").filter(inScope).sort();
  const audit = auditSourceFiles(base, files);
  if (!audit.passed) throw new Error(`源码审计未通过：${JSON.stringify(audit.findings)}`);
  const sourceFiles = Object.fromEntries(files.map(file => [file, digest(base, file)]));
  return { schemaVersion: 1, product: "MyCodex", version: candidateVersion,
    publicBaseline: "77692f879abf79358bf104195ac893de80d58e01", releaseTag: `mycodex-v${candidateVersion}`,
    payloadSourceDigest: sha256(JSON.stringify(sourceFiles)), sourceFiles };
}

export function verifyPayload(directory) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, "MYCODEX-MANIFEST.json"), "utf8"));
  const actual = [];
  function visit(relative) {
    for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })) {
      const child = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile() && child !== "MYCODEX-MANIFEST.json") actual.push(child);
      else if (!entry.isFile()) throw new Error(`Unexpected payload entry: ${child}`);
    }
  }
  visit("");
  actual.sort();
  if (JSON.stringify(actual) !== JSON.stringify(Object.keys(manifest.files)) ||
      sha256(JSON.stringify(manifest.files)) !== manifest.payloadDigest ||
      actual.some(file => digest(directory, file) !== manifest.files[file]))
    throw new Error("Payload inventory or SHA-256 mismatch.");
  const findings = auditPublicText(directory, [...actual, "MYCODEX-MANIFEST.json"]);
  if (findings.length) throw new Error(`发行包审计未通过：${JSON.stringify(findings)}`);
  assertTypeScriptBuild(directory);
  for (const command of commands) execFileSync("/bin/bash", ["-n", path.join(directory, `${command}.command`)]);
  return manifest;
}

export function packageAdapters(outputDirectory) {
  if (process.env.CODEX_COPILOT_HEAVY_LOCK_HELD !== "1") throw new Error("请通过 tools/Invoke-HeavyTask.sh 打包。");
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("请在 macOS ARM64 打包。");
  if (git(root, "status", "--porcelain", "--untracked-files=no")) throw new Error("请先提交源码变更。");
  const build = assertTypeScriptBuild(root), binding = sourceBinding();
  if (JSON.stringify(binding) !== JSON.stringify(JSON.parse(fs.readFileSync(path.join(root, sourceRecord), "utf8"))))
    throw new Error("发行源码绑定与当前源码摘要不同。");

  outputDirectory = path.resolve(outputDirectory);
  const outputParent = path.dirname(outputDirectory);
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "mycodex-package-"));
  let pending;
  try {
    const payload = path.join(stage, candidateName);
    fs.mkdirSync(payload);
    function copy(relative, target = relative) {
      const source = path.join(root, relative), destination = path.join(payload, target);
      if (!fs.lstatSync(source).isFile()) throw new Error(`Invalid package file: ${relative}`);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(source, destination);
      fs.chmodSync(destination, fs.statSync(source).mode & 0o111 ? 0o755 : 0o644);
    }
    const { outputs } = typescriptInputs(root);
    const files = [...Object.keys(binding.sourceFiles).filter(file => !file.startsWith("docs/")), ...outputs, typescriptManifest];
    for (const file of files) copy(file);
    fs.writeFileSync(path.join(payload, "VERSION"), candidateVersion + "\n", { flag: "wx", mode: 0o644 });
    for (const [target, source] of Object.entries(aliases)) copy(source, target);
    for (const command of commands) {
      copy("release/adapters-command.sh", `${command}.command`);
      fs.chmodSync(path.join(payload, `${command}.command`), 0o755);
    }
    const shipped = [...files, "VERSION", ...Object.keys(aliases), ...commands.map(command => `${command}.command`)].sort();
    const hashes = Object.fromEntries(shipped.map(file => [file, digest(payload, file)]));
    const manifest = { schemaVersion: 1, product: "MyCodex", version: candidateVersion, platform: "darwin", arch: "arm64",
      releaseTag: binding.releaseTag, sourceRevision: git(root, "rev-parse", "HEAD").trim(),
      payloadSourceDigest: binding.payloadSourceDigest, payloadDigest: sha256(JSON.stringify(hashes)), files: hashes, build,
      nativeConfiguration: { defaultEngine: null, engines: [], spine: { mcp: true, eventTap: true } },
      optionalAdapters: ["claude-code", "antigravity-acp-1.4.4", "codex-copilot"],
      thirdPartyRuntimesBundled: false, releaseStatus: "candidate" };
    writeJson(path.join(payload, "MYCODEX-MANIFEST.json"), manifest);
    execFileSync(process.execPath, ["--experimental-vm-modules", path.join(root, "tools/Check-PackageModules.mjs"), payload], { stdio: "pipe" });

    if (fs.existsSync(outputDirectory)) throw new Error("请选择尚不存在的输出目录。");
    fs.mkdirSync(outputParent, { recursive: true });
    pending = fs.mkdtempSync(path.join(outputParent, ".mycodex-artifacts-"));
    const filename = `${candidateName}.tar.gz`, archive = path.join(pending, filename);
    const env = { ...process.env, COPYFILE_DISABLE: "1", COPY_EXTENDED_ATTRIBUTES_DISABLE: "1" };
    execFileSync("/usr/bin/tar", ["-czf", archive, "--uid", "0", "--gid", "0", "--uname", "root", "--gname", "wheel",
      "--no-acls", "--no-xattrs", "--no-mac-metadata", "-C", stage, candidateName], { env });
    const extracted = path.join(stage, "verification");
    fs.mkdirSync(extracted);
    execFileSync("/usr/bin/tar", ["-xzf", archive, "-C", extracted], { env });
    verifyPayload(path.join(extracted, candidateName));
    const checksum = digest(pending, filename);
    fs.writeFileSync(`${archive}.sha256`, `${checksum}  ${filename}\n`, { flag: "wx" });
    const receipt = { schemaVersion: 1, product: manifest.product, version: candidateVersion, releaseTag: manifest.releaseTag,
      sourceRevision: manifest.sourceRevision, sourceRecord, sourceRecordSha256: digest(root, sourceRecord),
      payloadSourceDigest: manifest.payloadSourceDigest, payloadDigest: manifest.payloadDigest,
      manifestSha256: digest(payload, "MYCODEX-MANIFEST.json"),
      archive: { filename, bytes: fs.statSync(archive).size, sha256: checksum, payloadFiles: shipped.length },
      archiveChecks: { payloadHashes: "passed", commandSyntax: "passed", generatedRuntime: "passed", sourceAudit: "passed" },
      releaseStatus: "candidate" };
    writeJson(path.join(pending, receiptName), receipt);
    fs.chmodSync(pending, 0o755);
    fs.renameSync(pending, outputDirectory);
    return receipt;
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
    if (pending) fs.rmSync(pending, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error("用法：package-adapters.mjs --source-record 或 /完整路径/制品目录");
    const result = process.argv[2] === "--source-record" ? sourceBinding() : packageAdapters(process.argv[2]);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
