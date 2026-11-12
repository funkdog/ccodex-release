import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { paths } from "./settings.mjs";

export async function runtimeImport(specifier, profile) {
  const directory = paths(profile).runtime;
  try {
    const require = createRequire(path.join(directory, "package.json"));
    return await import(pathToFileURL(require.resolve(specifier)).href);
  } catch (error) {
    throw new Error(`Work IQ runtime dependency '${specifier}' is unavailable. Run 'ccodex workiq install'.`, { cause: error });
  }
}

export function expectedManifest() {
  return JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "package.json"), "utf8"));
}
