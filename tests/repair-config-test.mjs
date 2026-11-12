import assert from "node:assert/strict";
import test from "node:test";
import { configEntries, editSettings, readSetting, stringArray } from "../tools/config-document.mjs";
import { inheritedConfig, ensureManagedUiSettings, ensureChildIsolationSettings } from "../tools/gen-config.mjs";
import { initializeCliSettings } from "../bridge/surface-settings.mjs";
import { normalizeDesktopConfig } from "../bridge/desktop-profile.mjs";
import { memoryModelSelection } from "./fixtures/responses-bridge.mjs";

const nativeNumber = (text, key) => {
  const entry = configEntries(text).find(item =>
    item.table.length === 0 && item.key?.length === 1 && item.key[0] === key);
  return Number(entry?.value.replace(/#.*/s, "").replaceAll("_", "").trim());
};

test("native context, compaction threshold and prompt survive seeding and repeated repair", () => {
  const native = 'model_context_window = 90000 # user window\n'
    + 'model_auto_compact_token_limit = 45000 # user threshold\n'
    + 'compact_prompt = "SYNTHETIC_NATIVE_COMPACTION"\n';
  for (const existing of [null, `model = "synthetic-model"\n${native}`]) {
    const result = inheritedConfig({
      existing, source: `model = "stock"\n${native}`, sourceHome: "/stock", targetHome: "/copilot",
    });
    assert.equal(nativeNumber(result, "model_context_window"), 90000);
    assert.equal(nativeNumber(result, "model_auto_compact_token_limit"), 45000);
    assert.equal(readSetting(result, [], "compact_prompt"), "SYNTHETIC_NATIVE_COMPACTION");
    assert.equal(inheritedConfig({ existing: result }), result);
    assert.ok(result.includes("# user threshold"));
  }
});

test("CLI initialization preserves existing native policy and migrates legacy profile overrides", () => {
  const shared = 'model = "synthetic-model--long-context"\nmodel_reasoning_effort = "max"\n'
    + 'model_context_window = 90000\nmodel_auto_compact_token_limit = 45000\n'
    + 'compact_prompt = "SYNTHETIC_SHARED"\n'
    + '[profiles.ccodex]\nmodel_auto_compact_token_limit = 30000\n';
  const seeded = initializeCliSettings(shared);
  assert.equal(nativeNumber(seeded, "model_context_window"), 90000);
  assert.equal(nativeNumber(seeded, "model_auto_compact_token_limit"), 30000);
  assert.equal(readSetting(seeded, [], "compact_prompt"), "SYNTHETIC_SHARED");
  const existing = seeded.replace("30000", "25000");
  const repaired = initializeCliSettings(shared, existing);
  assert.equal(nativeNumber(repaired, "model_auto_compact_token_limit"), 25000);
  assert.equal(initializeCliSettings(shared, repaired), repaired);
});

test("Desktop alias synchronization preserves explicit native window and compaction policy", () => {
  const config = 'model = "synthetic-model"\nservice_tier = "context-long"\n'
    + 'model_context_window = 90000\nmodel_auto_compact_token_limit = 45000\n';
  const catalog = { models: [{
    slug: "synthetic-model--long-context", visibility: "list",
    copilot: { context_tier: "long_context" },
  }] };
  const result = normalizeDesktopConfig(config, catalog);
  assert.equal(result.model, "synthetic-model--long-context");
  assert.equal(nativeNumber(result.config, "model_context_window"), 90000);
  assert.equal(nativeNumber(result.config, "model_auto_compact_token_limit"), 45000);
  assert.equal(normalizeDesktopConfig(result.config, catalog).config, result.config);
});

for (const surface of ["desktop", "cli"]) {
  test(`${surface} model and Context switches retain native compact policy and supported current effort`, () => {
    const config = 'model = "synthetic-model"\nmodel_reasoning_effort = "max"\n'
      + 'model_context_window = 90000\nmodel_auto_compact_token_limit = 45000\n'
      + 'compact_prompt = "SYNTHETIC_NATIVE_COMPACTION"\n';
    const model = {
      slug: "synthetic-model", display_name: "Synthetic", default_reasoning_level: "medium",
      supported_reasoning_levels: [{ effort: "medium" }, { effort: "max" }],
      copilot: { base_model: "synthetic-model", long_context_prompt_tokens: 922000 },
    };
    const selection = memoryModelSelection(config, config, { models: [model] });
    for (const tier of ["long_context", "default"]) {
      const result = selection.use(model.slug, undefined, tier, { surface });
      assert.equal(result.effort, "max");
      const updated = selection.config(surface);
      assert.equal(nativeNumber(updated, "model_context_window"), 90000);
      assert.equal(nativeNumber(updated, "model_auto_compact_token_limit"), 45000);
      assert.equal(readSetting(updated, [], "compact_prompt"), "SYNTHETIC_NATIVE_COMPACTION");
    }
  });
}

test("repair does not restore stale stock configuration over current user and Desktop settings", () => {
  const current = `approval_policy = "on-request"
approvals_reviewer = "user"
[mcp_servers.private]
enabled = false
model = "not-a-root-model"
[mcp_servers.node_repl.env]
SKY_CUA_NATIVE_PIPE_DIRECTORY = 'current-owned-pipe'
[plugins."future-plugin@private"]
enabled = false
[model_providers.private]
name = "Keep"
[profiles.work]
model = "profile-model"
[desktop]
conversationDetailMode = "STEPS_EXECUTION"
futurePreference = "preserved"
`;
  const result = inheritedConfig({
    existing: current, source: 'approval_policy = "never"\n',
    sourceHome: "/stock", targetHome: "/copilot",
  });
  assert.equal(result, current);
  assert.equal(inheritedConfig({ existing: result }), result);
});

test("migration only replaces root selection and the owned provider", () => {
  const config = `model = "old"\n[model_providers.github-copilot]\nname = "old"\n[model_providers.github-copilot.auth]\ncommand = "old"\n[profiles.p]\nmodel = "keep"\n`;
  assert.equal(inheritedConfig({ existing: config }), '[profiles.p]\nmodel = "keep"\n');
});

test("multiline TOML and quoted table names survive targeted edits", () => {
  const config = `title = """line one
[desktop]
model = "not a setting"
"""
notify = [
  "program",
  "argument",
]
[mcp_servers."custom.server"]
enabled = false
[desktop] # comment
conversationDetailMode = "STEPS_PROSE"
`;
  const result = editSettings(config, ["desktop"], { conversationDetailMode: '"STEPS_EXECUTION"' });
  assert.equal(result, config.replace('conversationDetailMode = "STEPS_PROSE"', 'conversationDetailMode = "STEPS_EXECUTION"'));
  assert.equal(readSetting(result, ["mcp_servers", "custom.server"], "enabled"), false);
  assert.equal(editSettings(result, ["desktop"], { conversationDetailMode: '"STEPS_EXECUTION"' }), result);
});

test("invalid multiline input fails closed instead of deleting user settings", () => {
  assert.throws(() => editSettings('title = """unclosed\n[desktop]\n', ["desktop"], { x: "true" }), /Unclosed/);
});

test("UI migration enables native execution details without hiding tool output", () => {
  const result = ensureManagedUiSettings('[desktop]\nconversationDetailMode = "STEPS_PROSE"\n');
  assert.equal(readSetting(result, ["desktop"], "conversationDetailMode"), "STEPS_EXECUTION");
});

test("UI repair retains native and future reasoning efforts instead of resetting their list", () => {
  for (const input of [
    "[desktop]\nenabled-reasoning-efforts = ['persistent', 'future-effort', 'high']\n",
    "desktop.enabled-reasoning-efforts = ['persistent', 'future-effort', 'high']\n",
  ]) {
    const result = ensureManagedUiSettings(input);
    const array = result.match(/enabled-reasoning-efforts = (\[[^\n]+\])/)?.[1];
    const efforts = stringArray(array);
    assert.deepEqual(efforts.slice(0, 3), ["persistent", "future-effort", "high"]);
    assert.ok(efforts.includes("max"));
    assert.ok(efforts.includes("ultra"));
    assert.equal(efforts.filter(effort => effort === "high").length, 1);
    assert.equal(ensureManagedUiSettings(result), result);
  }
});

for (const selected of [false, true]) {
  test(`UI repair preserves the explicit Desktop Ultra picker preference ${selected}`, () => {
    for (const input of [
      `[desktop]\nshow-ultra-in-model-picker-slider = ${selected} # user preference\n`,
      `desktop.show-ultra-in-model-picker-slider = ${selected} # user preference\n`,
    ]) {
      const result = ensureManagedUiSettings(input);
      assert.equal(readSetting(result, ["desktop"], "show-ultra-in-model-picker-slider"), selected);
      assert.ok(result.includes(`# user preference\n`));
      assert.equal(ensureManagedUiSettings(result), result);
    }
  });
}

test("UI repair initializes an absent Ultra picker preference without resetting later changes", () => {
  const generated = ensureManagedUiSettings('[desktop]\nfuturePreference = "unchanged"\n');
  assert.equal(readSetting(generated, ["desktop"], "show-ultra-in-model-picker-slider"), true);
  const selected = editSettings(generated, ["desktop"], { "show-ultra-in-model-picker-slider": "false" });
  assert.equal(ensureManagedUiSettings(selected), selected);
  assert.equal(readSetting(selected, ["desktop"], "futurePreference"), "unchanged");
});

test("a first-time profile containing only the managed Work IQ block still inherits native capabilities", () => {
  const existing = "# BEGIN CCODEX MANAGED WORKIQ\n[mcp_servers.workiq]\nenabled = false\n# END CCODEX MANAGED WORKIQ\n";
  const source = "[mcp_servers.example]\ncommand = 'example'\n";
  const result = inheritedConfig({ existing, source, sourceHome: "/stock", targetHome: "/copilot" });
  assert.ok(result.includes(source));
  assert.ok(result.includes(existing));
});

test("repair preserves the Work IQ ownership marker immediately after the replaced provider table", () => {
  const block = "# BEGIN CCODEX MANAGED WORKIQ\n[mcp_servers.workiq]\nenabled = false\n# END CCODEX MANAGED WORKIQ\n";
  const config = `[model_providers.github-copilot.auth]\ncommand = "old"\n\n${block}`;
  const result = inheritedConfig({ existing: config });
  assert.ok(result.includes(block));
});

test("enhanced shell children do not export their profile or native Desktop identity into stock apps", () => {
  const original = '[shell_environment_policy]\nexclude = ["USER_PRIVATE_*"]\n';
  const configured = ensureChildIsolationSettings(original);
  assert.ok(configured.includes('"USER_PRIVATE_*"'));
  for (const key of ["CODEX_HOME", "CODEX_CLI_PATH", "CODEX_COPILOT_*",
    "CODEX_ELECTRON_USER_DATA_PATH", "NODE_REPL_*", "SKY_CUA_*", "BROWSER_USE_*"]) {
    assert.ok(configured.includes(JSON.stringify(key)), key);
  }
  assert.equal(ensureChildIsolationSettings(configured), configured);
  assert.equal(original, '[shell_environment_policy]\nexclude = ["USER_PRIVATE_*"]\n');
});

test("shell isolation preserves literal strings, comments, hashes and trailing commas", () => {
  const original = `[shell_environment_policy]
exclude = [
  'PRIVATE_#_*', # this is a comment, not part of the previous string
  "OTHER_\\u002a",
  'BACKSLASH_\\_*',
]
`;
  const configured = ensureChildIsolationSettings(original);
  const array = stringArray(configured.match(/^exclude = ([^\n]+)/m)[1]);
  assert.deepEqual(array.slice(0, 3), ["PRIVATE_#_*", "OTHER_*", "BACKSLASH_\\_*"]);
  assert.ok(array.includes("CODEX_HOME"));
  assert.equal(ensureChildIsolationSettings(configured), configured);
  assert.ok(original.includes("# this is a comment"));
});

test("string-array parsing supports TOML Unicode and multiline strings without running code", () => {
  assert.deepEqual(stringArray('["\\U0001F680", \'literal#value\',] # comment'),
    ["\u{1f680}", "literal#value"]);
  assert.deepEqual(stringArray(`["""\nFOO_\\\n  BAR""", '''\nBAZ_*''']`), ["FOO_BAR", "BAZ_*"]);
  for (const invalid of ['[1]', '[true]', '["missing quote]', '["\\q"]',
    '["\\uD800"]', '["\\U00110000"]', '["FOO"] + process.exit()']) {
    assert.throws(() => stringArray(invalid), /valid TOML string array/);
  }
});

test("environment names containing parentheses are quoted and remain stable on repair", () => {
  const text = editSettings("", ["shell_environment_policy", "set"], {
    "ProgramFiles(x86)": '"private-programs"',
  });
  assert.match(text, /^"ProgramFiles\(x86\)" = "private-programs"$/m);
  assert.equal(readSetting(text, ["shell_environment_policy", "set"], "ProgramFiles(x86)"), "private-programs");
  assert.equal(editSettings(text, ["shell_environment_policy", "set"], {
    "ProgramFiles(x86)": '"private-programs"',
  }), text);
});
