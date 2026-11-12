import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { atomicWrite, paths } from "./settings.mjs";
import { expectedManifest } from "./dependencies.mjs";

function run(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: "inherit", windowsHide: true, ...options });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Work IQ runtime setup failed (${signal || code}).`));
    });
  });
}

function npmCli() {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    ...(process.env.PATH || "").split(path.delimiter).map(directory =>
      path.join(directory, "node_modules", "npm", "bin", "npm-cli.js")),
  ];
  const found = candidates.find(candidate => candidate && candidate.endsWith("npm-cli.js") && fs.existsSync(candidate));
  if (!found) throw new Error("npm was not found. Install Node.js 22+ with npm, then retry.");
  return found;
}

export async function performInstall(profile) {
  const locations = paths(profile);
  const manifest = expectedManifest();
  const packageFile = path.join(locations.runtime, "package.json");
  if (fs.existsSync(packageFile)) {
    const previous = JSON.parse(fs.readFileSync(packageFile, "utf8"));
    if (previous.name !== manifest.name) throw new Error("The Work IQ runtime directory contains another package; it was not overwritten.");
  }
  console.log(`Heavy task PID: ${process.pid}; package: ${manifest.name}; profile: ${locations.home}`);
  atomicWrite(packageFile, `${JSON.stringify(manifest, null, 2)}\n`);
  const lock = path.join(import.meta.dirname, "package-lock.json");
  if (!fs.existsSync(lock)) throw new Error("The pinned Work IQ dependency lock is missing; refusing an unpinned installation.");
  atomicWrite(path.join(locations.runtime, "package-lock.json"), fs.readFileSync(lock, "utf8"));
  await run(process.execPath, [
    npmCli(), "ci", "--prefix", locations.runtime, "--ignore-scripts", "--no-audit", "--no-fund",
    "--fetch-retries=1", "--fetch-timeout=60000",
  ], {
    env: { ...process.env, npm_config_jobs: "6" },
  });
}

export async function installRuntime(profile) {
  const locations = paths(profile);
  const bundled = path.resolve(import.meta.dirname, "..", "..", "runtime", "workiq");
  if (fs.existsSync(path.join(bundled, "package.json"))) {
    const expected = expectedManifest();
    const installed = JSON.parse(fs.readFileSync(path.join(bundled, "package.json"), "utf8"));
    if (installed.name !== expected.name ||
        JSON.stringify(installed.dependencies) !== JSON.stringify(expected.dependencies)) {
      throw new Error("Bundled Work IQ dependency versions do not match the pinned manifest.");
    }
    fs.mkdirSync(locations.runtime, { recursive: true });
    fs.cpSync(bundled, locations.runtime, { recursive: true, force: false });
    return;
  }
  if (process.platform === "win32") {
    const heavyWrapper = path.resolve(import.meta.dirname, "..", "..", "tools", "Invoke-HeavyTask.ps1");
    if (!fs.existsSync(heavyWrapper)) {
      throw new Error(`Heavy-task wrapper is required for runtime installation: ${heavyWrapper}`);
    }
    const quote = value => `'${value.replace(/'/g, "''")}'`;
    const command = `& ${quote(process.execPath)} ${quote(path.join(import.meta.dirname, "setup.mjs"))} --perform-install ${quote(locations.home)}`;
    await run("pwsh.exe", ["-NoLogo", "-NoProfile", "-File", heavyWrapper, command]);
  } else {
    await performInstall(profile);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] !== "--perform-install" || !process.argv[3]) {
    console.error("Use ccodex workiq install.");
    process.exitCode = 2;
  } else {
    performInstall(process.argv[3]).catch(() => {
      console.error("Work IQ runtime installation failed. Review npm's dependency download diagnostics.");
      process.exitCode = 1;
    });
  }
}
