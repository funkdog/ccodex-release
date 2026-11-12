import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { currentHostContracts } from "../bridge/desktop-current-host-contract.mjs";

test("the engine picker commits through the host's native draft action before a host-RPC create", { timeout: 30000 }, async () => {
  const runtime = process.env.MYCODEX_TEST_PLAYWRIGHT ?? path.resolve(path.dirname(process.execPath), "../node_modules/playwright/index.mjs");
  const { chromium } = await import(pathToFileURL(runtime).href);
  const browser = await chromium.launch({ executablePath: process.env.MYCODEX_TEST_BROWSER ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
  const root = path.resolve(import.meta.dirname, ".."), errors = [];
  const files = new Set(["bridge/desktop-native-session.mjs", "bridge/desktop-native-composer.mjs", "bridge/desktop-execution-model.mjs", "bridge/diy/execution-picker.mjs", "bridge/desktop-model-controls.mjs", "bridge/desktop-native-context.mjs", "bridge/desktop-current-host-contract.mjs", "tools/typescript-runtime.mjs"]);
  try {
    const page = await browser.newPage(); page.on("pageerror", error => errors.push(error.message));
    await page.route("http://127.0.0.1/**", route => {
      const file = new URL(route.request().url()).pathname.slice(1);
      return route.fulfill(files.has(file) ? { contentType: "text/javascript", body: fs.readFileSync(path.join(root, file), "utf8") }
        : { contentType: "text/html", body: '<main><section data-composer-surface-variant="default"><div data-composer-input><div role="textbox" contenteditable="true">preserved draft</div><button data-composer-navigation-target="workspace-project">Project</button></div><footer><button data-codex-intelligence-trigger data-composer-navigation-target="reasoning">Native model</button></footer></section></main>' });
    });
    await page.goto("http://127.0.0.1/");
    await page.evaluate(async contract => {
      const { mountCurrentNativeSessions } = await import("/bridge/desktop-native-composer.mjs");
      globalThis.hostModel = "gpt-6-astra"; globalThis.hostEffort = "medium"; globalThis.hostCalls = [];
      globalThis.approvalSaves = [];
      const models = [{ id: "copilot/sol", label: "Copilot CLI", efforts: ["medium", "high"], defaultEffort: "medium", approvalModes: ["ask", "auto", "deny"], defaultCliApprovalMode: "auto" },
        { id: "antigravity/gemini", label: "Antigravity", efforts: ["medium", "high"], defaultEffort: "medium" },
        { id: "codex-copilot/sol", label: "Codex + Copilot", efforts: ["medium", "high"], defaultEffort: "medium", nativeCopilot: true },
        { id: "copilot/rejected", label: "Rejected fixture", efforts: ["medium"], defaultEffort: "medium" }];
      globalThis.codexWindowType = "electron"; globalThis.electronBridge = { getSentryInitOptions: () => ({ appVersion: contract.version }) };
      class Manager { startConversation() { throw new Error("Host RPC never invokes the renderer Manager"); } setDefaultModelConfig() {} }
      const bus = { dispatchMessage() {}, dispatchHostMessage() {}, subscribe() { return () => {}; } };
      const editor = document.querySelector("[data-composer-input]"), button = document.querySelector("[data-codex-intelligence-trigger]");
      if (contract.moduleFormat === "rspack-cache") button.removeAttribute("data-codex-intelligence-trigger");
      const editorFiber = { stateNode: editor, memoizedProps: {} }, buttonFiber = { stateNode: button, memoizedProps: {} };
      const pickerFiber = { child: editorFiber, memoizedProps: { model: hostModel, reasoningEffort: hostEffort,
        modelOptions: [{ model: { model: hostModel, isDefault: true, defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] } },
          ...models.map(model => ({ model: { model: "mycodex/" + model.id, defaultReasoningEffort: model.defaultEffort, supportedReasoningEfforts: model.efforts.map(reasoningEffort => ({ reasoningEffort })) } }))],
        async onSelectModel(model, effort) { hostCalls.push({ model, effort }); if (model.endsWith("/rejected")) return false;
          if (globalThis.holdSelection) await new Promise(resolve => { globalThis.releaseSelection = resolve; });
          hostModel = model; hostEffort = effort; pickerFiber.memoizedProps = { ...pickerFiber.memoizedProps, model, reasoningEffort: effort }; return true; } } };
      const routeFiber = { memoizedProps: { value: { location: { pathname: "/", key: "draft" } } }, child: pickerFiber };
      const rootFiber = { tag: 3, child: routeFiber, stateNode: {} }; rootFiber.stateNode.current = rootFiber;
      routeFiber.return = rootFiber; pickerFiber.return = routeFiber; editorFiber.return = pickerFiber; editorFiber.sibling = buttonFiber; buttonFiber.return = pickerFiber;
      editor.__reactFiber$fixture = editorFiber; button.__reactFiber$fixture = buttonFiber;
      globalThis.fixtureUi = await mountCurrentNativeSessions({ window: globalThis,
        importModule: async url => contract.moduleFormat === "rspack-cache"
          ? url === contract.initialModule ? { __webpack_modules__: { [contract.managerModuleId]: () => { throw Error("No factory execution"); } } }
            : { __webpack_require__: Object.assign(() => { throw Error("No vendor initialization"); }, { c: {
              [contract.managerModuleId]: { exports: { [contract.managerExport]: Manager } },
              [contract.busModuleId]: { exports: { [contract.busExport]: bus } },
            } }) }
          : url === contract.initialModule ? { [contract.managerExport]: Manager } : { [contract.busExport]: bus },
        services: { listModels: async () => models, listThreads: async () => ({ data: [], nextCursor: null }),
          setApprovalDefault: async settings => { approvalSaves.push(settings); return { cliApprovalMode: settings.cliApprovalMode }; },
          updateSettings: async () => { throw new Error("No working chat may be changed"); } } });
      globalThis.hostCreate = () => ({ model: hostModel, effort: hostEffort });
      globalThis.changeRoute = () => { routeFiber.memoizedProps.value.location = { pathname: "/local/00000000-0000-0000-0000-000000000001", key: "other" }; };
    }, currentHostContracts.at(-1));
    const picker = page.getByRole("combobox", { name: "模型", exact: true });
    const open = async () => { const trigger = page.getByRole("button", { name: "模型与引擎设置" }); if (await trigger.getAttribute("aria-expanded") !== "true") await trigger.click(); };
    const choose = async model => { await open(); await page.getByRole("combobox", { name: "执行引擎", exact: true }).selectOption(model.replace(/^mycodex\//, "").split("/")[0]); await picker.selectOption(model); await page.getByRole("button", { name: "应用切换" }).click(); await page.waitForFunction(() => document.querySelector('[data-mycodex-native-engine]').shadowRoot.querySelector('.trigger').getAttribute('aria-expanded') === 'false'); };
    await choose("mycodex/copilot/sol");
    assert.equal(await page.evaluate(() => hostCalls.length), 1, "A renderer-only selection must not leave the host on Astra");
    await page.waitForFunction(() => fixtureUi.controller.selection() === "mycodex/copilot/sol");
    await open();
    const policy = page.getByRole("combobox", { name: "工具审批" });
    assert.equal(await policy.inputValue(), "auto", "Host-RPC drafts must display the durable backend default");
    await policy.selectOption("ask");
    await page.waitForFunction(() => approvalSaves.length === 1 && fixtureUi.controller.preferences().cliApprovalMode === "ask");
    assert.deepEqual(await page.evaluate(() => approvalSaves), [{ model: "mycodex/copilot/sol", cliApprovalMode: "ask" }], "The host creates via main-process RPC, so a memory-only draft setting is insufficient");
    assert.deepEqual(await page.evaluate(() => hostCreate()), { model: "mycodex/copilot/sol", effort: "medium" });
    await page.getByRole("combobox", { name: "推理强度" }).selectOption("high");
    await page.waitForFunction(() => hostEffort === "high");
    assert.equal(await page.evaluate(() => hostCreate().effort), "high");
    await picker.selectOption("mycodex/copilot/rejected");
    await page.getByRole("button", { name: "应用切换" }).click();
    await page.getByRole("status").filter({ hasText: "拒绝" }).waitFor();
    assert.equal(await page.evaluate(() => fixtureUi.controller.selection()), "mycodex/copilot/sol");
    assert.equal(await page.evaluate(() => hostCreate().model), "mycodex/copilot/sol");
    assert.equal(await page.locator("[contenteditable]").innerText(), "preserved draft");
    for (const model of ["mycodex/antigravity/gemini", "mycodex/codex-copilot/sol"]) {
      await choose(model); await page.waitForFunction(model => hostModel === model, model);
      assert.equal(await page.evaluate(() => hostCreate().model), model);
    }
    await choose(""); await page.waitForFunction(() => hostModel === "gpt-6-astra");
    assert.equal(await page.evaluate(() => fixtureUi.controller.selection()), null);
    await page.evaluate(() => fixtureUi.dispose());
    assert.equal(await page.locator("[data-mycodex-native-engine]").count(), 0);
    assert.equal(await page.locator('[data-composer-navigation-target="reasoning"]').isVisible(), true);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
