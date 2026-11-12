import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureDeveloperBridgePort } from "../developer/bridge-port.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-dev-port-test-"));
  const home = path.join(root, "profile");
  fs.mkdirSync(home);
  const pointer = path.join(home, "bridge-port.txt");
  const config = path.join(home, "config.toml");
  const original = [
    'model = "fixture-model"',
    '[model_providers.github-copilot]',
    'base_url = "http://127.0.0.1:22691"',
    'wire_api = "responses"',
    '[desktop]',
    'conversationDetailMode = "STEPS_EXECUTION"',
    "",
  ].join("\n");
  fs.writeFileSync(pointer, "22691\n");
  fs.writeFileSync(config, original);
  const ensured = [];
  const options = {
    root, home, generation: "new-generation",
    health: async () => ({ bridge: "codex-copilot", pid: 42,
      runtime: { sourceGeneration: "old-generation" } }),
    inspectProcess: () => ({ args: [path.join(root, "bridge", "server.mjs")] }),
    allocatePort: async () => 45555,
    ensure: async port => {
      assert.equal(fs.readFileSync(pointer, "utf8"), "22691\n");
      assert.equal(fs.readFileSync(config, "utf8"), original);
      ensured.push(port);
    },
  };
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
    assert.match(path.basename(root), /^ccodex-dev-port-test-/);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, home, pointer, config, original, ensured, options };
}

test("rotation starts the new bridge before publishing its port and preserves Desktop settings", async t => {
  const f = fixture(t);
  assert.equal(await ensureDeveloperBridgePort(f.options), "45555");
  assert.deepEqual(f.ensured, ["45555"]);
  assert.equal(fs.readFileSync(f.pointer, "utf8"), "45555\n");
  assert.equal(fs.readFileSync(f.config, "utf8"),
    f.original.replace("127.0.0.1:22691", "127.0.0.1:45555"));
});

test("a failed candidate leaves both old endpoint files unchanged", async t => {
  const f = fixture(t);
  await assert.rejects(ensureDeveloperBridgePort({
    ...f.options, ensure: async () => { throw new Error("candidate failed"); },
  }), /candidate failed/);
  assert.equal(fs.readFileSync(f.pointer, "utf8"), "22691\n");
  assert.equal(fs.readFileSync(f.config, "utf8"), f.original);
});

test("a selected but stopped bridge is started even when Desktop will be reused", async t => {
  const f = fixture(t);
  assert.equal(await ensureDeveloperBridgePort({
    ...f.options, health: async () => { throw new Error("connection refused"); },
  }), "22691");
  assert.deepEqual(f.ensured, ["22691"]);
  assert.equal(fs.readFileSync(f.config, "utf8"), f.original);
});

test("a live current generation reuses its port without allocating another", async t => {
  const f = fixture(t);
  assert.equal(await ensureDeveloperBridgePort({
    ...f.options,
    health: async () => ({ bridge: "codex-copilot",
      runtime: { sourceGeneration: "new-generation" } }),
    allocatePort: async () => { throw new Error("unexpected rotation"); },
  }), "22691");
  assert.deepEqual(f.ensured, ["22691"]);
});

test("a different application cannot be overwritten or adopted", async t => {
  const f = fixture(t);
  await assert.rejects(ensureDeveloperBridgePort({
    ...f.options, health: async () => ({ bridge: "another-application" }),
  }), /owned by another application/);
  await assert.rejects(ensureDeveloperBridgePort({
    ...f.options, inspectProcess: () => ({ args: ["unrelated-server.mjs"] }),
  }), /not owned by this installation/);
  assert.deepEqual(f.ensured, []);
  assert.equal(fs.readFileSync(f.config, "utf8"), f.original);
});

test("a concurrent port selection is preserved instead of overwritten", async t => {
  const f = fixture(t);
  await assert.rejects(ensureDeveloperBridgePort({
    ...f.options,
    ensure: async () => { fs.writeFileSync(f.pointer, "46666\n"); },
  }), /selection changed concurrently/);
  assert.equal(fs.readFileSync(f.pointer, "utf8"), "46666\n");
  assert.equal(fs.readFileSync(f.config, "utf8"), f.original);
});

test("bridge startup may update other settings without losing those changes", async t => {
  const f = fixture(t);
  await ensureDeveloperBridgePort({
    ...f.options,
    ensure: async () => { fs.appendFileSync(f.config, 'sansFontSize = 17\n'); },
  });
  assert.equal(fs.readFileSync(f.config, "utf8"),
    f.original.replace("127.0.0.1:22691", "127.0.0.1:45555") + "sansFontSize = 17\n");
});

test("invalid pointer and allocated port fail before publishing configuration", async t => {
  const f = fixture(t);
  await assert.rejects(ensureDeveloperBridgePort({
    ...f.options, allocatePort: async () => 0,
  }), /Invalid developer bridge port/);
  fs.writeFileSync(f.pointer, "22691 extra\n");
  await assert.rejects(ensureDeveloperBridgePort(f.options), /exactly one decimal line/);
  assert.deepEqual(f.ensured, []);
  assert.equal(fs.readFileSync(f.config, "utf8"), f.original);
});
