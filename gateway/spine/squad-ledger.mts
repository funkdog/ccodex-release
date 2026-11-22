import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readJson, writeJson } from "./io.mjs";
import { privateDirectory } from "./storage.mjs";
import type { SquadLiteRecord } from "./squad-lite.mjs";
export type LedgerEntryKind = "assign" | "handoff" | "review" | "blocked" | "note" | "system_fallback";
export interface SquadLedgerEntry {
  seq: number; entryId: string; createdAt: number; authorThreadId: string; authorHandle: string; authorEngine: string;
  kind: LedgerEntryKind; summary: string; nextHandle: string | null; files?: string[]; verification?: string | null;
  verdict?: "approved" | "changes_requested" | "commented" | null;
  dispatchTurnId?: string | null;
}
export interface LedgerDelivery { seq: number; workerId: string; requestId: string; state: "queued" | "paused" | "sending" | "sent" | "failed"; turnId?: string; error?: string }
export interface SquadLedger { schemaVersion: 1; squadId: string; entries: SquadLedgerEntry[]; deliveries: LedgerDelivery[]; autoHopsUsed: number; hopPausedForHuman: boolean; ballInCourt: string | null; totalEntries?: number }
export function ledgerPath(home: string, id: string) {
  if (!/^sq-[a-f0-9]{8}$/.test(id)) throw new Error("Invalid squad ID.");
  return path.join(home, ".mycodex", "squad-relay", id, "ledger.json");
}
export function readLedger(home: string, id: string): SquadLedger {
  const file = ledgerPath(home, id);
  let data: SquadLedger;
  try { privateDirectory(path.dirname(file), false); data = readJson(file, 2 * 1024 * 1024, { privateFile: true }) as SquadLedger; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || !fs.existsSync(path.dirname(file))) return { schemaVersion: 1, squadId: id, entries: [], deliveries: [], autoHopsUsed: 0, hopPausedForHuman: false, ballInCourt: null };
    throw error;
  }
  const bounded = (v: unknown, max: number) => typeof v === "string" && v.length <= max && !v.includes("\0");
  if (data?.schemaVersion !== 1 || data.squadId !== id || !Array.isArray(data.entries) || !Array.isArray(data.deliveries) || !Number.isSafeInteger(data.autoHopsUsed) || data.autoHopsUsed < 0 || typeof data.hopPausedForHuman !== "boolean" || data.ballInCourt !== null && !bounded(data.ballInCourt, 60) ||
      data.entries.some((e, i) => !e || e.seq !== i + 1 || !bounded(e.summary, 4000) || !e.summary.trim() || !bounded(e.entryId, 128) || !e.entryId || !Number.isSafeInteger(e.createdAt) || e.createdAt < 0 || !bounded(e.authorThreadId, 36) || !bounded(e.authorHandle, 60) || !bounded(e.authorEngine, 512) || !["assign", "handoff", "review", "blocked", "note", "system_fallback"].includes(e.kind) || e.nextHandle !== null && !bounded(e.nextHandle, 60) || e.files !== undefined && (!Array.isArray(e.files) || e.files.length > 50 || e.files.some(f => !bounded(f, 512))) || e.verification != null && !bounded(e.verification, 4000) || e.verdict != null && (e.kind !== "review" || !["approved", "changes_requested", "commented"].includes(e.verdict))) ||
      new Set(data.entries.map(e => e.entryId)).size !== data.entries.length || data.deliveries.some(d => !d || !Number.isSafeInteger(d.seq) || d.seq < 1 || d.seq > data.entries.length || !bounded(d.workerId, 36) || !bounded(d.requestId, 128) || !["queued", "paused", "sending", "sent", "failed"].includes(d.state))) throw new Error("Invalid squad ledger.");
  return data;
}
export function renderIssue(record: SquadLiteRecord, ledger: SquadLedger) {
  return `# [${record.id}] ${record.label}\n\n- **主会话**: codex://threads/${record.anchorThreadId}\n- **当前状态**: ${record.status ?? "active"} · **当前接棒**: @${ledger.ballInCourt ?? "无"} · **自动接力计数**: ${ledger.autoHopsUsed}/${record.maxAutoHops ?? 3}${ledger.hopPausedForHuman ? " · ⚠ 待人工放行" : ""}\n- **小队目标**: ${record.goal ?? record.label}\n- **成员名册**:\n` + record.members.map(m => `  - @${m.shortName} · ${m.engine}${m.model ? " · " + m.model : ""} · codex://threads/${m.threadId}`).join("\n") + "\n\n---\n\n" + ledger.entries.map(e => `### #${e.seq} · ${new Date(e.createdAt).toISOString()} · [${e.kind}] @${e.authorHandle} ──► ${e.nextHandle ? "@" + e.nextHandle : "仅留档"}\n${e.summary}\n${e.verdict ? "- **评审结论**: " + e.verdict + "\n" : ""}${e.files?.length ? "- **涉及文件/依据**: " + e.files.map(f => "`" + f.replaceAll("`", "") + "`").join(", ") + "\n" : ""}${e.verification ? "- **验证与缺口**: " + e.verification + "\n" : ""}- **来源会话**: codex://threads/${e.authorThreadId}\n`).join("\n");
}
/** ledger.json is the transaction truth; ISSUE.md is a repairable projection. */
export function saveLedger(home: string, record: SquadLiteRecord, ledger: SquadLedger) {
  const file = ledgerPath(home, record.id); writeJson(file, ledger);
  const issue = path.join(path.dirname(file), "ISSUE.md"), pending = issue + "." + randomUUID() + ".pending";
  if (fs.existsSync(issue) && !fs.lstatSync(issue).isFile()) throw new Error("Unsafe ISSUE.md.");
  const fd = fs.openSync(pending, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, renderIssue(record, ledger)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.renameSync(pending, issue); const directoryFd = fs.openSync(path.dirname(issue), fs.constants.O_RDONLY); try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); } } finally { if (fs.existsSync(pending)) fs.unlinkSync(pending); }
}
