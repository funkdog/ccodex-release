import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { loadSquads, saveSquads, createSquad, addMember, removeMember,
  dissolveSquad, getSquadByThread, getSquadByAnchor } from "../gateway/spine/squad-lite.mjs";

test("squad identity is independent, unique and removable without changing thread data", () => {
  const store = { squads: {} }, anchor = randomUUID(), worker = randomUUID();
  const squad = createSquad(store, anchor, "Auth 小队", "claude-code");
  assert.match(squad.id, /^sq-[a-f0-9]{8}$/);
  assert.equal(getSquadByAnchor(store, anchor), squad);
  assert.deepEqual(squad.members, [{ threadId: anchor, role: "supervisor", shortName: "supervisor", engine: "claude-code" }]);
  assert(Number.isFinite(squad.createdAt));
  addMember(store, squad.id, worker, "impl-1", "codex");
  assert.equal(getSquadByThread(store, worker), squad);
  assert.throws(() => removeMember(store, squad.id, anchor), /anchor|supervisor/i);
  assert.throws(() => createSquad(store, worker, "Other", "codex"), /already/i);
  assert.throws(() => addMember(store, squad.id, worker, "duplicate", "codex"), /already/i);
  removeMember(store, squad.id, worker);
  assert.equal(getSquadByThread(store, worker), null);
  assert.equal(getSquadByAnchor(store, worker), null);
  dissolveSquad(store, squad.id);
  assert.deepEqual(store, { squads: {} });
});

test("unknown squads and invalid identities fail before mutating the store", () => {
  const store = { squads: {} };
  assert.throws(() => addMember(store, "sq-12345678", randomUUID(), "w", "codex"), /squad/i);
  assert.throws(() => createSquad(store, "not-a-uuid", "Auth", "codex"), /thread/i);
  assert.throws(() => createSquad(store, randomUUID(), "  ", "codex"), /label/i);
  assert.deepEqual(store, { squads: {} });
});

test("missing storage is read-only; writes round-trip atomically in the requested profile", async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "squad-lite-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const store = await loadSquads(home);
  assert.deepEqual(store, { squads: {} });
  assert.deepEqual(await fs.readdir(home), []);
  createSquad(store, randomUUID(), "小队 <script>", "claude-code");
  await saveSquads(home, store);
  assert.deepEqual(await loadSquads(home), store);
  await Promise.all(Array.from({ length: 8 }, () => saveSquads(home, store)));
  assert.deepEqual(await loadSquads(home), store);
  assert.deepEqual(await fs.readdir(path.join(home, ".mycodex")), ["squads.json"]);
  const other = path.join(home, "other-profile");
  assert.deepEqual(await loadSquads(other), { squads: {} });
});

test("corrupt storage is preserved and invalid saves cannot replace the last valid file", async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "squad-lite-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await fs.mkdir(path.join(home, ".mycodex"), { mode: 0o700 });
  const file = path.join(home, ".mycodex/squads.json");
  for (const raw of ["{broken", '{"squads":[]}', '{"squads":{"__proto__":{}}}']) {
    await fs.writeFile(file, raw);
    await assert.rejects(loadSquads(home));
    assert.equal(await fs.readFile(file, "utf8"), raw);
  }
  const store = { squads: {} };
  const squad = createSquad(store, randomUUID(), "Auth", "codex");
  await saveSquads(home, store);
  squad.members[0].role = "worker";
  await assert.rejects(saveSquads(home, store), /supervisor|anchor/i);
  assert.equal((await loadSquads(home)).squads[squad.id].members[0].role, "supervisor");
});
