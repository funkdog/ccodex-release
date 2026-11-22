import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { buildDesktopSquadsPatch } from "../bridge/desktop-sessions.mjs";
import { currentHostContracts } from "../bridge/desktop-current-host-contract.mjs";

test("Desktop loads sidebar and return navigation without a drawer, shortcut, duplicate RPC client or draft mutation", { timeout: 20000 }, async t => {
  const root = path.resolve(import.meta.dirname, "..");
  for (const module of ["desktop-spine-ui", "diy/drawer", "diy/workbench", "diy/squad-panel", "diy/radar-panel", "diy/daily-panel", "diy/work-panel"]) {
    for (const extension of [".mts", ".mjs", ".mjs.map"]) assert.equal(fs.existsSync(path.join(root, "bridge", module + extension)), false);
  }
  const patch = buildDesktopSquadsPatch("fixtureBinding", "fixtureResponse", true);
  assert.doesNotMatch(patch, /mountDiyDrawer|mountWorkbench|mountSquadPanel|data-mycodex-drawer|mycodex-squad-drawer-toggle|margin-inline-end|KeyM/);
  const runtime = process.env.MYCODEX_TEST_PLAYWRIGHT ?? path.resolve(path.dirname(process.execPath), "../node_modules/playwright/index.mjs");
  const { chromium } = await import(pathToFileURL(runtime).href);
  const browser = await chromium.launch({ executablePath: process.env.MYCODEX_TEST_BROWSER ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage(), errors = [];
  page.setDefaultTimeout(4000);
  page.on("pageerror", error => errors.push(error.message));
  const anchor = "11111111-1111-4111-8111-111111111111", worker = "22222222-2222-4222-8222-222222222222";
  await page.route("http://127.0.0.1/**", route => route.fulfill({ contentType: "text/html", body: `<html data-theme="dark"><body><main style="margin-inline-end:17px"><div data-above-composer-conversation-id="local:${worker}"></div><section data-composer-input><div role="textbox" contenteditable="true">User draft to preserve</div></section></main></body></html>` }));
  await page.goto("http://127.0.0.1/");
  await page.evaluate(({ anchor, worker, version }) => {
    globalThis.codexWindowType = "electron";
    globalThis.electronBridge = { getSentryInitOptions: () => ({ appVersion: version }) };
    globalThis.fixtureCalls = []; globalThis.fixtureRoutes = []; globalThis.fixtureFail = false;
    globalThis.fixtureSnapshot = { squads: [{ anchorThreadId: anchor, label: "Squad V2", status: "active", members: [{ threadId: worker, role: "worker", shortName: "impl" }] }], threads: [] };
    globalThis.fixtureBinding = raw => {
      const request = JSON.parse(raw); fixtureCalls.push(request.method);
      queueMicrotask(() => dispatchEvent(new CustomEvent("fixtureResponse", { detail: { id: request.id, ...(fixtureFail ? { error: "offline" } : { result: fixtureSnapshot }) } })));
    };
    addEventListener("message", event => {
      if (event.data?.type !== "navigate-to-route") return;
      fixtureRoutes.push(event.data.path);
      document.querySelector('[data-above-composer-conversation-id]').setAttribute('data-above-composer-conversation-id', `local:${event.data.path.split('/').pop()}`);
    });
  }, { anchor, worker, version: currentHostContracts.at(-1).version });
  assert.equal(await page.evaluate(patch), "active");
  assert.equal(await page.evaluate(patch), "active");
  assert.equal(await page.evaluate(() => __codexCopilotSquadsV1.inspect().error), null);
  const navigation = page.locator('[data-mycodex-return-anchor]');
  await navigation.waitFor({ state: "visible" });
  assert.equal(await navigation.locator(".meta").innerText(), "impl · Squad V2");
  assert.equal(await navigation.getAttribute("data-theme"), "dark");
  await page.evaluate(() => document.documentElement.dataset.theme = "light");
  await page.waitForFunction(() => document.querySelector('[data-mycodex-return-anchor]').dataset.theme === "light");
  const shortcut = await page.evaluate(() => {
    const event = new KeyboardEvent("keydown", { code: "KeyM", key: "M", metaKey: true, shiftKey: true, cancelable: true, bubbles: true });
    document.dispatchEvent(event);
    dispatchEvent(new CustomEvent("mycodex-squad-drawer-toggle"));
    return { prevented: event.defaultPrevented, spine: typeof globalThis.__mycodexSpine, margin: document.querySelector('main').style.marginInlineEnd };
  });
  assert.deepEqual(shortcut, { prevented: false, spine: "undefined", margin: "17px" });
  assert.equal(await page.locator('[data-mycodex-drawer]').count(), 0);
  await navigation.getByRole("button", { name: "★ 返回主会话", exact: true }).click();
  await navigation.waitFor({ state: "hidden" });
  assert.deepEqual(await page.evaluate(() => fixtureRoutes), [`/local/${anchor}`]);
  assert.equal(await page.locator('[contenteditable]').innerText(), "User draft to preserve");
  await page.evaluate(async worker => {
    document.querySelector('[data-above-composer-conversation-id]').setAttribute('data-above-composer-conversation-id', `local:${worker}`);
    await __codexCopilotSquadsV1.reload();
  }, worker);
  await navigation.waitFor({ state: "visible" });
  await page.evaluate(async () => { fixtureFail = true; await __codexCopilotSquadsV1.reload(); });
  await navigation.waitFor({ state: "hidden" });
  assert.deepEqual([...new Set(await page.evaluate(() => fixtureCalls))], ["listSquads"]);
  await page.evaluate(() => __codexCopilotSquadsV1.dispose());
  assert.equal(await navigation.count(), 0);
  const count = await page.evaluate(() => fixtureCalls.length);
  await page.waitForTimeout(5200);
  assert.equal(await page.evaluate(() => fixtureCalls.length), count);
  assert.deepEqual(errors, []);
});
