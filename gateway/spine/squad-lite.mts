import fs from "node:fs";
import { readJson, writeJson } from "./io.mjs";
import { privateDirectory } from "./storage.mjs";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { parseHostRef, type HostThreadRef } from "./host-thread-contracts.mjs";

export interface SquadLiteRecord {
  id: string;
  anchorThreadId: string;
  label: string;
  goal?: string; status?: "active" | "closed"; maxAutoHops?: number; updatedAt?: number;
  createdAt: number;
  members: Array<{
    threadId: string;
    role: "supervisor" | "worker";
    shortName: string;
    engine: string;
    hostRef?: HostThreadRef; model?: string | null; sidebarHidden?: boolean;
  }>;
}
export interface SquadStore { squads: Record<string, SquadLiteRecord> }

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
function threadId(value: string) {
  if (typeof value !== "string" || !uuid.test(value)) throw new Error("Invalid squad thread ID.");
  return value.toLowerCase();
}
function text(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid squad ${name}.`);
}
function record(store: SquadStore, id: string) {
  if (!Object.hasOwn(store.squads, id)) throw new Error("Squad does not exist.");
  return store.squads[id];
}
/** Validate at the disk boundary; malformed data must never become an empty
 * store that a later save could silently overwrite. No work/spine dependency. */
function validate(value: unknown): asserts value is SquadStore {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid squad store.");
  const store = value as SquadStore;
  if (!store.squads || typeof store.squads !== "object" || Array.isArray(store.squads)) throw new Error("Invalid squads map.");
  const members = new Set<string>();
  for (const [id, squad] of Object.entries(store.squads)) {
    if (!/^sq-[a-f0-9]{8}$/.test(id) || !squad || squad.id !== id ||
        !Number.isFinite(squad.createdAt) || squad.createdAt < 0 || !Array.isArray(squad.members)) throw new Error("Invalid squad record.");
    text(squad.label, "label");
    const anchor = threadId(squad.anchorThreadId);
    if (squad.status !== undefined && !["active", "closed"].includes(squad.status) || squad.maxAutoHops !== undefined && (!Number.isSafeInteger(squad.maxAutoHops) || squad.maxAutoHops < 0 || squad.maxAutoHops > 20)) throw new Error("Invalid squad lifecycle.");
    const handles = new Set<string>();
    let supervisors = 0;
    for (const member of squad.members) {
      if (!member || !["supervisor", "worker"].includes(member.role)) throw new Error("Invalid squad member role.");
      const id = threadId(member.threadId);
      text(member.shortName, "short name"); text(member.engine, "engine");
      if (member.hostRef && parseHostRef(member.hostRef).threadId !== id) throw new Error("Squad native identity mismatch.");
      const handle = member.shortName.toLowerCase();
      if (handles.has(handle)) throw new Error("Duplicate squad handle."); handles.add(handle);
      if (members.has(id) && squad.status !== "closed") throw new Error("Thread already belongs to a squad.");
      if (squad.status !== "closed") members.add(id);
      if (member.role === "supervisor") {
        if (id !== anchor) throw new Error("Only the anchor can be supervisor.");
        supervisors++;
      }
    }
    if (supervisors !== 1) throw new Error("Squad requires its anchor supervisor.");
  }
}

export async function loadSquads(dataDir: string): Promise<SquadStore> {
  if (!fs.existsSync(path.join(dataDir, ".mycodex"))) return { squads: {} };
  let store: unknown;
  try { privateDirectory(path.join(dataDir, ".mycodex"), false); store = readJson(path.join(dataDir, ".mycodex", "squads.json")); }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") return { squads: {} }; throw cause; }
  validate(store); return store;
}

/** Read-only projection of Squad V2 records for sidebar/session readers without mutating V1 store. */
export function loadV2SquadSummaries(dataDir: string): SquadLiteRecord[] {
  const v2Dir = path.join(dataDir, ".mycodex", "squads-v2"), out: SquadLiteRecord[] = [];
  try {
    if (!fs.existsSync(v2Dir) || !fs.lstatSync(v2Dir).isDirectory()) return out;
    privateDirectory(path.join(dataDir, ".mycodex"), false);
    for (const id of fs.readdirSync(v2Dir)) {
      try {
        const v2 = readJson(path.join(v2Dir, id, "state.json"), undefined, { privateFile: true }) as { anchorThreadId?: string; anchorHostRef?: HostThreadRef; status?: "active" | "closed"; state?: { squadId?: string; title?: string; intent?: string; updatedAt?: number }; slots?: Array<{ threadId?: string; handle?: string; engine?: string; model?: string; sidebarHidden?: boolean; hostRef?: HostThreadRef }> };
        if (!v2?.anchorThreadId || !uuid.test(v2.anchorThreadId) || !v2.state?.title) continue;
        const members: SquadLiteRecord["members"] = [{ threadId: v2.anchorThreadId.toLowerCase(), role: "supervisor", shortName: "main", engine: "codex", ...(v2.anchorHostRef ? { hostRef: v2.anchorHostRef } : {}) }];
        for (const slot of v2.slots ?? []) if (slot.threadId && uuid.test(slot.threadId) && slot.handle) {
          members.push({ threadId: slot.threadId.toLowerCase(), role: "worker", shortName: slot.handle, engine: slot.engine || "codex", model: slot.model ?? null, sidebarHidden: slot.sidebarHidden !== false, ...(slot.hostRef ? { hostRef: slot.hostRef } : {}) });
        }
        out.push({ id, anchorThreadId: v2.anchorThreadId.toLowerCase(), label: v2.state.title, ...(v2.state.intent ? { goal: v2.state.intent } : {}), status: v2.status === "closed" ? "closed" : "active", createdAt: v2.state.updatedAt ?? Date.now(), members });
      } catch { /* Ignore partial sidecar files. */ }
    }
  } catch { /* Optional V2 directory. */ }
  return out;
}
export async function saveSquads(dataDir: string, store: SquadStore): Promise<void> {
  validate(store); writeJson(path.join(dataDir, ".mycodex", "squads.json"), store);
}

export function createSquad(store: SquadStore, anchorThreadId: string, label: string, engine: string): SquadLiteRecord {
  const anchor = threadId(anchorThreadId);
  text(label, "label"); text(engine, "engine");
  if (getSquadByThread(store, anchor)) throw new Error("Thread already belongs to a squad.");
  let id: string;
  do { id = "sq-" + randomBytes(4).toString("hex"); } while (Object.hasOwn(store.squads, id));
  const squad: SquadLiteRecord = { id, anchorThreadId: anchor, label, createdAt: Date.now(),
    members: [{ threadId: anchor, role: "supervisor", shortName: "supervisor", engine }] };
  store.squads[id] = squad;
  return squad;
}

export function addMember(store: SquadStore, squadId: string, memberThreadId: string, shortName: string, engine: string): void {
  const squad = record(store, squadId), id = threadId(memberThreadId);
  text(shortName, "short name"); text(engine, "engine");
  if (getSquadByThread(store, id)) throw new Error("Thread already belongs to a squad.");
  if (squad.status === "closed") throw new Error("Squad is closed.");
  if (squad.members.some(m => m.shortName.toLowerCase() === shortName.toLowerCase())) throw new Error("Duplicate squad handle.");
  squad.members.push({ threadId: id, role: "worker", shortName, engine, sidebarHidden: true });
}
export function removeMember(store: SquadStore, squadId: string, memberThreadId: string): void {
  const squad = record(store, squadId), id = threadId(memberThreadId);
  if (squad.anchorThreadId.toLowerCase() === id) throw new Error("Cannot remove the anchor supervisor.");
  squad.members = squad.members.filter(member => member.threadId.toLowerCase() !== id);
}
export function dissolveSquad(store: SquadStore, squadId: string): void { delete store.squads[squadId]; }
export function getSquadByThread(store: SquadStore, memberThreadId: string): SquadLiteRecord | null {
  const id = threadId(memberThreadId);
  return Object.values(store.squads).find(squad => squad.status !== "closed" && squad.members.some(member => member.threadId.toLowerCase() === id)) ?? null;
}
export function getSquadByAnchor(store: SquadStore, anchorThreadId: string): SquadLiteRecord | null {
  const id = threadId(anchorThreadId);
  return Object.values(store.squads).find(squad => squad.status !== "closed" && squad.anchorThreadId.toLowerCase() === id) ?? null;
}
