import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { assertPrivateDesktopHome, desktopSnapshot, desktopStateRoot } from "./desktop-runtime.mjs";
import { promoteDesktopUpdate } from "./update-state.mjs";
import { desktopExtensionFiles } from "./desktop-extension-files.mjs";

const quote = value => `'${value.replaceAll("'", "''")}'`;

function metadata(root, file) {
  const actualRoot = fs.realpathSync(root);
  const actual = fs.realpathSync(file);
  const tail = path.relative(actualRoot, actual);
  const stat = fs.lstatSync(file);
  if (tail === ".." || tail.startsWith(`..${path.sep}`) || path.isAbsolute(tail) ||
      stat.isSymbolicLink() || !stat.isFile() || stat.size > 1024 * 1024) {
    throw new Error("Desktop update metadata must be a bounded private regular file.");
  }
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

function heavy(root, script, args) {
  const command = `& ${quote(path.join(root, "tools", script))} -InstallRoot ${quote(root)} ${args}`;
  const result = spawnSync("pwsh.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-File",
    path.join(root, "tools", "Invoke-HeavyTask.ps1"), command],
  { cwd: root, stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${script} failed; inspect the private update receipt and logs.`);
}

function unixHeavy(root, home, action, candidate) {
  const script = path.join(root, "tools", "desktop-unix-update.mjs");
  const args = [path.join(root, "tools", "Invoke-HeavyTask.sh"),
    process.execPath, script, action, "--install-root", root, "--home", home];
  if (candidate) args.push("--candidate", candidate);
  const result = spawnSync("bash", args, {
    cwd: root, stdio: "inherit", env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("Private Unix Desktop update failed; inspect its receipt.");
}

export async function desktopUpdateCommand({
  root = path.resolve(import.meta.dirname, ".."),
  home = process.env.CODEX_COPILOT_HOME || path.join(os.homedir(), ".codex-copilot"),
  platform = process.platform,
  args = [],
  runHeavy = heavy,
  runUnixHeavy = unixHeavy,
  assertOwned = () => {},
  output = value => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`),
} = {}) {
  const action = args[0] || "status";
  home = assertPrivateDesktopHome(home);
  if (fs.existsSync(path.join(root, "release.json")) &&
      !["status", "check", "--check"].includes(action)) {
    throw new Error("This team release is immutable. Update Desktop and its dependencies through a verified CCodex Release setup package.");
  }
  const stateRoot = desktopStateRoot({ root, home, platform });
  const currentFile = path.join(stateRoot, "desktop", "current.json");
  if (action === "status") {
    const selected = fs.existsSync(currentFile) ? metadata(stateRoot, currentFile) : null;
    output({
      schemaVersion: 1, surface: "copilot-desktop",
      selectedSnapshot: selected?.version || null,
      runtimeStateRoot: stateRoot,
      originalInstallationOwned: false,
      commands: ["desktop update check", "desktop update prepare",
        "desktop update validate <candidate>", "desktop update apply <validation.json>"],
    });
    return;
  }
  if (action === "check" || action === "--check") {
    if (platform === "win32") runHeavy(root, "Prepare-DesktopUpdate.ps1", "-CheckOnly");
    else runUnixHeavy(root, home, "check");
    return;
  }
  if (action === "prepare") {
    if (args.length > 1) throw new Error("Prepare downloads only the trusted official package endpoint.");
    if (platform === "win32") runHeavy(root, "Prepare-DesktopUpdate.ps1", "");
    else runUnixHeavy(root, home, "prepare");
    return;
  }
  if (action === "validate") {
    const candidate = args[1];
    if (!/^[\d.]+-[a-f0-9]{12}$/.test(candidate || "") || args.length !== 2) {
      throw new Error("Use desktop update validate <private-snapshot-version>.");
    }
    desktopSnapshot(root, { version: candidate, stateRoot, platform });
    const report = path.join(stateRoot, "desktop", "validation", candidate);
    if (platform === "win32") runHeavy(root, "Validate-DesktopUpdate.ps1",
      `-Candidate ${quote(candidate)} -ReportDirectory ${quote(report)}`);
    else runUnixHeavy(root, home, "validate", candidate);
    return;
  }
  if (action === "apply") {
    if (!args[1] || args.length !== 2) throw new Error("Use desktop update apply <private-validation.json>.");
    const file = path.resolve(args[1]);
    const validation = metadata(path.join(stateRoot, "desktop", "validation"), file);
    desktopSnapshot(root, { version: validation.candidate, stateRoot, platform });
    const result = await promoteDesktopUpdate({
      root: stateRoot, sourceRoot: root, candidate: validation.candidate,
      extensionFiles: desktopExtensionFiles(root),
      validate: async () => validation,
      preparedReceipt: validation.preparedReceipt,
      assertOwned,
    });
    output(result);
    return result;
  }
  throw new Error(`Unknown Desktop update action: ${action}`);
}

const evaluating = process.execArgv.some(value => ["-e", "--eval", "-p", "--print"].includes(value));
if (!evaluating && process.argv[1] &&
    import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { await desktopUpdateCommand({ args: process.argv.slice(2) }); }
  catch (error) {
    process.stderr.write(`Codex (Copilot) Desktop update: ${error.message}\n`);
    process.exitCode = 1;
  }
}
