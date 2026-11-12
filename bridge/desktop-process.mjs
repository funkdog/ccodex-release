import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { windowsSystemEnvironment } from "./windows-system-environment.mjs";
import { validatedFileSha256 } from "./file-validation-cache.mjs";

const nativeProbe = path.resolve(import.meta.dirname, "../bin/ccodex-process-probe.exe");

function verifyNativeProbe() {
  const file = path.join(path.dirname(nativeProbe), "ccodex-process-probe.manifest.json");
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) {
    throw new Error("Native identity probe metadata is invalid.");
  }
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!/^[a-f0-9]{64}$/i.test(manifest.sha256 || "") ||
      validatedFileSha256(nativeProbe) !== manifest.sha256.toLowerCase()) {
    throw new Error("Native identity probe integrity check failed.");
  }
}

function run(program, args) {
  const result = spawnSync(program, args, {
    encoding: "utf8", windowsHide: true,
    timeout: process.platform === "win32" ? 30000 : 10000, maxBuffer: 1024 * 1024,
    env: { ...(process.platform === "win32" ? windowsSystemEnvironment() : process.env),
      LC_ALL: "C", TZ: "UTC" },
  });
  if (result.error) throw result.error;
  return result;
}

function validPid(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid Desktop process id.");
}

function validPort(port) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("Invalid private Desktop endpoint port.");
  }
}

/** Parse the quoting used by Windows process command lines without executing it. */
export function windowsArguments(command) {
  if (typeof command !== "string" || command.length > 256 * 1024) {
    throw new Error("Invalid Desktop command line.");
  }
  const args = [];
  let at = 0;
  while (at < command.length) {
    while (/\s/.test(command[at] || "") && at < command.length) at++;
    if (at === command.length) break;
    let value = "";
    let quoted = false;
    while (at < command.length && (quoted || !/\s/.test(command[at]))) {
      let slashes = 0;
      while (command[at] === "\\") { slashes++; at++; }
      if (command[at] === '"') {
        value += "\\".repeat(Math.floor(slashes / 2));
        if (slashes % 2) { value += '"'; at++; }
        else if (quoted && command[at + 1] === '"') { value += '"'; at += 2; }
        else { quoted = !quoted; at++; }
      } else {
        value += "\\".repeat(slashes);
        if (at < command.length) {
          if (!quoted && /\s/.test(command[at])) break;
          value += command[at++];
        }
      }
    }
    if (quoted) throw new Error("Unclosed Desktop process command-line quote.");
    args.push(value);
  }
  return args;
}

function linuxStart(stat, pid) {
  const close = stat.lastIndexOf(")");
  const fields = stat.slice(close + 2).trim().split(/\s+/);
  if (!stat.startsWith(`${pid} (`) || close < 0 || !/^\d+$/.test(fields[19] || "")) {
    throw new Error("Linux process lifetime could not be established.");
  }
  return fields[19];
}

