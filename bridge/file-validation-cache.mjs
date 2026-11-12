import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

let active = null;
const normalize = value => process.platform === "win32" ? value.toLowerCase() : value;
const contained = (root, file) => normalize(file).startsWith(normalize(root) + path.sep);

function regular(file) {
  let current = path.resolve(file);
  while (current) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
      throw new Error("Validation paths cannot traverse a symbolic link or junction.");
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const stat = fs.lstatSync(file, { bigint: true });
  if (!stat.isFile()) throw new Error("Validation requires a regular file.");
  return stat;
}

export function fileSignature(file) {
  const stat = regular(file);
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.birthtimeNs].join(":");
}

export function rawFileSha256(file) {
  const hash = createHash("sha256");
  const handle = fs.openSync(file, "r");
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    for (;;) {
      const count = fs.readSync(handle, buffer, 0, buffer.length, null);
      if (!count) return hash.digest("hex");
      hash.update(buffer.subarray(0, count));
    }
  } finally { fs.closeSync(handle); }
}

export class FileValidationCache {
  constructor({ root, home, generation, persist = true }) {
    this.root = path.resolve(root);
    this.home = path.resolve(home);
    if (!generation || typeof generation !== "string") throw new Error("Validation generation is required.");
    this.generation = generation;
    this.file = path.join(this.home, "startup-validation.json");
    this.entries = {};
    this.changed = false;
    this.persist = persist;
    this.hits = 0;
    this.hashes = 0;
    if (!fs.existsSync(this.file)) return;
    const stat = regular(this.file);
    if (stat.size > 1024n * 1024n) throw new Error("Startup validation metadata exceeds its bound.");
    let saved;
    try { saved = JSON.parse(fs.readFileSync(this.file, "utf8")); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      this.changed = true;
      return;
    }
    if (saved?.schemaVersion === 1 && saved.generation === generation &&
        typeof saved.root === "string" && typeof saved.home === "string" &&
        normalize(saved.root) === normalize(this.root) &&
        normalize(saved.home) === normalize(this.home) &&
        saved.entries && typeof saved.entries === "object" &&
        !Array.isArray(saved.entries) && Object.keys(saved.entries).length <= 512) {
      this.entries = saved.entries;
    } else { this.changed = true; }
  }

  sha256(file) {
    const absolute = path.resolve(file);
    if (!contained(this.root, absolute) && !contained(this.home, absolute)) {
      return rawFileSha256(absolute);
    }
    const signature = fileSignature(absolute);
    const key = normalize(absolute);
    const saved = Object.hasOwn(this.entries, key) ? this.entries[key] : null;
    if (saved?.signature === signature && /^[a-f0-9]{64}$/.test(saved.sha256 || "")) {
      this.hits++;
      return saved.sha256;
    }
    const sha256 = rawFileSha256(absolute);
    if (fileSignature(absolute) !== signature) {
      throw new Error("A verified resource changed while it was being hashed.");
    }
    this.entries[key] = { signature, sha256 };
    this.hashes++;
    this.changed = true;
    return sha256;
  }

  flush() {
    if (!this.persist || !this.changed) return;
    if (fs.existsSync(this.file)) regular(this.file);
    const owner = path.join(this.home, ".ccodex-release-profile.json");
    const developerOwner = path.join(this.root, ".ccodex-dev-install.json");
    let owned = false;
    if (fs.existsSync(owner)) {
      regular(owner);
      owned = JSON.parse(fs.readFileSync(owner, "utf8")).product === "CCodexRelease";
    }
    if (!owned && fs.existsSync(developerOwner)) {
      regular(developerOwner);
      const developer = JSON.parse(fs.readFileSync(developerOwner, "utf8"));
      owned = developer.product === "CcodexDeveloper" &&
        normalize(developer.profile || "") === normalize(this.home);
    }
    if (!owned) {
      throw new Error("Startup validation cannot write to an unowned profile.");
    }
    const pending = `${this.file}.${randomUUID()}.pending`;
    fs.writeFileSync(pending, JSON.stringify({
      schemaVersion: 1, root: this.root, home: this.home, generation: this.generation,
      entries: this.entries,
    }) + "\n", { flag: "wx", mode: 0o600 });
    try { fs.renameSync(pending, this.file); }
    finally { if (fs.existsSync(pending)) fs.unlinkSync(pending); }
    this.changed = false;
  }
}

export function validatedFileSha256(file) {
  return active ? active.sha256(file) : rawFileSha256(file);
}

export async function withFileValidation(cache, operation) {
  if (active && active !== cache) throw new Error("Concurrent profile validation is not supported.");
  const previous = active;
  active = cache;
  try { return await operation(); }
  finally {
    active = previous;
    cache.flush();
  }
}
