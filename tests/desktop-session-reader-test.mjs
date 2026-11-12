import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { DesktopSessionReader, createDesktopSessionApi } from "../bridge/desktop-session-reader.mjs";
import { codexBackend } from "../tools/history/backends.mjs";
import fs from "node:fs";
import os from "node:os";

function fixture(count = 282) {
  let now = 1000, reads = 0, closes = 0;
  const rows = Array.from({ length: count }, (_, index) => ({
    id: randomUUID(), title: `Session ${index}`, cwd: index % 2 ? "project-b" : "project-a",
    inUse: index === 0, archived: index % 3 === 0, remote: false,
    modifiedAt: new Date(100000 - index * 100).toISOString(),
    operations: ["archive", "unarchive"],
  }));
  const reader = new DesktopSessionReader({
    now: () => now,
    backendFactory: async () => ({
      home: "fixture",
      list: async () => { reads++; return rows; },
      close: async () => { closes++; },
    }),
  });
  return { reader, rows, get reads() { return reads; }, get closes() { return closes; },
    advance(ms) { now += ms; } };
}

test("cross-page selection reuses one complete snapshot after a normal list", async () => {
  const f = fixture();
  const first = await f.reader.list({ limit: 50 });
  assert.equal(first.sessions.length, 50);
  assert.equal(f.reads, 1);
  const all = await f.reader.list({ cursor: 0, limit: 200 });
  assert.equal(all.sessions.length, 282);
  assert.equal(all.nextCursor, null);
  assert.equal(all.total, 282);
  assert.equal(f.reads, 1, "Select-all must not rescan every page");
  assert.equal(all.sessions.filter(row => row.inUse === false).length, 281);
  await f.reader.close();
});

test("a cold selection performs one scan and returns every bounded result", async () => {
  const f = fixture(500);
  const all = await f.reader.list({ limit: 200 });
  assert.equal(all.sessions.length, 500);
  assert.equal(all.nextCursor, null);
  assert.equal(f.reads, 1);
  await f.reader.close();
});

test("filtering preserves exact directory and archive semantics without truncating filtered selection", async () => {
  const f = fixture();
  await f.reader.list();
  const all = await f.reader.list({ limit: 200, cwd: "PROJECT-A", archived: false });
  assert.equal(all.total, f.rows.filter(row => row.cwd === "project-a" && !row.archived).length);
  assert(all.sessions.every(row => row.cwd === "project-a" && !row.archived));
  const found = await f.reader.list({ limit: 200, query: f.rows[12].id });
  assert.equal(found.sessions.length, 1);
  assert.equal(found.sessions[0].id, f.rows[12].id);
  assert.equal(f.reads, 1);
  await f.reader.close();
});

test("more than 500 matches are reported explicitly instead of silently selecting the first 500", async () => {
  const f = fixture(501);
  const all = await f.reader.list({ limit: 200 });
  assert.equal(all.total, 501);
  assert.equal(all.sessions.length, 200);
  assert.equal(all.nextCursor, 200);
  await f.reader.close();
});

test("normal refresh and page navigation always read fresh ownership and metadata", async () => {
  const f = fixture();
  await f.reader.list();
  f.rows[2].inUse = true;
  f.rows[2].title = "Changed live";
  const refreshed = await f.reader.list({ cursor: 0, limit: 50 });
  assert.equal(f.reads, 2);
  assert.equal(refreshed.sessions[2].inUse, true);
  assert.equal(refreshed.sessions[2].title, "Changed live");
  await f.reader.list({ cursor: 50, limit: 50 });
  assert.equal(f.reads, 3);
  await f.reader.close();
});

test("selection snapshots expire and changed ownership is re-read", async () => {
  const f = fixture();
  await f.reader.list();
  f.advance(30001);
  f.rows[1].inUse = true;
  const all = await f.reader.list({ limit: 200 });
  assert.equal(f.reads, 2);
  assert.equal(all.sessions[1].inUse, true);
  await f.reader.close();
});

