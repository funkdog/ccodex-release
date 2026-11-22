import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { readRadarArchive } from "../gateway/spine/radar-archive.mjs";
import { RadarService } from "../gateway/spine/radar.mjs";
import { KnowledgeService } from "../gateway/spine/knowledge.mjs";
import { SpineRegistry } from "../gateway/spine/registry.mjs";
import { validateSpineOptions } from "../gateway/spine/config.mjs";
const root = path.resolve(import.meta.dirname, "..");
const schema = process.env.MYCODEX_TEST_RADAR_SCHEMA ?? path.resolve(root, "../ai-agent-frontier-radar/plugin/report.schema.json");
const report = { schema_version: 1, report_date: "2026-11-02", timezone: "Asia/Shanghai", window_start: "2026-11-01T09:30:00+08:00", window_end: "2026-11-02T09:30:00+08:00", title: "Archived fixture", intro: "Synthetic test", status: "complete", coverage: "test only", items: [{ title: "Priority four", topics: ["agents"], summary: "Verified source adapter fixture", sources: [{ title: "Source", url: "https://example.test/fixture" }], priority: { score: 4, reason: "editorial reading recommendation" } }] };
const hash = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
function fixture(t) {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "spine-source-")); fs.chmodSync(home, 0o700); t.after(() => fs.rmSync(home, { force: true, recursive: true }));
  const file = path.join(home, "radar.sqlite3"), db = new DatabaseSync(file); db.exec("CREATE TABLE reports (id TEXT PRIMARY KEY, report_date TEXT, revision INTEGER, payload TEXT); PRAGMA user_version=17;");
  db.prepare("INSERT INTO reports VALUES (?,?,?,?)").run("fixture-1", report.report_date, 1, JSON.stringify(report)); db.close(); return { home, file };
}
test("archive adapter reads latest immutable report without schema initialization, creation or writes", async t => {
  const { home, file } = fixture(t), before = hash(file); assert.deepEqual(await readRadarArchive(file), report); assert.equal(hash(file), before);
  const db = new DatabaseSync(file); db.prepare("INSERT INTO reports VALUES (?,?,?,?)").run("fixture-2", report.report_date, 2, JSON.stringify({ ...report, title: "Revision 2" })); db.close();
  assert.equal((await readRadarArchive(file)).title, "Revision 2");
  const missing = path.join(home, "missing.sqlite3"); await assert.rejects(readRadarArchive(missing)); assert.equal(fs.existsSync(missing), false);
  const link = path.join(home, "linked.sqlite3"); fs.symlinkSync(file, link); await assert.rejects(readRadarArchive(link), /regular file/);
  const large = new DatabaseSync(file); large.prepare("INSERT INTO reports VALUES (?,?,?,?)").run("large", "2026-11-03", 1, "x".repeat(2 * 1024 * 1024 + 1)); large.close(); await assert.rejects(readRadarArchive(file), /budget/);
  assert.throws(() => validateSpineOptions({ radar: { schemaFile: schema, archiveDatabase: file, reportFile: path.join(home, "report.json") } }), /exactly one/);
});
test("archive refresh synchronizes current reports without claiming new collection and keeps last valid evidence on failure", async t => {
  const { home, file } = fixture(t), registry = new SpineRegistry(home), knowledge = new KnowledgeService(home), options = { schemaFile: schema, archiveDatabase: file };
  t.after(() => registry.close()); const radar = new RadarService(home, registry, knowledge, options), before = hash(file);
  const first = await radar.list({ highOnly: true }); assert.equal(first.total, 0); assert.equal(first.availableTotal, 1); assert.equal(first.highCount, 0); assert.equal(first.collectedThrough, report.window_end); assert.equal(first.refreshMode, "archive-sync"); assert.notEqual(first.syncedAt, first.collectedThrough);
  assert.equal(radar.refresh().state, "running"); while (registry.activeTasks) await new Promise(resolve => setTimeout(resolve, 5)); assert.equal((await radar.list()).refresh.state, "completed");
  const card = (await radar.list()).items[0]; await radar.feedback({ id: card.id, value: -1 }); assert.equal((await radar.list()).items[0].feedback, -1); await radar.feedback({ id: card.id, value: 0 }); await radar.saveCard({ id: card.id });
  assert.equal((await radar.list()).items[0].saved, true); assert.equal(hash(file), before);
  const restarted = new RadarService(home, registry, knowledge, options); assert.equal((await restarted.list()).items[0].saved, true);
  fs.renameSync(file, file + ".offline"); const stale = await restarted.list(); assert.equal(stale.stale, true); assert.equal(stale.items.length, 1); assert.equal(stale.collectedThrough, report.window_end);
  restarted.refresh(); while (registry.activeTasks) await new Promise(resolve => setTimeout(resolve, 5)); const failed = await restarted.list(); assert.equal(failed.refresh.state, "failed"); assert.equal(failed.items[0].id, card.id);
});
