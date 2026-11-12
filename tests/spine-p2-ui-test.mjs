import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { buildSpinePatch } from "../bridge/desktop-spine-ui.mjs";
import { currentHostContracts } from "../bridge/desktop-current-host-contract.mjs";
test("isolated Chrome validates P2 workbench actions, keyboard isolation, themes, layout restoration and disposal", { timeout: 30000 }, async () => {
  const runtime = process.env.MYCODEX_TEST_PLAYWRIGHT ?? path.resolve(path.dirname(process.execPath), "../node_modules/playwright/index.mjs");
  const { chromium } = await import(pathToFileURL(runtime).href), browser = await chromium.launch({ executablePath: process.env.MYCODEX_TEST_BROWSER ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
  const files = new Set(["bridge/diy/drawer.mjs", "bridge/diy/radar-panel.mjs", "bridge/diy/daily-panel.mjs", "bridge/diy/work-panel.mjs", "bridge/diy/workbench.mjs"]);
  const script = path.resolve(import.meta.dirname, "..");
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 920 } }), errors = []; page.on("pageerror", e => errors.push(e.message));
    await page.route("http://127.0.0.1/**", route => { const relative = new URL(route.request().url()).pathname.slice("/__compiled/".length); if (files.has(relative)) return route.fulfill({ contentType: "text/javascript", body: fs.readFileSync(path.join(script, relative), "utf8") }); return route.fulfill({ contentType: "text/html; charset=utf-8", body: '<style>html{color-scheme:light}html.dark{color-scheme:dark}body{margin:0;background:rgb(245,245,247);font:15px system-ui;color:rgb(45,45,48)}html.dark body{background:rgb(20,20,22);color:rgb(220,220,224)}main{margin:58px 36px 28px;padding:24px;border:1px solid rgba(120,120,120,.18);border-radius:16px;min-height:760px}section[data-composer-input]{margin-top:360px;padding:18px;border:1px solid rgba(120,120,120,.3);border-radius:12px}[contenteditable]{min-height:100px}</style><main><h2>聊天工作区 · 独立 fixture</h2><p>原生会话与输入区是主舞台，侧边工作台提供辅助资料。</p><section data-composer-input><div role="textbox" contenteditable="true">用户未发送草稿</div><button id="send">发送</button></section></main>' }); });
    await page.goto("http://127.0.0.1/");
    assert.equal(await page.evaluate(async () => typeof (await import("/__compiled/bridge/diy/workbench.mjs")).mountWorkbench), "function");
    await page.evaluate(async () => {
      const { mountWorkbench } = await import("/__compiled/bridge/diy/workbench.mjs");
      const one = "00000000-0000-0000-0000-000000000001", two = "00000000-0000-0000-0000-000000000002";
      globalThis.fixtureCalls = []; globalThis.fixtureSubscribers = new Set(); globalThis.fixtureDraftOccupied = true; globalThis.fixtureNativeSends = 0;
      document.addEventListener("keydown", e => { if (e.key === "Enter") fixtureNativeSends++; });
      globalThis.fixtureCards = [{ id: "a".repeat(32), title: "Agent 工程：可核验的执行与恢复", summary: "在保持原生工作流的前提下，评估可逆接入与协议兼容成本。", body: "Fixture body", score: 92, scoreReason: "fixture relevance", feedback: 0, topics: ["agents"], tags: ["Agent"], sources: [{ title: "GitHub", url: "https://example.test/agent" }], saved: false }, { id: "b".repeat(32), title: "推理基础设施与调用预算", summary: "比较轻量通道和主力模型的资源边界。", body: "Fixture body", score: 68, scoreReason: "fixture relevance", feedback: 0, topics: ["infra"], tags: ["Infra"], sources: [{ title: "Paper", url: "https://example.test/infra" }], saved: false }];
      const seen = new Set(); const changed = kind => fixtureSubscribers.forEach(receive => receive({ kind }));
      const card = { schemaVersion: 1, id: "MC-20261101-" + "c".repeat(24), revision: 1, date: "2026-11-01", title: "恢复边界的经验候选", body: "背景：跨引擎中断恢复。\n观察：保留原上下文与失败状态。\n待复核：返回原会话核对证据。", tags: ["恢复", "协议"], sources: [{ kind: "thread", uri: "mycodex://thread/" + one }], status: "candidate", createdAt: 1, updatedAt: 1, createdBy: "mycodex" };
      globalThis.fixtureDigest = { date: "2026-11-01", timezone: "Asia/Shanghai", handoff: [{ threadId: one, repository: "MyCodex", engine: "Codex + Copilot", title: "继续核对原生协议", status: "completed", updatedAt: Date.now(), today: true }, { threadId: two, repository: "MyCodex", engine: "Antigravity", title: "图片内联展开", status: "interrupted", updatedAt: Date.now(), today: true }], cards: [card], markdown: "# 团队日报\n\n- 已完成：协议检查。\n- 进行中：恢复验收。\n- 风险：窗口尚未加载。", coverage: { cli: 1, native: 1, repositories: 1, degraded: ["源头摘要，结论需复核。"] }, refreshedAt: Date.now() };
      const services = { subscribe(receive) { fixtureSubscribers.add(receive); return () => fixtureSubscribers.delete(receive); }, async request(method, params) {
        fixtureCalls.push([method, params]);
        if (method === "diy/radar/list") { const items = fixtureCards.filter(c => (!params.highOnly || c.score >= 85 || c.feedback < 0) && (!params.topic || c.topics.includes(params.topic))); return { configured: true, items, topics: ["agents", "infra"], total: items.length, nextOffset: null, syncedAt: "2026-11-01T09:00:00+08:00", unreadHighCount: fixtureCards.filter(c => c.score >= 85 && !seen.has(c.id) && !c.saved && c.feedback >= 0).length }; }
        if (method === "diy/radar/seen") { const prior = seen.size; params.ids.forEach(id => seen.add(id)); if (prior !== seen.size) changed("radar"); return { changed: prior !== seen.size }; }
        if (method === "diy/radar/feedback") { fixtureCards.find(c => c.id === params.id).feedback = params.value; changed("radar"); return { updated: true }; }
        if (method === "diy/radar/save_card") { fixtureCards.find(c => c.id === params.id).saved = true; changed("radar"); return { saved: true, destination: "mycodex" }; }
        if (method === "diy/daily/digest") return fixtureDigest;
        if (method === "diy/daily/save_card") return { saved: true, destination: "mycodex" };
        if (method === "diy/work/list") return { goals: [], items: [], activeWorkItemId: null };
        if (method === "diy/work/shared_list") return { goals: [], items: [], total: 0, nextOffset: null };
        if (method.endsWith("/refresh")) { changed(method.includes("radar") ? "radar" : "daily"); return { state: "completed" }; }
        throw new Error("Unexpected fixture method");
      } };
      globalThis.fixtureActions = { async prefillDraft(text) { if (fixtureDraftOccupied) throw new Error("Current draft contains text; it was preserved."); fixtureCalls.push(["prefillDraft", text]); }, async openThread(id) { fixtureCalls.push(["openThread", id]); }, async injectText(text) { fixtureCalls.push(["injectText", text]); }, async copyText(text) { fixtureCalls.push(["copyText", text]); } };
      globalThis.fixtureServices = services;
      globalThis.fixtureWorkbench = mountWorkbench({ document, container: document.body, services, hostActions: fixtureActions });
      document.querySelector('[role="textbox"]').focus();
    });
    await page.keyboard.press("Meta+Shift+M"); await page.locator('[data-slot="radar"]').click(); await page.getByRole("button", { name: "⚡ 结合本仓评估" }).waitFor();
    assert.equal(await page.locator('[data-mycodex-drawer]').evaluate(host => getComputedStyle(host).top), "10px");
    await page.getByRole("button", { name: "⚡ 结合本仓评估" }).click(); await page.getByRole("status").filter({ hasText: "当前草稿非空" }).waitFor();
    await page.evaluate(() => { fixtureDraftOccupied = false; }); await page.getByRole("button", { name: "⚡ 结合本仓评估" }).click();
    assert.equal(await page.evaluate(() => fixtureCalls.some(c => c[0] === "prefillDraft" && c[1].includes("请结合当前工作区架构"))), true);
    await page.getByRole("button", { name: "降低此类主题权重" }).click(); await page.getByRole("button", { name: "撤销" }).waitFor(); await page.getByRole("button", { name: "撤销" }).click(); await page.getByRole("button", { name: "📥 存知识卡" }).click();
    await page.getByRole("button", { name: "✓ 已存卡" }).waitFor(); assert.equal(await page.getByRole("button", { name: "✓ 已存卡" }).isDisabled(), true);
    await page.getByRole("button", { name: /日报·蒸馏/ }).click(); await page.getByRole("button", { name: "→ 跳回会话" }).first().click();
    await page.getByRole("button", { name: "📝 团队日报" }).click(); await page.getByRole("button", { name: "📋 复制 Markdown" }).click(); await page.getByRole("button", { name: "✓ 已复制" }).waitFor();
    await page.getByRole("button", { name: "💎 候选知识卡" }).click(); await page.getByRole("textbox", { name: "知识卡标题" }).fill("内联微调标题"); await page.getByRole("textbox", { name: "知识卡标题" }).press("Enter"); await page.getByRole("button", { name: "✓ 写入知识库" }).click(); await page.getByRole("button", { name: "✓ 已写入" }).waitFor();
    const calls = await page.evaluate(() => fixtureCalls); assert.ok(calls.some(c => c[0] === "openThread")); assert.ok(calls.some(c => c[0] === "copyText")); assert.ok(calls.some(c => c[0] === "diy/daily/save_card" && c[1].title === "内联微调标题")); assert.equal(await page.evaluate(() => fixtureNativeSends), 0);
    await page.keyboard.press("Escape"); assert.equal(await page.evaluate(() => document.activeElement.matches('[role="textbox"]')), true);
    await page.evaluate(() => { fixtureWorkbench.dispose(); }); assert.equal(await page.evaluate(() => fixtureSubscribers.size), 0);
    // Exercise the actual serialized host glue, with owned binding responses.
    await page.evaluate(`globalThis.codexWindowType='electron';globalThis.electronBridge={getSentryInitOptions:()=>({appVersion:${JSON.stringify(currentHostContracts.at(-1).version)}})};globalThis.fixtureBinding=payload=>{const p=JSON.parse(payload);fixtureServices.request(p.method,p.params).then(result=>globalThis.dispatchEvent(new CustomEvent('fixtureResponse',{detail:{id:p.id,result}})));};`);
    assert.equal(await page.evaluate(buildSpinePatch("fixtureBinding", "fixtureResponse")), "active");
    await page.getByRole("button", { name: /✦ MyCodex/ }).click(); await page.locator('[data-slot="radar"]').click(); await page.getByRole("button", { name: "⚡ 结合本仓评估" }).waitFor();
    assert.equal(await page.locator("main").evaluate(main => main.style.getPropertyValue("margin-inline-end")), "484px");
    await page.screenshot({ path: "/private/tmp/mycodex-p2-drawer-light.png" });
    const light = await page.locator("article.card").first().evaluate(card => getComputedStyle(card).backgroundColor);
    await page.evaluate(() => document.documentElement.classList.add("dark")); await page.waitForTimeout(30);
    const dark = await page.locator("article.card").first().evaluate(card => getComputedStyle(card).backgroundColor); assert.notEqual(light, dark);
    await page.screenshot({ path: "/private/tmp/mycodex-p2-drawer-dark.png" });
    await page.setViewportSize({ width: 760, height: 920 }); await page.waitForFunction(() => document.querySelector("main").style.getPropertyValue("margin-inline-end") === "");
    await page.emulateMedia({ reducedMotion: "reduce" }); assert.equal(await page.locator("aside").evaluate(aside => getComputedStyle(aside).transitionDuration), "0s");
    await page.evaluate(() => globalThis.__mycodexSpine.dispose()); assert.equal(await page.locator('[data-mycodex-drawer]').count(), 0); assert.equal(await page.locator("main").evaluate(main => main.style.getPropertyValue("margin-inline-end")), ""); assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
