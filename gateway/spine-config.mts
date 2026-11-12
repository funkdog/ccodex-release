import path from "node:path";
import type { SpineRuntimeOptions } from "./spine/contracts.mjs";
export function validateSpineOptions(value: unknown): SpineRuntimeOptions | undefined {
  if (value === undefined) return undefined;
  const object = (p: unknown, keys: string[]) => {
    if (!p || typeof p !== "object" || Array.isArray(p) || Object.keys(p).some(key => !keys.includes(key))) throw new Error("Invalid Spine runtime configuration.");
    return p as Record<string, unknown>;
  };
  const absolute = (p: unknown) => { if (typeof p !== "string" || !path.isAbsolute(p) || p.length > 4096) throw new Error("Spine paths must be absolute and bounded."); };
  const command = (value: unknown) => {
    const p = object(value, ["executable", "args", "cwd", "timeoutMs", "env"]); absolute(p.executable);
    if (!Array.isArray(p.args) || p.args.length > 64 || p.args.some(arg => typeof arg !== "string" || arg.length > 8192 || arg.includes("\0"))) throw new Error("Invalid Spine command arguments.");
    if (p.cwd !== undefined) absolute(p.cwd);
    if (p.timeoutMs !== undefined && (!Number.isSafeInteger(p.timeoutMs) || (p.timeoutMs as number) < 100 || (p.timeoutMs as number) > 300000)) throw new Error("Invalid Spine task timeout.");
    if (p.env !== undefined && (!p.env || typeof p.env !== "object" || Array.isArray(p.env) || Object.entries(p.env).some(([key, value]) => !/^[A-Z_][A-Z0-9_]{0,63}$/.test(key) || typeof value !== "string" || value.length > 8192))) throw new Error("Invalid Spine command environment.");
  };
  const p = object(value, ["mcp", "shimDirectory", "eventTap", "radar", "daily", "knowledge", "ui"]);
  for (const key of ["mcp", "eventTap"]) if (p[key] !== undefined && typeof p[key] !== "boolean") throw new Error("Invalid Spine boolean option.");
  if (p.shimDirectory !== undefined) absolute(p.shimDirectory);
  if (p.radar !== undefined) {
    const r = object(p.radar, ["schemaFile", "reportFile", "archiveDatabase", "loadCommand", "refreshCommand", "archive"]); absolute(r.schemaFile);
    if ([r.reportFile, r.archiveDatabase, r.loadCommand, r.archive].filter(value => value !== undefined).length !== 1) throw new Error("Configure exactly one radar report source.");
    if (r.reportFile !== undefined) absolute(r.reportFile);
    if (r.archiveDatabase !== undefined) absolute(r.archiveDatabase);
    for (const key of ["loadCommand", "refreshCommand"]) if (r[key] !== undefined) command(r[key]);
    if (r.archive !== undefined) { const a = object(r.archive, ["executable", "script", "dataHome"]); absolute(a.executable); absolute(a.script); if (a.dataHome !== undefined) absolute(a.dataHome); }
  }
  if (p.daily !== undefined) {
    const d = object(p.daily, ["repositories", "timezone", "distillCommand"]);
    if (d.repositories !== undefined) { if (!Array.isArray(d.repositories) || d.repositories.length > 32) throw new Error("Invalid repository list."); d.repositories.forEach(absolute); }
    if (d.timezone !== undefined) { if (typeof d.timezone !== "string") throw new Error("Invalid timezone."); new Intl.DateTimeFormat("en", { timeZone: d.timezone }); }
    if (d.distillCommand !== undefined) command(d.distillCommand);
  }
  if (p.knowledge !== undefined) {
    const k = object(p.knowledge, ["vaultRoot"]); if (k.vaultRoot !== undefined) absolute(k.vaultRoot);
  }
  if (p.ui !== undefined) { const u = object(p.ui, ["rightOffset"]); if (u.rightOffset !== undefined && (!Number.isSafeInteger(u.rightOffset) || (u.rightOffset as number) < 12 || (u.rightOffset as number) > 300)) throw new Error("Invalid UI safe offset."); }
  return p as SpineRuntimeOptions;
}
