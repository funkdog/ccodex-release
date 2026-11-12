import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { typescriptInputs, typeScriptInputState, typeScriptSnapshot, typescriptManifest, assertTypeScriptBuild, sha256 } from "./typescript-state.mjs";

const root = path.resolve(import.meta.dirname, "..");
function compiler(args) {
  if (!process.env.CODEX_COPILOT_HEAVY_LOCK_HELD && !process.env.CCODEX_RELEASE_HEAVY_TASK) throw new Error("Use npm run build/typecheck (the repository heavy-task wrapper owns the lock).");
  const entry = path.join(root, "node_modules/typescript/lib/tsc.js");
  if (!fs.existsSync(entry)) throw new Error("Install the pinned development dependencies with npm ci first.");
  const wanted = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).devDependencies.typescript;
  const installed = JSON.parse(fs.readFileSync(path.join(root, "node_modules/typescript/package.json"), "utf8")).version;
  if (installed !== wanted) throw new Error("Compiler version differs from the lockfile. Run npm ci.");
  const result = spawnSync(process.execPath, [entry, "--project", path.join(root, "tsconfig.json"), "--pretty", "false", ...args], { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`TypeScript failed (${result.status}); previous runtime output was preserved.`);
}
export function typecheck() { compiler([]); }
export function build() {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "mycodex-ts-"));
  try {
    const { outputs } = typescriptInputs(root);
    const manifestFile = path.join(root, typescriptManifest);
    const previous = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, "utf8")) : null;
    const retired = Object.entries(previous?.outputs ?? {}).filter(([file]) => !outputs.includes(file));
    for (const [file, hash] of retired) {
      if (!/^(?:gateway|bridge)\/(?!.*(?:^|\/)\.\.(?:\/|$)).+\.mjs(?:\.map)?$/.test(file)) throw new Error("Invalid retired TypeScript output path.");
      if (fs.existsSync(path.join(root, file)) && sha256(fs.readFileSync(path.join(root, file))) !== hash) throw new Error(`Retired output has local edits; preserve it before rebuilding: ${file}`);
    }
    const inputsBefore = JSON.stringify(typeScriptInputState(root), (key, value) => retired.some(([file]) => file === key) ? undefined : value);
    const unchanged = () => JSON.stringify(typeScriptInputState(root), (key, value) => retired.some(([file]) => file === key) ? undefined : value) === inputsBefore;
    // Emit to a private stage; allowJs is for legacy inference only. Copy only
    // canonical TS outputs, never rewrite the imported legacy JS modules.
    compiler(["--noEmit", "false", "--rootDir", root, "--outDir", stage, "--sourceMap", "--inlineSources"]);
    if (!unchanged()) throw new Error("TypeScript inputs changed during compilation; rebuild before starting.");
    for (const relative of outputs) {
      const output = path.join(stage, relative);
      if (relative.endsWith(".map")) {
        const map = JSON.parse(fs.readFileSync(output, "utf8"));
        map.sources = [path.basename(relative).replace(/\.mjs\.map$/, ".mts")];
        map.sourceRoot = "";
        fs.writeFileSync(output, JSON.stringify(map));
      }
      const destination = path.join(root, relative), pendingOutput = `${destination}.typescript.tmp`;
      try { fs.copyFileSync(output, pendingOutput); fs.renameSync(pendingOutput, destination); }
      finally { fs.rmSync(pendingOutput, { force: true }); }
    }
    for (const [file] of retired) fs.rmSync(path.join(root, file), { force: true });
    const manifest = path.join(root, typescriptManifest), pending = `${manifest}.tmp`;
    const snapshot = typeScriptSnapshot(root);
    if (!unchanged()) throw new Error("TypeScript inputs changed during output promotion; rebuild before starting.");
    fs.writeFileSync(pending, JSON.stringify(snapshot) + "\n");
    fs.renameSync(pending, manifest);
    console.log(JSON.stringify(assertTypeScriptBuild(root)));
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try {
    if (!process.env.CODEX_COPILOT_HEAVY_LOCK_HELD && !process.env.CCODEX_RELEASE_HEAVY_TASK) throw new Error("Use npm run build/typecheck (the repository heavy-task wrapper owns the lock).");
    if (process.argv[2] === "typecheck") typecheck(); else if (process.argv[2] === "build") build(); else throw new Error("Expected build or typecheck.");
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
