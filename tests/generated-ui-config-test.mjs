import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureManagedUiSettings } from "../tools/gen-config.mjs";

test("in-place UI migration preserves model, permissions and existing MCP configuration", () => {
  const preserved = 'model = "selected-model"\nmodel_reasoning_effort = "high"\n'
    + 'approval_policy = "on-request"\n\n[mcp_servers.private]\nenabled = false\n'
    + 'command = "unchanged-command"\n';
  const original = preserved + '\n[tui]\nraw_output_mode = true\nalternate_screen = "never"\n';
  const migrated = ensureManagedUiSettings(original);
  assert(migrated.startsWith(preserved));
  assert.match(migrated, /^raw_output_mode = false$/m);
  assert.match(migrated, /^alternate_screen = "always"$/m);
  assert.match(migrated, /"request-state".*"last-request-usage"/);
  const statusLine = migrated.match(/^status_line = (\[[^\n]+\])$/m)?.[1];
  assert.ok(statusLine, "generated status line must be present");
  assert.equal(statusLine.match(/"context-used"/g)?.length, 1);
  assert.doesNotMatch(statusLine, /"copilot-account"/, "Account usage belongs to the on-demand /usage command");
  assert.doesNotMatch(statusLine, /"context-tier"/);
  assert.equal(ensureManagedUiSettings(migrated), migrated);
});

test("generated UI migrates raw inline settings without modifying the stock profile", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-ui-config-"));
  const stock = path.join(root, "stock");
  const profile = path.join(root, "copilot");
  fs.mkdirSync(stock);
  fs.mkdirSync(profile);
  const original = 'approval_policy = "on-request"\n[tui]\nraw_output_mode = true\nalternate_screen = "never"\n[features]\nplugins = false\n';
  fs.writeFileSync(path.join(stock, "config.toml"), original);
  fs.writeFileSync(path.join(profile, "desktop-selection-generation.json"),
    JSON.stringify({ schemaVersion: 1, model: "gpt-test", effort: "high", contextTier: "default" }));
  fs.writeFileSync(path.join(profile, "cli-selection-generation.json"),
    JSON.stringify({ schemaVersion: 1, model: "cli-only", effort: "low", contextTier: "long_context" }));
  fs.writeFileSync(path.join(profile, "selection-generation.json"),
    JSON.stringify({ schemaVersion: 1, model: "obsolete-shared-default", effort: "low", contextTier: "default" }));
  fs.writeFileSync(path.join(profile, "models-desktop.json"), JSON.stringify({
    models: [{ slug: "gpt-test--default-context" }],
  }));
  try {
    execFileSync(process.execPath, [path.resolve(import.meta.dirname, "../tools/gen-config.mjs")], {
      env: { ...process.env, CODEX_COPILOT_SOURCE_HOME: stock, CODEX_COPILOT_HOME: profile },
      windowsHide: true,
    });
    const generated = fs.readFileSync(path.join(profile, "config.toml"), "utf8");
    assert.match(generated, /^raw_output_mode = false$/m);
    assert.match(generated, /^alternate_screen = "always"$/m);
    assert.match(generated, /"request-state".*"last-request-usage"/);
    assert.match(generated, /^status_line = \[[^\n]*"context-used"[^\n]*\]$/m);
    assert.doesNotMatch(generated.match(/^status_line = \[[^\n]*\]$/m)?.[0] || "", /"context-tier"/);
    assert.doesNotMatch(generated.match(/^status_line = \[[^\n]*\]$/m)?.[0] || "", /"copilot-account"/);
    assert.match(generated, /^model = "gpt-test--default-context"$/m);
    assert.doesNotMatch(generated, /cli-only|obsolete-shared-default/);
    assert.match(generated, /^model_catalog_json = ".*models-desktop\.json"$/m);
    assert.match(generated, /^approval_policy = "on-request"$/m);
    assert.match(generated, /^plugins = false$/m);
    assert.equal(fs.readFileSync(path.join(stock, "config.toml"), "utf8"), original);
  } finally {
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("repair keeps a newer /model selection instead of restoring an older shared snapshot", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-context-repair-"));
  const stock = path.join(root, "stock");
  const profile = path.join(root, "copilot");
  fs.mkdirSync(stock);
  fs.mkdirSync(profile);
  fs.writeFileSync(path.join(stock, "config.toml"), 'model = "stock"\n');
  fs.writeFileSync(path.join(profile, "selection-generation.json"), JSON.stringify({
    schemaVersion: 1,
    updatedAt: "2026-09-22T15:24:21.519Z",
    model: "older-model",
    effort: "low",
    contextTier: "default",
  }));
  fs.writeFileSync(path.join(profile, "config.toml"),
    'model = "current-model"\nmodel_reasoning_effort = "max"\nservice_tier = "context-long"\n');
  try {
    execFileSync(process.execPath, [path.resolve(import.meta.dirname, "../tools/gen-config.mjs")], {
      env: { ...process.env, CODEX_COPILOT_SOURCE_HOME: stock, CODEX_COPILOT_HOME: profile },
      windowsHide: true,
    });
    const generated = fs.readFileSync(path.join(profile, "config.toml"), "utf8");
    assert.match(generated, /^model = "current-model--long-context"$/m);
    assert.match(generated, /^model_reasoning_effort = "max"$/m);
    assert.doesNotMatch(generated, /^service_tier\s*=/m);
    assert.doesNotMatch(generated, /older-model/);
  } finally {
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a new profile's bridge port pointer configures the model provider without touching stock Codex", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-bridge-config-"));
  const stock = path.join(root, "stock");
  const profile = path.join(root, "copilot");
  fs.mkdirSync(stock);
  fs.mkdirSync(profile);
  const original = 'approval_policy = "on-request"\n';
  fs.writeFileSync(path.join(stock, "config.toml"), original);
  fs.writeFileSync(path.join(profile, "bridge-port.txt"), "22693\n");
  try {
    const environment = {
        ...process.env,
        CODEX_COPILOT_SOURCE_HOME: stock,
        CODEX_COPILOT_HOME: profile,
    };
    delete environment.CODEX_COPILOT_BRIDGE_PORT;
    execFileSync(process.execPath, [path.resolve(import.meta.dirname, "../tools/gen-config.mjs")], {
      env: environment,
      windowsHide: true,
    });
    const generated = fs.readFileSync(path.join(profile, "config.toml"), "utf8");
    assert.match(generated, /^base_url = "http:\/\/127\.0\.0\.1:22693"$/m);
    assert.equal(fs.readFileSync(path.join(stock, "config.toml"), "utf8"), original);
  } finally {
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
