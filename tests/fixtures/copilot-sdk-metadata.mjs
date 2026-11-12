import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function syntheticCopilotMetadata(packageRoot, home, models) {
  assert.ok(Array.isArray(models) && models.length > 0);
  const source = `
export class RuntimeConnection {
  static forStdio(options) { return options; }
}
export class CopilotClient {
  async start() {}
  async listModels() { return ${JSON.stringify(models)}; }
  async stop() {}
  async forceStop() {}
}
`;
  const sdkPath = path.join(home, "synthetic-copilot-sdk.mjs");
  fs.writeFileSync(sdkPath, source);
  const bundled = path.join(packageRoot, "runtime", "copilot", "node_modules",
    "@github", `copilot-${process.platform}-${process.arch}`, "copilot-sdk", "index.js");
  const nodeArguments = [];
  if (fs.existsSync(bundled)) {
    // Only the optional metadata SDK is synthetic. The packaged bridge,
    // transport, authentication API and pinned native cores remain untouched.
    const hook = path.join(home, "synthetic-copilot-metadata-hook.mjs");
    fs.writeFileSync(hook, `
import { registerHooks } from "node:module";
registerHooks({
  load(url, context, nextLoad) {
    if (url === ${JSON.stringify(pathToFileURL(bundled).href)}) {
      return { format: "module", shortCircuit: true, source: ${JSON.stringify(source)} };
    }
    return nextLoad(url, context);
  }
});
`);
    nodeArguments.push("--import", pathToFileURL(hook).href);
  }
  return { sdkPath, nodeArguments };
}
