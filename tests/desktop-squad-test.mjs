import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { createSquad, addMember, saveSquads } from "../gateway/spine/squad-lite.mjs";
import { loadDesktopSquads, buildDesktopSquadsPatch } from "../bridge/desktop-sessions.mjs";
import { createDesktopSessionApi } from "../bridge/desktop-session-reader.mjs";
import { parseGatewayUiRequest } from "../bridge/desktop-gateway-ui.mjs";
import { pathToFileURL } from "node:url";

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-squad-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const store = { squads: {} }, anchor = randomUUID(), worker = randomUUID();
  const squad = createSquad(store, anchor, "Auth <b>小队</b>", "claude-code");
  addMember(store, squad.id, worker, "impl-1", "codex");
  await saveSquads(home, store);
  return { home, store, squad, anchor, worker };
}

test("sidecar absence does not scan history or create storage", async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-squad-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  assert.deepEqual(await loadDesktopSquads(home, () => assert.fail("No history scan without squads")), { squads: [], threads: [] });
  assert.deepEqual(await fs.readdir(home), []);
});

test("a later anchor page keeps its squad; archiving the anchor leaves workers ungrouped", async t => {
  const f = await fixture(t), calls = [];
  const threads = [{ id: f.worker, status: { type: "active", activeFlags: ["waitingOnApproval"] } }, { id: f.anchor }];
  const load = () => loadDesktopSquads(f.home, async cursor => {
    calls.push(cursor);
    return { data: cursor === null ? threads.slice(0, 1) : threads.slice(1), nextCursor: cursor === null ? "next" : null };
  });
  const active = await load();
  assert.equal(active.squads[0].id, f.squad.id);
  assert.equal(active.threads.length, 2);
  assert.deepEqual(calls, [null, "next"]);
  threads[1].archived = true;
  assert.deepEqual((await load()).squads, []);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.home, ".mycodex/squads.json"), "utf8")).squads[f.squad.id].label, f.squad.label);
});

test("failed or repeated pagination cannot publish a misleading empty or partial squad", async t => {
  const f = await fixture(t);
  await assert.rejects(loadDesktopSquads(f.home, async () => ({ data: [], nextCursor: "repeat" })), /pagination/);
  await assert.rejects(loadDesktopSquads(f.home, async () => { throw new Error("offline"); }), /offline/);
  await assert.rejects(loadDesktopSquads(f.home, async () => ({ data: [], nextCursor: undefined })), /page/);
});

test("legacy list reads the sidecar in its profile and preserves normal list failure boundaries", async t => {
  const f = await fixture(t), rows = [{ id: f.anchor }, { id: f.worker, inUse: true }];
  const reader = { list: async () => ({ sessions: rows, nextCursor: null, total: 2 }),
    readSnapshot: async () => rows, close: async () => {} };
  const api = createDesktopSessionApi({ home: f.home, reader, api: () => assert.fail("Read-only path") });
  assert.equal((await api("list")).squads.squads[0].id, f.squad.id);
  assert.equal((await api("squads")).threads[1].status.type, "idle", "inUse must not be presented as running");
  await fs.writeFile(path.join(f.home, ".mycodex/squads.json"), "{broken");
  assert.equal((await api("list")).total, 2);
  await assert.rejects(api("squads"));
});

