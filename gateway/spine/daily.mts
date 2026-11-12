import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import type { StoredThread } from "../contracts.mjs";
import type { DailyOptions } from "./contracts.mjs";
import type { SpineRegistry } from "./registry.mjs";
import type { TraceStore } from "./trace.mjs";
import type { KnowledgeService, CardCandidate } from "./knowledge.mjs";
import { redact, runCommand, writeJson } from "./io.mjs";
import { privateDirectory } from "./storage.mjs";
export interface Handoff { threadId: string; repository: string; engine: string; title: string; status: string; updatedAt: number; today: boolean }
export interface DailyDigest { date: string; timezone: string; handoff: Handoff[]; markdown: string; cards: CardCandidate[]; coverage: { cli: number; native: number; repositories: number; degraded: string[] }; refreshedAt: number }
export function dayRange(date: string, timezone: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(date).toISOString().slice(0, 10) !== date) throw new Error("Invalid digest date.");
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const midnight = (utc: number) => {
    let epoch = utc;
    for (let i = 0; i < 4; i++) {
      const p = Object.fromEntries(parts.formatToParts(new Date(epoch)).map(value => [value.type, value.value]));
      const wall = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
      const next = epoch + utc - wall; if (next === epoch) break; epoch = next;
    }
    return epoch;
  };
  const target = Date.parse(date + "T00:00:00Z"); return { start: midnight(target), end: midnight(target + 86400000) };
}
export class DailyService {
  private directory: string; private cache: DailyDigest | null = null; private pending: Promise<DailyDigest> | null = null;
  private job: { id: string; state: string; error?: string } | null = null;
  private registry: SpineRegistry; private threads: () => StoredThread[]; private trace: TraceStore; private knowledge: KnowledgeService; private options: DailyOptions; private clock: () => number;
  private changed: () => void;
  constructor(home: string, registry: SpineRegistry, threads: () => StoredThread[], trace: TraceStore, knowledge: KnowledgeService, options: DailyOptions = {}, clock = () => Date.now(), changed = () => {}) {
    this.changed = changed;
    this.registry = registry; this.threads = threads; this.trace = trace; this.knowledge = knowledge; this.options = options; this.clock = clock;
    this.directory = privateDirectory(path.join(home, "gateway/spine/daily"));
  }
  private date() { return new Intl.DateTimeFormat("en-CA", { timeZone: this.options.timezone ?? "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(this.clock())); }
  async digest(params: Record<string, unknown> = {}) {
    if (Object.keys(params).some(key => key !== "date") || params.date !== undefined && typeof params.date !== "string") throw new Error("Invalid daily query.");
    const date = params.date as string ?? this.date(); dayRange(date, this.options.timezone ?? "Asia/Shanghai");
    if (this.cache?.date === date && this.clock() - this.cache.refreshedAt < 60000) return this.cache;
    if (!this.pending) this.pending = this.build(date).finally(() => { this.pending = null; });
    const result = await this.pending; return result.date === date ? result : this.build(date);
  }
  private async build(date: string): Promise<DailyDigest> {
    const timezone = this.options.timezone ?? "Asia/Shanghai", { start, end } = dayRange(date, timezone);
    const cli = this.threads().filter(thread => !thread.archived), native = this.trace.list().filter(thread => !thread.archived && !thread.deleted);
    const handoff: Handoff[] = [
      ...cli.map(thread => ({ threadId: thread.id, repository: path.basename(thread.cwd) || "工作区", engine: thread.engineId, title: redact(thread.name || thread.preview || "CLI 聊天"), status: thread.turns.at(-1)?.status ?? "unknown", updatedAt: thread.updatedAt * 1000, today: thread.updatedAt * 1000 >= start && thread.updatedAt * 1000 < end })),
      ...native.map(thread => ({ threadId: thread.threadId, repository: path.basename(thread.cwd) || "工作区", engine: thread.engine, title: redact(thread.title || thread.intent || "Codex 聊天"), status: thread.status, updatedAt: thread.updatedAt, today: thread.updatedAt >= start && thread.updatedAt < end })),
    ].filter(thread => thread.updatedAt >= start - 7 * 86400000 && thread.updatedAt < end).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 100).map(row => ({ ...row, title: row.title.slice(0, 300) }));
    const degraded = ["原生轨迹仅覆盖 Event Tap 启用后的生命周期，未采集逐 token 正文；未归档不等于任务尚未完成。"];
    const git: { repository: string; repositoryId: string; branch: string; commits: string[]; changes: number }[] = [];
    for (const repo of this.options.repositories ?? []) {
      try {
        const command = (args: string[]) => runCommand({ executable: process.platform === "win32" ? "" : "/usr/bin/git", args: ["--no-optional-locks", "-C", repo, ...args], timeoutMs: 10000 });
        const commits = (await command(["log", "--max-count=100", `--since=${new Date(start).toISOString()}`, `--until=${new Date(end - 1).toISOString()}`, "--format=%H %s"])).trim().split("\n").filter(Boolean).map(redact);
        let branch: string; try { branch = (await command(["symbolic-ref", "--short", "HEAD"])).trim(); } catch { branch = "detached"; }
        const status = await command(["status", "--porcelain=v1", "-z"]);
        git.push({ repository: path.basename(repo), repositoryId: createHash("sha256").update(path.resolve(repo)).digest("hex").slice(0, 16), branch: redact(branch), commits, changes: status.split("\0").filter(Boolean).length });
      } catch { degraded.push(`仓库 ${path.basename(repo)} 的只读 Git 元数据不可用。`); }
    }
    const clean = (value: string) => redact(value).replace(/(?:\/Users|\/home)\/[^\s/]+/g, "[本机用户]").replace(/[\r\n]/g, " ");
    const lines = [`# 团队日报 · ${date}`, "", "以下是活动证据摘要，任务完成与认知结论需复核。", ""];
    for (const repository of [...new Set([...handoff.filter(row => row.today).map(row => row.repository), ...git.map(row => row.repository)])]) {
      lines.push(`## ${clean(repository)}`);
      for (const row of handoff.filter(row => row.repository === repository && row.today)) lines.push(`- ${["failed", "interrupted"].includes(row.status) ? "风险/阻塞" : row.status === "completed" ? "已完成回复" : "进行中/待确认"}：${clean(row.title)}（${clean(row.engine)}）`);
      for (const repo of git.filter(row => row.repository === repository)) { lines.push(`- 分支：${clean(repo.branch)}；工作区变更条目 ${repo.changes}。`); lines.push(...repo.commits.map(commit => `- Git：${clean(commit.replace(/^([a-f0-9]{7})[a-f0-9]{33} /, "$1 "))}`)); }
      lines.push("");
    }
    let cards = handoff.filter(row => row.today).slice(0, 8).map(row => {
      const original = cli.find(thread => thread.id === row.threadId);
      const text = original?.turns.at(-1)?.items?.filter(item => item.type === "agentMessage").map(item => item.type === "agentMessage" ? item.text : "").join("\n").slice(0, 3000) ?? "";
      const fence = "~".repeat(Math.max(3, ...[...text.matchAll(/~+/g)].map(match => match[0].length + 1)));
      const quote = text ? `\n\n原会话结果节选（待核对）：\n${fence}text\n${redact(text)}\n${fence}` : "\n\n原生产出正文未抄送，需从原聊天核对。";
      return this.knowledge.candidate(row.threadId, date, row.title, `背景：${row.repository} 中的 ${row.engine} 会话。\n\n观察：最后记录状态为 ${row.status}。${quote}\n\n待复核：从原会话核对结论、工具结果与未闭环事项，当前摘要不推断已掌握的机制或方法论。`, ["工作连续性"], [`mycodex://thread/${row.threadId}`], row.engine);
    });
    cards.push(...git.filter(repo => repo.commits.length).slice(0, 4).map(repo => this.knowledge.candidate(`git:${repo.repositoryId}`, date, `Git 证据 · ${repo.repository}`, `仓库分支：${repo.branch}\n\n当日提交节选：\n${repo.commits.slice(0, 5).join("\n")}\n\n候选观察：这些是版本历史证据，不据此推断所有测试通过或任务已完成。`, ["版本历史"], repo.commits.slice(0, 5).map(commit => `mycodex://git/${repo.repositoryId}/${commit.split(" ")[0]}`))));
    if (this.options.distillCommand) {
      const output = JSON.parse(await runCommand(this.options.distillCommand, JSON.stringify({ date, timezone, handoff, git })));
      if (!Array.isArray(output.cards) || output.cards.length > 12) throw new Error("Distillation command returned invalid candidate cards.");
      cards = output.cards as CardCandidate[];
      if (cards.some(card => card.date !== date)) throw new Error("Distillation candidates do not match the requested evidence/date.");
      cards.forEach(card => this.knowledge.validate(card));
    }
    const result: DailyDigest = { date, timezone, handoff, markdown: lines.join("\n"), cards, coverage: { cli: cli.length, native: native.length, repositories: git.length, degraded }, refreshedAt: this.clock() };
    // Bound the UI wire projection without dropping persisted source records.
    if (Buffer.byteLength(JSON.stringify(result)) > 230 * 1024) throw new Error("Daily digest exceeds view budget; narrow configured repositories or source summaries.");
    writeJson(path.join(this.directory, `${date}.json`), result); this.cache = result; return result;
  }
  refresh() {
    if (this.job?.state === "running") return { ...this.job };
    const job = this.job = { id: randomUUID(), state: "running" } as { id: string; state: string; error?: string }; this.cache = null;
    this.registry.track(async () => { await this.digest(); job.state = "completed"; this.changed(); }).catch(cause => { job.state = "failed"; job.error = cause instanceof Error ? cause.message : "Digest failed."; this.changed(); }); return { ...job };
  }
  async saveCard(params: Record<string, unknown>) {
    if (Object.keys(params).some(key => !["id", "title", "tags", "date"].includes(key)) || typeof params.id !== "string" || params.title !== undefined && typeof params.title !== "string" || params.tags !== undefined && (!Array.isArray(params.tags) || params.tags.some(tag => typeof tag !== "string"))) throw new Error("Invalid candidate edit.");
    const digest = await this.digest(params.date ? { date: params.date } : {}), card = digest.cards.find(card => card.id === params.id); if (!card) throw new Error("Unknown current digest candidate.");
    return this.knowledge.save({ ...card, title: (params.title as string | undefined) ?? card.title, tags: (params.tags as string[] | undefined) ?? card.tags });
  }
}
