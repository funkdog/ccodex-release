import fs from "node:fs";
import path from "node:path";
import { readJson, writeJson } from "./io.mjs";
import { privateDirectory } from "./storage.mjs";
export interface SquadRolePreset { id: string; handle: string; kind: "cli" | "native"; model: string; reasoningEffort?: string | null; defaultPromptPrefix?: string; updatedAt: number }
export interface SquadRoleStore { schemaVersion: 1; roles: SquadRolePreset[] }
export function validateRoles(value: unknown): asserts value is SquadRoleStore {
  const data = value as SquadRoleStore;
  if (data?.schemaVersion !== 1 || !Array.isArray(data.roles) || data.roles.length > 30) throw new Error("Invalid squad roles.");
  const names = new Set<string>(), ids = new Set<string>();
  for (const role of data.roles) {
    if (!/^[a-z0-9_-]{1,60}$/.test(role.id) || typeof role.handle !== "string" || !role.handle.trim() || role.handle.length > 60 || /[@\n\r\0]/.test(role.handle) || role.handle.toLowerCase() === "supervisor" || !["cli", "native"].includes(role.kind) || typeof role.model !== "string" || !role.model || role.model.length > 512 || !Number.isFinite(role.updatedAt) || role.defaultPromptPrefix !== undefined && (typeof role.defaultPromptPrefix !== "string" || role.defaultPromptPrefix.length > 4000) || role.reasoningEffort != null && (typeof role.reasoningEffort !== "string" || role.reasoningEffort.length > 60)) throw new Error("Invalid squad role.");
    const name = role.handle.toLowerCase(); if (names.has(name) || ids.has(role.id)) throw new Error("Duplicate squad role."); names.add(name); ids.add(role.id);
  }
}
export function readRoles(home: string): SquadRoleStore {
  const directory = path.join(home, ".mycodex");
  if (!fs.existsSync(directory)) return { schemaVersion: 1, roles: [] };
  try { privateDirectory(directory, false); const data = readJson(path.join(directory, "squad-roles.json"), undefined, { privateFile: true }); validateRoles(data); return data; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: 1, roles: [] }; throw error; }
}
export function saveRoles(home: string, store: SquadRoleStore) { validateRoles(store); writeJson(path.join(home, ".mycodex", "squad-roles.json"), store); }
