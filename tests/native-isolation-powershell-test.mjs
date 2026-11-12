import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";

const source = path.resolve(import.meta.dirname, "../tools/Restore-NativeIsolation.ps1");
const options = { skip: process.platform !== "win32" };
const command = `
$ErrorActionPreference = 'Stop'
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
    $env:CCODEX_ISOLATION_TEST_SOURCE, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
$definition = $ast.Find({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
        $node.Name -eq 'Remove-OwnedIsolationEnvironmentValues'
}, $true)
if (-not $definition) { throw 'The production deletion function was not found.' }
. ([scriptblock]::Create($definition.Extent.Text))
$case = $env:CCODEX_ISOLATION_TEST_CASE | ConvertFrom-Json -AsHashtable
$key = [pscustomobject]@{
    Values = $case.values
    Deletions = @()
    Recreate = $case.recreate
}
$key | Add-Member ScriptMethod GetValue {
    param($name, $fallback, $options)
    if ($this.Values.ContainsKey($name)) { return $this.Values[$name] }
    return $fallback
}
$key | Add-Member ScriptMethod GetValueNames { @($this.Values.Keys) }
$key | Add-Member ScriptMethod DeleteValue {
    param($name, $throwOnMissing)
    [void]$this.Values.Remove($name)
    $this.Deletions += $name
    if ($this.Recreate -eq $name) { $this.Values[$name] = 'concurrently-recreated' }
}
$failure = $null
$removed = @()
try {
    $removed = @(Remove-OwnedIsolationEnvironmentValues $key $case.records 'fixture-backup.json' 6>$null)
} catch { $failure = $_.Exception.Message }
@{
    removed = @($removed)
    deletions = @($key.Deletions)
    values = $key.Values
    failure = $failure
} | ConvertTo-Json -Depth 8 -Compress
`;

