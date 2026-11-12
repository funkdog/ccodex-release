import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function bridgeSourceGeneration(root = import.meta.dirname) {
  const hash = createHash("sha256");
  const visit = (directory, relative = "") => {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory() && entry.name !== "node_modules") visit(file, name);
      else if (entry.isFile() && /\.(?:mjs|cjs|json)$/.test(entry.name)) {
        hash.update(name).update("\0").update(fs.readFileSync(file)).update("\0");
      }
    }
  };
  visit(root);
  return hash.digest("hex");
}

export function requireBridgeGeneration(health, expectedGeneration) {
  if (health?.runtime?.sourceGeneration !== expectedGeneration) {
    throw new Error(
      `Bridge PID ${health?.pid || "unknown"} is running older or different code. ` +
      "No running task was stopped. Once existing tasks are idle, run `ccodex bridge stop` " +
      "followed by `ccodex bridge` to load the installed repair; reopening Desktop alone is not enough.",
    );
  }
}
