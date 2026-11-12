import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { windowsSystemEnvironment } from "../bridge/windows-system-environment.mjs";

test("system diagnostics remove mixed-case portable PowerShell module discovery without changing their parent", () => {
  const source = {
    SystemRoot: "D:\\Operating System",
    PSModulePath: "portable-old-modules",
    psmodulepath: "portable-other-modules",
    PSHOME: "portable-old-engine",
    pshome: "another-engine",
    PATH: "keep-tool-bindings",
    CODEX_HOME: "keep-independent-profile",
  };
  const snapshot = { ...source };
  const env = windowsSystemEnvironment(source);
  assert.deepEqual(source, snapshot);
  assert.equal(env.PSModulePath, "D:\\Operating System\\System32\\WindowsPowerShell\\v1.0\\Modules");
  assert.equal(env.PATH, source.PATH);
  assert.equal(env.CODEX_HOME, source.CODEX_HOME);
  assert.equal(Object.keys(env).filter(name => name.toUpperCase() === "PSMODULEPATH").length, 1);
  assert.equal(Object.keys(env).filter(name => name.toUpperCase() === "PSHOME").length, 0);
});

test("system diagnostics fail before spawning if Windows location is unavailable", () => {
  assert.throws(() => windowsSystemEnvironment({}), /unavailable/);
  assert.throws(() => windowsSystemEnvironment({ SystemRoot: "relative-path" }), /unavailable/);
});

test("actual Windows PowerShell loads CIM modules despite a long foreign portable module path", {
  skip: process.platform !== "win32",
}, () => {
  const polluted = { ...process.env,
    PSModulePath: path.join("C:\\UninstalledPortableEngine",
      ...Array.from({ length: 25 }, () => "long-directory-name"), "Modules"),
    PSHOME: "C:\\UninstalledPortableEngine",
  };
  const shell = path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const result = spawnSync(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
    "$ErrorActionPreference='Stop';$p=Get-CimInstance Win32_Process -Filter 'ProcessId = " +
    process.pid + "';if($null -eq $p){throw 'Missing owned test process'};'system-cim-ready'"], {
    env: windowsSystemEnvironment(polluted), encoding: "utf8", timeout: 15000, windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "system-cim-ready");
});