export function readProcessIdentity(pid, {
  platform = process.platform, invoke = run, procRoot = "/proc",
  readFile = file => fs.readFileSync(file, "utf8"),
  readLink = fs.readlinkSync,
  expectedLifetime,
} = {}) {
  validPid(pid);
  if (platform === "win32") {
    if (expectedLifetime !== undefined && !/^windows:\d+$/.test(expectedLifetime)) {
      throw new Error("Invalid expected Windows process lifetime.");
    }
    if (invoke === run && fs.existsSync(nativeProbe)) {
      verifyNativeProbe();
      const result = invoke(nativeProbe, ["process", String(pid),
        ...(expectedLifetime ? [expectedLifetime] : [])]);
      if (result.status === 0) {
        const value = JSON.parse(result.stdout);
        if (value === null) return null;
        if (value.pid !== pid || !/^windows:\d+$/.test(value.lifetime || "") ||
            typeof value.executable !== "string" || !path.win32.isAbsolute(value.executable) ||
            (expectedLifetime && value.lifetime !== expectedLifetime)) {
          throw new Error("Native Windows process identity is invalid.");
        }
        return { ...value, platform, args: windowsArguments(value.commandLine) };
      }
    }
    const shell = path.win32.join(process.env.SystemRoot || "C:\\Windows",
      "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const result = invoke(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);` +
      `$ErrorActionPreference='Stop';for($attempt=0;$attempt -lt 3;$attempt++){` +
      `$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}';` +
      `if($null -eq $p){'null';exit 0};` +
      `if(-not $p.CreationDate){throw 'Process lifetime is unreadable'};` +
      `$lifetime='windows:'+$p.CreationDate.ToUniversalTime().Ticks.ToString();` +
      (expectedLifetime ? `if($lifetime -cne '${expectedLifetime}'){'null';exit 0};` : "") +
      // Exited/reused PIDs need no executable access. Retry transient CIM gaps,
      // but never treat an unreadable matching live process as an expired one.
      `$live=Get-Process -Id ${pid} -ErrorAction SilentlyContinue;` +
      `if($null -eq $live -or $live.HasExited){'null';exit 0};` +
      `if(-not $p.ExecutablePath -or -not $p.CommandLine){Start-Sleep -Milliseconds 25;continue};` +
      `$after=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}';` +
      `if($null -eq $after){'null';exit 0};` +
      `if($after.CreationDate -ne $p.CreationDate){` +
      (expectedLifetime ? "'null';exit 0" : "continue") + `};` +
      `@{pid=[int]$p.ProcessId;lifetime=$lifetime;` +
      `executable=$p.ExecutablePath;commandLine=$p.CommandLine}|ConvertTo-Json -Compress;exit 0};` +
      `throw 'Process identity is unreadable'`]);
    if (result.status !== 0) throw new Error(
      `Windows Desktop process identity could not be established: ${String(result.stderr || "system probe failed").trim().slice(0, 1000)}`);
    const value = JSON.parse(result.stdout);
    if (value === null) return null;
    if (value.pid !== pid || !/^windows:\d+$/.test(value.lifetime || "") ||
        typeof value.executable !== "string" || !path.win32.isAbsolute(value.executable)) {
      throw new Error("Windows Desktop process identity is invalid.");
    }
    return { ...value, platform, args: windowsArguments(value.commandLine) };
  }
  if (platform === "linux") {
    const directory = path.posix.join(procRoot, String(pid));
    try {
      const before = linuxStart(readFile(`${directory}/stat`), pid);
      const boot = readFile(`${procRoot}/sys/kernel/random/boot_id`).trim();
      if (!/^[a-f0-9-]{36}$/i.test(boot)) throw new Error("Linux boot identity is invalid.");
      const executable = readLink(`${directory}/exe`);
      const command = readFile(`${directory}/cmdline`);
      if (command.length > 256 * 1024 || !path.posix.isAbsolute(executable) ||
          executable.endsWith(" (deleted)")) throw new Error("Linux Desktop executable/arguments are invalid.");
      const args = command.split("\0");
      if (args.at(-1) === "") args.pop();
      const after = linuxStart(readFile(`${directory}/stat`), pid);
      if (before !== after || !args.length) throw new Error("Linux process changed during identity inspection.");
      return { pid, platform, lifetime: `linux:${boot}:${before}`, executable, args };
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ESRCH") return null;
      throw error;
    }
  }
  if (platform === "darwin") {
    const born = () => invoke("/bin/ps", ["-p", String(pid), "-o", "lstart="]);
    const before = born();
    if (before.status === 1 && !before.stdout.trim()) return null;
    if (before.status !== 0 || !before.stdout.trim()) {
      throw new Error("macOS Desktop process lifetime could not be established.");
    }
    const image = invoke("/usr/sbin/lsof", ["-nP", "-a", "-p", String(pid), "-d", "txt", "-Fpn"]);
    const command = invoke("/bin/ps", ["-ww", "-p", String(pid), "-o", "args="]);
    const after = born();
    // A graceful quit can finish between ps and lsof. A reaped process, or
    // an unreaped zombie, has no live executable to inspect. Keep failures
    // for unreadable live processes distinct from that normal exit race.
    if (after.status === 1 && !after.stdout.trim()) return null;
    const lines = image.stdout?.split(/\r?\n/) || [];
    const executable = lines.find(line => line.startsWith("n/"))?.slice(1);
    if (image.status !== 0 || command.status !== 0 || after.status !== 0 ||
        before.stdout.trim() !== after.stdout.trim() ||
        lines.filter(line => line.startsWith("p")).some(line => line !== `p${pid}`) ||
        !lines.includes(`p${pid}`) || !executable || !command.stdout.trim()) {
      if (after.status === 0 && before.stdout.trim() === after.stdout.trim()) {
        const state = invoke("/bin/ps", ["-p", String(pid), "-o", "stat="]);
        if (state.status === 1 && !state.stdout.trim()) return null;
        if (state.status === 0 && /^Z\S*\s*$/.test(state.stdout.trim())) return null;
      }
      throw new Error("macOS Desktop executable/command identity could not be established.");
    }
    return { pid, platform, lifetime: `macos:${before.stdout.trim().replace(/\s+/g, " ")}`,
      executable, commandLine: command.stdout.trim() };
  }
  throw new Error(`Independent Desktop process inspection is unsupported: ${platform}`);
}

