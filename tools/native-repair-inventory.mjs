import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { desktopExtensionFiles } from "../bridge/desktop-extension-files.mjs";

export function nativeRepairInventory(root) {
  const declared = JSON.parse(fs.readFileSync(path.join(root, "tools", "native-repair-files.json"), "utf8"));
  assert(Array.isArray(declared), "Native repair inventory must be an array.");
  const files = new Set([...declared, ...desktopExtensionFiles(root)]);
  for (const relative of files) {
    assert(typeof relative === "string" && relative &&
      !path.isAbsolute(relative) && !/^[A-Za-z]:/.test(relative) &&
      relative.split(/[\\/]/).every(part => part && part !== "." && part !== ".."),
    "Native repair inventory escaped its source.");
    const file = path.join(root, relative);
    const stat = fs.lstatSync(file);
    assert(stat.isFile() && !stat.isSymbolicLink(), `Repair input is not a regular file: ${relative}`);
  }
  return [...files].sort();
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    assert.equal(process.argv.length, 3, "Usage: native-repair-inventory.mjs <source-root>");
    console.log(JSON.stringify(nativeRepairInventory(path.resolve(process.argv[2]))));
  } catch (error) {
    console.error(`Complete native repair inventory rejected: ${error.message}`);
    process.exitCode = 1;
  }
}
