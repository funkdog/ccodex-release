import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { currentHostContracts } from "../bridge/desktop-current-host-contract.mjs";

for (const nativeDefault of [false, true]) test(`native same-source switching keeps the engine fixed with defaultNative=${nativeDefault}`, { timeout: 30000 }, async t => {
  const runtime = process.env.MYCODEX_TEST_PLAYWRIGHT ?? path.resolve(path.dirname(process.execPath), "../node_modules/playwright/index.mjs");
  const { chromium } = await import(pathToFileURL(runtime).href);
  const browser = await chromium.launch({ executablePath: process.env.MYCODEX_TEST_BROWSER ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
  t.after(() => browser.close()); const page = await browser.newPage({ viewport: { width: 1080, height: 680 } });
  page.setDefaultTimeout(5000);
  const root = path.resolve(import.meta.dirname, ".."), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("http://127.0.0.1/**", route => {
    const file = new URL(route.request().url()).pathname.slice(1);
    if (/^(?:bridge|tools)\/.+\.mjs$/.test(file)) return route.fulfill({ contentType: "text/javascript", body: fs.readFileSync(path.join(root, file), "utf8") });
    return route.fulfill({ contentType: "text/html; charset=utf-8", body: `<!doctype html><html style="color-scheme:light"><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0;background:Canvas;color:CanvasText;font:14px system-ui}main{min-height:680px;display:flex;align-items:end;padding:24px}.composer{width:100%;padding:16px;border:1px solid #8883;border-radius:22px;box-shadow:0 2px 8px #0001}[data-composer-input]>div{height:80px;outline:none}.footer{display:flex;align-items:center;gap:8px;min-height:32px}.access{white-space:nowrap;flex-shrink:0;color:#a86a35}.controls{display:flex;align-items:center;justify-content:end;flex:1;min-width:0}.send{border:0;border-radius:50%;background:#326fc5;color:white;flex:none;width:32px;height:32px}.native{white-space:nowrap;border:0;background:transparent;color:inherit}</style><main><section class="composer" data-composer-surface-variant="default"><div data-composer-input><div role="textbox" contenteditable="true">Draft remains unchanged.</div></div><footer class="footer"><span class="access">＋　完全访问</span><div class="controls"><button class="native" data-composer-navigation-target="reasoning">Codex · Viwo API · gpt-6.2-astra 无</button></div><button class="send" aria-label="发送">↑</button></footer></section></main></html>` });
  });
  await page.goto("http://127.0.0.1/");
  const originalHeight = await page.locator(".footer").evaluate(node => node.getBoundingClientRect().height);
  await page.evaluate(async ({ contract, nativeDefault }) => {
    const { mountCurrentNativeSessions } = await import("/bridge/desktop-native-composer.mjs");
    const id = "00000000-0000-0000-0000-000000000001", first = nativeDefault ? "gpt-6.2-astra" : "codex-copilot/api-aaaaaaaaaaaa--gpt-6.2-astra", second = nativeDefault ? "gpt-6.1-sol" : "codex-copilot/api-aaaaaaaaaaaa--gpt-6.1-sol", backup = "codex-copilot/api-bbbbbbbbbbbb--gpt-6.1-sol";
    const models = [{ id: first, label: "Codex · Viwo API · gpt-6.2-astra", sourceLabel: "Viwo API", nativeCopilot: true, efforts: ["none"], canSwitchModel: true },
      { id: second, label: "Codex · Viwo API · gpt-6.1-sol", sourceLabel: "Viwo API", nativeCopilot: true, efforts: ["none"], canSwitchModel: true },
      { id: backup, label: "Codex · Backup API · gpt-6.1-sol", sourceLabel: "Backup API", nativeCopilot: true, efforts: ["none"], canSwitchModel: true },
      { id: "copilot/other", label: "Copilot CLI · Other", canSwitchModel: true },
      { id: "codex-copilot/api-aaaaaaaaaaaa--fixed", label: "Codex · Viwo API · Fixed", nativeCopilot: true, canSwitchModel: false }];
    globalThis.hostModel = nativeDefault ? first : "mycodex/" + first; globalThis.hostCalls = []; globalThis.handoffs = []; globalThis.speedCalls = [];
    globalThis.codexWindowType = "electron"; globalThis.electronBridge = { getSentryInitOptions: () => ({ appVersion: contract.version }) };
    class Manager { startConversation() { throw new Error("No turn should be sent"); } setDefaultModelConfig() {} }
    const bus = { dispatchMessage() {}, dispatchHostMessage() {}, subscribe() { return () => {}; } };
    const editor = document.querySelector("[data-composer-input]"), button = document.querySelector(".native");
    const editorFiber = { stateNode: editor, memoizedProps: {} }, buttonFiber = { stateNode: button, memoizedProps: {} };
    const pickerFiber = { child: editorFiber, memoizedProps: { model: hostModel, reasoningEffort: "none", reasoningEffortDisabled: true,
      modelOptions: models.map(model => ({ disabledReason: model.canSwitchModel === false ? "Fixture model is unavailable" : undefined,
        model: { model: nativeDefault && !model.id.includes("/") ? model.id : "mycodex/" + model.id, supportedReasoningEfforts: [] } })),
      selectedServiceTier: null, serviceTierOptions: [{ value: null, label: "Standard" }, { value: "priority", iconKind: "fast", label: "Fast" }],
      onSelectServiceTier(value) { speedCalls.push(value); pickerFiber.memoizedProps = { ...pickerFiber.memoizedProps, selectedServiceTier: value }; },
      onSelectModel(model, effort) { hostCalls.push({ model, effort }); hostModel = model; pickerFiber.memoizedProps = { ...pickerFiber.memoizedProps, model, reasoningEffort: effort }; return true; } } };
    const routeFiber = { memoizedProps: { value: { location: { pathname: "/local/" + id, key: "existing" } } }, child: pickerFiber };
    globalThis.showNewDraft = () => {
      routeFiber.memoizedProps = { value: { location: { pathname: "/", key: "draft" } } };
      const workspace = document.createElement("button"); workspace.dataset.composerNavigationTarget = "workspace-project"; workspace.textContent = "Workspace";
      document.querySelector(".footer").prepend(workspace);
    };
    const rootFiber = { tag: 3, child: routeFiber, stateNode: {} }; rootFiber.stateNode.current = rootFiber;
    routeFiber.return = rootFiber; pickerFiber.return = routeFiber; editorFiber.return = pickerFiber; editorFiber.sibling = buttonFiber; buttonFiber.return = pickerFiber;
    editor.__reactFiber$fixture = editorFiber; button.__reactFiber$fixture = buttonFiber;
    globalThis.fixture = await mountCurrentNativeSessions({ window: globalThis,
      importModule: async url => url === contract.initialModule ? { __webpack_modules__: { [contract.managerModuleId]: () => { throw Error("No vendor initialization"); } } }
        : { __webpack_require__: Object.assign(() => { throw Error("No vendor initialization"); }, { c: {
          [contract.managerModuleId]: { exports: { [contract.managerExport]: Manager } }, [contract.busModuleId]: { exports: { [contract.busExport]: bus } },
        } }) },
      services: { listModels: async () => { if (nativeDefault) throw Error("Fixture gateway unavailable"); return models; }, listThreads: async () => ({ data: nativeDefault ? [] : [{ id, model: first, nativeProvider: "mycodex-copilot", reasoningEffort: "none" }], nextCursor: null }),
        updateSettings: async () => { throw Error("Native settings must not be sent to gateway storage"); },
        switchExecution: async params => { handoffs.push(params); throw Error("Cross-source handoff is not ready in this fixture"); } } });
  }, { contract: currentHostContracts.at(-1), nativeDefault });
  const trigger = page.getByRole("button", { name: "模型与引擎设置" }); await trigger.waitFor();
  await page.waitForFunction(() => getComputedStyle(document.querySelector(".native")).display === "none");
  assert.equal(await page.locator(".footer").evaluate(node => node.getBoundingClientRect().height), originalHeight);
  assert.equal(await page.locator('[data-mycodex-native-engine]').count(), 1);
  assert.equal(await page.getByRole("combobox", { name: "推理强度" }).count(), 0, "Unknown reasoning must not add another inline control");
  await trigger.click();
  await page.getByRole("combobox", { name: "模型", exact: true }).selectOption(nativeDefault ? "gpt-6.1-sol" : "mycodex/codex-copilot/api-aaaaaaaaaaaa--gpt-6.1-sol");
  assert.equal(await page.evaluate(() => hostCalls.length + handoffs.length), 0);
  await page.getByRole("button", { name: "应用切换" }).click();
  await page.waitForFunction(() => hostModel.endsWith("gpt-6.1-sol") && document.querySelector('[data-mycodex-native-engine]').shadowRoot.querySelector('.trigger').getAttribute('aria-expanded') === 'false');
  assert.equal(await page.evaluate(() => hostCalls.length), 1); assert.equal(await page.evaluate(() => handoffs.length), 0);
  assert.ok((await trigger.innerText()).includes("gpt-6.1-sol"));
  await trigger.click();
  assert.equal(await page.getByRole("combobox", { name: "执行引擎", exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole("combobox", { name: "执行引擎", exact: true }).locator("option").count(), 1);
  if (!nativeDefault) {
    assert.equal(await page.getByRole("combobox", { name: "模型来源" }).isDisabled(), true);
    assert.equal(await page.getByRole("combobox", { name: "模型来源" }).locator("option").count(), 1);
  }
  assert.equal(await page.getByRole("combobox", { name: "模型", exact: true }).locator("option").count(), 2);
  const speed = page.getByRole("combobox", { name: "响应速度", exact: true });
  if (nativeDefault) {
    assert.equal(await speed.inputValue(), "");
    await speed.selectOption("priority");
    await page.waitForFunction(() => speedCalls.length === 1);
    assert.equal(await speed.inputValue(), "priority");
    await speed.selectOption("");
    await page.waitForFunction(() => speedCalls.length === 2);
    assert.deepEqual(await page.evaluate(() => speedCalls), ["priority", null]);
    assert.equal(await speed.inputValue(), "");
    assert.equal(await page.getByRole("combobox", { name: "执行引擎", exact: true }).isDisabled(), true);
  } else assert.equal(await speed.isVisible(), false, "External engines must not inherit the native speed action");
  assert.equal(await page.evaluate(() => hostCalls.length), 1); assert.equal(await page.evaluate(() => handoffs.length), 0);
  assert.ok((await trigger.innerText()).includes(nativeDefault ? "gpt-6.1-sol" : "Viwo API")); assert.equal(await page.locator('[contenteditable]').innerText(), "Draft remains unchanged.");
  await page.keyboard.press("Escape");
  for (const width of [1080, 480, 360]) {
    await page.setViewportSize({ width, height: 680 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.equal(await page.locator(".footer").evaluate(node => node.getBoundingClientRect().height), originalHeight);
  }
  const directory = process.env.MYCODEX_CONTROLS_PREVIEW_DIR;
  if (directory && !nativeDefault) {
    fs.mkdirSync(directory, { recursive: true }); await page.setViewportSize({ width: 860, height: 680 });
    await page.locator('[contenteditable]').evaluate(node => { node.textContent = "和 Codex 一起工作"; node.style.color = "#999"; });
    for (const theme of ["light", "dark"]) {
      await page.evaluate(theme => { document.documentElement.style.colorScheme = theme; }, theme);
      await trigger.click();
      await page.screenshot({ path: path.join(directory, `execution-picker-${theme}.png`) }); await page.keyboard.press("Escape");
      await page.locator('[contenteditable]').focus();
      await page.locator(".composer").screenshot({ path: path.join(directory, `execution-picker-${theme}-compact.png`) });
    }
  }
  await page.setViewportSize({ width: 1080, height: 680 });
  await page.evaluate(() => showNewDraft());
  await page.waitForFunction(() => !document.querySelector('[data-mycodex-native-engine]').shadowRoot.querySelector('#engine').disabled);
  await trigger.click();
  const engine = page.getByRole("combobox", { name: "执行引擎", exact: true });
  assert.equal(await engine.isDisabled(), false);
  assert.ok(await engine.locator('option[value=""]').count(), "New drafts must offer the app's default engine");
  if (!nativeDefault) {
    await engine.selectOption("copilot");
    await page.getByRole("button", { name: "应用切换" }).click();
    await page.waitForFunction(() => hostModel === "mycodex/copilot/other");
    assert.equal(await page.evaluate(() => handoffs.length), 0);
  }
  await page.evaluate(() => fixture.dispose()); assert.equal(await page.locator(".native").isVisible(), true); assert.deepEqual(errors, []);
});
