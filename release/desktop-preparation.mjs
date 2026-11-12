import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { readSetting } from "../tools/config-document.mjs";
import { atomicWrite } from "../bridge/workiq/settings.mjs";
import { boundedJson, assertRegularPath } from "./paths.mjs";
import { verifyDesktopBackend } from "./desktop-preflight.mjs";

function binding(root, home, runtime) {
  const config = fs.readFileSync(assertRegularPath(path.join(home, "config.toml")), "utf8");
  const metadata = boundedJson(path.join(root, "release.json"));
  const values = [
    root, home, metadata.releaseId, runtime.manifest.version,
    readSetting(config, ["mcp_servers","node_repl"], "command"),
    readSetting(config, ["marketplaces","openai-primary-runtime"], "source"),
    readSetting(config, ["marketplaces","openai-bundled"], "source_type"),
    readSetting(config, [], "cli_auth_credentials_store"),
  ];
  return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}

export async function prepareDesktopState({
  root, home, runtime, env, verify = verifyDesktopBackend,
}) {
  const file = assertRegularPath(path.join(home, "desktop-preparation.json"));
  const generation = binding(root, home, runtime);
  let previous;
  try { previous = boundedJson(file, 16384); }
  catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  const state = path.join(home, "state_5.sqlite");
  if (previous?.schemaVersion === 1 && previous.binding === generation &&
      previous.stateQueryVerified === true && fs.existsSync(state)) {
    assertRegularPath(state, { allowMissing: false });
    return { sqliteReady: true, profileVerified: true, stateQueryVerified: true,
      modelRequestsSent: false };
  }
  const result = await verify({ root, home, runtime, env });
  atomicWrite(file, JSON.stringify({
    schemaVersion: 1, binding: generation, stateQueryVerified: true,
    preparedAt: new Date().toISOString(),
  }) + "\n");
  return result;
}
