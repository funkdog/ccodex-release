// Explicit browser acceptance; uses an isolated profile, never an open app.
// Set MYCODEX_SQUAD_PUPPETEER to an installed puppeteer-core module file and
// MYCODEX_SQUAD_BROWSER to a Chrome/Chromium executable.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { buildDesktopSquadsPatch } from "../bridge/desktop-sessions.mjs";

if (!process.env.MYCODEX_SQUAD_PUPPETEER || !process.env.MYCODEX_SQUAD_BROWSER)
  throw new Error("Browser acceptance requires MYCODEX_SQUAD_PUPPETEER and MYCODEX_SQUAD_BROWSER.");
const { default: puppeteer } = await import(pathToFileURL(process.env.MYCODEX_SQUAD_PUPPETEER).href);
const profile = await fs.mkdtemp(path.join(os.tmpdir(), "squad-browser-"));
const server = createServer((_request, response) => { response.setHeader("Content-Type", "text/html"); response.end("<!doctype html><html></html>"); });
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await puppeteer.launch({ executablePath: process.env.MYCODEX_SQUAD_BROWSER,
    headless: true, userDataDir: profile, timeout: 15000, protocolTimeout: 15000,
    args: ["--no-first-run", "--disable-sync", "--disable-background-networking"] });
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.setViewport({ width: 640, height: 600 });
  const anchor = "00000000-0000-0000-0000-000000000001";
  const workers = [2, 3, 4, 5].map(n => anchor.slice(0, -1) + n);
  const outsider = anchor.slice(0, -1) + "6";
  const snapshot = { squads: [{ id: "sq-12345678", anchorThreadId: anchor, label: "Auth <b>重构小队很长的名称</b>", createdAt: 1,
    members: [anchor, ...workers].map((threadId, index) => ({ threadId, role: index ? "worker" : "supervisor", shortName: index ? "impl-" + index : "supervisor", engine: "claude-code" })) }],
    threads: [anchor, ...workers].map((id, index) => ({ id, title: "Native title", status:
      [{ type: "active" }, { type: "active", activeFlags: ["waitingOnApproval"] }, { type: "active" }, { type: "completed" }, { type: "idle" }][index] })) };
  const native = id => `<button data-app-action-sidebar-thread-row data-app-action-sidebar-thread-id="local:${id}"
    data-app-action-sidebar-thread-host-id="local" data-app-action-sidebar-thread-active="${id === anchor}">Native ${id.slice(-1)}</button>`;
  await page.setContent(`<html data-theme="dark"><head><style>
    body{margin:0}.app-shell-left-panel{width:200px;padding:8px;box-sizing:border-box;background:#15161a}
    [data-app-action-sidebar-thread-row]{display:block;width:100%;height:28px}
    </style></head><body><aside class="app-shell-left-panel"><div id="native-section">${[anchor, ...workers, outsider].map(native).join("")}
    <button data-app-action-sidebar-thread-row data-app-action-sidebar-thread-id="${workers[0]}" data-app-action-sidebar-thread-host-id="remote">Remote same ID</button>
    </div></aside></body></html>`);
  await page.evaluate((snapshot) => {
    globalThis.fixtureSnapshot = snapshot; globalThis.fixtureClicks = []; globalThis.fixtureFail = false;
    document.addEventListener("click", event => {
      if (event.target.matches("[data-app-action-sidebar-thread-row]")) globalThis.fixtureClicks.push(event.target.getAttribute("data-app-action-sidebar-thread-id"));
    });
    globalThis.fixtureBinding = raw => {
      const request = JSON.parse(raw);
      globalThis.dispatchEvent(new CustomEvent("fixture-response", { detail: { id: request.id,
        ...(globalThis.fixtureFail ? { error: "fixture offline" } : { result: globalThis.fixtureSnapshot }) } }));
    };
  }, snapshot);
  const patch = buildDesktopSquadsPatch("fixtureBinding", "fixture-response", true);
  assert.equal(await page.evaluate(patch), "active");
  await page.waitForFunction(() => document.querySelectorAll("[data-ccodex-squad-source]").length === 4);
  assert.equal(await page.$$eval("[data-ccodex-squad-source]", nodes => nodes.length), 4);
  assert.equal(await page.$$eval(".sidebar-group-header,[data-squad-id]", nodes => nodes.length), 0, "never inserts fake groups");
  assert.equal(await page.$eval(`[data-app-action-sidebar-thread-id="local:${anchor}"]`, n => getComputedStyle(n).display), "block");
  assert.equal(await page.$eval('[data-app-action-sidebar-thread-host-id="remote"]', n => getComputedStyle(n).display), "block");
  assert.equal(await page.$$eval("#native-section > button", nodes => nodes.length), 7, "native rows stay in original parents");
  await page.evaluate(async () => { fixtureSnapshot.squads[0].members[1].sidebarHidden = false; await __codexCopilotSquadsV1.reload(); });
  assert.equal(await page.$eval(`[data-app-action-sidebar-thread-id="local:${workers[0]}"]`, n => getComputedStyle(n).display), "block");
  await page.click(`[data-app-action-sidebar-thread-id="local:${workers[0]}"]`);
  assert.deepEqual(await page.evaluate(() => fixtureClicks), ["local:" + workers[0]]);
  await page.evaluate(() => {
    const section = document.getElementById("native-section"), replacement = section.cloneNode(true);
    replacement.querySelectorAll("[data-ccodex-squad-source]").forEach(n => n.removeAttribute("data-ccodex-squad-source")); section.replaceWith(replacement);
  });
  await page.waitForFunction(() => document.querySelectorAll("[data-ccodex-squad-source]").length === 3);
  await page.evaluate(async () => { fixtureFail = true; await __codexCopilotSquadsV1.reload(); });
  assert.equal(await page.$$eval("[data-ccodex-squad-source]", nodes => nodes.length), 0, "read failure restores native rows");
  await page.evaluate(async () => { fixtureFail = false; await __codexCopilotSquadsV1.reload(); });
  assert.equal(await page.$$eval("[data-ccodex-squad-source]", nodes => nodes.length), 3);
  await page.evaluate(async () => { fixtureSnapshot.squads[0].status = "closed"; await __codexCopilotSquadsV1.reload(); });
  assert.equal(await page.$$eval("[data-ccodex-squad-source]", nodes => nodes.length), 0, "closing reveals all native chats");
  await page.evaluate(() => __codexCopilotSquadsV1.dispose());
  assert.equal(await page.$$eval("#codex-copilot-squad-style", nodes => nodes.length), 0);
  assert.deepEqual(errors, []);
  console.log("Squad sidebar acceptance passed: CSS-only folding, promotion, native navigation, remount, fail-open, safe close and disposal.");

} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  await fs.rm(profile, { recursive: true, force: true });
}
