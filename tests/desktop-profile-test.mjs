import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-desktop-profile-test-"));
process.env.CODEX_COPILOT_HOME = root;
const { buildDesktopCatalog, resolveModelSelection } = await import("../bridge/catalog.mjs");
const {
  DESKTOP_CATALOG_FILE,
  catalogFilesHealthy,
  readCatalogGeneration,
  writeCatalogSnapshot,
} = await import("../bridge/catalog-store.mjs");
const { normalizeDesktopConfig, applyDesktopProfile } =
  await import("../bridge/desktop-profile.mjs");
const { overridesForConfig } = await import("../bridge/cli-launch-overrides.mjs");

const catalog = { models: [{
  slug: "gpt-test",
  display_name: "GPT Test",
  description: "Local synthetic model",
  visibility: "list",
  priority: 1,
  context_window: 128_000,
  max_context_window: 256_000,
  service_tiers: [{ id: "context-long", name: "256K", description: "128K" }],
  copilot: {
    base_model: "gpt-test",
    default_prompt_tokens: 128_000,
    long_context_prompt_tokens: 256_000,
    default_context_window_tokens: 128_000,
    long_context_window_tokens: 256_000,
  },
}] };

test("publication keeps the CLI catalog independent and repairs Desktop presets", () => {
  const first = writeCatalogSnapshot(catalog);
  assert.equal(first.changed, true);
  assert.equal(catalogFilesHealthy(catalog), true);
  const desktop = JSON.parse(fs.readFileSync(DESKTOP_CATALOG_FILE, "utf8"));
  assert.deepEqual(desktop.models.map((entry) => [entry.slug, entry.visibility]), [
    ["gpt-test", "hide"],
    ["gpt-test--default-context", "list"],
    ["gpt-test--long-context", "list"],
  ]);
  assert.deepEqual(desktop.models.map((entry) => entry.context_window),
    [128_000, 128_000, 256_000]);
  assert.equal(buildDesktopCatalog(catalog).models.length, 3);
  assert.equal(writeCatalogSnapshot(catalog).changed, false);

  const generation = readCatalogGeneration();
  fs.writeFileSync(DESKTOP_CATALOG_FILE, "corrupt", "utf8");
  assert.equal(catalogFilesHealthy(catalog), false);
  assert.equal(writeCatalogSnapshot(catalog).changed, true);
  assert.notEqual(readCatalogGeneration(), generation,
    "Catalog repair must notify an existing Desktop renderer");
  assert.equal(catalogFilesHealthy(catalog), true);
});

test("explicit Desktop presets override inherited service tiers without changing upstream model", () => {
  const upstream = [{
    id: "gpt-test",
    capabilities: { limits: { max_prompt_tokens: 128_000 } },
    codex_copilot_context: {
      default_prompt_tokens: 128_000,
      long_context_prompt_tokens: 256_000,
    },
  }];
  assert.deepEqual([
    resolveModelSelection(upstream, "gpt-test--default-context", "context-long"),
    resolveModelSelection(upstream, "gpt-test--long-context", null),
  ].map((selection) => [selection.model.id, selection.contextTier]), [
    ["gpt-test", "default"],
    ["gpt-test", "long_context"],
  ]);
});

test("Desktop config normalization preserves unrelated settings and respects explicit overrides", () => {
  const desktop = buildDesktopCatalog(catalog);
  const initial = 'model = "gpt-test"\nservice_tier = "context-long"\n'
    + 'model_reasoning_effort = "high"\n\n[mcp_servers.private]\nenabled = false\n';
  const long = normalizeDesktopConfig(initial, desktop);
  assert.match(long.config, /^model = "gpt-test--long-context"$/m);
  assert.doesNotMatch(long.config, /^service_tier\s*=/m);
  assert.match(long.config, /^\[mcp_servers.private\]\nenabled = false$/m);
  assert.equal(normalizeDesktopConfig(long.config, desktop).config, long.config);
  const standard = normalizeDesktopConfig(initial.replace('service_tier = "context-long"\n', ""), desktop);
  assert.match(standard.config, /^model = "gpt-test--default-context"$/m);
  assert.equal(normalizeDesktopConfig(
    initial.replace("context-long", "fast"), desktop,
  ).config, initial.replace("context-long", "fast"));
  const overridden = normalizeDesktopConfig(
    initial.replace('service_tier = "context-long"', "model_context_window = 90000"),
    desktop,
  );
  assert.equal(overridden.model, "gpt-test--default-context");
  assert.match(overridden.config, /^model_context_window = 90000$/m);
});

test("CLI translates a Desktop default back to its original /model tier", () => {
  assert.deepEqual(overridesForConfig('model = "gpt-test--long-context"\n'),
    { model: "gpt-test", serviceTier: "context-long" });
  assert.deepEqual(overridesForConfig(
    'model = "gpt-test--default-context"\nservice_tier = "context-long"\n',
  ), { model: "gpt-test", serviceTier: "default" });
  assert.equal(overridesForConfig('model = "gpt-test"\n'), null);
  assert.throws(() => overridesForConfig('model = "unsafe&name--long-context"\n'), /unsafe/);
});

test("Desktop launch reuses its published catalog without a blocking network refresh", async () => {
  fs.writeFileSync(path.join(root, "config.toml"),
    'model = "gpt-test"\nservice_tier = "context-long"\n[tui]\nraw_output_mode = false\n');
  let calls = 0;
  const refresh = async (url, options) => {
    assert.equal(url, "http://127.0.0.1:22999/catalog/refresh?max_age_ms=900000");
    assert.equal(options.method, "POST");
    calls++;
    return { ok: true };
  };
  const first = await applyDesktopProfile({ home: root, port: 22999, refresh });
  assert.deepEqual(first, {
    catalogModels: 3,
    changed: true,
    model: "gpt-test--long-context",
  });
  const updated = fs.readFileSync(path.join(root, "config.toml"), "utf8");
  assert.match(updated, /^\[tui\]\nraw_output_mode = false$/m);
  assert.doesNotMatch(updated, /^service_tier\s*=/m);
  assert.equal((await applyDesktopProfile({ home: root, port: 22999, refresh })).changed, false);
  assert.equal(calls, 0);
});

test("a missing Desktop catalog still requires an authorized refresh before startup", async () => {
  fs.unlinkSync(DESKTOP_CATALOG_FILE);
  let calls = 0;
  await applyDesktopProfile({ home: root, port: 22999, refresh: async () => {
    calls++;
    writeCatalogSnapshot(catalog);
    return { ok: true };
  } });
  assert.equal(calls, 1);
});

test.after(() => {
  assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
  assert.ok(path.basename(root).startsWith("ccodex-desktop-profile-test-"));
  fs.rmSync(root, { recursive: true, force: true });
});
