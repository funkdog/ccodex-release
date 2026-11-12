import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";

export async function createInventory(root, { concurrency = 6, onProgress = () => {} } = {}) {
  const files = [];
  const forbidden = /^(?:github-auth\.json|auth\.json|msal\.cache\.dpapi.*|history\.jsonl|session_index\.jsonl|installation_id|cap_sid)$/i;
  const text = /\.(?:json|jsonl|toml|env|md|mjs|cjs|js|ps1|cmd|py|sh|txt|yaml|yml|cs|cpp|c|h|def|html)$/i;
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      const relative = path.relative(root, file).replaceAll("\\", "/");
      if (entry.isSymbolicLink()) throw new Error(`Release cannot contain links: ${relative}`);
      if (entry.isDirectory()) {
        if ([".git", "sessions", "login-sessions", "desktop-data"].includes(entry.name)) {
          throw new Error(`Private state directory: ${relative}`);
        }
        walk(file);
      } else if (entry.isFile()) {
        if (forbidden.test(entry.name) || /\.(?:sqlite(?:-shm|-wal)?|dpapi|log|lnk)$/i.test(entry.name)) {
          throw new Error(`Private runtime state in package: ${relative}`);
        }
        if (["release.json", "release-files.json", "release-install.json"].includes(relative)) continue;
        const stat = fs.statSync(file);
        const tests = relative.startsWith("tests/");
        files.push({
          path: relative, file, size: stat.size,
          scan: !tests && stat.size < 48 * 1024 * 1024 && text.test(entry.name),
          firstParty: !tests && !relative.startsWith("desktop/") && !relative.startsWith("runtime/") &&
            !relative.includes("references/"),
        });
      }
    }
  }
  walk(root);
  onProgress({ discovered: files.length, completed: 0 });
  const queue = [];
  for (let index = 0; index < files.length; index += 96) queue.push(files.slice(index, index + 96));
  const results = [];
  const workers = [];
  let completed = 0;
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, () =>
      new Promise((resolve, reject) => {
        const worker = new Worker(new URL("./inventory-worker.mjs", import.meta.url));
        workers.push(worker);
        const next = () => {
          const batch = queue.pop();
          if (!batch) { resolve(); return; }
          worker.postMessage(batch);
        };
        worker.on("error", reject);
        worker.on("message", message => {
          if (message.error) { reject(new Error(message.error)); return; }
          results.push(...message.results);
          completed += message.results.length;
          onProgress({ discovered: files.length, completed });
          next();
        });
        next();
      })));
    return results.sort((left, right) => left.path.localeCompare(right.path));
  } finally { await Promise.all(workers.map(worker => worker.terminate())); }
}

export async function verifyInventory(root, entries, { concurrency = 6, onProgress = () => {} } = {}) {
  const { assertRegularPath } = await import("./paths.mjs");
  assertRegularPath(root, { allowMissing: false });
  root = path.resolve(root);
  const checkedDirectories = new Set([root]);
  const checkDirectory = directory => {
    if (checkedDirectories.has(directory)) return;
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error("Resource directory escaped the release root.");
    checkDirectory(parent);
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("Release resources cannot traverse junctions or non-directories.");
    }
    checkedDirectories.add(directory);
  };
  const names = new Set();
  const files = entries.map(entry => {
    if (typeof entry.path !== "string" || path.isAbsolute(entry.path) ||
        /^[\\/]|^[A-Z]:/i.test(entry.path) ||
        entry.path.split(/[\\/]/).some(part => !part || part === "." || part === "..") ||
        names.has(entry.path.toLowerCase()) ||
        !Number.isSafeInteger(entry.size) || entry.size < 0 ||
        !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw new Error("The resource inventory contains an invalid or duplicate path.");
    }
    names.add(entry.path.toLowerCase());
    const file = path.resolve(root, entry.path);
    const directory = path.dirname(file);
    checkDirectory(directory);
    return { ...entry, file, expectedSha256: entry.sha256, scan: false };
  });
  const queue = [];
  for (let index = 0; index < files.length; index += 96) queue.push(files.slice(index, index + 96));
  const workers = [];
  let completed = 0;
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, () =>
      new Promise((resolve, reject) => {
        const worker = new Worker(new URL("./inventory-worker.mjs", import.meta.url));
        workers.push(worker);
        const next = () => {
          const batch = queue.pop();
          if (!batch) { resolve(); return; }
          worker.postMessage(batch);
        };
        worker.on("error", reject);
        worker.on("message", message => {
          if (message.error) { reject(new Error(message.error)); return; }
          completed += message.results.length;
          onProgress(completed, files.length);
          next();
        });
        next();
      })));
    return {
      checkedFiles: completed,
      checkedBytes: entries.reduce((sum, entry) => sum + entry.size, 0),
    };
  } finally { await Promise.all(workers.map(worker => worker.terminate())); }
}