export function sameProcessLifetime(first, second) {
  const normalized = (value, platform) => platform === "win32" ? value.toLowerCase() : value;
  return !!first && !!second && first.pid === second.pid &&
    first.platform === second.platform && first.lifetime === second.lifetime &&
    typeof first.lifetime === "string" && !!first.lifetime &&
    typeof first.executable === "string" && typeof second.executable === "string" &&
    normalized(first.executable, first.platform) === normalized(second.executable, second.platform);
}

export function desktopProcessMatches(identity, { executable, userData, port, launchArgs }) {
  if (!identity || typeof executable !== "string" || typeof userData !== "string") return false;
  const normalized = value => identity.platform === "win32" ? value.toLowerCase() : value;
  if (normalized(identity.executable) !== normalized(executable)) return false;
  const dataArg = `--user-data-dir=${userData}`;
  const portArg = `--remote-debugging-port=${port}`;
  if (Array.isArray(identity.args)) {
    const data = identity.args.filter(arg => /^--user-data-dir(?:=|$)/i.test(arg));
    const debug = identity.args.filter(arg => /^--remote-debugging-port(?:=|$)/i.test(arg));
    return data.length === 1 && debug.length === 1 &&
      normalized(data[0]) === normalized(dataArg) && debug[0] === portArg;
  }
  // BSD ps exposes flattened argv. Bind its full string to the exact invocation,
  // not a substring that a decoy argument could supply. Native macOS execution
  // evidence is still required by the publisher; this is not a fixture proof.
  return identity.platform === "darwin" && Array.isArray(launchArgs) &&
    identity.commandLine === [executable, ...launchArgs].join(" ") &&
    launchArgs.filter(arg => /^--user-data-dir(?:=|$)/i.test(arg)).length === 1 &&
    launchArgs.includes(dataArg) && launchArgs.includes(portArg);
}

export function desktopEndpointOwner(port, {
  pid, platform = process.platform, invoke = run, procRoot = "/proc",
  readFile = file => fs.readFileSync(file, "utf8"),
  readDirectory = fs.readdirSync, readLink = fs.readlinkSync,
} = {}) {
  validPort(port);
  if (platform === "win32") {
    if (invoke === run && fs.existsSync(nativeProbe)) {
      verifyNativeProbe();
      const result = invoke(nativeProbe, ["endpoint", String(port)]);
      if (result.status === 0 && /^[1-9][0-9]*\s*$/.test(result.stdout)) {
        const owner = Number(result.stdout.trim());
        if (Number.isSafeInteger(owner)) return owner;
      }
    }
    const program = path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "netstat.exe");
    const result = invoke(program, ["-ano", "-p", "tcp"]);
    if (result.status !== 0) throw new Error("Private Desktop endpoint ownership cannot be established.");
    const pattern = new RegExp(`^\\s*TCP\\s+127\\.0\\.0\\.1:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)\\s*$`);
    const owners = [...new Set(result.stdout.split(/\r?\n/).flatMap(line => {
      const match = pattern.exec(line);
      return match ? [Number(match[1])] : [];
    }))];
    if (owners.length !== 1 || !Number.isSafeInteger(owners[0]) || owners[0] <= 0) {
      throw new Error("Private Desktop endpoint ownership is ambiguous.");
    }
    return owners[0];
  }
  validPid(pid);
  if (platform === "linux") {
    const inodes = new Set();
    const hexPort = port.toString(16).toUpperCase().padStart(4, "0");
    for (const line of readFile(`${procRoot}/net/tcp`).split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields[1] === `0100007F:${hexPort}` && fields[3] === "0A" &&
          /^\d+$/.test(fields[9] || "")) inodes.add(fields[9]);
    }
    for (const fd of readDirectory(`${procRoot}/${pid}/fd`)) {
      let link;
      try { link = readLink(`${procRoot}/${pid}/fd/${fd}`); }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      const inode = /^socket:\[(\d+)\]$/.exec(link)?.[1];
      if (inode && inodes.has(inode)) return pid;
    }
    throw new Error("The expected Linux process does not own the private loopback listener.");
  }
  if (platform === "darwin") {
    const result = invoke("/usr/sbin/lsof", ["-nP", "-a", "-p", String(pid),
      `-i4TCP:${port}`, "-sTCP:LISTEN", "-Fpn"]);
    const lines = result.stdout?.split(/\r?\n/) || [];
    if (result.status !== 0 || !lines.includes(`p${pid}`) ||
        lines.filter(line => line.startsWith("p")).some(line => line !== `p${pid}`) ||
        !lines.includes(`n127.0.0.1:${port}`)) {
      throw new Error("The expected macOS process does not own the private loopback listener.");
    }
    return pid;
  }
  throw new Error(`Independent Desktop endpoint inspection is unsupported: ${platform}`);
}
