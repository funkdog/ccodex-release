import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const windows = { skip: process.platform !== "win32" };
const module = path.resolve(import.meta.dirname, "../tools/desktop-package.ps1");
const quote = value => `'${value.replaceAll("'", "''")}'`;

function run(t, entries, existing = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-desktop-package-"));
  const destination = path.join(root, "extracted");
  const archive = path.join(root, "candidate.msix");
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
    assert.match(path.basename(root), /^ccodex-desktop-package-/);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const script = `
$ErrorActionPreference='Stop'
. ${quote(module)}
$zip=[IO.Compression.ZipFile]::Open(${quote(archive)},[IO.Compression.ZipArchiveMode]::Create)
try {
${entries.map(name => `$entry=$zip.CreateEntry(${quote(name)})
$writer=[IO.StreamWriter]::new($entry.Open())
try {$writer.Write('fixture')} finally {$writer.Dispose()}
`).join("\n")}
} finally {$zip.Dispose()}
${existing ? `New-Item -ItemType Directory -Path ${quote(destination)} | Out-Null` : ""}
try {
  $result=Expand-IndependentDesktopPackage -Package ${quote(archive)} -Destination ${quote(destination)}
  @{passed=$true;files=$result.Files;destinationExists=(Test-Path -LiteralPath ${quote(destination)})}|ConvertTo-Json -Compress
} catch {
  @{passed=$false;error=$_.Exception.Message;destinationExists=(Test-Path -LiteralPath ${quote(destination)})}|ConvertTo-Json -Compress
}`;
  const result = spawnSync("pwsh.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64")],
  { encoding: "utf8", windowsHide: true, timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  return { root, destination, result: JSON.parse(result.stdout.trim()) };
}

test("signed-package extractor writes only inside a fresh owned directory", windows, t => {
  const f = run(t, ["app/ChatGPT.exe", "app/resources/app.asar"]);
  assert.equal(f.result.passed, true);
  assert.equal(f.result.files, 2);
  assert.equal(fs.readFileSync(path.join(f.destination, "app", "ChatGPT.exe"), "utf8"), "fixture");
});

for (const entry of ["../stock.exe", "/stock.exe", "C:/stock.exe", "app/file:stream", "app/../../stock.exe"]) {
  test(`package extraction rejects ${entry} before writing any file`, windows, t => {
    const f = run(t, ["app/first.exe", entry]);
    assert.equal(f.result.passed, false);
    assert.equal(f.result.destinationExists, false);
    assert.match(f.result.error, /Unsafe|escaped/);
  });
}

test("package extraction rejects case-insensitive duplicate paths before writing", windows, t => {
  const f = run(t, ["app/ChatGPT.exe", "APP/chatgpt.exe"]);
  assert.equal(f.result.passed, false);
  assert.equal(f.result.destinationExists, false);
  assert.match(f.result.error, /duplicate/);
});

test("package extraction does not reuse an existing directory", windows, t => {
  const f = run(t, ["app/ChatGPT.exe"], true);
  assert.equal(f.result.passed, false);
  assert.equal(f.result.destinationExists, true);
  assert.match(f.result.error, /new owned directory/);
  assert.equal(fs.existsSync(path.join(f.destination, "app", "ChatGPT.exe")), false);
});
