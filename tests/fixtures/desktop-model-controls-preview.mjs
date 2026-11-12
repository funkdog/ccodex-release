// Optional visual QA fixture. It does not connect to a Desktop process.
import http from "node:http";
import {
  buildDesktopModelControlsPatch,
  desktopModelGroups,
} from "../../bridge/desktop-model-controls.mjs";

const catalog = { models: [
  {
    slug: "gpt-6-astra", display_name: "\u200BGPT-6 Astra", visibility: "hide",
    copilot: { base_model: "gpt-6-astra" },
  },
  ...[
    ["gpt-6-astra", "GPT-6 Astra", 400_000, 1_200_000],
    ["gpt-6-luna", "GPT-6 Luna", 400_000, 1_000_000],
    ["gpt-6-sol", "GPT-6 Sol", 400_000, 1_000_000],
  ].flatMap(([base, name, standard, long]) => [
    ["default", standard, "Standard"],
    ["long_context", long, "Long"],
  ].map(([tier, window, label]) => ({
    slug: `${base}--${tier === "default" ? "default" : "long"}-context`,
    display_name: `\u200B${name} · ${label} (${window / 1000}K prompt)`,
    context_window: window, visibility: "list",
    copilot: {
      base_model: base, context_tier: tier,
      default_context_window_tokens: standard,
      long_context_window_tokens: long,
    },
  }))),
] };
const models = catalog.models.filter(model => model.visibility === "list")
  .map(model => ({
    model: model.slug, displayName: model.display_name,
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"]
      .map(reasoningEffort => ({ reasoningEffort })),
  }));
const patch = buildDesktopModelControlsPatch(desktopModelGroups(catalog));
const html = `<!doctype html>
<html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Codex Copilot model controls preview</title>
<style>
  :root { --main-surface-primary:#171821; --main-surface-secondary:#292b37;
    --text-primary:#f6f6f8; --text-secondary:#b5b6c1; --text-tertiary:#8d8f9c;
    --border-light:#3c3e4b; }
  * { box-sizing:border-box; }
  body { margin:0; background:#0c0d13; color:var(--text-primary);
    font:14px/1.5 system-ui,sans-serif; min-height:100vh;
    display:flex; align-items:flex-end; justify-content:center; padding:48px 18px; }
  .composer { width:min(680px,100%); background:#14151e; border:1px solid #424654;
    border-radius:18px; padding:18px; box-shadow:0 24px 70px #0009; }
  .composer textarea { display:block; width:100%; height:100px; resize:none;
    background:transparent; color:inherit; border:0; outline:0; font:inherit; }
  .toolbar { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
  .toolbar button { background:#20212c; color:inherit; border:1px solid #424654;
    border-radius:10px; min-height:32px; padding:5px 12px; font:inherit; cursor:pointer; }
  .toolbar button:hover { background:#303241; }
  #status { margin-left:auto; color:#8d8f9c; font-size:12px; }
</style>
<div class="composer">
  <textarea placeholder="Delegate a task or paste a URL."></textarea>
  <div class="toolbar">
    <button type="button" aria-label="Select model" data-codex-intelligence-trigger="true">
      GPT-6 Astra · Long (1.2M prompt) · Max
    </button>
    <span id="status">Isolated model controls preview</span>
  </div>
</div>
<script>
  const models = ${JSON.stringify(models)};
  const trigger = document.querySelector('[data-codex-intelligence-trigger]');
  const props = {
    model: 'gpt-6-astra--long-context', reasoningEffort: 'max',
    modelOptions: models.map(model => ({ model, disabledReason: null })),
    models, modelOptionsDisabled: false, reasoningEffortDisabled: false,
    onBeforeSelectModel: () => true,
    async onSelectModel(model, effort) {
      props.model = model;
      props.reasoningEffort = effort;
      document.getElementById('status').textContent = model + ' / ' + effort;
      globalThis.__codexCopilotModelControlsV1?.refresh();
    },
  };
  const root = { tag: 3, stateNode: {} };
  const picker = { tag: 0, memoizedProps: props, return: root };
  const button = { tag: 5, stateNode: trigger, return: picker };
  root.stateNode.current = root;
  root.child = picker;
  picker.child = button;
  trigger.__reactFiber$preview = button;
  ${patch}
  requestAnimationFrame(() => {
    const view = new URLSearchParams(location.search).get('view');
    if (!view) return;
    trigger.click();
    if (view !== 'main') {
      document.querySelector('#codex-copilot-model-menu [data-cc-control="' + view + '"]')
        ?.click();
    }
  });
</script>
</html>`;

const port = Number(process.argv[2] || 22888);
const server = http.createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(html);
});
server.listen(port, "127.0.0.1", () => {
  console.log(`Model controls visual fixture: http://127.0.0.1:${port}/`);
});
setTimeout(() => server.close(), 180_000).unref();
