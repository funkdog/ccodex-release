import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const generated = /^(?:desktop|runtime|profiles?|profile-seed|dist|outputs|work|codex-source|artifacts|release-readiness|test-evidence|\.release-staging|\.build-teamsetup)(?:\/|$)|^bin\/(?:runtimes|cores|node-pty)\//;
const privateFile = /(?:^|\/)(?:auth\.json|hosts\.yml|credentials\.json|credential-store\.json|\.env(?:\..*)?|\.ccodex-dev-install\.json)$/;
const compiled = /\.(?:exe|dll|pdb|obj|lib|exp|pyc|zip|7z|tar(?:\.gz|\.xz)?|deb|rpm|pkg|log|tap|tmp|bak(?:-.*)?)$/i;
const secrets = [
  /github_pat_[A-Za-z0-9_]{20,}/,
  /gh[pousr]_[A-Za-z0-9_]{20,}/,
  /sk-[A-Za-z0-9_-]{24,}/,
  /-{5}BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-{5}/,
];
const machinePaths = [/\b[A-Z]:[\\/]+Users[\\/]+[^\\/\s"'\x60<>]+/i, /\/(?:Users|home)\/[^/\s"'\x60<>]+/];
const privateTerms = /(?:10[j]qka|my[h]exin|\ba[i]me\b|gitlab-[o]uter|slip[s]hod|gemini-4-[c]arbon|gpt-6\\?\.[12]-[s]ol|gpt-6\\?\.2-[a]stra|gpt-daybreak-(?:blue|red)-[l]atest|小[红]书)/i;
const knownBinary = /\.(?:ico|png|jpg|jpeg|gif|webp)$/i;
const contentFindings = (file, text) => {
  const findings = [];
  if (text.includes("\0")) findings.push({ file, issue: "unexpected binary source" });
  if (machinePaths.some(pattern => pattern.test(text))) findings.push({ file, issue: "machine-specific user path" });
  if (privateTerms.test(text)) findings.push({ file, issue: "private publication term" });
  if (secrets.some(pattern => pattern.test(text))) findings.push({ file, issue: "credential-shaped content" });
  return findings;
};

export function auditPublicText(root, files) {
  return files.filter(file => !knownBinary.test(file)).flatMap(file => contentFindings(file, fs.readFileSync(path.join(root, file), "utf8")));
}

export function auditSourceFiles(root, files) {
  const base = path.resolve(root);
  const findings = [];
  let bytes = 0;
  for (const relative of [...files].sort()) {
    const name = relative.replaceAll("\\", "/");
    const full = path.resolve(base, relative);
    if (name.startsWith("/") || name.split("/").some(part => part === "..")
      || !full.startsWith(base + path.sep)) {
      findings.push({ file: name, issue: "unsafe source path" });
      continue;
    }
    if (generated.test(name) || privateFile.test(name) || compiled.test(name) ||
        /(?:^|\/)node_modules(?:\/|$)/.test(name) || name.endsWith(".mjs.map") ||
        name === "tools/typescript-build-manifest.json" ||
        (name.endsWith(".mjs") && fs.existsSync(full.slice(0, -4) + ".mts"))) {
      findings.push({ file: name, issue: "private or generated artifact" });
      continue;
    }
    const stat = fs.lstatSync(full);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 10 * 1024 * 1024) {
      findings.push({ file: name, issue: "not a regular small source file" });
      continue;
    }
    bytes += stat.size;
    if (!knownBinary.test(name)) findings.push(...contentFindings(name, fs.readFileSync(full, "utf8")));
  }
  return { passed: findings.length === 0, files: files.length, bytes, findings };
}

function main() {
  const root = path.resolve(import.meta.dirname, "..");
  const git = spawnSync("git", ["-C", root, "ls-files", "-z"], {
    encoding: "utf8", windowsHide: true,
  });
  assert.equal(git.status, 0, "A Git working tree is required.");
  const files = git.stdout.split("\0").filter(Boolean);
  assert.ok(files.length > 0, "The publication candidate is empty.");
  const diff = spawnSync("git", ["-C", root, "diff", "--quiet", "--"], {
    encoding: "utf8", windowsHide: true,
  });
  assert.equal(diff.status, 0, "Stage source changes before auditing publication.");
  const result = auditSourceFiles(root, files);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  if (!result.passed) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