function exercise(input) {
  // Execute only the extracted production function against a dictionary fake.
  // Never dot-source the repair entry point or touch the real user registry.
  const result = spawnSync("pwsh.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command,
  ], {
    windowsHide: true, encoding: "utf8", timeout: 15000,
    env: {
      ...process.env,
      CCODEX_ISOLATION_TEST_SOURCE: source,
      CCODEX_ISOLATION_TEST_CASE: JSON.stringify(input),
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout);
}

test("native isolation deletes owned values rather than storing empty strings", options, () => {
  const result = exercise({
    values: { CODEX_HOME: "owned-copilot-profile", USER_PRIVATE: "keep", USER_EMPTY: "" },
    records: [
      { name: "CODEX_HOME", value: "owned-copilot-profile", owned: true },
      { name: "USER_PRIVATE", value: "keep", owned: false },
    ],
  });
  assert.equal(result.failure, null);
  assert.deepEqual(result.removed, ["CODEX_HOME"]);
  assert.deepEqual(result.deletions, ["CODEX_HOME"]);
  assert.deepEqual(result.values, { USER_PRIVATE: "keep", USER_EMPTY: "" });
});

test("native isolation preserves a value changed since its backup", options, () => {
  const result = exercise({
    values: { CODEX_HOME: "user-new-profile" },
    records: [{ name: "CODEX_HOME", value: "owned-copilot-profile", owned: true }],
  });
  assert.match(result.failure, /changed during isolation repair.*fixture-backup\.json/);
  assert.deepEqual(result.deletions, []);
  assert.equal(result.values.CODEX_HOME, "user-new-profile");
});

test("native isolation refuses an unapproved name even if marked owned", options, () => {
  const result = exercise({
    values: { USER_PRIVATE: "keep" },
    records: [{ name: "USER_PRIVATE", value: "keep", owned: true }],
  });
  assert.match(result.failure, /unverified isolation environment value/);
  assert.deepEqual(result.deletions, []);
  assert.equal(result.values.USER_PRIVATE, "keep");
});

test("native isolation reports concurrent recreation instead of false deletion success", options, () => {
  const result = exercise({
    values: { CODEX_HOME: "owned-copilot-profile" }, recreate: "CODEX_HOME",
    records: [{ name: "CODEX_HOME", value: "owned-copilot-profile", owned: true }],
  });
  assert.match(result.failure, /recreated during isolation repair.*fixture-backup\.json/);
  assert.deepEqual(result.deletions, ["CODEX_HOME"]);
  assert.equal(result.values.CODEX_HOME, "concurrently-recreated");
});

const helperCommand = `
$ErrorActionPreference = 'Stop'
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
    $env:CCODEX_ISOLATION_TEST_SOURCE, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
foreach ($name in @('Test-SameIsolationPath', 'Find-LegacyStockDesktopHelper')) {
    $definition = $ast.Find({
        param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
            $node.Name -eq $name
    }, $true)
    if (-not $definition) { throw "Production function missing: $name" }
    . ([scriptblock]::Create($definition.Extent.Text))
}
$case = $env:CCODEX_ISOLATION_TEST_CASE | ConvertFrom-Json
$found = @(Find-LegacyStockDesktopHelper $case.processes $case.listeners $case.stockPaths $case.script)
ConvertTo-Json -InputObject $found -Depth 5 -Compress
`;

function detectHelpers(change = value => value) {
  const node = String.raw`C:\Tools\node.exe`;
  const script = String.raw`C:\Owned\CodexCopilot\bridge\desktop-patch.mjs`;
  const desktop = String.raw`C:\Vendor\Codex\ChatGPT.exe`;
  const input = change({
    script, stockPaths: [desktop],
    processes: [
      { Name: "node.exe", ProcessId: 11, ExecutablePath: node,
        CreationDate: "2026-10-01T00:00:00Z", CommandLine: `"${node}" "${script}" 62232` },
      { Name: "ChatGPT.exe", ProcessId: 22, ExecutablePath: desktop,
        CreationDate: "2026-10-02T00:00:00Z", CommandLine: `"${desktop}" --remote-debugging-port=62232` },
    ],
    listeners: [{ LocalPort: 62232, LocalAddress: "127.0.0.1", OwningProcess: 22 }],
  });
  const result = spawnSync("pwsh.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", helperCommand,
  ], {
    windowsHide: true, encoding: "utf8", timeout: 15000,
    env: { ...process.env, CCODEX_ISOLATION_TEST_SOURCE: source,
      CCODEX_ISOLATION_TEST_CASE: JSON.stringify(input) },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout);
}

test("native isolation identifies only a legacy helper bound to an official stock lifetime", options, () => {
  const findings = detectHelpers();
  assert.equal(findings.length, 1);
  assert.equal(findings[0].helperPid, 11);
  assert.equal(findings[0].desktopPid, 22);
  assert.equal(findings[0].debugPort, 62232);
});

test("native isolation never classifies an independently profiled Desktop as stock", options, () => {
  assert.deepEqual(detectHelpers(value => {
    value.processes[1].CommandLine += ' --user-data-dir="C:\\Private\\desktop-data"';
    return value;
  }), []);
});

test("native isolation does not stop modern receipt-bound helpers", options, () => {
  assert.deepEqual(detectHelpers(value => {
    value.processes[0].CommandLine = '"C:\\Tools\\node.exe" "C:\\Owned\\CodexCopilot\\bridge\\desktop-patch.mjs" --instance receipt.json --token token';
    return value;
  }), []);
});

test("native isolation rejects reused ports, unknown executable paths and missing lifetimes", options, () => {
  for (const change of [
    value => { value.listeners[0].OwningProcess = 33; return value; },
    value => { value.processes[1].ExecutablePath = String.raw`C:\Other\ChatGPT.exe`; return value; },
    value => { value.processes[1].CreationDate = null; return value; },
    value => { value.processes[0].CreationDate = null; return value; },
    value => { value.processes[0].CommandLine += " --unrecognized"; return value; },
  ]) assert.deepEqual(detectHelpers(change), []);
});
