import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { assertRegularPath } from "./paths.mjs";

export function nativeAdapterCommand(root, executable, args = []) {
  root = path.resolve(root);
  executable = assertRegularPath(path.resolve(executable), { allowMissing: false });
  const relative = path.relative(root, executable);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative) || ![
        "ChatGPT.exe", "codex.exe", "codex-copilot-core.exe",
      ].includes(path.basename(executable))) {
    throw new Error("The native adapter accepts only this release's contained executables.");
  }
  const adapter = assertRegularPath(path.join(root, "bin", "ccodex-release-native.exe"),
    { allowMissing: false });
  const dll = assertRegularPath(path.join(path.dirname(executable), "ccodex-release-host.dll"),
    { allowMissing: false });
  if (!fs.statSync(adapter).isFile() || !fs.statSync(dll).isFile()) {
    throw new Error("The private native adapter is unavailable; no system fallback was used.");
  }
  return { file: adapter, args: [executable, ...args] };
}

export async function startReleaseDesktop(root, executable, args, options) {
  const command = nativeAdapterCommand(root, executable, args);
  const result = spawnSync(command.file, ["--launch", ...command.args], {
    env: options.env, cwd: options.cwd, windowsHide: true,
    encoding: "utf8", timeout: 30000, maxBuffer: 64 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw result.error || new Error(result.stderr?.trim() || "The private Desktop adapter failed.");
  }
  const receipt = JSON.parse(result.stdout);
  if (!Number.isSafeInteger(receipt.pid) || receipt.pid <= 0) {
    throw new Error("The private Desktop adapter did not return an owned process.");
  }
  return { pid: receipt.pid };
}
