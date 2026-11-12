import fs from "node:fs";
import path from "node:path";

/** Read the existing archive without running its initialization/migration code.
 * No database is created here. This small adapter owns the external SQLite
 * layout assumption; report contents still pass the original report schema. */
export async function readRadarArchive(file: string): Promise<unknown | null> {
  if (!path.isAbsolute(file)) throw new Error("Radar archive must be an absolute regular file.");
  const resolved = path.resolve(file), stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(resolved) !== resolved || stat.size > 512 * 1024 * 1024) throw new Error("Radar archive must be a bounded regular file without links.");
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(resolved, { readOnly: true, timeout: 500, enableDoubleQuotedStringLiterals: false });
  try {
    database.exec("PRAGMA query_only=ON");
    const row = database.prepare("SELECT id, length(CAST(payload AS BLOB)) AS bytes FROM reports ORDER BY report_date DESC, revision DESC LIMIT 1").get();
    if (!row) return null;
    if (typeof row.id !== "string" || row.id.length > 128 || typeof row.bytes !== "number" || row.bytes > 2 * 1024 * 1024) throw new Error("Radar report exceeds the source read budget.");
    const payload = database.prepare("SELECT payload FROM reports WHERE id=? AND length(CAST(payload AS BLOB)) <= ?").get(row.id, 2 * 1024 * 1024)?.payload;
    if (typeof payload !== "string") throw new Error("Radar archive report changed or is invalid.");
    return JSON.parse(payload) as unknown;
  } finally { database.close(); }
}
