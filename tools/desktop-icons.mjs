import path from "node:path";
import { spawn } from "node:child_process";
import { windowsSystemEnvironment } from "../bridge/windows-system-environment.mjs";

export function createDesktopIconController({
  root, home, helperToken, assertOwned, log = () => {},
  platform = process.platform, helperPid = process.pid, start = spawn, now = Date.now,
}) {
  let worker = null;
  let closed = false;
  let retryAt = 0;
  return {
    async refresh() {
      if (platform !== "win32" || closed || worker || now() < retryAt) return false;
      await assertOwned();
      if (closed || worker) return false;
      const shell = path.win32.join(process.env.SystemRoot || "C:\\Windows",
        "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const child = start(shell, [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-File",
        path.join(root, "tools", "desktop-icons.ps1"),
        "-Instance", path.join(home, "desktop-instance.json"),
        "-HelperToken", helperToken, "-HelperPid", String(helperPid),
      ], { cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
        env: windowsSystemEnvironment() });
      worker = child;
      child.stdin?.on("error", () => {});
      child.stdout?.on("data", value => log(`Desktop icon: ${String(value).trim()}`));
      child.stderr?.on("data", value => log(`Desktop icon warning: ${String(value).trim()}`));
      const finished = () => {
        if (worker !== child) return;
        worker = null;
        retryAt = now() + 30000;
      };
      child.once("error", error => { log(`Desktop icon worker: ${error.message}`); finished(); });
      child.once("exit", finished);
      return true;
    },
    close() {
      closed = true;
      worker?.stdin?.end("stop\n");
    },
  };
}
