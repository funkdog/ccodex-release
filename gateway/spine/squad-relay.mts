import fs from "node:fs";
import path from "node:path";
import { readJson, writeJson } from "./io.mjs";
import { privateDirectory } from "./storage.mjs";
import { parseHostRef, type HostThreadRef } from "./host-thread-contracts.mjs";

export interface SquadBrief {
  dispatchId?: string;
  execution?: { ref: HostThreadRef; turnId: string };
  squadGoal: string;
  task: string;
  exclusions?: string[];
  squadId: string;
  workerId: string;
  issuedAt: number;
}

export interface SquadResult {
  dispatchId?: string;
  squadId: string;
  workerId: string;
  summary: string;
  artifactPath?: string;
  completedAt: number;
  status: "completed" | "failed";
  error?: string;
}

function identity(value: string, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_@-][A-Za-z0-9_.@-]{0,127}$/.test(value) || value.endsWith(".")) {
    throw new Error(`Invalid relay ${label}.`);
  }
  return value;
}

function squadDirectory(dataDir: string, squadId: string): string {
  return path.resolve(dataDir, ".mycodex", "squad-relay", identity(squadId, "squadId"));
}

function dispatchIdentity(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value)) throw new Error("Invalid relay dispatchId.");
  return value;
}
function relayFile(dataDir: string, squadId: string, workerId: string, kind: "brief" | "result", dispatchId?: string): string {
  const suffix = kind === "result" && dispatchId ? `.${dispatchIdentity(dispatchId)}` : "";
  return path.join(squadDirectory(dataDir, squadId), `${identity(workerId, "workerId")}${suffix}.${kind}.json`);
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function parseBrief(value: unknown, squadId: string, workerId: string): SquadBrief {
  const p = record(value);
  if (p.squadId !== squadId || p.workerId !== workerId || typeof p.squadGoal !== "string" || typeof p.task !== "string" ||
      !Number.isSafeInteger(p.issuedAt) || (p.issuedAt as number) < 0 ||
      p.exclusions !== undefined && (!Array.isArray(p.exclusions) || p.exclusions.some(item => typeof item !== "string"))) {
    throw new Error("Invalid relay brief.");
  }
  if (p.dispatchId !== undefined) dispatchIdentity(p.dispatchId);
  if (p.execution !== undefined) {
    const execution = record(p.execution);
    if (parseHostRef(execution.ref).threadId !== workerId || typeof execution.turnId !== "string" || !execution.turnId.length || execution.turnId.length > 128) throw new Error("Invalid relay execution.");
  }
  return p as unknown as SquadBrief;
}

function parseResult(value: unknown, squadId: string, workerId: string): SquadResult {
  const p = record(value);
  if (p.squadId !== squadId || p.workerId !== workerId || typeof p.summary !== "string" ||
      !Number.isSafeInteger(p.completedAt) || (p.completedAt as number) < 0 ||
      p.status !== "completed" && p.status !== "failed" ||
      p.artifactPath !== undefined && typeof p.artifactPath !== "string" || p.error !== undefined && typeof p.error !== "string") {
    throw new Error("Invalid relay result.");
  }
  if (p.dispatchId !== undefined) dispatchIdentity(p.dispatchId);
  return p as unknown as SquadResult;
}

function existingDirectory(directory: string): string | null {
  try {
    fs.lstatSync(directory);
    return privateDirectory(directory, false);
  }
  catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (cause instanceof Error && cause.message === "Spine storage is unavailable." && !fs.existsSync(directory)) return null;
    throw cause;
  }
}

function readRelay<T>(file: string, parse: (value: unknown) => T): T | null {
  if (!existingDirectory(path.dirname(file))) return null;
  try { return parse(readJson(file)); }
  catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw cause;
  }
}

/** Reuse Spine's exclusive temporary file, fsync and atomic rename protocol. */
export async function writeBrief(dataDir: string, brief: SquadBrief): Promise<void> {
  const file = relayFile(dataDir, brief.squadId, brief.workerId, "brief");
  writeJson(file, parseBrief(brief, brief.squadId, brief.workerId));
}

