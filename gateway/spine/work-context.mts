import type { WorkItemStatus } from "./work-contracts.mjs";

export interface WorkContextEntry {
  id: string;
  kind: "agreement" | "material" | "result";
  title: string;
  summary: string;
  state: "candidate" | "adopted" | "reference" | "superseded";
  reference: string | null;
}

/** A planning/discussion record carries no implicit execution authorization. */
export interface GeneralWorkItemRecord {
  schemaVersion: 1;
  kind: "general";
  id: string;
  revision: number;
  goalId: string;
  title: string;
  userIntent: string;
  outcome: string;
  status: WorkItemStatus;
  owner: string;
  progress: string;
  nextStep: { kind: "discussion" | "action"; description: string; owner: string } | null;
  decision: string | null;
  expectedOutput: string | null;
  doneCriteria: string[];
  openQuestions: string[];
  context: WorkContextEntry[];
  supervisorThreadId: string | null;
  changeNote: string | null;
  createdAt: string;
  updatedAt: string;
}

export function workText(value: unknown, field: string, limit = 4096, empty = false): string {
  if (typeof value !== "string" || value.includes("\0") || value.length > limit || (!empty && !value.trim())) {
    throw new Error(`Invalid ${field}: expected bounded text.`);
  }
  return value.trim();
}

export function workId(value: unknown, field: string): string {
  const result = workText(value, field, 96);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(result)) throw new Error(`Invalid ${field}.`);
  return result;
}

function list(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > 32) throw new Error(`Invalid ${field}.`);
  return value.map(entry => workText(entry, field, 1024));
}

function nullableText(value: unknown, field: string, limit = 4096): string | null {
  return value == null ? null : workText(value, field, limit);
}

export function parseGeneralWorkItem(value: unknown, expectedId?: string): GeneralWorkItemRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid general work record.");
  if (Buffer.byteLength(JSON.stringify(value)) > 64 * 1024) throw new Error("General work record exceeds its context budget.");
  const raw = value as Record<string, unknown>;
  const id = workId(raw.id, "work.id");
  if (expectedId && expectedId !== id) throw new Error("Work identity mismatch.");
  if (raw.schemaVersion !== 1 || raw.kind !== "general" || !Number.isSafeInteger(raw.revision) || Number(raw.revision) < 1) {
    throw new Error("Invalid general work schema or revision.");
  }
  // Repository bindings are a separate code-work contract, never dummy values.
  for (const key of ["workspace", "repository", "handoff", "squad", "responsibleHostRef", "policy"]) {
    if (Object.hasOwn(raw, key)) throw new Error(`General work cannot declare ${key}; code execution requires a code work binding.`);
  }
  const status = raw.status as WorkItemStatus;
  if (!["draft", "ready", "in_progress", "ready_for_acceptance", "needs_attention", "done", "paused"].includes(status)) {
    throw new Error("Invalid general work status.");
  }
  let nextStep: GeneralWorkItemRecord["nextStep"] = null;
  if (raw.nextStep != null) {
    if (typeof raw.nextStep !== "object" || Array.isArray(raw.nextStep)) throw new Error("Invalid nextStep.");
    const next = raw.nextStep as Record<string, unknown>;
    if (next.kind !== "discussion" && next.kind !== "action") throw new Error("Invalid nextStep.kind.");
    nextStep = { kind: next.kind, description: workText(next.description, "nextStep.description"), owner: workText(next.owner, "nextStep.owner", 256) };
  }
  if (!Array.isArray(raw.context) || raw.context.length > 32) throw new Error("Invalid work.context.");
  const seen = new Set<string>();
  const context: WorkContextEntry[] = raw.context.map(value => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid context entry.");
    const entry = value as Record<string, unknown>;
    const id = workId(entry.id, "context.id");
    if (seen.has(id)) throw new Error("Duplicate context identity.");
    seen.add(id);
    if (entry.kind !== "agreement" && entry.kind !== "material" && entry.kind !== "result") throw new Error("Invalid context.kind.");
    if (entry.state !== "candidate" && entry.state !== "adopted" && entry.state !== "reference" && entry.state !== "superseded") throw new Error("Invalid context.state.");
    const reference = nullableText(entry.reference, "context.reference", 1024);
    if (entry.state === "adopted" && !reference) throw new Error("Adopted context requires a source reference.");
    return { id, kind: entry.kind, title: workText(entry.title, "context.title", 256), summary: workText(entry.summary, "context.summary", 2048), state: entry.state, reference };
  });
  const expectedOutput = nullableText(raw.expectedOutput, "expectedOutput");
  const doneCriteria = list(raw.doneCriteria, "doneCriteria");
  if (["ready", "in_progress", "ready_for_acceptance", "done"].includes(status) && (!expectedOutput || !doneCriteria.length)) {
    throw new Error("Actionable work requires an expected output and acceptance criteria.");
  }
  if (["ready", "in_progress"].includes(status) && !nextStep) throw new Error("Actionable work requires a next step and owner.");
  const createdAt = workText(raw.createdAt, "createdAt", 64), updatedAt = workText(raw.updatedAt, "updatedAt", 64);
  if (!Number.isFinite(Date.parse(createdAt)) || !Number.isFinite(Date.parse(updatedAt))) throw new Error("Invalid work timestamps.");
  return {
    schemaVersion: 1, kind: "general", id, revision: Number(raw.revision), goalId: workId(raw.goalId, "work.goalId"),
    title: workText(raw.title, "work.title", 256), userIntent: workText(raw.userIntent, "work.userIntent"),
    outcome: workText(raw.outcome ?? "", "work.outcome", 4096, true), status,
    owner: workText(raw.owner ?? "", "work.owner", 256, true), progress: workText(raw.progress ?? "", "work.progress", 4096, true),
    nextStep, decision: nullableText(raw.decision, "decision"), expectedOutput, doneCriteria,
    openQuestions: list(raw.openQuestions, "openQuestions"), context,
    supervisorThreadId: nullableText(raw.supervisorThreadId, "supervisorThreadId", 128),
    changeNote: nullableText(raw.changeNote, "changeNote"), createdAt, updatedAt,
  };
}
