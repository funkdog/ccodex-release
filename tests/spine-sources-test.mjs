import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
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
test("first radar render shows available editorial items when no high-score item exists, and explicit filters still work", { timeout: 30000 }, async () => {
  const runtime = process.env.MYCODEX_TEST_PLAYWRIGHT ?? path.resolve(path.dirname(process.execPath), "../node_modules/playwright/index.mjs");
  const { chromium } = await import(pathToFileURL(runtime).href); const browser = await chromium.launch({ executablePath: process.env.MYCODEX_TEST_BROWSER ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
  try {
    const page = await browser.newPage(); await page.route("http://127.0.0.1/**", route => route.request().url().endsWith("panel.mjs") ? route.fulfill({ contentType: "text/javascript", body: fs.readFileSync(path.join(root, "bridge/diy/radar-panel.mjs"), "utf8") }) : route.fulfill({ contentType: "text/html; charset=utf-8", body: "<main></main>" }));
    await page.goto("http://127.0.0.1/"); await page.evaluate(async () => {
      const { mountRadarPanel } = await import("/panel.mjs"); const controller = new AbortController(); globalThis.calls = [];
      mountRadarPanel({ document, container: document.querySelector("main"), signal: controller.signal, hostActions: {}, services: { async request(method, p) { calls.push([method, p]); return method.endsWith("/list") ? { configured: true, items: p.highOnly ? [] : [{ id: "a".repeat(32), title: "Priority four", summary: "Source fixture", score: 80, scoreReason: "report priority 4/5", feedback: 0, topics: ["agents"], sources: [{ url: "https://example.test/fixture" }] }], topics: ["agents"], total: p.highOnly ? 0 : 1, availableTotal: 1, highCount: 0, collectedThrough: "2026-11-02T09:30:00+08:00", syncedAt: "2026-11-02T12:00:00+08:00", refreshMode: "archive-sync" } : {}; } } });
    });
    await page.getByRole("heading", { name: "Priority four" }).waitFor({ timeout: 3000 }); assert.match(await page.locator(".synced").textContent(), /采集/); assert.equal(await page.getByRole("button", { name: "全部", exact: true }).getAttribute("aria-pressed"), "true");
    await page.getByRole("button", { name: "🔥 高契合" }).click(); await page.getByText("当前筛选暂无条目。", { exact: true }).waitFor(); await page.getByRole("button", { name: "全部", exact: true }).click(); await page.getByRole("heading", { name: "Priority four" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "同步最新归档", exact: true }).getAttribute("title"), "同步最新归档；新报告由既有采集任务产生");
  } finally { await browser.close(); }
});
