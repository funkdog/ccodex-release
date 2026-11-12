import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const revision = fs.readFileSync(path.join(root, "CODEX-SOURCE-REVISION"), "utf8").trim();
if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error("Invalid Codex source revision.");
process.stdout.write(revision);