test("snapshot result mutation cannot change later returned operation capabilities", async () => {
  const f = fixture();
  const all = await f.reader.list({ limit: 200 });
  all.sessions[1].title = "Client edit";
  all.sessions[1].operations.length = 0;
  const repeated = await f.reader.list({ limit: 200 });
  assert.equal(repeated.sessions[1].title, "Session 1");
  assert.deepEqual(repeated.sessions[1].operations, ["archive", "unarchive"]);
  await f.reader.close();
});

test("invalid filters and pages fail before reading local metadata", async () => {
  const f = fixture();
  for (const args of [
    { limit: 500 }, { limit: 0 }, { cursor: -1 }, { cursor: 0.5 },
    { query: [] }, { cwd: null }, { archived: "false" },
  ]) await assert.rejects(f.reader.list(args), /filters|page size/);
  assert.equal(f.reads, 0);
  await f.reader.close();
});

test("concurrent selection reads coalesce into one native ownership scan", async () => {
  let release, reads = 0;
  const wait = new Promise(resolve => { release = resolve; });
  const f = fixture();
  f.reader.factory = async () => ({
    home: "fixture",
    async list() { reads++; await wait; return f.rows; },
    close() {},
  });
  const left = f.reader.list({ limit: 200 });
  const right = f.reader.list({ limit: 200 });
  release();
  assert.equal((await left).total, 282);
  assert.equal((await right).total, 282);
  assert.equal(reads, 1);
  await f.reader.close();
});

test("failed native reads are not cached and the owned reader closes safely", async () => {
  const f = fixture();
  f.reader.factory = async () => ({
    home: "fixture",
    list: async () => { throw new Error("Native ownership unavailable"); },
    close() {},
  });
  await assert.rejects(f.reader.list(), /ownership unavailable/);
  assert.equal(f.reader.snapshot, null);
  await f.reader.close();
  await assert.rejects(f.reader.list(), /closing/);
});

test("Desktop preview and apply retain the original live service and exact arguments", async () => {
  const f = fixture(), calls = [];
  const api = createDesktopSessionApi({
    reader: f.reader,
    api: async (operation, args) => { calls.push({ operation, args }); return { accepted: true }; },
  });
  await api("list", { limit: 50 });
  const args = { clientId: randomUUID(), planId: randomUUID(), confirmation: "exact" };
  await api("preview", args);
  assert(f.reader.snapshot);
  await api("apply", args);
  assert.equal(f.reader.snapshot, null);
  assert.deepEqual(calls.map(call => call.operation), ["preview", "apply"]);
  assert.equal(calls[0].args, args);
  assert.equal(calls[1].args, args);
  await api.close();
});

test("completed batches invalidate selection snapshots and failed batches are never retried", async () => {
  const f = fixture();
  let calls = 0;
  const api = createDesktopSessionApi({
    reader: f.reader,
    api: async operation => {
      calls++;
      if (operation === "apply") throw new Error("Uncertain result");
      return { done: true };
    },
  });
  await api("list", {});
  await assert.rejects(api("apply", {}), /Uncertain result/);
  assert.equal(calls, 1);
  await api("progress", {});
  assert.equal(f.reader.snapshot, null);
  await api.close();
});

test("native database-only listing is opt-in and retains source and ownership checks", async () => {
  for (const databaseOnly of [true, false]) {
    const calls = [], id = randomUUID();
    let checked = 0;
    const backend = await codexBackend({
      home: fs.realpathSync(os.tmpdir()), databaseOnly, nativeWriterLocks: true,
      checkWriters: async () => { checked++; return { [id]: true }; },
      rpc: {
        child: { pid: 123 }, close() {},
        request: async (method, params) => {
          calls.push({ method, params });
          return { data: params.archived ? [] : [{ id, name: "Fixture" }], nextCursor: null };
        },
      },
    });
    const rows = await backend.list();
    assert.equal(rows[0].inUse, true);
    assert.equal(checked, 1);
    assert.equal(calls.length, 2);
    assert(calls.every(call => call.params.useStateDbOnly === databaseOnly));
    assert(calls.every(call => call.params.sourceKinds.includes("subAgent")));
    await assert.rejects(backend.mutate("archive", id), /running/);
  }
});
