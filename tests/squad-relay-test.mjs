import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import {
  cleanupSquadRelay, formatBriefAsText, readAllResults, readBrief, readResult, writeBrief, writeResult,
} from "../gateway/spine/squad-relay.mjs";

const brief = { squadGoal: "Ship relay", task: "Implement file results", exclusions: ["gateway/contracts.mts", "shared/**"], squadId: "squad-1", workerId: "@worker-1", issuedAt: 100 };
const result = { squadId: brief.squadId, workerId: brief.workerId, summary: "File protocol implemented", artifactPath: ".mycodex/squad-relay/squad-1/@worker-1.artifact.md", completedAt: 200, status: "completed" };
async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "mc-squad-relay-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  return { dataDir, directory: path.join(dataDir, ".mycodex/squad-relay/squad-1") };
}

test("relay reads missing state without creating it, then round trips and replaces brief/result files", async t => {
  const { dataDir, directory } = await fixture(t);
  assert.equal(await readBrief(dataDir, "squad-1", "@worker-1"), null);
  assert.equal(await readResult(dataDir, "squad-1", "@worker-1"), null);
  assert.deepEqual(await readAllResults(dataDir, "squad-1"), []);
  await assert.rejects(fs.stat(path.join(dataDir, ".mycodex")), { code: "ENOENT" });
  await writeBrief(dataDir, brief);
  await writeResult(dataDir, result);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, "@worker-1.brief.json"), "utf8")), brief);
  assert.deepEqual(await readBrief(dataDir, "squad-1", "@worker-1"), brief);
  assert.deepEqual(await readResult(dataDir, "squad-1", "@worker-1"), result);
  const failed = { ...result, summary: "Verification failed", status: "failed", error: "Type mismatch" };
  await writeResult(dataDir, failed);
  assert.deepEqual(await readResult(dataDir, "squad-1", "@worker-1"), failed);
  assert.deepEqual((await fs.readdir(directory)).sort(), ["@worker-1.brief.json", "@worker-1.result.json"]);
});

test("result collection ignores briefs/artifacts and cleanup affects only the named squad", async t => {
  const { dataDir, directory } = await fixture(t);
  await writeBrief(dataDir, brief);
  await writeResult(dataDir, { ...result, workerId: "@worker-2", status: "failed", error: "Stopped" });
  await writeResult(dataDir, result);
  await fs.writeFile(path.join(directory, "@worker-1.artifact.md"), "# Deliverable\n");
  await writeResult(dataDir, { ...result, squadId: "squad-2" });
  assert.deepEqual((await readAllResults(dataDir, "squad-1")).map(r => [r.workerId, r.status]), [["@worker-1", "completed"], ["@worker-2", "failed"]]);
  await cleanupSquadRelay(dataDir, "squad-1");
  await cleanupSquadRelay(dataDir, "squad-1");
  await assert.rejects(fs.stat(directory), { code: "ENOENT" });
  assert.deepEqual(await readResult(dataDir, "squad-2", "@worker-1"), { ...result, squadId: "squad-2" });
});

test("invalid IDs, malformed JSON and mismatched records never become missing or completed results", async t => {
  const { dataDir, directory } = await fixture(t);
  for (const id of ["", ".", "..", "../outside", "a/b", "a\\b", "C:outside"]) {
    await assert.rejects(writeBrief(dataDir, { ...brief, squadId: id }), /Invalid.*squadId/);
    await assert.rejects(readResult(dataDir, "squad-1", id), /Invalid.*workerId/);
    await assert.rejects(cleanupSquadRelay(dataDir, id), /Invalid.*squadId/);
  }
  await assert.rejects(writeResult(dataDir, { ...result, status: "running" }), /Invalid.*result/);
  await writeBrief(dataDir, brief);
  const file = path.join(directory, "@worker-1.result.json");
  await fs.writeFile(file, "{partial");
  await assert.rejects(readResult(dataDir, "squad-1", "@worker-1"), SyntaxError);
  await fs.writeFile(file, JSON.stringify({ ...result, workerId: "other" }));
  await assert.rejects(readAllResults(dataDir, "squad-1"), /Invalid.*result/);
  await fs.writeFile(path.join(directory, "@worker-1.brief.json"), JSON.stringify({ ...brief, exclusions: [42] }));
  await assert.rejects(readBrief(dataDir, "squad-1", "@worker-1"), /Invalid.*brief/);
});

test("relay refuses linked squad directories and linked result files", async t => {
  const { dataDir, directory } = await fixture(t);
  const outside = path.join(dataDir, "outside");
  await fs.mkdir(outside);
  await writeBrief(dataDir, brief);
  await fs.symlink(path.join(directory, "@worker-1.brief.json"), path.join(directory, "@worker-1.result.json"));
  await assert.rejects(readResult(dataDir, "squad-1", "@worker-1"));
  await assert.rejects(writeResult(dataDir, result));
  await fs.rm(directory, { recursive: true });
  await fs.symlink(outside, directory, "dir");
  await assert.rejects(cleanupSquadRelay(dataDir, "squad-1"), /Linked/);
  assert.equal((await fs.stat(outside)).isDirectory(), true);
});

test("brief text carries the goal, task, worker boundaries and relative deliverable paths", () => {
  assert.equal(formatBriefAsText(brief), `[Squad Goal] Ship relay\n\n[Your Task] Implement file results\n\n[Boundaries] You are @worker-1. Do not modify: gateway/contracts.mts, shared/**.\nWrite your deliverable to:\n  .mycodex/squad-relay/squad-1/@worker-1.artifact.md\nWrite your result summary to:\n  .mycodex/squad-relay/squad-1/@worker-1.result.json`);
  assert.match(formatBriefAsText({ ...brief, exclusions: undefined }), /Do not modify: none\./);
});

test("another thread can replace results while readers observe only complete JSON", { timeout: 10000 }, async t => {
  const { dataDir } = await fixture(t);
  await writeResult(dataDir, result);
  const worker = new Worker(`
    const { parentPort, workerData } = require("node:worker_threads");
    import(workerData.module).then(async ({ writeResult }) => {
      parentPort.postMessage("ready");
      for (let i = 0; i < 16; i++) await writeResult(workerData.dataDir, { ...workerData.result, summary: String(i).repeat(32768) });
    }).catch(error => { throw error; });
  `, { eval: true, workerData: { module: new URL("../gateway/spine/squad-relay.mjs", import.meta.url).href, dataDir, result } });
  t.after(() => worker.terminate());
  const exited = once(worker, "exit");
  await once(worker, "message");
  let done = false;
  exited.then(() => { done = true; });
  let reads = 0;
  while (!done) {
    const saved = await readResult(dataDir, "squad-1", "@worker-1");
    assert.equal(saved.workerId, result.workerId);
    assert.equal(saved.status, "completed");
    reads++;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.deepEqual(await exited, [0]);
  assert.ok(reads > 0);
  assert.equal((await readResult(dataDir, "squad-1", "@worker-1")).summary, "15".repeat(32768));
});
