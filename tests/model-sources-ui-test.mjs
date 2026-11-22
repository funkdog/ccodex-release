import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { ModelSources } from "../bridge/model-sources.mjs";
import { createModelSourcesHandler } from "../bridge/model-sources-http.mjs";

const playwright = process.env.MYCODEX_TEST_PLAYWRIGHT ?? path.resolve(path.dirname(process.execPath), "../node_modules/playwright/index.mjs");
const browserFile = process.env.MYCODEX_TEST_BROWSER ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
test("source manager shows masked credentials, explicitly reveals and rotates a key, and switches the preferred source", { timeout: 30000 }, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sources-ui-"));
  const sources = new ModelSources(home, { fetchImpl: async () => Response.json({ data: [{ id: "gpt-fixture" }, { id: "gemini-fixture" }] }) });
  const saved = sources.save({ label: "Primary fixture", baseUrl: "https://example.test/v1", apiKey: "fixture-primary-key-1234", revision: 0 });
  await sources.discover(saved.savedId, saved.revision); sources.prefer({ id: saved.savedId, model: "gpt-fixture", revision: 2 });
  let handler; const server = http.createServer((req, res) => handler(req, res));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port; handler = createModelSourcesHandler({ sources, port });
  const { chromium } = await import(pathToFileURL(playwright).href);
  const browser = await chromium.launch({ executablePath: browserFile, headless: true });
  t.after(async () => { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(home, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 650, height: 900 } }), errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}/sources`);
  await page.locator("#preferred").filter({ hasText: "Primary fixture" }).waitFor();
  assert.equal(await page.locator("#key").inputValue(), "");
  assert.ok(!(await page.content()).includes("fixture-primary-key-1234"));
  await page.getByRole("button", { name: "查看密钥" }).click();
  await page.waitForFunction(() => document.getElementById("key").type === "text");
  assert.equal(await page.locator("#key").inputValue(), "fixture-primary-key-1234");
  await page.getByRole("button", { name: "隐藏密钥" }).click(); assert.equal(await page.locator("#key").inputValue(), "");
  await page.locator("#key").fill("fixture-rotated-key-5678");
  await page.getByRole("button", { name: "查看密钥" }).click(); await page.getByRole("button", { name: "隐藏密钥" }).click();
  assert.equal(await page.locator("#key").inputValue(), "fixture-rotated-key-5678", "Masking cannot discard an unsaved replacement key");
  await page.getByRole("button", { name: "保存来源" }).click();
  await page.getByRole("status").filter({ hasText: "已保存" }).waitFor();
  assert.equal(sources.source(saved.savedId).apiKey, "fixture-rotated-key-5678");
  assert.equal(await page.locator("#key").inputValue(), "");
  await page.locator("#model").selectOption("gemini-fixture"); await page.getByRole("button", { name: "设为优先" }).click();
  await page.locator("#preferred").filter({ hasText: "gemini-fixture" }).waitFor();
  assert.equal(sources.snapshot().preferredModel, "gemini-fixture");
  await page.getByRole("button", { name: "GitHub Copilot", exact: true }).click(); await page.getByRole("button", { name: "设为优先" }).click();
  await page.locator("#preferred").filter({ hasText: "GitHub Copilot" }).waitFor(); assert.equal(sources.read().preferred, "copilot");
  assert.equal(sources.source(saved.savedId).apiKey, "fixture-rotated-key-5678");
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.deepEqual(errors, []);
});

test("existing-chat picker locks the engine and keeps supported model updates in the original session", { timeout: 30000 }, async t => {
  const { chromium } = await import(pathToFileURL(playwright).href);
  const browser = await chromium.launch({ executablePath: browserFile, headless: true }); t.after(() => browser.close());
  const page = await browser.newPage(), root = path.resolve(import.meta.dirname, "..");
  page.setDefaultTimeout(5000);
  await page.route("http://127.0.0.1/**", route => {
    const file = new URL(route.request().url()).pathname.slice(1);
    if (/^(?:bridge|tools)\/.+\.mjs$/.test(file)) return route.fulfill({ contentType: "text/javascript", body: fs.readFileSync(path.join(root, file), "utf8") });
    return route.fulfill({ contentType: "text/html", body: '<main id="target"></main>' });
  });
  await page.goto("http://127.0.0.1/");
  await page.evaluate(async () => {
    const { mountNativeEnginePicker } = await import("/bridge/desktop-native-composer.mjs"), { createNativeSessionController } = await import("/bridge/desktop-native-session.mjs");
    const controller = createNativeSessionController(); const id = "00000000-0000-0000-0000-000000000001";
    controller.remember({ id, model: "mycodex/first/model", cliApprovalMode: "auto" });
    globalThis.calls = []; globalThis.handoffs = []; globalThis.opened = 0;
    const models = [{ id: "first/model", label: "First CLI", canSwitchModel: true }, { id: "first/other", label: "Other supported model", canSwitchModel: true },
      { id: "first/fixed", label: "Unavailable model", canSwitchModel: false }, { id: "second/model", label: "Second CLI", canSwitchModel: true },
      { id: "codex-copilot/api-aaaaaaaaaaaa--gpt", label: "Codex · Viwo API · GPT fixture", sourceLabel: "Viwo API", nativeCopilot: true }];
    globalThis.picker = mountNativeEnginePicker({ document, container: document.getElementById("target"), controller, currentThread: () => controller.thread(id),
      services: { listModels: async () => models, openModelSources: async () => { opened++; },
        updateSettings: async params => { calls.push(params); return { id, model: params.model.replace(/^mycodex\//, ""), cliApprovalMode: "auto" }; },
        switchExecution: async params => { handoffs.push(params); throw Error("No handoff is allowed"); } } });
    globalThis.controller = controller;
  });
  const select = page.getByRole("combobox", { name: "模型", exact: true });
  const open = async () => { const trigger = page.getByRole("button", { name: "模型与引擎设置" }); if (await trigger.getAttribute("aria-expanded") !== "true") await trigger.click(); };
  await open();
  const engine = page.getByRole("combobox", { name: "执行引擎", exact: true });
  assert.equal(await engine.isDisabled(), true); assert.equal(await engine.locator("option").count(), 1);
  assert.deepEqual(await select.locator("option").evaluateAll(rows => rows.map(row => row.value)), ["mycodex/first/model", "mycodex/first/other"]);
  await select.selectOption("mycodex/first/other");
  assert.equal(await page.evaluate(() => calls.length), 0, "Browsing a model must not change the execution engine");
  await page.getByRole("button", { name: "应用切换" }).click();
  await page.waitForFunction(() => controller.thread("00000000-0000-0000-0000-000000000001").model === "mycodex/first/other");
  assert.equal((await page.evaluate(() => calls))[0].model, "mycodex/first/other");
  assert.equal(await page.evaluate(() => handoffs.length), 0);
  await open();
  await page.getByRole("button", { name: "模型来源与密钥" }).click(); assert.equal(await page.evaluate(() => opened), 1);
  assert.equal(await page.evaluate(() => controller.thread("00000000-0000-0000-0000-000000000001").cliApprovalMode), "auto");
  await page.evaluate(() => picker.dispose());
});
