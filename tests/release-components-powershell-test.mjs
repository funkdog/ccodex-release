import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { requiredCliComponentFiles } from "../bridge/cli-components.mjs";

const verifier = path.resolve(import.meta.dirname, "../tools/Verify-ReleaseArtifacts.ps1");
const command = `
$ErrorActionPreference = 'Stop'
$source = Get-Content -LiteralPath $env:CCODEX_ARCHIVE_COMPONENT_SOURCE -Raw
$start = $source.IndexOf('    if ($manifest.coreVersion -notmatch')
$end = $source.IndexOf('    if ($compatibility.schemaVersion', $start)
if ($start -lt 0 -or $end -le $start) { throw 'Production archive component validation was not found.' }
$case = $env:CCODEX_ARCHIVE_COMPONENT_CASE | ConvertFrom-Json -AsHashtable
$target = $case.target
$targetIsWindows = $target.StartsWith('windows-')
$executableSuffix = if ($targetIsWindows) { '.exe' } else { '' }
$componentPrefix = 'bin/'
$componentNames = @(
  "\${componentPrefix}codex-code-mode-host$executableSuffix",
  "\${componentPrefix}codex-path/rg$executableSuffix",
  "\${componentPrefix}codex-resources/bwrap",
  "\${componentPrefix}codex-resources/codex-command-runner.exe",
  "\${componentPrefix}codex-resources/codex-windows-sandbox-setup.exe"
)
$manifest = $case.manifest
$revision = $case.revision
$chain = @{ patchedTree = $case.tree }
$seen = $case.seen
$failure = $null
try { & ([scriptblock]::Create($source.Substring($start, $end - $start))) }
catch { $failure = $_.Exception.Message }
@{ failure = $failure } | ConvertTo-Json -Compress
`;

function fixture(target = "windows-arm64") {
  const revision = "a".repeat(40);
  const tree = "b".repeat(40);
  const components = requiredCliComponentFiles(target, "codex-cli 0.160.0")
    .map(file => ({ file, target, sourceRevision: revision, patchedTree: tree,
      sha256: "C".repeat(64) }));
  return { target, revision, tree, manifest: { coreVersion: "codex-cli 0.160.0", components },
    seen: Object.fromEntries(components.map(row => [`bin/${row.file}`, { Hash: row.sha256 }])) };
}

function verify(input) {
  const result = spawnSync("pwsh.exe", ["-NoLogo", "-NoProfile", "-NonInteractive",
    "-Command", command], { windowsHide: true, encoding: "utf8", timeout: 15000,
    env: { ...process.env, CCODEX_ARCHIVE_COMPONENT_SOURCE: verifier,
      CCODEX_ARCHIVE_COMPONENT_CASE: JSON.stringify(input) } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout).failure;
}

test("archive gate verifies complete native path/resource companions for every target", {
  skip: process.platform !== "win32",
}, () => {
  for (const os of ["windows", "linux", "macos"]) {
    for (const arch of ["arm64", "x64"]) assert.equal(verify(fixture(`${os}-${arch}`)), null);
  }
});

for (const [name, mutate] of [
  ["missing inventory", f => { delete f.manifest.components; }],
  ["missing archived file", f => { delete f.seen[`bin/${f.manifest.components[0].file}`]; }],
  ["modified archived bytes", f => { f.seen[`bin/${f.manifest.components[0].file}`].Hash = "D".repeat(64); }],
  ["foreign patch tree", f => { f.manifest.components[0].patchedTree = "e".repeat(40); }],
  ["duplicate role", f => { f.manifest.components.push({ ...f.manifest.components[0] }); }],
  ["escaping path", f => { f.manifest.components[0].file = "../stock.exe"; }],
]) {
  test(`archive gate refuses ${name} rather than reporting a complete release`, {
    skip: process.platform !== "win32",
  }, () => {
    const f = fixture();
    mutate(f);
    assert.match(verify(f), /companion|inventory/);
  });
}

test("standard promotion retains verified companion bytes in canonical runtime outputs", () => {
  const source = fs.readFileSync(path.resolve(import.meta.dirname, "../tools/Publish-Release.ps1"), "utf8");
  assert.match(source, /foreach \(\$component in \$runtimeManifest\.components\)/);
  assert.match(source, /Promoted companion hash mismatch/);
  assert.match(source, /Copy-Item -LiteralPath \$sourceComponent -Destination \$destinationComponent/);
});
