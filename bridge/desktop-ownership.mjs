import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { desktopProcessMatches, sameProcessLifetime, windowsArguments,
  readProcessIdentity, desktopEndpointOwner } from "./desktop-process.mjs";
import { readDesktopInstance } from "./desktop-instance.mjs";
import { windowsSystemEnvironment } from "./windows-system-environment.mjs";

const execute = promisify(execFile);

export async function inspectWindowsDesktopOwnership(receipt, { invoke = execute } = {}) {
  const { pid, debugPort } = receipt;
  if (!Number.isSafeInteger(pid) || pid <= 0 ||
      !Number.isInteger(debugPort) || debugPort < 1024 || debugPort > 65535) {
    throw new Error("Invalid private Desktop process/port.");
  }
  if (invoke === execute && fs.existsSync(path.resolve(import.meta.dirname, "../bin/ccodex-process-probe.exe"))) {
    const before = readProcessIdentity(pid, { expectedLifetime: receipt.identity?.lifetime });
    if (!before) throw new Error("The private Desktop lifetime ended.");
    const owner = desktopEndpointOwner(debugPort);
    const after = readProcessIdentity(pid, { expectedLifetime: before.lifetime });
    if (owner !== pid || !sameProcessLifetime(before, after)) {
      throw new Error("Private Desktop lifetime/profile/endpoint ownership changed.");
    }
    return { ...after, endpointOwner: owner };
  }
  const command =
    "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);" +
    "$ErrorActionPreference='Stop';" +
    `$live=Get-Process -Id ${pid} -ErrorAction SilentlyContinue;` +
    "if($null -eq $live -or $live.HasExited){'null';exit 0};" +
    `$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}';` +
    "if($null -eq $p){'null';exit 0};" +
    "if(-not $p.ExecutablePath -or -not $p.CommandLine){throw 'Process identity is unreadable'};" +
    `$pattern='^\\s*TCP\\s+127\\.0\\.0\\.1:${debugPort}\\s+\\S+\\s+LISTENING\\s+(\\d+)\\s*$';` +
    "$owners=@(& \"$env:SystemRoot\\System32\\netstat.exe\" -ano -p tcp|" +
    "ForEach-Object {if($_ -match $pattern){[int]$Matches[1]}}|Sort-Object -Unique);" +
    `if($owners.Count -ne 1 -or $owners[0] -ne ${pid}){throw 'Private endpoint owner changed'};` +
    `$after=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}';` +
    "if($live.HasExited -or $null -eq $after -or $p.CreationDate -ne $after.CreationDate){" +
    "throw 'Private Desktop lifetime changed'};" +
    "@{pid=[int]$p.ProcessId;platform='win32';" +
    "lifetime='windows:'+$p.CreationDate.ToUniversalTime().Ticks.ToString();" +
    "executable=$p.ExecutablePath;commandLine=$p.CommandLine;" +
    "endpointOwner=$owners[0]}|ConvertTo-Json -Compress";
  const shell = path.join(process.env.SystemRoot || "C:\\Windows",
    "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const result = await invoke(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
    windowsHide: true, encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024,
    env: windowsSystemEnvironment(),
  });
  const value = JSON.parse(result.stdout);
  if (value === null) throw new Error("The private Desktop lifetime ended.");
  return { ...value, args: windowsArguments(value.commandLine) };
}

export function createDesktopOwnershipGuard(binding, {
  home, helperToken, inspect = inspectWindowsDesktopOwnership,
  now = Date.now, maximumAgeMs = 2000,
  receiptReader = readDesktopInstance,
  alive = pid => { process.kill(pid, 0); },
} = {}) {
  let verifiedAt = -Infinity;
  let pending = null;
  return async () => {
    const current = receiptReader(home);
    if (current?.instanceToken !== binding.receipt.instanceToken ||
        current?.helperToken !== helperToken) {
      throw new Error("The private Desktop helper was superseded.");
    }
    alive(binding.receipt.pid);
    if (pending) return pending;
    if (now() - verifiedAt < maximumAgeMs) return;
    pending = (async () => {
      if (process.platform !== "win32") binding.assertOwned();
      else {
        const identity = await inspect(binding.receipt);
        if (identity.endpointOwner !== binding.receipt.pid ||
            !sameProcessLifetime(binding.identity, identity) ||
            !desktopProcessMatches(identity, {
              executable: binding.receipt.executable,
              userData: binding.receipt.userData,
              port: binding.receipt.debugPort,
              launchArgs: binding.receipt.launchArgs,
            })) {
          throw new Error("Private Desktop lifetime/profile/endpoint ownership changed.");
        }
      }
      const latest = receiptReader(home);
      if (latest?.instanceToken !== current.instanceToken || latest?.helperToken !== helperToken) {
        throw new Error("The private Desktop helper was superseded during verification.");
      }
      verifiedAt = now();
    })().finally(() => { pending = null; });
    return pending;
  };
}
