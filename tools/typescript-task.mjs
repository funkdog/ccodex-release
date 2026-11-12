import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { assertTypeScriptBuild } from "./typescript-state.mjs";
const root = path.resolve(import.meta.dirname, ".."), mode = process.argv[2];
const tests = ["spine-sources", "desktop-acceptance", "gateway-media", "spine-p2", "spine-p2-ui", "spine-native-tap", "spine-compressor", "spine-registry", "spine-mcp", "spine-drawer", "desktop-protected-start", "gateway-session-management", "session-contract", "typescript-build", "antigravity", "gemini-cli", "google-provider", "desktop-mode", "desktop-native-session", "desktop-cli-selector", "gateway-engines", "gateway-router", "gateway-protocol", "gateway-routed-stdio", "gateway-backend-stage", "copilot-provider", "copilot-provider-native", "desktop-current-host", "desktop-shortcut", "desktop-extension-files", "source-publication", "desktop-launch", "desktop-process"].map(name => `tests/${name}-test.mjs`);
tests.push("tests/desktop-status-test.mjs");
tests.push("tests/desktop-upgrade-continuity-test.mjs");
tests.push("tests/desktop-host-draft-test.mjs");
tests.push("tests/spine-p3-isolation-test.mjs", "tests/spine-p3-host-test.mjs");
tests.push("tests/spine-p3-dispatch-test.mjs");
tests.push("tests/spine-p3-work-squad-test.mjs");
tests.push("tests/spine-shared-work-test.mjs");
tests.push("tests/spine-work-cli-test.mjs");
tests.push("tests/claude-api-test.mjs");
tests.push("tests/claude-native-test.mjs");
tests.push("tests/desktop-host-cache-test.mjs");
tests.push("tests/adapters-only-test.mjs", "tests/configure-adapters-test.mjs", "tests/adapter-connection-test.mjs", "tests/package-adapters-test.mjs", "tests/execution-picker-browser-test.mjs");
const adapterTests = ["adapters-only", "configure-adapters", "adapter-connection", "package-adapters", "typescript-build", "source-publication",
  "desktop-mode", "desktop-native-session", "execution-picker-browser", "desktop-cli-selector", "desktop-host-cache", "desktop-host-draft", "desktop-current-host",
  "desktop-shortcut", "desktop-process", "desktop-protected-start", "desktop-status", "desktop-upgrade-continuity", "desktop-extension-files", "desktop-launch",
  "gateway-media", "gateway-session-management", "session-contract", "gateway-engines", "gateway-router", "gateway-protocol", "gateway-routed-stdio", "gateway-backend-stage",
  "antigravity", "gemini-cli", "claude-api", "claude-native", "copilot-provider", "copilot-provider-native"].map(name => `tests/${name}-test.mjs`);
function heavy(args) {
  let program, command;
  if (process.platform === "win32") {
    const quote = value => `'${value.replaceAll("'", "''")}'`;
    program = "powershell.exe";
    command = ["-NoProfile", "-File", path.join(root, "tools/Invoke-HeavyTask.ps1"), `& ${[process.execPath, ...args].map(quote).join(" ")}`];
  } else { program = "bash"; command = [path.join(root, "tools/Invoke-HeavyTask.sh"), process.execPath, ...args]; }
  return new Promise((resolve, reject) => {
    const child = spawn(program, command, { cwd: root, stdio: "inherit" });
    child.once("error", reject); child.once("exit", code => code === 0 ? resolve() : reject(new Error(`Task failed (${code}).`)));
  });
}
async function run() {
  if (mode === "check") { console.log(JSON.stringify(assertTypeScriptBuild(root))); return; }
  if (mode === "build" || mode === "typecheck") { await heavy(["tools/typescript-build.mjs", mode]); return; }
  if (mode === "test") { await heavy(["tools/typescript-build.mjs", "build"]); await heavy(["--test", "--test-concurrency=6", ...tests]); await heavy(["--experimental-vm-modules", "tools/Check-PackageModules.mjs"]); return; }
  if (mode === "test-adapters") { await heavy(["tools/typescript-build.mjs", "build"]); await heavy(["--test", "--test-concurrency=2", ...adapterTests]); await heavy(["--experimental-vm-modules", "tools/Check-PackageModules.mjs"]); return; }
  if (mode !== "watch") throw new Error("Expected build, typecheck, watch, test or check.");
  // Release the global lock between rebuilds. A persistent compiler watch
  // must not monopolize it and block another authorized build/test task.
  let pending = true, running = false, timer;
  const rebuild = async () => {
    if (running) { pending = true; return; }
    running = true;
    do { pending = false; try { await heavy(["tools/typescript-build.mjs", "build"]); } catch (error) { console.error(error.message); } } while (pending);
    running = false;
  };
  const watchers = ["bridge", "gateway", "tests/types", "tools"].filter(dir => fs.existsSync(path.join(root, dir))).map(dir => fs.watch(path.join(root, dir), { recursive: true }, (_event, file) => {
    if (!file || !/\.(?:mts|mjs)$/.test(file) && !file.endsWith(".schema.json")) return;
    if (file.endsWith(".mjs") && fs.existsSync(path.join(root, dir, file.replace(/\.mjs$/, ".mts")))) return;
    clearTimeout(timer); timer = setTimeout(rebuild, 150);
  }));
  const control = fs.watch(root, (_event, file) => { if (["package.json", "package-lock.json", "tsconfig.json"].includes(file)) { clearTimeout(timer); timer = setTimeout(rebuild, 150); } });
  const stop = () => { clearTimeout(timer); control.close(); for (const watcher of watchers) watcher.close(); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  await rebuild();
}
run().catch(error => { console.error(error.message); process.exitCode = 1; });
