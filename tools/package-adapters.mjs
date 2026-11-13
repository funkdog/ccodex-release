import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { assertTypeScriptBuild, typescriptInputs, typescriptManifest } from "./typescript-state.mjs";
import { auditSourceFiles } from "./check-source-publication.mjs";

const root = path.resolve(import.meta.dirname, "..");
export const adaptersVersion = "0.1.0-rc.4";
const checksum = bytes => createHash("sha256").update(bytes).digest("hex");
const additions = new Set(["release/adapters-command.sh", "release/adapters-sdk/package.json", "release/adapters-sdk/package-lock.json",
  "tools/configure-adapters.mjs", "tools/adapter-connection.mjs", "tools/package-adapters.mjs", "bridge/desktop-execution-model.mts", "bridge/diy/execution-picker.mts"]);
const ownedChanges = new Set([...additions, "package.json", "tools/install-macos-launcher.mjs", "bridge/desktop-mode.mjs", "bridge/desktop-shortcut.mjs", "bridge/desktop-current-host-contract.mjs",
  "bridge/desktop-backends/app-server-gateway.mjs", "gateway/contracts.mts", "gateway/routed-stdio.mts", "gateway/server.mts", "tools/typescript-task.mjs",
  "gateway/engines/index.mts", "gateway/engines/claude-code.mts", "gateway/protocol.mts", "gateway/sdk-contracts.mts",
  "bridge/desktop-native-composer.mts", "bridge/desktop-native-session.mts", "bridge/desktop-diy-contracts.mts",
  "bridge/catalog.mjs", "bridge/server.mjs", "bridge/translate.mjs", "bridge/request-sanitize.mjs",
  "gateway/google-contracts.mts", "gateway/google-provider.mts"]);
const inScope = file => !/^release\/RC\d+-SOURCE\.json$/.test(file) &&
  (/^(?:bridge|gateway|tools|release)\//.test(file) || ["assets/catalog-templates.json", "package.json", "package-lock.json", "tsconfig.json", "VERSION"].includes(file));
export function adaptersPackageFiles(base = root) {
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: base, encoding: "utf8" }).split("\0").filter(Boolean)
    .filter(inScope);
  const audited = auditSourceFiles(base, files);
  if (!audited.passed) throw new Error(`源码审计未通过：${JSON.stringify(audited.findings)}`);
  const unknown = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd: base, encoding: "utf8" }).split("\0").filter(file => inScope(file) && !additions.has(file));
  const unrelated = execFileSync("git", ["diff", "HEAD", "--name-only", "-z"], { cwd: base, encoding: "utf8" }).split("\0").filter(file => inScope(file) && !ownedChanges.has(file));
  if (unknown.length || unrelated.length) throw new Error("源码中有精简版范围外的改动；请从独立、已审查基线打包，不能混入开发现场。");
  return [...new Set([...files, ...typescriptInputs(base).outputs, typescriptManifest])].sort();
}

export function packageAdapters(output) {
  if (process.env.CODEX_COPILOT_HEAVY_LOCK_HELD !== "1") throw new Error("请通过 tools/Invoke-HeavyTask.sh 打包。");
  const build = assertTypeScriptBuild(root);
  output = path.resolve(output);
  if (!output.endsWith(".tar.gz") || fs.existsSync(output)) throw new Error("请选择不存在的 .tar.gz 输出文件。");
  const files = adaptersPackageFiles();
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "mycodex-adapters-package-"));
  const name = `mycodex-adapters-macos-arm64-${adaptersVersion}`;
  const payload = path.join(stage, name);
  try {
    fs.mkdirSync(payload);
    for (const relative of files) {
      const source = path.join(root, relative), destination = path.join(payload, relative);
      if (!fs.lstatSync(source).isFile() || fs.lstatSync(source).isSymbolicLink()) throw new Error("发行包拒绝链接和特殊文件。");
      fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.copyFileSync(source, destination);
    }
    fs.copyFileSync(path.join(root, "docs/ADAPTERS-MACOS.zh-CN.md"), path.join(payload, "README.zh-CN.md"));
    for (const entry of ["Install", "Configure", "Diagnose", "Start", "Install-Launcher"]) {
      const target = path.join(payload, `${entry}.command`);
      fs.copyFileSync(path.join(root, "release/adapters-command.sh"), target); fs.chmodSync(target, 0o755);
    }
    const shippedFiles = [...files, "README.zh-CN.md", ...["Install", "Configure", "Diagnose", "Start", "Install-Launcher"].map(entry => `${entry}.command`)].sort();
    const hashes = Object.fromEntries(shippedFiles.map(relative => [relative, checksum(fs.readFileSync(path.join(payload, relative)))]));
    const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const manifest = { schemaVersion: 1, product: "MyCodex Adapters", version: adaptersVersion, platform: "darwin", arch: "arm64",
      sourceRevision: revision, sourceDigest: checksum(JSON.stringify(hashes)), files: hashes, build,
      featureScope: ["native-codex", "claude-code", "antigravity-acp-1.4.4"],
      nativeConfiguration: "official-existing", externalModels: "opt-in-after-selected-model-inference-check",
      excludedFeatures: ["workbench", "squad", "radar", "daily", "model-sources", "conversation-handoff"],
      prerequisites: ["Node.js >=24", "compatible official desktop", "own authenticated CLI only for optional external models"],
      thirdPartyRuntimesBundled: false, releaseStatus: "candidate", liveDesktopAcceptance: "pending", published: false };
    fs.writeFileSync(path.join(payload, "ADAPTERS-MANIFEST.json"), JSON.stringify(manifest, null, 2) + "\n");
    assertTypeScriptBuild(payload);
    execFileSync(process.execPath, ["--experimental-vm-modules", path.join(payload, "tools/Check-PackageModules.mjs"), payload], { stdio: "pipe" });
    fs.mkdirSync(path.dirname(output), { recursive: true });
    execFileSync("/usr/bin/tar", ["-czf", output, "-C", stage, name], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
    const sha256 = checksum(fs.readFileSync(output));
    fs.writeFileSync(`${output}.sha256`, `${sha256}  ${path.basename(output)}\n`, { flag: "wx" });
    return { output, sha256, version: adaptersVersion, files: files.length, bytes: fs.statSync(output).size, sourceDigest: manifest.sourceDigest,
      releaseStatus: manifest.releaseStatus, published: false, liveDesktopAcceptance: "pending" };
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error("用法：package-adapters.mjs /完整路径/mycodex-adapters.tar.gz");
    console.log(JSON.stringify(packageAdapters(process.argv[2]), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
