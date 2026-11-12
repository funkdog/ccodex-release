import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { releaseRoot } from "./environment.mjs";
import { verifyFileManifest } from "./verify.mjs";
import { assertRegularPath } from "./paths.mjs";

const output = path.resolve(process.argv[2] || path.join(process.cwd(), "ccodex-release-resources.zip"));
if (!output.toLowerCase().endsWith(".zip")) throw new Error("Export destination must be a ZIP file.");
assertRegularPath(output);
if (fs.existsSync(output)) throw new Error("Export destination already exists; choose another file.");
await verifyFileManifest(releaseRoot);
const inventory = JSON.parse(fs.readFileSync(path.join(releaseRoot, "release-files.json"), "utf8"));
const files = ["release.json", "release-files.json", ...inventory.files.map(item => item.path)];
fs.mkdirSync(path.dirname(output), { recursive: true });
const listFile = path.join(path.dirname(output), `.ccodex-export-${process.pid}.json`);
fs.writeFileSync(listFile, JSON.stringify(files), { flag: "wx" });
const python = path.join(releaseRoot, "runtime", "primary", "codex-primary-runtime",
  "dependencies", "python", "python.exe");
try {
  const result = spawnSync(python, [path.join(releaseRoot, "release", "export.py"),
    releaseRoot, output, listFile], { stdio: "inherit", windowsHide: true, timeout: 1200000 });
  if (result.error || result.status !== 0) throw result.error || new Error("Resource export failed.");
  console.log(`Credential-free release resources exported: ${output}`);
  console.log("Extract and run install.cmd. Installed credentials and profile data are not exported.");
} finally { fs.unlinkSync(listFile); }
