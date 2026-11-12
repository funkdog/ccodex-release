import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { prepareDesktopState } from "../release/desktop-preparation.mjs";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-desktop-preparation-"));
test.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
const result = { sqliteReady: true, profileVerified: true, stateQueryVerified: true, modelRequestsSent: false };

function fixture(name) {
  const root = path.join(temporary, name);
  const home = path.join(root, "profile");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(root, "release.json"), '{"releaseId":"private-slot"}');
  fs.writeFileSync(path.join(home, "config.toml"), 'model = "test"\ncli_auth_credentials_store = "file"\n');
  const runtime = { manifest: { version: "fixed" } };
  let calls = 0;
  return { root, home, runtime, env: {}, calls: () => calls,
    async verify() {
      calls++;
      fs.writeFileSync(path.join(home, "state_5.sqlite"), "synthetic-state-not-a-real-database");
      return result;
    } };
}

test("state validated during installation need not spawn a second backend on unchanged startup", async () => {
  const f = fixture("reuse");
  assert.deepEqual(await prepareDesktopState(f), result);
  assert.deepEqual(await prepareDesktopState(f), result);
  assert.equal(f.calls(), 1);
});

test("missing state requires a new native state query before GUI startup", async () => {
  const f = fixture("missing");
  await prepareDesktopState(f);
  fs.unlinkSync(path.join(f.home, "state_5.sqlite"));
  await prepareDesktopState(f);
  assert.equal(f.calls(), 2);
});

test("user model or language preferences do not invalidate native resource bindings", async () => {
  const f = fixture("preference");
  await prepareDesktopState(f);
  fs.appendFileSync(path.join(f.home, "config.toml"), '\n[desktop]\nlocaleOverride = "en-US"\n');
  await prepareDesktopState(f);
  assert.equal(f.calls(), 1);
});

test("native binding changes force fresh validation, without deleting state or credentials", async () => {
  const f = fixture("binding");
  await prepareDesktopState(f);
  fs.appendFileSync(path.join(f.home, "config.toml"), '\n[mcp_servers.node_repl]\ncommand = "new-native-repl"\n');
  await prepareDesktopState(f);
  assert.equal(f.calls(), 2);
});

test("failed native validation never publishes an installation-ready marker", async () => {
  const f = fixture("failed");
  await assert.rejects(prepareDesktopState({ ...f, verify: async () => { throw new Error("sqlite failed"); } }),
    /sqlite failed/);
  assert.equal(fs.existsSync(path.join(f.home, "desktop-preparation.json")), false);
});
