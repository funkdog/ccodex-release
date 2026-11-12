import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { mountCliSelector, buildCliSelectorPatch } from "../bridge/desktop-cli-selector.mjs";

export async function probeCliSelector({ playwright, executablePath }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-selector-ui-"));
  const { chromium } = await import(pathToFileURL(playwright).href);
  const browser = await chromium.launch({ executablePath, headless: true });
  const report = { recordedAt: new Date().toISOString(), environment: "isolated-browser-fixture", desktopTouched: false, checks: {} };
  let page;
  try {
    page = await browser.newPage({ viewport: { width: 1000, height: 720 } });
    // A loopback fixture has the secure-origin browser APIs used by app://.
    // Fulfill in the test process: no external website or server is contacted.
    await page.route("http://127.0.0.1/selector-fixture", route => route.fulfill({ contentType: "text/html", body: "<!doctype html>" }));
    await page.goto("http://127.0.0.1/selector-fixture");
    await page.setContent('<html><head><title>MyCodex selector test</title></head><body style="margin:0;background:#14161b;color:#bec4cf;font:16px system-ui;padding:48px"><h1>MyCodex · CLI 选择器</h1><p>独立交互验证页面 · 使用合成数据 · 非当前 ChatGPT 界面</p><p>组件只通过注入的业务函数读取模型、创建空会话。</p></body></html>');
    let creates = 0, opens = 0, release, saved;
    const hold = new Promise(resolve => { release = resolve; });
    await page.exposeFunction("fixtureModels", () => [{ id: "copilot/test-model", label: "GitHub Copilot · 测试模型" },
      { id: "copilot/escaped", label: '<img src=x onerror="window.injected=true">' }]);
    await page.exposeFunction("fixtureCreate", async request => {
      creates++; assert.equal(request.model, "copilot/test-model"); assert.equal(request.cwd, "/tmp/mycodex-probe");
      await hold; return { id: "00000000-0000-0000-0000-000000000001" };
    });
    await page.exposeFunction("fixtureOpen", () => { if (++opens === 1) throw new Error("Synthetic navigation failure"); });
    await page.exposeFunction("fixtureHistory", () => ({ data: [{ id: "00000000-0000-0000-0000-000000000002", title: "之前创建的 CLI 会话", model: "copilot/test-model", cwd: "/tmp/mycodex-probe" }], nextCursor: null }));
    await page.exposeFunction("fixtureSave", value => { saved = value; });
    await page.evaluate(`globalThis.selector = (${mountCliSelector.toString()})({document, container:document.body,
      services:{listModels:()=>fixtureModels(),listThreads:()=>fixtureHistory(),createThread:params=>fixtureCreate(params)},openThread:id=>fixtureOpen(id),
      preferences:{read:()=>({}),write:value=>fixtureSave(value)}})`);
    await page.getByRole("button", { name: "MyCodex · CLI 会话", exact: true }).click();
    await page.getByRole("option", { name: "GitHub Copilot · 测试模型" }).waitFor({ state: "attached" });
    await page.waitForFunction(() => document.querySelector('[data-mycodex-cli-selector]').shadowRoot.querySelector('input').value === '/tmp/mycodex-probe');
    report.checks.workspaceRecoveredFromHistory = true;
    assert.equal(await page.locator('[data-mycodex-cli-selector]').evaluate(host => host.shadowRoot.querySelectorAll("img").length), 0);
    report.checks.untrustedLabelsAreText = true;
    await page.screenshot({ path: path.join(root, "selector.png") });
    await page.locator('[data-mycodex-cli-selector]').evaluate(host => {
      const form = host.shadowRoot.querySelector("form");
      form.dispatchEvent(new Event("submit", { cancelable: true })); form.dispatchEvent(new Event("submit", { cancelable: true }));
    });
    await page.waitForFunction(() => document.querySelector('[data-mycodex-cli-selector]').shadowRoot.querySelector('[type="submit"]').disabled);
    release();
    await page.getByText("Synthetic navigation failure", { exact: false }).waitFor();
    assert.equal(creates, 1); report.checks.doubleSubmitCreatesOnce = true;
    await page.getByRole("button", { name: "打开会话", exact: true }).click();
    await page.getByRole("form", { name: "CLI 新会话" }).waitFor({ state: "hidden" });
    assert.equal(creates, 1); assert.equal(opens, 2); report.checks.navigationRetryDoesNotRecreate = true;
    assert.deepEqual(saved, { cwd: "/tmp/mycodex-probe", model: "copilot/test-model" });
    report.checks.workspaceAndModelRemembered = true;
    await page.getByRole("button", { name: "MyCodex · CLI 会话", exact: true }).click();
    assert.equal(await page.getByRole("button", { name: "创建会话", exact: true }).isEnabled(), true);
    report.checks.canCreateAnotherThread = true;
    await page.getByRole("button", { name: "之前创建的 CLI 会话", exact: false }).click();
    await page.getByRole("form", { name: "CLI 新会话" }).waitFor({ state: "hidden" });
    assert.equal(creates, 1); assert.equal(opens, 3); report.checks.existingThreadOpensWithoutCreation = true;
    await page.evaluate(() => globalThis.selector.dispose());
    assert.equal(await page.locator('[data-mycodex-cli-selector]').count(), 0); report.checks.disposeRemovesComponent = true;
    // Exercise the generated injection script as well as the direct component.
    // This fake bridge is confined to this owned browser page, never Desktop.
    let bindingCalls = 0;
    await page.exposeFunction("fixtureBinding", async payload => {
      bindingCalls++;
      const request = JSON.parse(payload);
      assert.ok(["listModels", "listThreads"].includes(request.method));
      await page.evaluate(detail => globalThis.dispatchEvent(new CustomEvent("fixtureResponse", { detail })), {
        id: request.id, result: request.method === "listModels" ? [{ id: "copilot/fixture", label: "Serialized binding fixture" }]
          : { data: [], nextCursor: null },
      });
    });
    await page.evaluate(() => { globalThis.electronBridge = { getSentryInitOptions: () => ({ appVersion: "26.1023.50603" }) }; });
    assert.equal(await page.evaluate(() => typeof crypto.randomUUID), "function");
    const patch = buildCliSelectorPatch("fixtureBinding", "fixtureResponse");
    assert.equal(await page.evaluate(patch), "active");
    assert.equal(await page.evaluate(patch), "active");
    assert.equal(await page.locator('[data-mycodex-cli-selector]').count(), 1);
    report.checks.repeatedPatchIsIdempotent = true;
    await page.getByRole("button", { name: "MyCodex · CLI 会话", exact: true }).click();
    await page.getByRole("option", { name: "Serialized binding fixture" }).waitFor({ state: "attached" });
    assert.equal(bindingCalls, 2); report.checks.serializedBindingRoundTrip = true;
    await page.evaluate(() => { globalThis.__mycodexCliSelector.dispose();
      globalThis.electronBridge.getSentryInitOptions = () => ({ appVersion: "unverified" }); });
    assert.equal(await page.evaluate(patch), "unsupported");
    assert.equal(await page.locator('[data-mycodex-cli-selector]').count(), 0);
    report.checks.unverifiedRendererIsNotMounted = true;
    report.passed = true;
  } catch (error) {
    report.passed = false; report.error = error.message;
    try { report.selectorStatus = await page.locator('[role="status"]').textContent({ timeout: 1000 }); } catch {}
  }
  finally { await browser.close(); }
  fs.writeFileSync(path.join(root, "report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  return { root, report };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [playwright, executablePath] = process.argv.slice(2);
  if (!playwright || !executablePath) throw new Error("Usage: node tools/probe-cli-selector.mjs <playwright entry> <browser executable>");
  probeCliSelector({ playwright, executablePath }).then(({ root, report }) => {
    console.log(JSON.stringify({ reportFile: path.join(root, "report.json"), ...report }, null, 2));
    if (!report.passed) process.exitCode = 1;
  }, error => { console.error(error.message); process.exitCode = 1; });
}
