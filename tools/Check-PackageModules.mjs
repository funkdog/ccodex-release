import { assertTypeScriptBuild } from "./typescript-state.mjs";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { pathToFileURL } from "node:url";

if (!vm.SourceTextModule) throw new Error("Run with node --experimental-vm-modules.");
const root = fs.realpathSync(process.argv[2] || path.resolve(import.meta.dirname, ".."));
assertTypeScriptBuild(root);
const queue = ["bridge", "tools", "gateway"];
let modules = 0;
let dependencies = 0;
while (queue.length) {
  const relative = queue.pop();
  const directory = path.join(root, relative);
  if (!fs.existsSync(directory)) throw new Error(`Package directory is missing: ${relative}`);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Package module tree contains a link: ${file}`);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") queue.push(path.relative(root, file));
    } else if (entry.name.endsWith(".mjs")) {
      const parsed = new vm.SourceTextModule(fs.readFileSync(file, "utf8"),
        { identifier: pathToFileURL(file).href });
      modules++;
      for (const specifier of parsed.dependencySpecifiers) {
        if (!specifier.startsWith(".")) continue;
        const target = path.resolve(path.dirname(file), specifier);
        const tail = path.relative(root, target);
        if (tail === ".." || tail.startsWith(`..${path.sep}`) || path.isAbsolute(tail) ||
            !fs.existsSync(target) || !fs.statSync(target).isFile()) {
          throw new Error(`Packaged module dependency is missing or outside the payload: ${path.relative(root, file)} -> ${specifier}`);
        }
        dependencies++;
      }
    }
  }
}
process.stdout.write(`${JSON.stringify({ root, modules, relativeImportsVerified: dependencies, evaluatedCode: false })}\n`);
