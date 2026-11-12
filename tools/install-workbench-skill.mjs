import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { readRoutingConnection } from "../gateway/routed-stdio.mjs";

const root = path.resolve(import.meta.dirname, ".."), hash = text => createHash("sha256").update(text).digest("hex");
const marker = ".mycodex-workbench-install.json";
function regular(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) throw new Error("Invalid skill installation file.");
  return fs.readFileSync(file, "utf8");
}
/** Canonical instructions stay in the package. This owned output binds one
 * explicit private gateway, without copying credentials or changing config. */
export function installWorkbenchSkill(connectionFile, destination = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "skills", "mycodex-workbench")) {
  const config = readRoutingConnection(connectionFile);
  if (!config.spine?.mcp) throw new Error("The selected gateway has not enabled work access.");
  const quote = value => `'${value.replaceAll("'", process.platform === "win32" ? "''" : "'\\''")}'`;
  const command = `${process.platform === "win32" ? "& " : ""}${[process.execPath, path.join(root, "gateway/spine/work-cli.mjs"), connectionFile].map(quote).join(" ")}`;
  const skill = regular(path.join(root, "skills/mycodex-workbench/SKILL.md")).replace("MYCODEX_WORKBENCH_COMMAND", command);
  destination = path.resolve(destination);
  if (fs.existsSync(destination)) {
    const stat = fs.lstatSync(destination);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Skill destination must be an owned directory.");
    let previous;
    try { previous = JSON.parse(regular(path.join(destination, marker))); } catch { throw new Error("Existing skill is not an owned MyCodex installation; preserved."); }
    if (previous.product !== "MyCodexWorkbenchSkill" || previous.skillHash !== hash(regular(path.join(destination, "SKILL.md")))) throw new Error("Installed skill has local edits; preserved.");
    const extras = fs.readdirSync(destination).filter(file => ![marker, "SKILL.md"].includes(file));
    if (extras.length) throw new Error("Installed skill contains unrelated files; preserved.");
    // Keep an identical binding untouched. Changing instances is an explicit
    // installation and still requires ownership of the previous generated copy.
    if (regular(path.join(destination, "SKILL.md")) === skill) return { installed: true, changed: false, destination };
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const stage = path.join(path.dirname(destination), `.mycodex-workbench-${randomUUID()}`);
  fs.mkdirSync(stage, { mode: 0o700 });
  try {
    fs.writeFileSync(path.join(stage, "SKILL.md"), skill, { flag: "wx", mode: 0o600 });
    fs.writeFileSync(path.join(stage, marker), JSON.stringify({ product: "MyCodexWorkbenchSkill", schemaVersion: 1, skillHash: hash(skill) }) + "\n", { flag: "wx", mode: 0o600 });
    if (fs.existsSync(destination)) {
      // Do not replace a non-empty directory in place. Retain the old owned
      // output for rollback until the prepared replacement has been promoted.
      const backup = `${stage}.previous`;
      fs.renameSync(destination, backup);
      try { fs.renameSync(stage, destination); } catch (cause) { fs.renameSync(backup, destination); throw cause; }
      fs.rmSync(backup, { recursive: true });
    } else fs.renameSync(stage, destination);
    return { installed: true, changed: true, destination };
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length < 3 || process.argv.length > 4) throw new Error("Usage: install-workbench-skill.mjs <private connection file> [skill directory]");
    console.log(JSON.stringify(installWorkbenchSkill(process.argv[2], process.argv[3])));
  } catch { console.error("Workbench skill was not installed: check the private connection and destination ownership; existing files were preserved."); process.exitCode = 1; }
}
