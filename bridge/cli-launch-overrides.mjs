import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readSetting } from "../tools/config-document.mjs";
import {
  DEFAULT_CONTEXT_SUFFIX,
  LONG_CONTEXT_SUFFIX,
} from "./catalog.mjs";

export function overridesForConfig(text) {
  const configured = readSetting(text, [], "model");
  if (typeof configured !== "string") return null;
  const long = configured.endsWith(LONG_CONTEXT_SUFFIX);
  const standard = configured.endsWith(DEFAULT_CONTEXT_SUFFIX);
  if (!long && !standard) return null;
  const base = configured.slice(
    0,
    -(long ? LONG_CONTEXT_SUFFIX : DEFAULT_CONTEXT_SUFFIX).length,
  );
  // The Windows CMD launcher passes the slug through a FOR /F field. Never
  // print shell metacharacters or an empty/unrecognized model in that channel.
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(base)) {
    throw new Error("Desktop model alias contains an unsafe CLI model slug.");
  }
  return { model: base, serviceTier: long ? "context-long" : "default" };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const home = process.env.CODEX_COPILOT_HOME || path.join(os.homedir(), ".codex-copilot");
    const override = overridesForConfig(
      fs.readFileSync(path.join(home, "ccodex.config.toml"), "utf8"),
    );
    if (override) process.stdout.write(`${override.model}|${override.serviceTier}\n`);
  } catch (error) {
    process.stderr.write(`ccodex CLI defaults: ${error.message}\n`);
    process.exitCode = 1;
  }
}
