import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { configEntries, stringArray } from "../tools/config-document.mjs";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-capability-audit-"));
process.env.CODEX_COPILOT_HOME = home;

const root = path.resolve(import.meta.dirname, "..");
const { CLI_STATUS_ITEMS, initializeCliSettings } = await import(
  pathToFileURL(path.join(root, "bridge", "surface-settings.mjs")).href
);
const { ensureManagedUiSettings } = await import(
  pathToFileURL(path.join(root, "tools", "gen-config.mjs")).href
);
const catalog = await import(
  `${pathToFileURL(path.join(root, "bridge", "catalog.mjs")).href}?test=${Date.now()}`
);
const audit = await import(
  `${pathToFileURL(path.join(root, "bridge", "request-audit.mjs")).href}?test=${Date.now()}`
);

test("generated Codex status keeps active, cumulative, and compaction fields distinct", () => {
  const shared = 'model = "synthetic-status-model"\nmodel_reasoning_effort = "max"\n';
  for (const generated of [ensureManagedUiSettings(shared), initializeCliSettings(shared)]) {
    const entry = configEntries(generated).find(item =>
      JSON.stringify([...(item.table || []), ...(item.key || [])]) === JSON.stringify(["tui", "status_line"]));
    assert.ok(entry, "The production configuration must contain native status fields.");
    const items = stringArray(entry.value);
    assert.deepEqual(items, CLI_STATUS_ITEMS);
    for (const name of ["context-used", "used-tokens", "compaction-count", "post-compaction-usage"]) {
      assert.equal(items.filter(item => item === name).length, 1, name);
    }
  }
});

test("patched Codex core exposes /context without a context service-tier command", () => {
  const source = fs.readFileSync(path.join(root, "patches", "codex-context-picker.patch"), "utf8");
  const windowsInput = fs.readFileSync(
    path.join(root, "patches", "codex-windows-input-record.patch"),
    "utf8",
  );
  const rendering = fs.readFileSync(path.join(root, "patches", "codex-render-status-v2.patch"), "utf8");
  assert.match(source, /SlashCommand::Context/);
  assert.match(source, /show current context-window usage/);
  assert.match(source, /tier\.id != LOCAL_CONTEXT_SERVICE_TIER/);
  assert.match(source, /EnableMouseCapture/);
  assert.match(windowsInput, /ensure_input_record_mode/);
  assert.match(windowsInput, /ENABLE_VIRTUAL_TERMINAL_INPUT/);
  assert.equal(
    rendering.match(/row_display: SelectionRowDisplay::SingleLine/g)?.length,
    2,
    "both native model pickers must use stable one-line rows",
  );
});

function model(overrides = {}) {
  return {
    id: "gpt-test",
    name: "GPT Test",
    vendor: "OpenAI",
    model_picker_enabled: true,
    supported_endpoints: ["/responses"],
    capabilities: {
      type: "chat",
      supports: {
        reasoning_effort: ["low", "high", "future-level"],
        vision: true,
      },
      limits: {
        max_prompt_tokens: 272_000,
        max_context_window_tokens: 400_000,
        max_output_tokens: 128_000,
      },
    },
    ...overrides,
  };
}

test("catalog never invents reasoning efforts", () => {
  const generated = catalog.buildCatalog([model()]).models[0];
  assert.deepEqual(
    generated.supported_reasoning_levels.map((item) => item.effort),
    ["low", "high"],
  );
  assert.match(generated.description, /reasoning: low\/high/);

  const noEffort = catalog.buildCatalog([
    model({
      id: "no-effort",
      capabilities: {
        type: "chat",
        supports: { vision: false },
        limits: {
          max_prompt_tokens: 168_000,
          max_context_window_tokens: 200_000,
          max_output_tokens: 32_000,
        },
      },
    }),
  ]).models[0];
  assert.deepEqual(noEffort.supported_reasoning_levels, []);
  assert.equal(noEffort.default_reasoning_level, undefined);
  assert.match(noEffort.description, /no configurable reasoning effort/);
});

test("request selection recognizes the current context-long service tier", () => {
  const longModel = model({
    codex_copilot_context: {
      default_prompt_tokens: 272_000,
      long_context_prompt_tokens: 922_000,
    },
    capabilities: {
      type: "chat",
      supports: {
        reasoning_effort: ["low", "high"],
        vision: true,
      },
      limits: {
        max_prompt_tokens: 272_000,
        max_context_window_tokens: 1_050_000,
        max_output_tokens: 128_000,
      },
    },
  });

  assert.equal(
    catalog.resolveModelSelection([longModel], "gpt-test", "context-long")?.contextTier,
    "long_context",
  );
  assert.equal(
    catalog.resolveModelSelection([longModel], "gpt-test--long-context")?.contextTier,
    "long_context",
  );
  assert.equal(
    catalog.resolveModelSelection([longModel], "gpt-test--default-context", "context-long")?.contextTier,
    "default",
  );
  assert.equal(catalog.resolveModelSelection([model()], "gpt-test", "context-long"), null);
  assert.equal(catalog.resolveModelSelection([model()], "gpt-test--default-context"), null);

  const cliCatalog = catalog.buildCatalog([longModel]);
  const desktopCatalog = catalog.buildDesktopCatalog(cliCatalog);
  assert.deepEqual(cliCatalog.models.map((entry) => entry.slug), ["gpt-test"],
    "The CLI must keep one model with its own Context selection step");
  assert.deepEqual(desktopCatalog.models.map((entry) => [entry.slug, entry.visibility]), [
    ["gpt-test", "hide"],
    ["gpt-test--default-context", "list"],
    ["gpt-test--long-context", "list"],
  ]);
  assert.deepEqual(desktopCatalog.models.map((entry) => entry.context_window),
    [272_000, 272_000, 922_000]);
  assert.equal(desktopCatalog.models[1].max_context_window, 272_000);
  assert.equal(desktopCatalog.models[2].max_context_window, 922_000);
  assert.deepEqual(desktopCatalog.models.slice(1).map((entry) => entry.service_tiers), [[], []]);
  assert.equal(catalog.buildDesktopCatalog(catalog.buildCatalog([model()])).models.length, 1);
});

test("request audit records proof fields and redacts request content", () => {
  const record = audit.startRequestAudit({
    surface: "ccodex",
    account: "test-user",
    requestedModel: "gpt-test",
    upstreamModel: "gpt-test",
    contextTier: "long_context",
    effectiveContextWindow: 922_000,
    endpoint: "/responses",
    request: {
      reasoning: { effort: "high" },
      input: [{ role: "user", content: "secret prompt" }],
      tools: [{ name: "secret-tool" }],
    },
  });
  record.complete({
    providerRequestId: "github-request",
    serviceRequestId: "copilot-request",
    usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 75 }, output_tokens: 20 },
  });
  const latest = audit.readLatestRequestAudit();
  assert.deepEqual(latest.usage, {
    input_tokens: 100,
    input_tokens_details: { cached_tokens: 75 },
    output_tokens: 20,
  });
  assert.equal(latest.serializedEffortPath, "reasoning.effort");
  assert.equal(latest.serializedEffort, "high");
  assert.equal(latest.contextTier, "long_context");
  assert.equal(latest.effectiveContextWindow, 922_000);
  const serialized = JSON.stringify(latest);
  assert.doesNotMatch(serialized, /secret prompt|secret-tool/);
});

test.after(() => {
  assert.equal(path.dirname(fs.realpathSync(home)), fs.realpathSync(os.tmpdir()));
  assert.ok(path.basename(home).startsWith("codex-capability-audit-"));
  fs.rmSync(home, { recursive: true, force: true });
});