test("gateway permits only the new read method and the browser patch has no Node dependencies", () => {
  assert.equal(parseGatewayUiRequest(JSON.stringify({ id: "sq-request", method: "listSquads", params: {} })).method, "listSquads");
  assert.throws(() => parseGatewayUiRequest(JSON.stringify({ id: "sq-request", method: "createSquad" })), /unapproved/);
  const patch = buildDesktopSquadsPatch("binding", "response", true);
  assert.doesNotMatch(patch, /node:|--mc-|--squad-|data-ccodex-squads|work-store|work-service|loadSquads\(/);
  assert.match(patch, /data-ccodex-squad-badge/);
  assert.match(patch, /data-ccodex-squad-tone/);
  assert.match(patch, /client-new-thread:/);
});

test("sidebar badges resolve optimistic native IDs, preserve navigation and clean up", { timeout: 30000 }, async t => {
  const runtime = process.env.MYCODEX_TEST_PLAYWRIGHT ?? path.resolve(path.dirname(process.execPath), "../node_modules/playwright/index.mjs");
  const { chromium } = await import(pathToFileURL(runtime).href);
  const browser = await chromium.launch({ executablePath: process.env.MYCODEX_TEST_BROWSER ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage(), anchor = randomUUID(), worker = randomUUID(), outsider = randomUUID();
  page.setDefaultTimeout(5000);
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.route("http://127.0.0.1/**", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><html></html>" }));
  await page.goto("http://127.0.0.1/");
  await page.setContent(`<html><head><style>.app-shell-left-panel{width:240px} [data-app-action-sidebar-thread-row]{display:block;width:100%;height:32px}</style></head>
    <body><aside class="app-shell-left-panel"><div id="native-section">${[anchor, worker, outsider].map((id, i) => `<button data-app-action-sidebar-thread-row data-app-action-sidebar-thread-host-id="local" data-app-action-sidebar-thread-selected="${i === 0}" data-app-action-sidebar-thread-id="local:${i === 0 ? "client-new-thread:" + randomUUID() : id}">${i === 0 ? "Anchor" : i === 1 ? "Worker" : "Other"}</button>`).join("")}</div></aside></body></html>`);
  await page.evaluate(({ anchor, worker }) => {
    const row = document.querySelector("[data-app-action-sidebar-thread-row]");
    row.__reactFiber$fixture = { memoizedProps: {}, return: { memoizedProps: { conversationId: anchor } } };
    globalThis.fixtureSnapshot = { squads: [{ anchorThreadId: anchor, members: [{ threadId: anchor, role: "supervisor" }, { threadId: worker, role: "worker", shortName: "impl-1" }], memberStates: { [worker]: "running" } }], threads: [] };
    globalThis.workerChild = document.querySelectorAll("[data-app-action-sidebar-thread-row]")[1].firstChild;
    globalThis.fixtureClicks = 0; globalThis.fixtureToggles = 0; globalThis.fixtureFail = false;
    row.addEventListener("click", () => fixtureClicks++);
    addEventListener("mycodex-squad-drawer-toggle", () => fixtureToggles++);
    globalThis.fixtureBinding = raw => { const request = JSON.parse(raw); dispatchEvent(new CustomEvent("fixtureResponse", { detail: { id: request.id, ...(fixtureFail ? { error: "offline" } : { result: fixtureSnapshot }) } })); };
  }, { anchor, worker });
  assert.equal(await page.evaluate(buildDesktopSquadsPatch("fixtureBinding", "fixtureResponse", true)), "active");
  const row = page.locator("[data-app-action-sidebar-thread-row]").first();
  await page.evaluate(() => __codexCopilotSquadsV1.reload());
  assert.equal(await row.getAttribute("data-ccodex-squad-tone"), "running");
  assert.equal(await row.evaluate(n => getComputedStyle(n, "::after").content), '"⟳1"');
  const workerRow = page.locator(`[data-app-action-sidebar-thread-id="local:${worker}"]`);
  assert.equal(await workerRow.isVisible(), false);
  assert.equal(await workerRow.getAttribute("data-ccodex-squad-badge"), null);
  assert.equal(await page.locator("#native-section > button").count(), 3);
  for (const status of [
    { type: "active", activeFlags: ["waitingOnApproval"] },
    { type: "waitingOnUserInput" },
  ]) {
    await page.evaluate(async ({ worker, status }) => { fixtureSnapshot.threads = [{ id: worker, status }]; await __codexCopilotSquadsV1.reload(); }, { worker, status });
    assert.equal(await workerRow.isVisible(), true, "system wait temporarily reveals a hidden worker");
    assert.equal(await workerRow.getAttribute("data-ccodex-squad-badge"), "⚠ @impl-1");
    assert.equal(await workerRow.getAttribute("data-ccodex-squad-tone"), "attention");
  }
  await page.evaluate(async worker => { fixtureSnapshot.threads = [{ id: worker, status: { type: "idle" } }]; await __codexCopilotSquadsV1.reload(); }, worker);
  assert.equal(await workerRow.isVisible(), false, "unpromoted worker hides again after approval");
  assert.equal(await workerRow.getAttribute("data-ccodex-squad-badge"), null);
  await page.evaluate(async () => { fixtureSnapshot.squads[0].members[1].sidebarHidden = false; await __codexCopilotSquadsV1.reload(); });
  assert.equal(await workerRow.isVisible(), true);
  assert.equal(await workerRow.getAttribute("data-ccodex-squad-badge"), "@impl-1");
  assert.equal(await workerRow.getAttribute("data-ccodex-squad-tone"), "neutral");
  assert.equal(await workerRow.evaluate(n => getComputedStyle(n, "::after").content), '"@impl-1"');
  assert.ok(await workerRow.evaluate(n => n.childNodes.length === 1 && n.firstChild === workerChild));
  assert.equal(await page.locator(`[data-app-action-sidebar-thread-id="local:${outsider}"]`).getAttribute("data-ccodex-squad-badge"), null);

  await row.click({ position: { x: 20, y: 16 } });
  assert.deepEqual(await page.evaluate(() => [fixtureClicks, fixtureToggles]), [1, 0]);
  await row.click({ position: { x: 230, y: 16 } });
  assert.deepEqual(await page.evaluate(() => [fixtureClicks, fixtureToggles]), [2, 0]);
  await row.evaluate(n => n.setAttribute("data-app-action-sidebar-thread-selected", "false"));
  await row.click({ position: { x: 230, y: 16 } });
  assert.deepEqual(await page.evaluate(() => [fixtureClicks, fixtureToggles]), [3, 0]);
  for (const [state, tone] of [["attention", "attention"], ["done", "settled"], ["idle", "neutral"]]) {
    await page.evaluate(async ({ worker, state }) => { fixtureSnapshot.squads[0].memberStates[worker] = state; await __codexCopilotSquadsV1.reload(); }, { worker, state });
    assert.equal(await row.getAttribute("data-ccodex-squad-tone"), tone);
  }
  await page.evaluate(async () => { fixtureFail = true; await __codexCopilotSquadsV1.reload(); });
  assert.equal(await row.getAttribute("data-ccodex-squad-badge"), null);
  assert.equal(await workerRow.isVisible(), true);
  assert.equal(await workerRow.getAttribute("data-ccodex-squad-badge"), null);
  await page.evaluate(async () => { fixtureFail = false; await __codexCopilotSquadsV1.reload(); });
  await row.evaluate((n, anchor) => { n.__reactFiber$fixture = { memoizedProps: { href: `/local/${anchor}` } }; }, anchor);
  await page.evaluate(() => __codexCopilotSquadsV1.refresh());
  assert.equal(await row.getAttribute("data-ccodex-squad-tone"), "neutral");
  await page.evaluate(async () => { fixtureSnapshot.squads[0].status = "closed"; await __codexCopilotSquadsV1.reload(); });
  assert.equal(await row.getAttribute("data-ccodex-squad-badge"), null);
  assert.equal(await workerRow.isVisible(), true);
  assert.equal(await workerRow.getAttribute("data-ccodex-squad-badge"), null);
  await page.evaluate(() => __codexCopilotSquadsV1.dispose());
  assert.equal(await page.locator("#codex-copilot-squad-style,[data-ccodex-squad-source],[data-ccodex-squad-badge],[data-ccodex-squad-tone]").count(), 0);
  assert.deepEqual(errors, []);
});
