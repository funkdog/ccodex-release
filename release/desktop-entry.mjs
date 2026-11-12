import fs from "node:fs";
import path from "node:path";
import { resolveDesktopMode } from "../bridge/desktop-mode.mjs";
import { runRelease } from "./launch.mjs";
import { boundedJson } from "./paths.mjs";
import { releaseRoot, releaseEnvironment } from "./environment.mjs";
import { spawnSync } from "node:child_process";

const emit = (event, detail = {}) => process.stdout.write(
  JSON.stringify({ guiEvent: event, ...detail }) + "\n");

try {
  const install = boundedJson(path.join(releaseRoot, "release-install.json"));
  const args = process.argv.slice(2).filter(value => value !== "--startup-probe");
  const selection = resolveDesktopMode({ arguments: args, legacyHome: install.profile });
  const env = selection.mode === "app-server-gateway" ? { ...process.env }
    : releaseEnvironment({ home: selection.home, desktopHost: true });
  process.env = { ...env };
  if (process.argv.includes("--startup-probe")) {
    const result = spawnSync(path.join(releaseRoot, "bin", "ccodex-process-probe.exe"),
      ["console", String(process.pid)], { windowsHide: true, encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error("GUI console state could not be verified.");
    }
    const consoleState = JSON.parse(result.stdout);
    if (typeof consoleState.attached !== "boolean" || typeof consoleState.windowVisible !== "boolean") {
      throw new Error("GUI console visibility diagnostic was invalid.");
    }
    emit("diagnostic", { guiNodePid: process.pid, consoleAttached: consoleState.attached,
      consoleWindowVisible: consoleState.windowVisible });
  }
  if (selection.mode === "provider-bridge" && !selection.inspectOnly && !fs.existsSync(path.join(env.CODEX_HOME, "github-auth.json"))) {
    const abort = new AbortController();
    process.stdin.setEncoding("utf8");
    const cancel = data => { if (data.includes("cancel")) abort.abort(); };
    process.stdin.on("data", cancel);
    process.stdin.resume();
    emit("login-required");
    const { signIn } = await import("../bridge/cli.mjs");
    try {
      const result = await signIn({ force: true, signal: abort.signal,
        onProgress: detail => emit("login-code", detail) });
      if (!result || abort.signal.aborted) {
        emit("cancelled");
        process.exitCode = 130;
      }
    } finally {
      process.stdin.off("data", cancel);
      process.stdin.pause();
    }
  }
  if (!process.exitCode) {
    emit("starting");
    process.exitCode = await runRelease(["desktop", ...args], { inherited: env });
    emit("ready");
  }
} catch (error) {
  emit("error", { message: error.message });
  process.exitCode = 1;
}