export async function readBrief(dataDir: string, squadId: string, workerId: string): Promise<SquadBrief | null> {
  return readRelay(relayFile(dataDir, squadId, workerId, "brief"), value => parseBrief(value, squadId, workerId));
}

export async function writeResult(dataDir: string, result: SquadResult): Promise<void> {
  const file = relayFile(dataDir, result.squadId, result.workerId, "result", result.dispatchId);
  writeJson(file, parseResult(result, result.squadId, result.workerId));
}

export async function readResult(dataDir: string, squadId: string, workerId: string, dispatchId?: string): Promise<SquadResult | null> {
  return readRelay(relayFile(dataDir, squadId, workerId, "result", dispatchId), value => parseResult(value, squadId, workerId));
}

export async function readAllResults(dataDir: string, squadId: string): Promise<SquadResult[]> {
  const directory = existingDirectory(squadDirectory(dataDir, squadId));
  if (!directory) return [];
  const results: SquadResult[] = [];
  for (const file of fs.readdirSync(directory).sort()) {
    if (!file.endsWith(".result.json")) continue;
    const value = readJson(path.join(directory, file)), p = record(value);
    const result = parseResult(p, squadId, p.workerId as string);
    if (path.basename(relayFile(dataDir, squadId, result.workerId, "result", result.dispatchId)) !== file) throw new Error("Invalid relay result filename.");
    if (result) results.push(result);
  }
  return results;
}

export async function cleanupSquadRelay(dataDir: string, squadId: string): Promise<void> {
  const directory = existingDirectory(squadDirectory(dataDir, squadId));
  if (directory) await fs.promises.rm(directory, { recursive: true, force: true });
}

export async function removeBrief(dataDir: string, squadId: string, workerId: string): Promise<void> {
  const file = relayFile(dataDir, squadId, workerId, "brief");
  if (existingDirectory(path.dirname(file))) await fs.promises.rm(file, { force: true });
}

export async function cleanupWorkerRelay(dataDir: string, squadId: string, workerId: string, dispatchId?: string): Promise<void> {
  const file = relayFile(dataDir, squadId, workerId, "brief");
  if (!existingDirectory(path.dirname(file))) return;
  if (dispatchId) {
    const result = relayFile(dataDir, squadId, workerId, "result", dispatchId);
    await fs.promises.rm(result, { force: true }); await fs.promises.rm(result.replace(/\.result\.json$/, ".artifact.md"), { force: true });
    if ((await readBrief(dataDir, squadId, workerId))?.dispatchId === dispatchId) await fs.promises.rm(file, { force: true });
  } else {
    const prefix = file.slice(0, -"brief.json".length);
    for (const suffix of ["brief.json", "result.json", "artifact.md"]) await fs.promises.rm(prefix + suffix, { force: true });
    for (const name of fs.readdirSync(path.dirname(file))) {
      if (!name.startsWith(workerId + ".")) continue;
      if (/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.(?:result\.json|artifact\.md)$/.test(name.slice(workerId.length + 1)))
        await fs.promises.rm(path.join(path.dirname(file), name), { force: true });
    }
  }
}

export function formatBriefAsText(brief: SquadBrief, dataDir?: string): string {
  const squadId = identity(brief.squadId, "squadId"), workerId = identity(brief.workerId, "workerId");
  const suffix = brief.dispatchId ? `.${dispatchIdentity(brief.dispatchId)}` : "";
  const prefix = (dataDir ? path.join(squadDirectory(dataDir, squadId), workerId) : `.mycodex/squad-relay/${squadId}/${workerId}`) + suffix;
  return `[Squad Goal] ${brief.squadGoal}\n\n[Your Task] ${brief.task}\n\n` +
    `[Boundaries] You are ${workerId}. Do not modify: ${brief.exclusions?.join(", ") || "none"}.\n` +
    `Write your deliverable to:\n  ${prefix}.artifact.md\n` +
    `Write your result summary to:\n  ${prefix}.result.json`;
}
