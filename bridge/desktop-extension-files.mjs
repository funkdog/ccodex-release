import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** Bind update validation to all shipped bridge/tool code, not five UI files. */
export function desktopExtensionFiles(root) {
  const actualRoot = fs.realpathSync(root);
  const files = [];
  function visit(relative) {
    const directory = path.join(root, relative);
    const actual = path.relative(actualRoot, fs.realpathSync(directory));
    if (actual === ".." || actual.startsWith(`..${path.sep}`) || path.isAbsolute(actual) ||
        fs.lstatSync(directory).isSymbolicLink()) {
      throw new Error("Desktop extension source escaped its installation.");
    }
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const child = `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error("Desktop extension source cannot contain links.");
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") visit(child);
      } else if (entry.isFile() && /\.(?:mts|ts|map|mjs|cjs|js|json|ps1|sh|cmd|py|html|swift)$/.test(entry.name)) {
        files.push(child);
      }
    }
  }
  visit("bridge");
  visit("tools");
  if (fs.existsSync(path.join(root, "gateway"))) visit("gateway");
  for (const file of ["package.json", "package-lock.json", "tsconfig.json"]) {
    const target = path.join(root, file);
    if (!fs.existsSync(target)) continue;
    if (!fs.lstatSync(target).isFile() || fs.lstatSync(target).isSymbolicLink()) throw new Error("Invalid TypeScript configuration file.");
    files.push(file);
  }
  return files.sort();
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error("Usage: desktop-extension-files.mjs <installation-root>");
    console.log(JSON.stringify(desktopExtensionFiles(path.resolve(process.argv[2]))));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
