import fs from "node:fs";
import path from "node:path";
import { readJson, writeJson } from "./io.mjs";
import { privateDirectory } from "./storage.mjs";
import type { GoalRecord, WorkItemRecord } from "./work-contracts.mjs";
import { parseGoalRecord, parseWorkItemRecord } from "./work-contracts.mjs";
import { parseGeneralWorkItem } from "./work-context.mjs";
import type { GeneralWorkItemRecord } from "./work-context.mjs";

const validIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/;

function ensureSchema(directory: string, label: string) {
  const schemaFile = path.join(directory, "schema.json");
  let exists = true;
  try {
    fs.lstatSync(schemaFile);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") exists = false;
    else throw cause;
  }
  if (!exists) writeJson(schemaFile, { schemaVersion: 1 });
  const current = readJson(schemaFile, 1024, { privateFile: true }) as { schemaVersion?: number };
  if (current.schemaVersion !== 1) {
    throw new Error(`Incompatible ${label} schema; existing data was preserved.`);
  }
}

export class WorkStore {
  readonly goalsDirectory: string;
  readonly workItemsDirectory: string;

  constructor(home: string) {
    this.goalsDirectory = privateDirectory(path.join(home, "gateway/spine/goals"));
    this.workItemsDirectory = privateDirectory(path.join(home, "gateway/spine/work-items"));
    ensureSchema(this.goalsDirectory, "goals");
    ensureSchema(this.workItemsDirectory, "work-items");
  }

  private goalFile(id: string): string {
    if (!validIdPattern.test(id)) throw new Error(`Invalid goal id "${id}".`);
    return path.join(this.goalsDirectory, `${id}.json`);
  }

  private workItemFile(id: string): string {
    if (!validIdPattern.test(id)) throw new Error(`Invalid WorkItem id "${id}".`);
    return path.join(this.workItemsDirectory, `${id}.json`);
  }

  private generalWorkItemFile(id: string): string {
    if (!validIdPattern.test(id)) throw new Error(`Invalid WorkItem id "${id}".`);
    // Older code-only readers skip the dotted identifier instead of parsing
    // a general record as a Git execution binding during a rollback.
    return path.join(this.workItemsDirectory, `${id}.general.json`);
  }

  getGoal(id: string): GoalRecord | undefined {
    const file = this.goalFile(id);
    try {
      return parseGoalRecord(readJson(file, 256 * 1024, { privateFile: true }), id);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw cause;
    }
  }

  listGoals(): GoalRecord[] {
    const records: GoalRecord[] = [];
    for (const entry of fs.readdirSync(this.goalsDirectory).sort()) {
      if (!entry.endsWith(".json") || entry === "schema.json") continue;
      const id = entry.slice(0, -5);
      if (!validIdPattern.test(id)) continue;
      const goal = this.getGoal(id);
      if (goal) records.push(goal);
    }
    return records.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  }

  saveGoal(record: GoalRecord, expectedRevision: number): GoalRecord {
    const parsed = parseGoalRecord(record, record.id);
    const current = this.getGoal(parsed.id);
    if ((current?.revision ?? 0) !== expectedRevision || parsed.revision !== expectedRevision + 1) {
      throw new Error("Goal revision conflict.");
    }
    writeJson(this.goalFile(parsed.id), parsed);
    return structuredClone(parsed);
  }

  getWorkItem(id: string): WorkItemRecord | undefined {
    const file = this.workItemFile(id);
    try {
      const raw = readJson(file, 512 * 1024, { privateFile: true });
      if (raw && typeof raw === "object" && (raw as { kind?: unknown }).kind === "general") {
        parseGeneralWorkItem(raw, id);
        return undefined; // Legacy code execution sees code bindings only.
      }
      return parseWorkItemRecord(raw, id);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw cause;
    }
  }

  listWorkItems(filter?: { goalId?: string; status?: string }): WorkItemRecord[] {
    const records: WorkItemRecord[] = [];
    for (const entry of fs.readdirSync(this.workItemsDirectory).sort()) {
      if (!entry.endsWith(".json") || entry === "schema.json") continue;
      const id = entry.slice(0, -5);
      if (!validIdPattern.test(id)) continue;
      const item = this.getWorkItem(id);
      if (!item) continue;
      if (filter?.goalId && item.goalId !== filter.goalId) continue;
      if (filter?.status && item.status !== filter.status) continue;
      records.push(item);
    }
    return records.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  }

  saveWorkItem(record: WorkItemRecord, expectedRevision: number): WorkItemRecord {
    const parsed = parseWorkItemRecord(record, record.id);
    if (this.getGeneralWorkItem(parsed.id)) throw new Error("Work kind cannot change to code execution implicitly.");
    const current = this.getWorkItem(parsed.id);
    if ((current?.revision ?? 0) !== expectedRevision || parsed.revision !== expectedRevision + 1) {
      throw new Error("WorkItem revision conflict.");
    }
    writeJson(this.workItemFile(parsed.id), parsed);
    return structuredClone(parsed);
  }

  getGeneralWorkItem(id: string): GeneralWorkItemRecord | undefined {
    const file = this.generalWorkItemFile(id);
    try {
      const raw = readJson(file, 512 * 1024, { privateFile: true });
      return parseGeneralWorkItem(raw, id);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw cause;
    }
  }

  listGeneralWorkItems(filter?: { goalId?: string; status?: string }): GeneralWorkItemRecord[] {
    const records: GeneralWorkItemRecord[] = [];
    for (const entry of fs.readdirSync(this.workItemsDirectory).sort()) {
      if (!entry.endsWith(".general.json")) continue;
      const id = entry.slice(0, -".general.json".length);
      if (!validIdPattern.test(id)) continue;
      const item = this.getGeneralWorkItem(id);
      if (item && (!filter?.goalId || item.goalId === filter.goalId) && (!filter?.status || item.status === filter.status)) records.push(item);
    }
    return records.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  }

  saveGeneralWorkItem(record: GeneralWorkItemRecord, expectedRevision: number): GeneralWorkItemRecord {
    const parsed = parseGeneralWorkItem(record, record.id);
    if (this.getWorkItem(parsed.id)) throw new Error("Work kind cannot change from an existing code binding.");
    const current = this.getGeneralWorkItem(parsed.id);
    if ((current?.revision ?? 0) !== expectedRevision || parsed.revision !== expectedRevision + 1) throw new Error("Work revision conflict.");
    writeJson(this.generalWorkItemFile(parsed.id), parsed);
    return structuredClone(parsed);
  }
}
