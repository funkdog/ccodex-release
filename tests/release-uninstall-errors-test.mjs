import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const windows = process.platform === "win32";
const shell = windows ? path.join(process.env.SystemRoot,
  "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : "";
const env = { ...process.env };
for (const name of Object.keys(env)) {
  if (["PSMODULEPATH", "PSHOME"].includes(name.toUpperCase())) delete env[name];
}
if (windows) env.PSModulePath = path.join(process.env.SystemRoot,
  "System32", "WindowsPowerShell", "v1.0", "Modules");

function runScript(script) {
  const result = spawnSync(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64")], {
    env, encoding: "utf8", windowsHide: true, timeout: 30000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

test("uninstall handles mapped-image access denial and never treats a permanent failure as success",
  { skip: !windows }, () => {
    const source = fs.readFileSync(path.join(root, "release", "uninstall.ps1"), "utf8");
    const begin = source.indexOf("function Test-RetryableDeleteError");
    const end = source.indexOf("$lock = [IO.File]::Open", begin);
    assert(begin >= 0 && end > begin);
    const logic = source.slice(begin, end);
    const output = runScript(`$ErrorActionPreference='Stop'
${logic}
foreach($e in @([IO.IOException]::new('busy'),[UnauthorizedAccessException]::new('mapped'),
  [Exception]::new('wrapper',[UnauthorizedAccessException]::new('mapped')))){
  if(-not (Test-RetryableDeleteError $e)){throw 'Mapped image or wrapped IO error was not retryable'}
}
if(Test-RetryableDeleteError ([ArgumentException]::new('invalid'))){throw 'Invalid argument became retryable'}
'bounded-delete-errors-ready'`);
    assert.match(output, /bounded-delete-errors-ready/);
    assert.match(source, /Test-RetryableDeleteError \$_\.Exception/);
    assert.match(source, /\[DateTime\]::UtcNow -ge \$deadline\) \{ throw \}/);
    assert.match(source, /AddSeconds\(45\)/);
  });

test("cleanup bootstrap does not use PowerShell 5.1 recursion on a long runtime tree", () => {
  const source = fs.readFileSync(path.join(root, "release", "uninstall-bootstrap.ps1"), "utf8");
  assert(!source.includes("Get-ChildItem -LiteralPath $stage -Recurse"));
  assert.match(source, /\$LASTEXITCODE -ne 0\) \{\s+\$code = 1/);
  assert.match(source, /Refusing redirected cleanup-helper removal/);
  assert.match(source, /\[IO.File\]::Delete\(\$cleaner\)/);
  assert.match(source, /Test-RetryableDeleteError \$_\.Exception/);
});

test("native cleanup rejects a junction before removing any neighboring resource", { skip: !windows }, () => {
  const home = fs.mkdtempSync(path.join(root, "..", "cleanup-safety-"));
  const temp = path.join(home, "temp");
  const stage = path.join(temp, "ccodex-uninstall-" + "a".repeat(32));
  const outside = path.join(home, "outside");
  const helper = path.join(root, "bin", "ccodex-release-cleanup.exe");
  fs.mkdirSync(stage, { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(stage, "neighbor.txt"), "keep-neighbor");
  fs.writeFileSync(path.join(outside, "keep.txt"), "keep-outside");
  const link = path.join(stage, "redirected");
  try {
    fs.symlinkSync(outside, link, "junction");
    const result = spawnSync(helper, [stage], {
      env: { ...env, TEMP: temp, TMP: temp }, encoding: "utf8", windowsHide: true, timeout: 15000,
    });
    assert.equal(result.status, 2, result.stderr);
    assert.equal(fs.readFileSync(path.join(stage, "neighbor.txt"), "utf8"), "keep-neighbor");
    assert.equal(fs.readFileSync(path.join(outside, "keep.txt"), "utf8"), "keep-outside");
  } finally {
    if (fs.existsSync(link)) fs.unlinkSync(link);
    assert(path.resolve(home).startsWith(path.resolve(root, "..") + path.sep));
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("native cleanup never accepts a non-owned temporary directory", { skip: !windows }, () => {
  const helper = path.join(root, "bin", "ccodex-release-cleanup.exe");
  const result = spawnSync(helper, [root], {
    env, encoding: "utf8", windowsHide: true, timeout: 15000,
  });
  assert.equal(result.status, 2);
  assert(fs.existsSync(path.join(root, "release.json")));
});
