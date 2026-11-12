import fs from "node:fs";
import { parentPort } from "node:worker_threads";
import { sha256File } from "./integrity.mjs";

const secretPattern = /\b(?:gh[oup]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{24,})\b/;

parentPort.on("message", batch => {
  try {
    const results = batch.map(entry => {
      const stat = fs.lstatSync(entry.file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Not a regular resource: ${entry.path}`);
      if (entry.size !== stat.size) throw new Error(`Resource changed during inventory: ${entry.path}`);
      if (entry.scan) {
        const contents = fs.readFileSync(entry.file, "utf8");
        if (secretPattern.test(contents)) throw new Error(`Potential credential: ${entry.path}`);
        if (entry.firstParty && /(?:[A-Z]:[\\/]+Users[\\/]+[a-z0-9_. -]+|[A-Z]:\\\\Users\\\\[a-z0-9_. -]+)\b/i.test(contents)) {
          throw new Error(`Machine-specific path in release code: ${entry.path}`);
        }
      }
      const sha256 = sha256File(entry.file);
      if (entry.expectedSha256 && sha256 !== entry.expectedSha256) {
        throw new Error(`Resource checksum changed: ${entry.path}`);
      }
      return { path: entry.path, size: stat.size, sha256 };
    });
    parentPort.postMessage({ results });
  } catch (error) { parentPort.postMessage({ error: error.message }); }
});
