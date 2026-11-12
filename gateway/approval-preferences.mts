import "../tools/typescript-runtime.mjs";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ApprovalMode } from "./contracts.mjs";

const modes: ApprovalMode[] = ["ask", "read-only", "auto", "deny"];
const key = /^[a-z][a-z0-9-]{0,63}$/;
type Preferences = { schemaVersion: 1; engines: Record<string, { adapter: string; mode: ApprovalMode }> };

/** Explicit UI choices only, owned by the instance gateway. Conversation reads
 * and native approval envelopes must never become authorization evidence. */
export class ApprovalPreferences {
  private file: string;
  private value: Preferences;
  constructor(home: string) {
    this.file = path.join(home, "gateway", "cli-approval-defaults.json");
    this.value = this.read();
  }
  private read(): Preferences {
    let stat: fs.Stats;
    try { stat = fs.lstatSync(this.file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: 1, engines: {} }; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536 ||
        (process.platform !== "win32" && (stat.uid !== process.getuid!() || (stat.mode & 0o077))))
      throw new Error("CLI approval preferences must be private owned regular storage.");
    const value = JSON.parse(fs.readFileSync(this.file, "utf8")) as Preferences;
    if (value?.schemaVersion !== 1 || !value.engines || typeof value.engines !== "object" || Array.isArray(value.engines) ||
        Object.keys(value).some(k => !["schemaVersion", "engines"].includes(k)) || Object.keys(value.engines).length > 64 ||
        Object.entries(value.engines).some(([id, entry]) => !key.test(id) || !entry || !key.test(entry.adapter) || !modes.includes(entry.mode) ||
          Object.keys(entry).some(k => !["adapter", "mode"].includes(k)))) throw new Error("Invalid CLI approval preferences.");
    return value;
  }
  get(engineId: string, adapter: string, supported: ApprovalMode[], initial: ApprovalMode = "ask"): ApprovalMode {
    const saved = this.value.engines[engineId];
    return saved?.adapter === adapter && supported.includes(saved.mode) ? saved.mode : supported.includes(initial) ? initial : "ask";
  }
  set(engineId: string, adapter: string, mode: ApprovalMode) {
    if (!key.test(engineId) || !key.test(adapter) || !modes.includes(mode)) throw new Error("Invalid CLI approval preference.");
    this.read(); // Revalidate storage before replacing it; never follow a link.
    const next: Preferences = { schemaVersion: 1, engines: { ...this.value.engines, [engineId]: { adapter, mode } } };
    const bytes = JSON.stringify(next) + "\n";
    if (Object.keys(next.engines).length > 64 || Buffer.byteLength(bytes) > 65536) throw new Error("CLI approval preference limit reached.");
    const pending = `${this.file}.${randomUUID()}.pending`;
    const fd = fs.openSync(pending, "wx", 0o600);
    try {
      try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(pending, this.file);
      const directory = fs.openSync(path.dirname(this.file), "r");
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
      this.value = next;
    } finally { fs.rmSync(pending, { force: true }); }
  }
}
