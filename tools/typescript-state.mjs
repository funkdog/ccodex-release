import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export const typescriptManifest = "tools/typescript-build-manifest.json";
const controls = ["package.json", "package-lock.json", "tsconfig.json",
  "tools/typescript-build.mjs", "tools/typescript-task.mjs", "tools/typescript-state.mjs", "tools/typescript-runtime.mjs"];
export const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
function files(root, directory) {
  const result = [];
  if (!fs.existsSync(path.join(root, directory))) return result;
  for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const relative = `${directory}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error(`TypeScript input cannot be linked: ${relative}`);
    if (entry.isDirectory()) result.push(...files(root, relative));
    else if (entry.isFile()) result.push(relative);
  }
  return result;
}
export function typescriptInputs(root) {
  const tree = ["bridge", "gateway"].flatMap(directory => files(root, directory));
  const sources = tree.filter(file => file.endsWith(".mts")).sort();
  const outputs = sources.filter(file => !file.endsWith(".d.mts")).flatMap(file => [file.slice(0, -4) + ".mjs", file.slice(0, -4) + ".mjs.map"]);
  const generated = new Set(outputs);
  const inputs = [...controls, ...tree.filter(file => /\.(?:mts|mjs)$/.test(file) && !generated.has(file) || file.endsWith(".schema.json"))].sort();
  return { sources, outputs, inputs };
}
function digestFile(root, relative) {
  const file = path.join(root, relative), stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Invalid TypeScript file: ${relative}`);
  return sha256(fs.readFileSync(file));
}
export function typeScriptInputState(root) {
  const { sources, inputs } = typescriptInputs(root);
  return { schemaVersion: 1, compiler: JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).devDependencies.typescript,
    sources, inputs: Object.fromEntries(inputs.map(file => [file, digestFile(root, file)])) };
}
export function typeScriptSnapshot(root) {
  const { outputs } = typescriptInputs(root);
  return { ...typeScriptInputState(root), outputs: Object.fromEntries(outputs.map(file => [file, digestFile(root, file)])) };
}
/** Runtime verification needs only Node, including in an offline package.
 * Never repairs, installs dependencies or alters an active app/session. */
export function assertTypeScriptBuild(root) {
  if (!fs.existsSync(path.join(root, "tsconfig.json")) && !typescriptInputs(root).sources.length) return { applicable: false };
  const stale = reason => new Error(`TypeScript build is missing or stale (${reason}). Run npm run build in the source checkout before starting or packaging MyCodex.`);
  try {
    const stat = fs.lstatSync(path.join(root, typescriptManifest));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw stale("manifest");
    const saved = JSON.parse(fs.readFileSync(path.join(root, typescriptManifest), "utf8"));
    const current = typeScriptSnapshot(root);
    if (JSON.stringify(saved) !== JSON.stringify(current)) throw stale("source/config/output fingerprint");
    return { applicable: true, sources: current.sources.length, outputs: Object.keys(current.outputs).length };
  } catch (error) {
    if (error.message.startsWith("TypeScript build")) throw error;
    throw stale(error.code === "ENOENT" ? "missing file" : error.message);
  }
}
