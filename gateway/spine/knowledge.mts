import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { KnowledgeOptions } from "./contracts.mjs";
import type { MycodexKnowledgeCard, KnowledgeSource } from "./knowledge-contracts.mjs";
import { privateDirectory } from "./storage.mjs";
import { readJson, writeJson, redact } from "./io.mjs";
import { validateSource } from "./schema.mjs";
export type CardCandidate = MycodexKnowledgeCard;
const schemaFile = path.join(import.meta.dirname, "schemas/mycodex-knowledge-card.schema.json");
export class KnowledgeService {
  directory: string; library: string; private receipts = new Map<string, Promise<{ destination: string; saved: boolean; id: string; revision: number }>>();
  constructor(home: string, options?: KnowledgeOptions) {
    this.directory = privateDirectory(path.join(home, "gateway/spine/knowledge"));
    if (options?.vaultRoot && (!path.isAbsolute(options.vaultRoot) || !fs.lstatSync(options.vaultRoot).isDirectory() || fs.lstatSync(options.vaultRoot).isSymbolicLink())) throw new Error("MyCodex vault root must be an existing regular directory.");
    this.library = privateDirectory(options?.vaultRoot ? path.join(options.vaultRoot, "MyCodex/Knowledge") : path.join(this.directory, "library"));
  }
  candidate(sourceId: string, date: string, title: string, body: string, tags: string[], uris: string[], engine?: string): CardCandidate {
    const id = "MC-" + date.replaceAll("-", "") + "-" + createHash("sha256").update(sourceId).digest("hex").slice(0, 24);
    const sources: KnowledgeSource[] = uris.map(uri => {
      const kind = uri.startsWith("mycodex://thread/") ? "thread" : uri.startsWith("mycodex://radar/") ? "radar" : uri.startsWith("mycodex://git/") ? "git" : "web";
      return { kind, uri, ...(engine ? { engine } : {}) };
    });
    return { schemaVersion: 1, id, revision: 1, date, title: redact(title).slice(0, 300), body: redact(body).slice(0, 50000), tags: [...new Set(tags)].slice(0, 12), sources, status: "candidate", createdAt: Date.now(), updatedAt: Date.now(), createdBy: "mycodex" };
  }
  validate(card: CardCandidate) {
    validateSource(card, schemaFile);
    if (!card.title.trim() || new Date(card.date).toISOString().slice(0, 10) !== card.date || card.updatedAt < card.createdAt) throw new Error("Invalid MyCodex card content/date.");
    for (const source of card.sources) { const url = new URL(source.uri); if (/[\s\x00-\x1f\x7f]/.test(source.uri) || url.username || url.password || source.kind === "web" && !["https:", "http:"].includes(url.protocol)) throw new Error("Unsafe knowledge source URI."); }
  }
  save(input: CardCandidate): Promise<{ destination: string; saved: boolean; id: string; revision: number }> {
    let card: CardCandidate;
    try { this.validate(input); card = { ...input, title: redact(input.title), body: redact(input.body), tags: [...new Set(input.tags.map(tag => tag.trim()).filter(Boolean))] }; this.validate(card); }
    catch (cause) { return Promise.reject(cause); }
    const pending = this.receipts.get(card.id); if (pending) return pending.then(() => this.save(card));
    const work = Promise.resolve().then(() => this.commit(card)).finally(() => this.receipts.delete(card.id)); this.receipts.set(card.id, work); return work;
  }
  private markdown(card: CardCandidate) {
    return `<!-- MyCodex managed card schema=1 id=${card.id} revision=${card.revision} -->\n---\nmycodex_schema: 1\nid: ${card.id}\nrevision: ${card.revision}\nstatus: ${card.status}\ntags: ${JSON.stringify(card.tags)}\n---\n\n# ${card.title}\n\n${card.body}\n\n## 来源\n${card.sources.map(source => `- ${source.kind}${source.engine ? " · " + source.engine : ""}: ${source.uri}`).join("\n")}\n`;
  }
  private commit(card: CardCandidate) {
    const recordFile = path.join(this.directory, `${card.id}.json`);
    const previous = fs.existsSync(recordFile) ? readJson(recordFile) as { card: CardCandidate; hash: string; outputFile: string } : null;
    const hash = createHash("sha256").update(JSON.stringify({ date: card.date, title: card.title, body: card.body, tags: card.tags, sources: card.sources, status: card.status })).digest("hex");
    if (previous) {
      this.validate(previous.card);
      if (previous.card.id !== card.id || !/^[a-f0-9]{64}$/.test(previous.hash)) throw new Error("Corrupt knowledge ownership record.");
      const expected = path.join(this.library, `${card.id}@${previous.card.revision}.md`);
      if (previous.outputFile !== expected) throw new Error("Knowledge record does not belong to this library.");
      if (previous.hash === hash && fs.existsSync(expected)) {
        const fd = fs.openSync(expected, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try { const stat = fs.fstatSync(fd); if (stat.isFile() && stat.size < 256 * 1024 && fs.readFileSync(fd, "utf8") === this.markdown(previous.card)) return { saved: true, destination: "mycodex", id: card.id, revision: previous.card.revision }; } finally { fs.closeSync(fd); }
      }
      card = { ...card, revision: previous.card.revision + 1, createdAt: previous.card.createdAt, updatedAt: Date.now() };
    }
    this.validate(card);
    const outputFile = path.join(this.library, `${card.id}@${card.revision}.md`), text = this.markdown(card);
    const pending = `${outputFile}.${randomUUID()}.pending`, fd = fs.openSync(pending, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    try {
      if (fs.existsSync(outputFile)) { const file = fs.openSync(outputFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); try { if (fs.fstatSync(file).size > 256 * 1024 || fs.readFileSync(file, "utf8") !== text) throw new Error("Knowledge revision already exists with different content."); } finally { fs.closeSync(file); } }
      else fs.linkSync(pending, outputFile);
      const d = fs.openSync(this.library, fs.constants.O_RDONLY); try { fs.fsyncSync(d); } finally { fs.closeSync(d); }
      writeJson(recordFile, { card, hash, outputFile });
    } finally { fs.unlinkSync(pending); }
    return { saved: true, destination: "mycodex", id: card.id, revision: card.revision };
  }
}
