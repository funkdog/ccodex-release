import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { RadarOptions } from "./contracts.mjs";
import type { SpineRegistry } from "./registry.mjs";
import type { KnowledgeService } from "./knowledge.mjs";
import { privateDirectory } from "./storage.mjs";
import { readJson, writeJson, runCommand } from "./io.mjs";
import { validateSource } from "./schema.mjs";
import { readRadarArchive } from "./radar-archive.mjs";
interface ReportItem { title: string; summary: string; topics: string[]; tags?: string[]; body?: string; sources: { title: string; url: string; published_at?: string }[]; priority?: { score: number; reason: string } }
interface Report { schema_version: number; report_date: string; timezone: string; window_end: string; status: string; items: ReportItem[] }
export interface RadarCard { id: string; title: string; summary: string; body: string; topics: string[]; tags: string[]; sources: { title: string; url: string; published_at?: string }[]; score: number | null; scoreReason: string; feedback: number; saved: boolean }
export class RadarService {
  private file: string; private preferences: { feedback: Record<string, { value: number; topics: string[] }>; saved: string[]; seen?: string[] };
  private refreshing: { id: string; state: string; error?: string } | null = null;
  private registry: SpineRegistry; private knowledge: KnowledgeService; private options?: RadarOptions;
  private changed: () => void;
  private snapshotFile: string; private sourceError: string | null = null; private lastSyncedAt: number | null = null;
  constructor(home: string, registry: SpineRegistry, knowledge: KnowledgeService, options?: RadarOptions, changed = () => {}) {
    this.changed = changed;
    this.registry = registry; this.knowledge = knowledge; this.options = options;
    this.file = path.join(privateDirectory(path.join(home, "gateway/spine/radar")), "preferences.json");
    this.snapshotFile = path.join(path.dirname(this.file), "last-valid-report.json");
    this.preferences = fs.existsSync(this.file) ? readJson(this.file) as typeof this.preferences : { feedback: {}, saved: [] };
  }
  private async report(strict = false): Promise<Report | null> {
    if (!this.options) return null;
    try {
    let value: unknown;
    if (this.options.reportFile) value = readJson(this.options.reportFile);
    else if (this.options.archiveDatabase) { value = await readRadarArchive(this.options.archiveDatabase); if (value === null) return null; }
    else if (this.options.loadCommand) value = JSON.parse(await runCommand(this.options.loadCommand));
    else if (this.options.archive) {
      const a = this.options.archive, env = a.dataHome ? { AI_RADAR_DATA_DIR: a.dataHome } : undefined;
      const listing = JSON.parse(await runCommand({ executable: a.executable, args: [a.script, "list", "--limit", "1"], env }));
      const id = listing.reports?.[0]?.id; if (!id) return null;
      if (typeof id !== "string" || id.length > 128) throw new Error("Invalid archive report identity.");
      const result = JSON.parse(await runCommand({ executable: a.executable, args: [a.script, "get", id], env })); value = result.report;
    }
    validateSource(value, this.options.schemaFile);
    const report = value as Report;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(report.report_date) || !Number.isFinite(Date.parse(report.window_end))) throw new Error("Report dates are invalid.");
    this.cards(report); writeJson(this.snapshotFile, report); this.lastSyncedAt = Date.now(); this.sourceError = null; return report;
    } catch (cause) {
      this.sourceError = cause instanceof Error ? cause.message : "Report source is unavailable.";
      if (!strict && fs.existsSync(this.snapshotFile)) { const cached = readJson(this.snapshotFile); validateSource(cached, this.options.schemaFile); this.lastSyncedAt ??= fs.statSync(this.snapshotFile).mtimeMs; return cached as Report; }
      throw cause;
    }
  }
  private cards(report: Report): RadarCard[] {
    const weights: Record<string, number> = {};
    for (const feedback of Object.values(this.preferences.feedback)) for (const topic of feedback.topics) weights[topic] = (weights[topic] ?? 0) + feedback.value * 5;
    return report.items.map(item => {
      for (const source of item.sources) { const url = new URL(source.url); if (/[\s\x00-\x1f\x7f]/.test(source.url) || !["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Radar sources require safe public HTTP(S) URLs."); }
      const id = createHash("sha256").update(item.title + "\n" + item.sources[0].url).digest("hex").slice(0, 32);
      const score = item.priority ? Math.max(0, Math.min(100, item.priority.score * 20 + item.topics.reduce((sum, topic) => sum + Math.max(-20, Math.min(20, weights[topic] ?? 0)), 0))) : null;
      return { id, title: item.title.slice(0, 300), summary: item.summary.slice(0, 1500), body: (item.body ?? "").slice(0, 3000), topics: item.topics, tags: item.tags ?? item.topics, sources: item.sources.slice(0, 3).map(source => ({ title: source.title.slice(0, 200), url: source.url.slice(0, 2048), ...(source.published_at ? { published_at: source.published_at } : {}) })), score, scoreReason: item.priority ? `报告阅读优先级 ${item.priority.score}/5；叠加本地主题反馈。${item.priority.reason}` : "报告未提供阅读评分", feedback: this.preferences.feedback[id]?.value ?? 0, saved: this.preferences.saved.includes(id) };
    }).sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  }
  async list(params: Record<string, unknown> = {}) {
    if (Object.keys(params).some(key => !["topic", "highOnly", "offset", "limit"].includes(key)) || params.topic !== undefined && typeof params.topic !== "string" || params.highOnly !== undefined && typeof params.highOnly !== "boolean") throw new Error("Invalid radar filter.");
    const limit = params.limit ?? 20, offset = params.offset ?? 0;
    if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 20 || !Number.isSafeInteger(offset) || (offset as number) < 0 || (offset as number) > 100) throw new Error("Invalid radar page.");
    const refreshMode = this.options?.refreshCommand ? "collector" : "archive-sync";
    const report = await this.report(); if (!report) return { configured: !!this.options, items: [], topics: [], total: 0, availableTotal: 0, highCount: 0, nextOffset: null, syncedAt: null, refreshMode, refresh: this.refreshing };
    const cards = this.cards(report), filtered = cards.filter(card => (!params.topic || card.topics.includes(params.topic as string)) && (!params.highOnly || (card.score ?? 0) >= 85 || card.feedback < 0));
    const items: RadarCard[] = [];
    for (const card of filtered.slice(offset as number, (offset as number) + (limit as number))) { if (items.length && Buffer.byteLength(JSON.stringify([...items, card])) > 220 * 1024) break; items.push(card); }
    return { configured: true, date: report.report_date, status: report.status, items, topics: [...new Set(cards.flatMap(card => card.topics))], total: filtered.length, availableTotal: cards.length, highCount: cards.filter(card => (card.score ?? 0) >= 85 && card.feedback >= 0).length, nextOffset: (offset as number) + items.length < filtered.length ? (offset as number) + items.length : null, collectedThrough: report.window_end, syncedAt: this.lastSyncedAt === null ? null : new Date(this.lastSyncedAt).toISOString(), refreshMode, refresh: this.refreshing, stale: !!this.sourceError, sourceError: this.sourceError, unreadHighCount: cards.filter(card => (card.score ?? 0) >= 85 && card.feedback >= 0 && !card.saved && !(this.preferences.seen ?? []).includes(card.id)).length };
  }
  async feedback(params: Record<string, unknown>) {
    if (Object.keys(params).some(key => !["id", "value"].includes(key)) || typeof params.id !== "string" || ![-1, 0, 1].includes(params.value as number)) throw new Error("Invalid radar feedback.");
    const report = await this.report(), card = report && this.cards(report).find(card => card.id === params.id); if (!card) throw new Error("Unknown radar item.");
    if (!this.preferences.feedback[card.id] && Object.keys(this.preferences.feedback).length >= 2000) throw new Error("Preference limit reached.");
    this.preferences.feedback[card.id] = { value: params.value as number, topics: card.topics }; writeJson(this.file, this.preferences); this.changed(); return { updated: true };
  }
  async saveCard(params: Record<string, unknown>) {
    if (Object.keys(params).some(key => key !== "id") || typeof params.id !== "string") throw new Error("Invalid radar card request.");
    const report = await this.report(), card = report && this.cards(report).find(card => card.id === params.id); if (!card || !report) throw new Error("Unknown radar item.");
    const result = await this.knowledge.save(this.knowledge.candidate(card.id, report.report_date, card.title, card.summary + "\n\n" + card.body, card.tags, [`mycodex://radar/${card.id}`, ...card.sources.map(source => source.url)]));
    if (!this.preferences.saved.includes(card.id)) this.preferences.saved.push(card.id); writeJson(this.file, this.preferences); this.changed(); return result;
  }
  async seen(params: Record<string, unknown>) {
    if (Object.keys(params).some(key => key !== "ids") || !Array.isArray(params.ids) || params.ids.length > 20 || params.ids.some(id => typeof id !== "string")) throw new Error("Invalid radar seen acknowledgment.");
    const report = await this.report(); if (!report) return { changed: false };
    const ids = new Set(this.cards(report).map(card => card.id)); if (params.ids.some(id => !ids.has(id))) throw new Error("Unknown radar item.");
    const seen = this.preferences.seen ?? []; const next = [...new Set([...seen, ...params.ids as string[]])].slice(-2000);
    if (JSON.stringify(seen) === JSON.stringify(next)) return { changed: false };
    this.preferences.seen = next; writeJson(this.file, this.preferences); this.changed(); return { changed: true };
  }
  refresh() {
    if (!this.options) throw new Error("尚未配置雷达报告来源。");
    if (this.refreshing?.state === "running") return this.refreshing;
    const job = this.refreshing = { id: randomUUID(), state: "running" } as { id: string; state: string; error?: string };
    this.registry.track(async () => { if (this.options!.refreshCommand) await runCommand(this.options!.refreshCommand); await this.report(true); job.state = "completed"; this.changed(); }).catch(cause => { job.state = "failed"; job.error = cause instanceof Error ? cause.message : "Refresh failed."; this.changed(); });
    return { ...job };
  }
}
