import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { showCliUpdateNotice, refreshCliUpdateNotice } from "../bridge/cli-update-notice.mjs";
import { OFFICIAL_CLI_RELEASE } from "../bridge/cli-update.mjs";

const now = Date.parse("2026-10-03T10:00:00Z");
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-update-notice-"));
  const home = path.join(root, "private");
  fs.mkdirSync(home);
  const launched = [];
  const messages = [];
  const options = { root, home, now: () => now, launch: value => launched.push(value),
    output: value => messages.push(value),
    inspect: pid => ({ platform: process.platform, pid, lifetime: "notice-fixture-lifetime",
      executable: process.execPath, argv: [] }),
    selection: () => ({ manifest: { coreVersion: "codex-cli 0.145.0" } }) };
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
    assert.match(path.basename(root), /^ccodex-update-notice-/);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const cache = (version = "0.160.0", checkedAt = now) => {
    fs.mkdirSync(path.join(home, "cli-updates"), { recursive: true });
    fs.writeFileSync(path.join(home, "cli-updates", "official-release.json"), JSON.stringify({
      schemaVersion: 1, release: { source: OFFICIAL_CLI_RELEASE, version },
      checkedAt: new Date(checkedAt).toISOString(),
    }));
  };
  return { ...options, launched, messages, cache };
}

test("missing notice metadata launches a quiet refresh, coalescing repeated startup", t => {
  const f = fixture(t);
  assert.equal(showCliUpdateNotice(f).shown, false);
  assert.equal(showCliUpdateNotice(f).shown, false);
  assert.equal(f.launched.length, 1);
  assert.deepEqual(f.messages, []);
  assert.equal(fs.existsSync(path.join(f.home, "config.toml")), false);
});

test("a fresh newer official version is shown once without changing core or Desktop", t => {
  const f = fixture(t);
  f.cache();
  assert.equal(showCliUpdateNotice(f).shown, true);
  assert.equal(showCliUpdateNotice(f).shown, false);
  assert.equal(f.messages.length, 1);
  assert.match(f.messages[0], /0\.160\.0.*ccodex update check/);
  assert.equal(f.launched.length, 0);
  assert.equal(fs.existsSync(path.join(f.root, "bin", "core-current.txt")), false);
  assert.equal(fs.existsSync(path.join(f.root, "desktop")), false);
});

for (const version of ["0.145.0", "0.144.9"]) {
  test(`${version} is not advertised as a new core`, t => {
    const f = fixture(t);
    f.cache(version);
    assert.equal(showCliUpdateNotice(f).shown, false);
    assert.deepEqual(f.messages, []);
  });
}

test("expired metadata schedules refresh and labels the old checked date honestly", t => {
  const f = fixture(t);
  f.cache("0.160.0", now - 7 * 60 * 60000);
  showCliUpdateNotice(f);
  assert.equal(f.launched.length, 1);
  assert.match(f.messages[0], /checked 2026-10-03T03:00:00\.000Z/);
});

test("foreign and future-dated metadata cannot generate an update claim", t => {
  const f = fixture(t);
  f.cache("0.160.0", now + 10 * 60000);
  assert.equal(showCliUpdateNotice(f).metadataAvailable, false);
  assert.deepEqual(f.messages, []);
});

test("refresh calls only official metadata without credentials and releases its own lease", async t => {
  const f = fixture(t);
  showCliUpdateNotice(f);
  const { id } = f.launched[0];
  await refreshCliUpdateNotice({ home: f.home, id, now: () => now, inspect: f.inspect,
    request: async (url, options) => {
      assert.equal(url, OFFICIAL_CLI_RELEASE);
      assert.equal(options.headers.authorization, undefined);
      return new Response(JSON.stringify({ tag_name: "rust-v0.160.0", draft: false,
        prerelease: false, published_at: "2026-10-01T20:19:13Z" }));
    } });
  assert.equal(fs.existsSync(path.join(f.home, "cli-updates", "notice-refresh.lock")), false);
  assert.equal(showCliUpdateNotice(f).shown, true);
});

test("failed refresh cannot promote a core or retain its owned metadata lease", async t => {
  const f = fixture(t);
  showCliUpdateNotice(f);
  await assert.rejects(refreshCliUpdateNotice({ home: f.home, id: f.launched[0].id,
    inspect: f.inspect,
    request: async () => new Response("", { status: 503 }) }), /HTTP 503/);
  assert.equal(fs.existsSync(path.join(f.home, "cli-updates", "notice-refresh.lock")), false);
  assert.equal(fs.existsSync(path.join(f.home, "cli-updates", "official-release.json")), false);
});

test("a verified dead expired notice worker can be replaced, but a live lease is preserved", t => {
  const f = fixture(t);
  showCliUpdateNotice(f);
  const lock = path.join(f.home, "cli-updates", "notice-refresh.lock");
  const original = JSON.parse(fs.readFileSync(lock, "utf8"));
  original.createdAt = new Date(now - 3 * 60000).toISOString();
  fs.writeFileSync(lock, JSON.stringify(original));
  showCliUpdateNotice(f);
  assert.equal(f.launched.length, 1);
  showCliUpdateNotice({ ...f, inspect: pid => pid === process.pid
    ? { platform: process.platform, pid, lifetime: "replacement-lifetime", executable: process.execPath, argv: [] }
    : null });
  assert.equal(f.launched.length, 2);
  assert.notEqual(f.launched[1].id, original.id);
});
