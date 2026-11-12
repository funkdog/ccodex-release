// Owned browser fixture only. Never connects to the running Desktop endpoint.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { mountDiyDrawer } from "../bridge/diy/drawer.mjs";
import { createHostActions, buildSpinePatch } from "../bridge/desktop-spine-ui.mjs";
import { currentHostContracts } from "../bridge/desktop-current-host-contract.mjs";

test("compiled drawer in isolated browser mounts, switches, handles host actions and disposes late work", { timeout: 30000 }, async () => {
  // Reuse the existing installed runtime. Explicit env overrides support CI.
  const runtime = path.resolve(path.dirname(process.execPath), "../node_modules/playwright/index.mjs");
  const playwright = process.env.MYCODEX_TEST_PLAYWRIGHT ?? runtime;
  const executablePath = process.env.MYCODEX_TEST_BROWSER ?? (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : undefined);
  const { chromium } = await import(pathToFileURL(playwright).href);
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage(), errors = []; page.on("pageerror", e => errors.push(e.message));
    await page.route("http://127.0.0.1/**", route => {
      if (route.request().url().endsWith("drawer.mjs")) return route.fulfill({ contentType: "text/javascript", body: fs.readFileSync(path.resolve(import.meta.dirname, "../bridge/diy/drawer.mjs"), "utf8") });
      return route.fulfill({ contentType: "text/html", body: '<main><button id="focus">before</button><section data-composer-input><div role="textbox" contenteditable="true"></div></section></main>' });
    });
    await page.goto("http://127.0.0.1/");
    assert.equal(await page.evaluate(async () => typeof (await import("/drawer.mjs")).mountDiyDrawer), "function");
    await page.evaluate(`globalThis.mount=${mountDiyDrawer.toString()};globalThis.actionsFactory=${createHostActions.toString()};`);
    const report = await page.evaluate(async () => {
      const calls = [], services = { request: async (method, params) => { calls.push([method, params]); return { schemaVersion: 1 }; } };
      let route = "/local/original", disposed = 0, aborted = false, release;
      const actions = actionsFactory({ document, readRoute: () => route, navigate: path => { route = path; }, composerSelector: '[role="textbox"]', wait: async () => {} });
      const drawer = mount({ document, container: document.body, services, hostActions: actions, slots: [
        { id: "a", label: "Normal", async mount({ document, container, services, hostActions }) {
          const host = document.createElement("div"); host.textContent = JSON.stringify(await services.request("diy/spine/status", {})); container.append(host);
          const button = document.createElement("button"); button.textContent = "inject"; button.onclick = () => hostActions.injectText("fixture text"); host.append(button);
          return { host, dispose() { disposed++; host.remove(); } };
        } },
        { id: "late", label: "Late", async mount({ document, container, signal }) {
          signal.addEventListener("abort", () => { aborted = true; }); await new Promise(resolve => { release = resolve; });
          const host = document.createElement("span"); host.textContent = "late"; container.append(host); return { host, dispose() { disposed++; host.remove(); } };
        } },
      ] });
      document.querySelector("#focus").focus(); drawer.open(); await new Promise(resolve => setTimeout(resolve, 20));
      const shadow = drawer.host.shadowRoot; const mounted = shadow.querySelector(".panel").textContent.includes("schemaVersion");
      await actions.injectText("fixture text"); const injected = document.querySelector('[role="textbox"]').textContent;
      await actions.openThread("s-1"); const navigated = route;
      let preserved = false; try { await actions.prefillDraft("replace"); } catch { preserved = true; }
      drawer.select("late"); await new Promise(resolve => setTimeout(resolve, 0)); drawer.close(); release(); await new Promise(resolve => setTimeout(resolve, 20));
      const lateGone = shadow.querySelector(".panel").childElementCount === 0, focused = document.activeElement.id === "focus";
      drawer.open(); await new Promise(resolve => setTimeout(resolve, 0)); drawer.dispose(); drawer.dispose(); if (release) release(); await new Promise(resolve => setTimeout(resolve, 20));
      return { mounted, injected, navigated, preserved, aborted, lateGone, focused, removed: !drawer.host.isConnected, disposed, calls: calls.length };
    });
    assert.equal(report.mounted, true); assert.equal(report.injected, "fixture text"); assert.equal(report.navigated, "/local/s-1"); assert.equal(report.preserved, true);
    assert.equal(report.aborted, true); assert.equal(report.lateGone, true); assert.equal(report.focused, true); assert.equal(report.removed, true); assert.ok(report.disposed >= 2); assert.equal(report.calls, 1);
    // Exact serialized host installer gets its explicit dependencies; no hidden
    // closure variables or Node globals may enter the pure drawer.
    await page.evaluate(`globalThis.codexWindowType='electron';globalThis.electronBridge={getSentryInitOptions:()=>({appVersion:${JSON.stringify(currentHostContracts.at(-1).version)}})};globalThis.fixtureBinding=payload=>{const p=JSON.parse(payload);globalThis.dispatchEvent(new CustomEvent('fixtureResponse',{detail:{id:p.id,result:{schemaVersion:1}}}));};`);
    assert.equal(await page.evaluate(buildSpinePatch("fixtureBinding", "fixtureResponse")), "active");
    assert.equal(await page.evaluate(buildSpinePatch("fixtureBinding", "fixtureResponse")), "active");
    assert.equal(await page.evaluate(() => document.querySelectorAll('[data-mycodex-drawer]').length), 1);
    await page.evaluate(() => { globalThis.__mycodexSpine.dispose(); }); assert.equal(await page.evaluate(() => document.querySelectorAll('[data-mycodex-drawer]').length), 0);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
