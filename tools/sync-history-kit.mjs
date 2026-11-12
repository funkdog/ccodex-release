import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const HISTORY_KIT_FILES = Object.freeze([
  "manager.mjs", "backends.mjs", "server.mjs", "cli.mjs", "ui.html",
  "desktop.cmd", "desktop.sh",
]);

export function syncHistoryKit({
  source = path.resolve(import.meta.dirname, "../../copilot-cli-enhancements/history"),
  destination = path.join(import.meta.dirname, "history"),
} = {}) {
  source = fs.realpathSync(source);
  assert(fs.lstatSync(source).isDirectory() && !fs.lstatSync(source).isSymbolicLink());
  fs.mkdirSync(destination, { recursive: true });
  const actual = fs.realpathSync(destination);
  assert.equal(actual, path.resolve(destination), "History kit destination cannot be linked.");
  const files = [];
  for (const name of HISTORY_KIT_FILES) {
    const input = path.join(source, name);
    assert(fs.lstatSync(input).isFile() && !fs.lstatSync(input).isSymbolicLink(), "History kit requires regular source files.");
    const output = path.join(actual, name);
    if (fs.existsSync(output)) assert(!fs.lstatSync(output).isSymbolicLink(), "History kit output cannot be linked.");
    fs.copyFileSync(input, output);
    const sha256 = createHash("sha256").update(fs.readFileSync(input)).digest("hex");
    assert.equal(createHash("sha256").update(fs.readFileSync(output)).digest("hex"), sha256);
    files.push({ name, sha256 });
  }
  return { source, destination: actual, files };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.log(JSON.stringify(syncHistoryKit(), null, 2));
}
