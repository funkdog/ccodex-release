import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { SquadV2Kernel } from "../gateway/spine/squad-v2-kernel.mjs";
import { git } from "../gateway/spine/squad-v2-workspace.mjs";
import { serveMcp } from "../gateway/spine/mcp-server.mjs";
import { SQUAD_CARD_URI, SQUAD_CARD_MIME, conversationSquadCardResource } from "../bridge/diy/squad-card.mjs";
import { renderSquadStudioHtml } from "../bridge/diy/squad-studio.mjs";
import { buildDesktopSquadsPatch } from "../bridge/desktop-sessions.mjs";
import { readNativeComposerRoute } from "../bridge/desktop-native-composer.mjs";
import { desktopPickerBinding } from "../bridge/desktop-model-controls.mjs";
import { currentHostContracts } from "../bridge/desktop-current-host-contract.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

async function launchHeadlessBrowser() {
  const runtime =
    process.env.MYCODEX_TEST_PLAYWRIGHT ??
    path.resolve(path.dirname(process.execPath), "../node_modules/playwright/index.mjs");
  const { chromium } = await import(pathToFileURL(runtime).href);
  return chromium.launch({
    executablePath:
      process.env.MYCODEX_TEST_BROWSER ??
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  });
}

async function createV2KernelFixture(t, open) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "squad-v2-ui-"));
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "squad-ui-test@example.invalid");
  await git(root, "config", "user.name", "Squad UI Test");
  await fsp.writeFile(path.join(root, ".gitignore"), ".mycodex/\nnode_modules\n");
  await fsp.writeFile(path.join(root, "owned.ts"), "export const mode = 'v1';\nexport const keep = true;\n");
  await git(root, "add", ".gitignore", "owned.ts");
  await git(root, "commit", "-m", "initial fixture");

  const anchorId = "00000000-0000-4000-8000-000000000001";
  const threads = new Map([
    [anchorId, { id: anchorId, cwd: root, status: { type: "active" } }],
  ]);
  let seq = 10;
  const sent = [];
  const kernel = new SquadV2Kernel(
    root,
    {
      read: async id => {
        const thread = threads.get(id);
        if (!thread) throw new Error("offline");
        return thread;
      },
      create: async (_slot, cwd) => {
        const id = `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
        const thread = { id, cwd, status: { type: "idle" } };
        threads.set(id, thread);
        return thread;
      },
      open,
      send: async (thread, text, requestId) => {
        sent.push({ id: thread.id, text, requestId });
        thread.status = { type: "active" };
      },
    },
    () => {},
  );
  t.after(async () => {
    await kernel.shutdown();
    await fsp.rm(root, { recursive: true, force: true });
  });
  return { kernel, root, anchorId, threads, sent };
}

test("pure DIY view static audit passes on Studio and Card", () => {
  const forbidden =
    /node:|\bprocess\.|\brequire\(|\b(?:VUn|eLt)\b|[Rr]eact[Ff]iber|app:\/\/|\/[Uu]sers\//;
  for (const rel of ["bridge/diy/squad-studio.mts", "bridge/diy/squad-card.mts"]) {
    const source = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
    assert.doesNotMatch(source, forbidden, `${rel} must remain a pure browser view`);
  }
  const resource = conversationSquadCardResource();
  assert.equal(resource.uri, SQUAD_CARD_URI);
  assert.equal(resource.mimeType, SQUAD_CARD_MIME);
});

test(
  "Squad Studio split-pane browser E2E verifies 0px Needs You, XSS safety, Gate lock, in-place /diff, stateful promotion, clean isolation, themes and 400-680px zero overflow",
  { timeout: 45000 },
  async t => {
    const f = await createV2KernelFixture(t);
    const initSnap = await f.kernel.init({
      anchorThreadId: f.anchorId,
      title: 'Squad Studio <img src=x onerror="window.__studioXss=true">',
      intent: "验证右侧分屏工作台与真实内核接口闭环",
      workspace: "worktree",
      state: {
        invariants: ["禁止修改 gateway 范围外文件"],
        contracts: ["共用 STATE.md expectedRevision"],
        criteria: [
          { id: "C1", text: "Needs You 为空时物理 0px 隐藏", verifiedBy: "@clean-verifier" },
          { id: "C2", text: "原地代码 Diff 与 Gate 审批跑通" },
        ],
      },
    });
    const squadId = initSnap.squadId;

    const dispatched = await f.kernel.dispatch({
      squadId,
      slots: [
        {
          slotId: "role-studio",
          handle: "role-studio",
          continuity: "stateful",
          workspace: "worktree",
          model: "fixture-codex-a",
          reasoningEffort: "high",
          task: "实现右侧分屏工作台",
          touches: ["owned.ts"],
        },
        {
          slotId: "clean-verifier",
          handle: "clean-verifier",
          continuity: "clean",
          workspace: "shared",
          model: "gpt-6-luna",
          task: "零历史独立终审",
          touches: [],
        },
      ],
    });
    const studioSlot = dispatched.slots.find(s => s.slotId === "role-studio");
    const verifierSlot = dispatched.slots.find(s => s.slotId === "clean-verifier");

    await fsp.writeFile(
      path.join(studioSlot.worktreePath, "owned.ts"),
      "export const mode = 'v2-studio';\nexport const keep = true;\nexport const addedLine = 42;\n",
    );
    await fsp.writeFile(
      path.join(studioSlot.worktreePath, ".mycodex", "result.md"),
      [
        "status: done",
        "summary: 完成分屏组件渲染",
        "## Changes & Verification",
        "- 已对接 `/snapshot` 与 **Gate**。",
        "* 已验证 /tmp/squad/isolated/very-long-worktree-path/owned.ts。",
        "## Assumptions & Trade-offs",
        '- 假设保留 `?token=` **鉴权参数** <img src=x onerror="window.__studioXss=true">',
        "",
      ].join("\n"),
    );
    await fsp.writeFile(
      path.join(f.root, ".mycodex", "squads-v2", squadId, "slots", "clean-verifier", ".mycodex", "result.md"),
      [
        "status: done",
        "summary: 终审门禁通过",
        "## Changes & Verification",
        "只读核验无越界。",
        "## Assumptions & Trade-offs",
        "- 零历史上下文独立运行测试",
        "",
      ].join("\n"),
    );
    f.threads.get(studioSlot.threadId).status = { type: "idle" };
    f.threads.get(verifierSlot.threadId).status = { type: "idle" };

    const browser = await launchHeadlessBrowser();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 520, height: 900 } });
    const errors = [];
    page.on("pageerror", err => errors.push(err.message));

    await page.goto(dispatched.studioUrl);
    await page.locator(".studio-shell").waitFor();

    // 1. XSS safety & 0px Needs You when needsYou is empty
    assert.equal(await page.evaluate(() => Boolean(window.__studioXss)), false);
    assert.match(await page.locator(".studio-sub-title").textContent(), /<img src=x/);
    const quietNeedsHeight = await page.locator("#needs-you-slot").evaluate(el => ({
      hidden: el.hidden,
      height: el.getBoundingClientRect().height,
    }));
    assert.deepEqual(quietNeedsHeight, { hidden: true, height: 0 });

    // 2. Role inspection: optional evidence + in-place /diff + stateful promote
    const studioCard = page.locator("#slot-card-role-studio");
    if ((await studioCard.locator(".role-peek-panel").count()) === 0) {
      await studioCard.locator(".role-card-summary").click();
    }
    assert.equal(await studioCard.locator(".role-peek-panel > .assumptions-callout").isVisible(), true);
    assert.match(await studioCard.locator(".assumptions-callout").innerText(), /关键假设与取舍/);
    assert.match(await studioCard.locator(".assumptions-callout").innerText(), /<img src=x/);
    assert.equal(await page.evaluate(() => Boolean(window.__studioXss)), false);

    const resultBody = studioCard.locator(".result-body-text");
    assert.equal(await resultBody.isVisible(), false);
    await studioCard.getByText("查看验证过程与取舍", { exact: true }).click();
    assert.doesNotMatch(await resultBody.innerText(), /status: done|summary:|Assumptions & Trade-offs|## /);
    assert.equal(await resultBody.locator("h2").textContent(), "Changes & Verification");
    assert.equal(await resultBody.locator("ul > li").count(), 2);
    assert.equal(await resultBody.locator("code").first().textContent(), "/snapshot");
    assert.equal(await resultBody.locator("strong").textContent(), "Gate");
    for (const text of await studioCard.locator(".assumptions-list li").allTextContents()) {
      assert.doesNotMatch(text, /^(?:[-*•]|\d+\.)\s+/);
    }
    assert.equal(await studioCard.locator(".assumptions-list code").textContent(), "?token=");
    assert.equal(await studioCard.locator(".assumptions-list strong").textContent(), "鉴权参数");
    assert.equal(await studioCard.locator("img").count(), 0);

    const promoteBtn = studioCard.getByRole("button", { name: "扶正至侧栏", exact: true });
    await promoteBtn.click();
    await studioCard.locator("text=✓ 已扶正至侧栏").waitFor();
    assert.equal((await f.kernel.status({ squadId })).slots.find(s => s.slotId === "role-studio").sidebarHidden, false);

    await studioCard.getByRole("button", { name: /交付与变更/ }).click();
    await studioCard.locator('[data-diff-path="owned.ts"]').click();
    await studioCard.locator(".diff-table").waitFor();
    const diffText = await studioCard.locator(".diff-table").innerText();
    assert.match(diffText, /\+export const mode = 'v2-studio';/);
    assert.match(diffText, /-export const mode = 'v1';/);
    const lineNums = await studioCard.locator(".diff-ln").allTextContents();
    assert.ok(lineNums.includes("1") && lineNums.includes("3"), "dual diff line numbers rendered");
    await studioCard.getByRole("button", { name: "← 文件列表", exact: true }).click();
    await studioCard.locator('[data-diff-path="owned.ts"]').waitFor();

    // 3. Clean verifier slot strictly omits promote / step-in buttons and shows zero-history badge
    const cleanCard = page.locator("#slot-card-clean-verifier");
    await cleanCard.locator(".role-card-summary").click();
    await cleanCard.locator(".role-peek-panel").waitFor();
    assert.match(await cleanCard.locator(".peek-tabs").innerText(), /零历史隔离槽/);
    assert.equal(await cleanCard.getByRole("button", { name: /扶正|深聊/ }).count(), 0);

    // 4. Open a Decision Gate -> Needs You visible -> select option & approve -> rev increments & collapses to 0px
    const currentRev = (await f.kernel.status({ squadId })).state.revision;
    await f.kernel.state({
      squadId,
      expectedRevision: currentRev,
      patch: {
        activeGate: {
          id: "G-STUDIO",
          kind: "decision",
          title: "确认分屏契约收敛",
          question: "选择代码抽检呈现方式",
          options: [
            { id: "opt-inline", label: "分屏原地 Diff", summary: "保持主对话不中断" },
            { id: "opt-jump", label: "跳转新窗口", summary: "离开当前对话" },
          ],
          recommendedOptionId: "opt-inline",
          status: "open",
          openedAt: 0,
          stateRevision: 0,
        },
      },
    });
    await page.getByRole("button", { name: "刷新", exact: true }).click();
    await page.locator("#needs-you-slot .needs-you-item").waitFor();
    assert.ok(
      (await page.locator("#needs-you-slot").evaluate(el => el.getBoundingClientRect().height)) > 80,
    );
    await page.locator('[data-gate-option-id="opt-inline"]').click();
    await page.locator('[data-gate-note-input="1"]').fill("按推荐方案执行");
    await page.locator('[data-gate-action="approved"]').click();
    await page.waitForFunction(() => {
      const slot = document.getElementById("needs-you-slot");
      return Boolean(slot && slot.hidden && slot.getBoundingClientRect().height === 0);
    });
    const afterGate = await f.kernel.status({ squadId });
    assert.equal(afterGate.state.revision, currentRev + 2);
    assert.equal(afterGate.state.activeGate.status, "approved");
    assert.match(afterGate.state.activeGate.resolutionText, /分屏原地 Diff — 按推荐方案执行/);

    // 5. Theme toggle & zero horizontal overflow across 400px, 520px, and 680px
    for (const width of [400, 520, 680]) {
      await page.setViewportSize({ width, height: 900 });
      for (const clickToggle of [false, true]) {
        if (clickToggle) await page.locator('[data-action="toggle-theme"]').click();
        const metrics = await page.evaluate(() => ({
          theme: document.documentElement.dataset.theme,
          docScrollWidth: document.documentElement.scrollWidth,
          docClientWidth: document.documentElement.clientWidth,
          bodyScrollWidth: document.body.scrollWidth,
          bodyClientWidth: document.body.clientWidth,
        }));
        assert.ok(
          metrics.docScrollWidth <= metrics.docClientWidth &&
            metrics.bodyScrollWidth <= metrics.bodyClientWidth,
          `0px horizontal overflow failed at ${width}px (${metrics.theme}): ${JSON.stringify(metrics)}`,
        );
      }
    }
    assert.deepEqual(errors, []);
  },
);

test("Studio Markdown preserves structure, fence contents and section boundaries without duplicate metadata or HTML execution", { timeout: 45000 }, async t => {
  const f = await createV2KernelFixture(t);
  const initial = await f.kernel.init({ anchorThreadId: f.anchorId, title: "Markdown", intent: "View rendering" });
  const dispatched = await f.kernel.dispatch({ squadId: initial.squadId, slots: [
    { slotId: "markdown", handle: "markdown", continuity: "stateful", workspace: "shared", task: "Markdown", touches: [] },
  ] });
  const snapshot = structuredClone(dispatched);
  const slot = snapshot.slots[0];
  const payload = '<img src=x onerror="window.__markdownXss=true">';
  const longPath = "/tmp/isolated/" + "long-path-".repeat(35) + "/result.md";
  slot.briefMarkdown = ["# Brief", "## Scope", "### Details", "- **Safe** `code`", "1. ordered", "", "paragraph one", "line two", "", "```html", payload, "```", longPath].join("\n");
  const browser = await launchHeadlessBrowser();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 400, height: 900 } });
  const errors = [];
  page.on("pageerror", err => errors.push(err.message));
  await page.route("http://127.0.0.1/**", route => route.fulfill({
    contentType: route.request().url().endsWith("/snapshot") ? "application/json" : "text/html",
    body: route.request().url().endsWith("/snapshot") ? JSON.stringify(snapshot) : renderSquadStudioHtml(snapshot),
  }));
  const render = async (body, assumptions = ["- **Safe** `code`", "* star", "1. numbered", "• bullet"]) => {
    slot.result = { status: "done", summary: "Delivery", body, assumptions, reportedAt: Date.now() };
    await page.goto("http://127.0.0.1/squads/markdown");
    if (!(await page.locator(".role-peek-panel").count())) await page.locator(".role-card-summary").click();
    await page.locator(".result-summary-head").waitFor();
    const evidence = page.getByText("查看验证过程与取舍", { exact: true });
    if (await evidence.count()) await evidence.click();
  };
  const body = ["---", "private: frontmatter", "---", "status: done", "summary: Delivery", "", "## Changes & Verification", "- **Verified** `inline`", "* " + longPath, "1. ordered", "2. next", "", "paragraph one", "line two", "", "```html", "## Assumptions & Trade-offs", payload, "```", "## Assumptions & Trade-offs", "- duplicate assumption", "### Nested assumption", "hidden child", "## Evidence", "kept evidence"].join("\n");
  await render(body);
  const result = page.locator(".result-body-text");
  assert.deepEqual(await result.locator("h2").allTextContents(), ["Changes & Verification", "Evidence"]);
  assert.equal(await result.locator("ul > li").count(), 2);
  assert.equal(await result.locator("ol > li").count(), 2);
  assert.equal(await result.locator("strong").textContent(), "Verified");
  assert.equal(await result.locator(".md-inline-code").first().textContent(), "inline");
  assert.equal(await result.locator(".md-inline-code").nth(1).getAttribute("title"), longPath);
  assert.match(await result.locator("pre > code").textContent(), /## Assumptions & Trade-offs\n<img src=x/);
  assert.doesNotMatch(await result.innerText(), /status:|summary:|private:|duplicate assumption|hidden child/);
  assert.ok((await result.locator("p").allTextContents()).includes("paragraph one\nline two"));
  for (const text of await page.locator(".assumptions-list li").allTextContents()) assert.doesNotMatch(text, /^(?:[-*•]|\d+\.)\s+/);
  assert.equal(await page.locator(".assumptions-list code").textContent(), "code");
  assert.equal(await page.locator(".assumptions-list strong").textContent(), "Safe");

  for (const theme of ["light", "dark"]) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    assert.equal(await result.evaluate(node => node.scrollWidth <= node.clientWidth), true, `long result path fits ${theme}`);
  }
  await page.getByRole("button", { name: "裁剪 Brief", exact: true }).click();
  const brief = page.locator(".brief-markdown");
  assert.equal(await brief.locator("h1").textContent(), "Brief");
  assert.equal(await brief.locator("h2").textContent(), "Scope");
  assert.equal(await brief.locator("h3").textContent(), "Details");
  assert.equal(await brief.locator("ul > li > strong").textContent(), "Safe");
  assert.equal(await brief.locator("pre > code").textContent(), payload);
  assert.equal(await brief.locator("ol > li").textContent(), "ordered");
  for (const width of [400, 520, 680]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ["light", "dark"]) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      assert.equal(await brief.evaluate(node => node.scrollWidth <= node.clientWidth), true, `brief fits ${width}px ${theme}`);
    }
  }
  assert.equal(await page.locator("img").count(), 0);
  assert.equal(await page.evaluate(() => Boolean(window.__markdownXss)), false);

  await render("status: done\nsummary: Delivery\n## Assumptions & Trade-offs\n- only callout");
  assert.equal(await result.count(), 0, "no empty body after deduplication");
  await render("status: done\nsummary: Delivery\n# Assumptions & Trade-offs\n### Nested\nhidden\n# Delivery\nkept");
  assert.deepEqual(await result.locator("h1").allTextContents(), ["Delivery"]);
  assert.doesNotMatch(await result.innerText(), /Nested|hidden/);
  await render("status: done\nsummary: Delivery\n## Assumptions & Trade-offs\n- retained", []);
  assert.equal(await result.locator("h2").textContent(), "Assumptions & Trade-offs", "keep assumptions when no callout exists");
  assert.equal(await result.locator("li").textContent(), "retained");
  await render("- **status**: done\n**summary**: Delivery\n## 关键假设与取舍 / 待确认\n- duplicate\n## Evidence\nKept", ["- surfaced"]);
  assert.equal(await page.locator(".assumptions-callout li").textContent(), "surfaced");
  assert.equal(await result.locator("h2").textContent(), "Evidence");
  assert.doesNotMatch(await result.textContent(), /duplicate|status|summary/);
  assert.deepEqual(errors, []);
});

test("Studio keeps completed criteria folded across refreshes and criterion IDs on one line at narrow widths", { timeout: 25000 }, async t => {
  const f = await createV2KernelFixture(t);
  const snapshot = await f.kernel.init({ anchorThreadId: f.anchorId, title: "Criteria", intent: "Keep pending work visible", state: {
    criteria: [
      ...Array.from({ length: 8 }, (_, i) => ({ id: `OPT-${i + 1}A`, text: "Completed verification with detailed evidence".repeat(3), ...(i % 2 ? { verifiedBy: "@verifier" } : { verifiedAt: 0 }) })),
      { id: "OPT-9A", text: "Pending work with a long explanation that must wrap without squeezing the identifier".repeat(4) },
      { id: "OPT-9B", text: "Another pending item" },
    ],
  } });
  const browser = await launchHeadlessBrowser();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 400, height: 900 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("http://127.0.0.1/**", route => route.fulfill({ contentType: route.request().url().includes("/snapshot") ? "application/json" : "text/html", body: route.request().url().includes("/snapshot") ? JSON.stringify(snapshot) : renderSquadStudioHtml(snapshot) }));
  await page.goto("http://127.0.0.1/squads/criteria");
  const fold = page.locator(".completed-criteria"), rows = page.locator(".criterion-row");
  assert.equal(await fold.getAttribute("open"), null);
  assert.match(await fold.locator("summary").innerText(), /已完成事项 \(8\)/);
  assert.equal(await rows.count(), 10);
  assert.equal(await page.locator(".criterion-row:visible").count(), 2);
  assert.equal(await page.locator(".criterion-row.is-done:visible").count(), 0);
  const refresh = async () => {
    snapshot.state.revision++;
    await page.getByRole("button", { name: "刷新", exact: true }).click();
    await page.waitForFunction(revision => document.body.textContent.includes(`STATE rev.${revision}`), snapshot.state.revision);
    await page.waitForFunction(() => [...document.querySelectorAll("button")].some(button => button.textContent === "刷新" && !button.disabled));
  };
  await fold.locator("summary").click();
  await refresh();
  assert.equal(await fold.evaluate(node => node.open), true);
  assert.equal(await page.locator(".criterion-row:visible").count(), 10);
  for (const width of [400, 520, 680]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ["light", "dark"]) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      const metrics = await page.locator(".criterion-id").evaluateAll(ids => ids.map(id => {
        const range = document.createRange(); range.selectNodeContents(id);
        return { lines: range.getClientRects().length, whiteSpace: getComputedStyle(id).whiteSpace, shrink: getComputedStyle(id).flexShrink };
      }));
      assert.equal(metrics.length, 10);
      for (const id of metrics) assert.deepEqual(id, { lines: 1, whiteSpace: "nowrap", shrink: "0" });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, `${width}px ${theme} document fits`);
      assert.equal(await rows.evaluateAll(nodes => nodes.every(node => node.scrollWidth <= node.clientWidth)), true, `${width}px ${theme} rows fit`);
    }
  }
  await fold.locator("summary").click();
  await refresh();
  assert.equal(await fold.evaluate(node => node.open), false);
  assert.equal(await page.locator(".criterion-row:visible").count(), 2);
  snapshot.state.criteria = snapshot.state.criteria.map(c => ({ ...c, verifiedAt: 0 }));
  await refresh();
  assert.match(await fold.locator("summary").innerText(), /已完成事项 \(10\)/);
  assert.equal(await page.locator(".criterion-row:visible").count(), 0);
  snapshot.state.criteria = [{ id: "OPT-10A", text: "Only pending work" }];
  await refresh();
  assert.equal(await fold.count(), 0);
  assert.equal(await page.locator(".criterion-row:visible").count(), 1);
  snapshot.state.criteria = [];
  await refresh();
  assert.equal(await fold.count(), 0);
  assert.equal(await rows.count(), 0);
  assert.deepEqual(errors, []);
});

test("Studio refresh button recovers after background/manual success and failure without losing focused Gate notes or unlocking busy actions", { timeout: 25000 }, async t => {
  const f = await createV2KernelFixture(t);
  const snapshot = await f.kernel.init({ anchorThreadId: f.anchorId, title: "Polling", intent: "Recover refresh", state: { activeGate: { id: "G", title: "Decide", question: "Ready?", kind: "decision", status: "open", openedAt: 0, stateRevision: 1 } } });
  const browser = await launchHeadlessBrowser();
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  let snapshotRelease, gateRelease;
  await page.route("http://127.0.0.1/**", async route => {
    if (route.request().url().includes("/snapshot")) {
      const response = await new Promise(resolve => { snapshotRelease = resolve; });
      return route.fulfill(response);
    }
    if (route.request().url().includes("/gate")) {
      await new Promise(resolve => { gateRelease = resolve; });
      snapshot.state.revision = 2;
      snapshot.state.activeGate.status = "approved";
      snapshot.needsYou = [];
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(snapshot) });
    }
    return route.fulfill({ contentType: "text/html", body: renderSquadStudioHtml(snapshot) });
  });
  await page.goto("http://127.0.0.1/squads/polling");
  const refresh = page.getByRole("button", { name: "刷新", exact: true });
  const beginPoll = async (manual = false) => {
    snapshotRelease = undefined;
    if (manual) await refresh.click();
    else await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    for (let i = 0; i < 100 && !snapshotRelease; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(snapshotRelease, "snapshot request reached the held endpoint");
  };
  const finishPoll = async (fail = false) => {
    snapshotRelease({ status: fail ? 500 : 200, contentType: "application/json", body: JSON.stringify(fail ? { error: "Controlled failure" } : snapshot) });
    await page.waitForFunction(() => [...document.querySelectorAll("button")].some(button => button.textContent === "刷新" && !button.disabled));
  };
  await beginPoll();
  await page.locator('[data-action="toggle-theme"]').click();
  assert.equal(await refresh.isDisabled(), true, "a render during polling must keep refresh disabled");
  await finishPoll();
  const input = page.locator('[data-gate-note-input="1"]');
  await input.fill("Keep my draft and selection");
  await input.evaluate(node => { node.focus(); node.setSelectionRange(5, 12); window.__noteNode = node; });
  await beginPoll();
  await finishPoll();
  assert.deepEqual(await input.evaluate(node => ({ same: node === window.__noteNode, focused: document.activeElement === node, value: node.value, start: node.selectionStart, end: node.selectionEnd })), { same: true, focused: true, value: "Keep my draft and selection", start: 5, end: 12 });
  await input.evaluate(node => node.blur());
  await beginPoll(true);
  assert.equal(await refresh.isDisabled(), true);
  await finishPoll(true);
  assert.match(await page.locator(".status-banner").innerText(), /Controlled failure/);
  await beginPoll();
  await finishPoll(true);

  await beginPoll();
  await page.locator('[data-gate-action="approved"]').click();
  for (let i = 0; i < 100 && !gateRelease; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(gateRelease);
  snapshotRelease({ contentType: "application/json", body: JSON.stringify(snapshot) });
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 100)));
  assert.equal(await refresh.isDisabled(), true, "poll completion cannot unlock an in-flight Gate action");
  gateRelease();
  await page.locator("#needs-you-slot[hidden]").waitFor({ state: "attached" });
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some(button => button.textContent === "刷新" && !button.disabled));
  assert.deepEqual(errors, []);
});

test("Studio and Card separate human criterion titles from safe technical details, retaining legacy content and expansion state", { timeout: 30000 }, async t => {
  const f = await createV2KernelFixture(t);
  const payload = '<img src=x onerror="window.__criterionXss=true">';
  const legacyChinese = "页面刷新后继续保留当前草稿：运行 `tests/draft-test.mjs` 验证刷新前后输入值、选区及 DOM 身份完全一致。";
  const legacyEnglish = "Restore draft: Run `tests/draft-test.mjs` and assert the selection, focus and input identity remain unchanged.";
  const url = "https://example.invalid/acceptance/this-is-a-long-url-that-must-stay-a-title";
  const criteria = [
    { id: "OPT-5A", text: "刷新后仍能继续处理当前待办", detail: `Run \`tests/criterion-test.mjs\` and **verify** every state.\n${payload}` },
    { id: "OPT-5B", text: legacyChinese }, { id: "OPT-5C", text: legacyEnglish, detail: null },
    { id: "OPT-5D", text: "备注：简短说明" }, { id: "OPT-5E", text: url },
    { id: "OPT-5F", text: "标题：这是一条明确保留完整标题且不应启用旧数据拆分的成果说明", detail: "Use the explicit standard only." },
    { id: "OPT-5G", text: "兼容没有冒号的旧版完整成果标题" },
  ];
  const snapshot = await f.kernel.init({ anchorThreadId: f.anchorId, title: "Criteria layers", intent: "Readable outcomes", state: { criteria } });
  const browser = await launchHeadlessBrowser();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 400, height: 900 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(snapshot => { window.openai = { toolOutput: snapshot }; }, snapshot);
  await page.route("http://127.0.0.1/**", route => route.fulfill({ contentType: route.request().url().includes("/snapshot") ? "application/json" : "text/html", body: route.request().url().includes("/snapshot") ? JSON.stringify(snapshot) : route.request().url().endsWith("/card") ? conversationSquadCardResource().text : renderSquadStudioHtml(snapshot) }));
  await page.goto("http://127.0.0.1/squads/layers");
  const row = id => page.locator(`[data-criterion-id="${id}"]`);
  const refresh = async () => {
    snapshot.state.revision++;
    await page.getByRole("button", { name: "刷新", exact: true }).click();
    await page.waitForFunction(revision => document.body.textContent.includes(`STATE rev.${revision}`), snapshot.state.revision);
  };
  const checkTitles = async (textClass, detailClass) => {
    assert.equal(await row("OPT-5A").locator(textClass).textContent(), criteria[0].text);
    assert.equal(await row("OPT-5B").locator(textClass).textContent(), "页面刷新后继续保留当前草稿");
    assert.equal(await row("OPT-5C").locator(textClass).textContent(), "Restore draft");
    assert.equal(await row("OPT-5D").locator(textClass).textContent(), criteria[3].text);
    assert.equal(await row("OPT-5E").locator(textClass).textContent(), url);
    assert.equal(await row("OPT-5F").locator(textClass).textContent(), criteria[5].text);
    assert.equal(await row("OPT-5G").locator(textClass).textContent(), criteria[6].text);
    for (const id of ["OPT-5D", "OPT-5E", "OPT-5G"]) assert.equal(await row(id).locator(detailClass).count(), 0);
    for (const id of ["OPT-5A", "OPT-5B", "OPT-5C", "OPT-5F"]) assert.equal(await row(id).getAttribute("open"), null);
    assert.doesNotMatch(await row("OPT-5A").innerText(), /criterion-test|<img/);
  };
  await checkTitles(".criterion-text", ".criterion-detail-content");
  await row("OPT-5A").locator("summary").click();
  assert.equal(await row("OPT-5A").locator("code").textContent(), "tests/criterion-test.mjs");
  assert.equal(await row("OPT-5A").locator("strong").textContent(), "verify");
  assert.match(await row("OPT-5A").innerText(), /<img src=x/);
  await row("OPT-5B").locator("summary").click();
  assert.match(await row("OPT-5B").locator(".criterion-detail-content").textContent(), /页面刷新后继续保留当前草稿：运行/);
  await refresh();
  assert.equal(await row("OPT-5A").evaluate(node => node.open), true);
  assert.equal(await row("OPT-5B").evaluate(node => node.open), true);
  await row("OPT-5A").locator("summary").click();
  await refresh();
  assert.equal(await row("OPT-5A").evaluate(node => node.open), false);
  assert.equal(await row("OPT-5B").evaluate(node => node.open), true);
  snapshot.state.criteria[1].verifiedAt = 0;
  await refresh();
  await page.locator(".completed-criteria > summary").click();
  assert.equal(await row("OPT-5B").evaluate(node => node.open), true, "detail stays open when the criterion moves into completed work");
  for (const width of [400, 520, 680]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ["light", "dark"]) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, `Studio ${width}px ${theme}`);
    }
  }
  assert.equal(await page.locator("img").count(), 0);
  assert.equal(await page.evaluate(() => Boolean(window.__criterionXss)), false);
  const style = await row("OPT-5A").evaluate(node => ({ id: getComputedStyle(node.querySelector(".criterion-id")).fontWeight, title: getComputedStyle(node.querySelector(".criterion-text")).fontWeight }));
  assert.ok(Number(style.id) < Number(style.title), "machine ID is visually subordinate to the outcome title");

  await page.goto("http://127.0.0.1/card");
  await page.locator(".mc-criteria-fold > summary").click();
  await checkTitles(".mc-crit-text", ".mc-criterion-detail-content");
  await row("OPT-5A").locator("summary").click();
  assert.equal(await row("OPT-5A").locator("code").textContent(), "tests/criterion-test.mjs");
  assert.match(await row("OPT-5A").innerText(), /<img src=x/);
  await row("OPT-5B").locator("summary").click();
  assert.match(await row("OPT-5B").locator(".mc-criterion-detail-content").textContent(), /页面刷新后继续保留当前草稿：运行/);
  for (const width of [400, 520, 680]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ["light", "dark"]) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, `Card ${width}px ${theme}`);
    }
  }
  assert.equal(await page.locator("img").count(), 0);
  assert.equal(await page.evaluate(() => Boolean(window.__criterionXss)), false);
  const cardStyle = await row("OPT-5A").evaluate(node => ({ id: getComputedStyle(node.querySelector(".mc-crit-id")).fontWeight, title: getComputedStyle(node.querySelector(".mc-crit-text")).fontWeight }));
  assert.ok(Number(cardStyle.id) < Number(cardStyle.title));
  assert.deepEqual(errors, []);
});

test(
  "Inline Milestone Card (SQUAD_CARD_URI) bridges to real serveMcp + SquadV2Kernel for Blueprint approval, revision conflict recovery and Convergence rendering",
  { timeout: 35000 },
  async t => {
    const f = await createV2KernelFixture(t);
    const created = await f.kernel.init({
      anchorThreadId: f.anchorId,
      title: "MCP 内嵌里程碑卡验收",
      intent: "主对话流内双通道批复 Gate 与展示关键假设",
      state: {
        criteria: [
          { id: "C1", text: "立项对齐卡直接批复 Gate" },
          { id: "C2", text: "阶段交付卡高亮队友关键假设" },
        ],
        activeGate: {
          id: "G-BLUEPRINT",
          kind: "blueprint",
          title: "立项角色切分确认",
          question: "是否按 2 持久专家 + 1 空白终审启动？",
          options: [
            { id: "plan-a", label: "标准异构编排", summary: "stateful 写代码 + clean 独立终审" },
            { id: "plan-b", label: "单槽串行", summary: "仅派发单个实现槽" },
          ],
          recommendedOptionId: "plan-a",
          status: "open",
          openedAt: 0,
          stateRevision: 1,
        },
      },
    });
    const squadId = created.squadId;

    // Wire real serveMcp over streams to SquadV2Kernel
    const mcpIn = new PassThrough();
    const mcpOut = new PassThrough();
    const pendingMcp = new Map();
    let outBuf = "";
    mcpOut.on("data", chunk => {
      outBuf += chunk;
      for (;;) {
        const nl = outBuf.indexOf("\n");
        if (nl < 0) break;
        const msg = JSON.parse(outBuf.slice(0, nl));
        outBuf = outBuf.slice(nl + 1);
        if (msg.id !== undefined && pendingMcp.has(msg.id)) {
          const waiter = pendingMcp.get(msg.id);
          pendingMcp.delete(msg.id);
          msg.error ? waiter.reject(new Error(msg.error.message)) : waiter.resolve(msg.result);
        }
      }
    });
    let mcpReqSeq = 1;
    const callMcp = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = mcpReqSeq++;
        pendingMcp.set(id, { resolve, reject });
        mcpIn.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    const mcpServer = serveMcp({
      input: mcpIn,
      output: mcpOut,
      surface: "full",
      dispatch: async (method, params) => {
        if (method === "diy/squad/list") return f.kernel.status(params);
        if (method === "diy/squad/roles") return f.kernel.state(params);
        throw new Error(`Unexpected MCP dispatch: ${method}`);
      },
    });
    t.after(() => {
      mcpServer.dispose();
      mcpIn.destroy();
      mcpOut.destroy();
    });

    await callMcp("initialize", {
      protocolVersion: "2025-06-18",
      clientInfo: { name: "card-host-test", version: "1.0.0" },
      capabilities: {},
    });
    mcpIn.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const readRes = await callMcp("resources/read", { uri: SQUAD_CARD_URI });
    const cardHtml = readRes.contents[0].text;
    const initialToolResult = await callMcp("tools/call", {
      name: "mycodex.show_squad_card",
      arguments: { squadId },
    });

    const browser = await launchHeadlessBrowser();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 780, height: 900 } });
    const errors = [];
    page.on("pageerror", err => errors.push(err.message));

    const cardToolCalls = [];
    const syncedContexts = [];
    const sizeEvents = [];
    await page.exposeFunction("__hostMcpCallTool", async (name, args) => {
      cardToolCalls.push(name);
      return callMcp("tools/call", { name, arguments: args });
    });
    await page.exposeFunction("__hostRecordContext", payload => {
      syncedContexts.push(payload);
    });
    await page.exposeFunction("__hostRecordSize", payload => {
      sizeEvents.push(payload);
    });

    await page.route("http://127.0.0.1/**", route => {
      const url = new URL(route.request().url());
      if (url.pathname === "/card.html") {
        return route.fulfill({ contentType: "text/html; charset=utf-8", body: cardHtml });
      }
      return route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: `<!doctype html><html><body style="margin:0;padding:16px"><iframe id="card-frame" src="/card.html" style="width:100%;border:0;min-height:480px"></iframe><script>
          const frame = document.getElementById("card-frame");
          const initialResult = ${JSON.stringify(initialToolResult)};
          window.addEventListener("message", async event => {
            if (event.source !== frame.contentWindow || !event.data || event.data.jsonrpc !== "2.0") return;
            const msg = event.data;
            if (msg.method === "ui/initialize") {
              frame.contentWindow.postMessage({
                jsonrpc: "2.0",
                id: msg.id,
                result: {
                  hostCapabilities: { updateModelContext: true },
                  hostContext: { theme: "dark" },
                },
              }, "*");
              return;
            }
            if (msg.method === "ui/notifications/initialized") {
              frame.contentWindow.postMessage({
                jsonrpc: "2.0",
                method: "ui/notifications/tool-input",
                params: { arguments: { squadId: ${JSON.stringify(squadId)} } },
              }, "*");
              frame.contentWindow.postMessage({
                jsonrpc: "2.0",
                method: "ui/notifications/tool-result",
                params: initialResult,
              }, "*");
              return;
            }
            if (msg.method === "ui/notifications/size-changed") {
              window.__hostRecordSize(msg.params);
              return;
            }
            if (msg.method === "ui/update-model-context") {
              window.__hostRecordContext(msg.params);
              frame.contentWindow.postMessage({ jsonrpc: "2.0", id: msg.id, result: {} }, "*");
              return;
            }
            if (msg.method === "tools/call") {
              try {
                const result = await window.__hostMcpCallTool(msg.params.name, msg.params.arguments);
                frame.contentWindow.postMessage({ jsonrpc: "2.0", id: msg.id, result }, "*");
              } catch (err) {
                frame.contentWindow.postMessage({ jsonrpc: "2.0", id: msg.id, error: { message: String(err.message || err) } }, "*");
              }
            }
          });
        </script></body></html>`,
      });
    });

    await page.goto("http://127.0.0.1/");
    const cardFrame = page.frameLocator("#card-frame");
    await cardFrame.locator(".mc-gate-box").waitFor();
    assert.equal(await cardFrame.locator("html").getAttribute("data-theme"), "dark");
    assert.match(await cardFrame.locator(".mc-eyebrow").innerText(), /方案拍板/);

    // Let the 50ms fallback window elapse before proving no automatic status RPC.
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 100)));
    assert.equal(cardToolCalls.filter(name => name === "mycodex.squad_status").length, 0);
    assert.equal(await cardFrame.locator(".mc-title").textContent(), "MCP 内嵌里程碑卡验收");
    assert.equal(await cardFrame.locator(".mc-intent, .mc-role-grid, .mc-role-chip, .mc-slot-grid").count(), 0);
    assert.equal(await cardFrame.locator(".mc-criteria-fold").getAttribute("open"), null);
    assert.equal(await cardFrame.locator(".mc-assumptions, .mc-blocker-row").count(), 0);
    assert.doesNotMatch(await cardFrame.locator(".mc-head").innerText(), /已收束/);
    assert.ok(await cardFrame.locator("#squad-card").evaluate(node => node.getBoundingClientRect().height < 520), "Blueprint fits a compact screen");
    await cardFrame.getByRole("button", { name: "刷新状态", exact: true }).click();
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 100)));
    assert.equal(cardToolCalls.filter(name => name === "mycodex.squad_status").length, 1, "manual refresh still issues one status RPC");

    // Approve Blueprint Gate through real serveMcp -> SquadV2Kernel
    await cardFrame.locator(".mc-note-input").fill("同意立项启动");
    await cardFrame.locator('[data-gate-action="approved"]').click();
    await cardFrame.locator(".mc-resolved-receipt").waitFor();
    assert.match(await cardFrame.locator(".mc-resolved-receipt").innerText(), /同意立项启动/);
    assert.ok(syncedContexts.length >= 1, "ui/update-model-context synced after Gate resolution");
    assert.ok(sizeEvents.length >= 1, "ui/notifications/size-changed emitted");

    // Advance backend to Convergence state with verified criteria & teammate assumptions, plus test conflict recovery
    const dispatched = await f.kernel.dispatch({
      squadId,
      slots: [
        { slotId: "impl", handle: "role-studio", continuity: "stateful", workspace: "shared", task: "Implement UI", touches: [] },
      ],
    });
    const implSlot = dispatched.slots[0];
    await fsp.writeFile(
      path.join(f.root, ".mycodex", "squads-v2", squadId, "slots", "impl", ".mycodex", "result.md"),
      [
        "status: done",
        "summary: 完成内嵌卡与工作台闭环",
        "## Changes & Verification",
        "Playwright 验收通过。",
        "## Assumptions & Trade-offs",
        "1. 内嵌卡与右侧 Studio 共享单一 expectedRevision 乐观锁，保留 `token` 与 **隔离** <img src=x onerror=window.__cardXss=true>",
        "* 星号条目",
        "• 圆点条目",
        "",
      ].join("\n"),
    );
    f.threads.get(implSlot.threadId).status = { type: "idle" };
    const latestBeforeConv = await f.kernel.status({ squadId });
    const convState = await f.kernel.state({
      squadId,
      expectedRevision: latestBeforeConv.state.revision,
      patch: {
        criteria: [
          { id: "C1", text: "立项对齐卡直接批复 Gate", verifiedBy: "@clean-verifier" },
          { id: "C2", text: "阶段交付卡高亮队友关键假设", verifiedBy: "@clean-verifier" },
        ],
        activeGate: {
          id: "G-CONVERGENCE",
          kind: "convergence",
          title: "阶段交付验收",
          question: "确认合入集成工作树？",
          status: "open",
          openedAt: 0,
          stateRevision: 0,
        },
      },
    });
    const convResult = await callMcp("tools/call", {
      name: "mycodex.show_squad_card",
      arguments: { squadId, summary: "共享乐观锁让卡片与工作台的裁决保持一致。", highlights: [{ title: "同源状态与清晰写边界", body: "内嵌卡与右侧 Studio 共享单一 expectedRevision 乐观锁，保留 `token` 与 **隔离** <img src=x onerror=window.__cardXss=true>", kind: "architecture" }] },
    });
    await page.evaluate(result => {
      const frame = document.getElementById("card-frame");
      frame.contentWindow.postMessage(
        { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: result },
        "*",
      );
    }, convResult);

    await cardFrame.locator(".mc-review-item").waitFor();
    assert.match(await cardFrame.locator(".mc-eyebrow").innerText(), /阶段验收/);
    assert.match(await cardFrame.locator(".mc-review-item").innerText(), /共享单一 expectedRevision 乐观锁/);
    assert.equal(await cardFrame.locator(".mc-review-item code").textContent(), "token");
    assert.equal(await cardFrame.locator(".mc-review-item strong").textContent(), "隔离");
    assert.equal(await cardFrame.locator(".mc-review-item img").count(), 0);
    assert.equal(await cardFrame.locator("html").evaluate(() => Boolean(window.__cardXss)), false);
    assert.match(await cardFrame.locator(".mc-badges").first().innerText(), /✓ 2\/2 判据/);

    assert.doesNotMatch(await cardFrame.locator(".mc-head").innerText(), /已收束/);
    assert.match(await cardFrame.locator(".mc-head").innerText(), /1\/1 静止/);
    assert.deepEqual(await cardFrame.locator("#squad-card").evaluate(node => [...node.querySelectorAll('*')].filter(item => ['auto','scroll'].includes(getComputedStyle(item).overflowY)).map(item => item.className)), [], "Convergence stays in the conversation flow");

    // Trigger an external revision bump to verify optimistic conflict recovery without silent overwrite
    await f.kernel.state({
      squadId,
      expectedRevision: convState.state.revision,
      patch: { intent: "外部并发推进后的新说明" },
    });
    await cardFrame.locator('[data-gate-action="approved"]').click();
    await cardFrame.locator(".mc-notice.is-error").waitFor();
    assert.match(await cardFrame.locator(".mc-notice.is-error").innerText(), /刚被更新至 rev\./);

    // Now approve on refreshed revision -> succeeds
    await cardFrame.locator('[data-gate-action="approved"]').click();
    await cardFrame.locator(".mc-resolved-receipt").waitFor();
    assert.equal((await f.kernel.status({ squadId })).state.activeGate.status, "approved");
    assert.deepEqual(errors, []);
  },
);

test("Card bootstrap uses pushed and legacy snapshots immediately, falls back once for input-only hosts and reports actual lifecycle", { timeout: 20000 }, async t => {
  const snapshot = { squadId: "bootstrap", status: "active", slots: [], state: { schemaVersion: 2, revision: 1, title: "Bootstrap", intent: "Do not repeat this", criteria: [{ id: "C1", text: "done", verifiedAt: 0 }], openBlockers: [], tasks: [] } };
  const result = { structuredContent: snapshot, content: [{ type: "text", text: JSON.stringify(snapshot) }], isError: false };
  const browser = await launchHeadlessBrowser();
  t.after(() => browser.close());
  for (const mode of ["pushed", "input-only", "legacy", "legacy-input"]) {
    const page = await browser.newPage({ viewport: { width: 600, height: 700 } });
    t.after(() => page.close());
    page.setDefaultTimeout(5000);
    const calls = [], errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.exposeFunction("recordStatusCall", () => { calls.push("status"); return result; });
    await page.addInitScript(({ mode, snapshot }) => {
      if (mode.startsWith("legacy")) window.openai = {
        toolInput: { squadId: snapshot.squadId },
        ...(mode === "legacy" ? { toolOutput: snapshot } : {}),
        callTool: () => window.recordStatusCall(),
      };
    }, { mode, snapshot });
    await page.route("http://127.0.0.1/**", route => route.fulfill({ contentType: "text/html", body: mode.startsWith("legacy") || route.request().url().endsWith("card") ? conversationSquadCardResource().text : `<!doctype html><iframe src="/card" style="width:100%;border:0"></iframe><script>
      const frame = document.querySelector("iframe");
      const result = ${JSON.stringify(result)};
      const reply = msg => frame.contentWindow.postMessage(msg, "*");
      addEventListener("message", async event => {
        if (event.source !== frame.contentWindow) return;
        const msg = event.data;
        if (msg.method === "ui/initialize") reply({ jsonrpc: "2.0", id: msg.id, result: {} });
        if (msg.method === "ui/notifications/initialized") {
          reply({ jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: { squadId: "bootstrap" } } });
          if (${JSON.stringify(mode)} === "pushed") reply({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: result });
        }
        if (msg.method === "tools/call") reply({ jsonrpc: "2.0", id: msg.id, result: await window.recordStatusCall() });
      });
    </script>` }));
    await page.goto("http://127.0.0.1/");
    const card = mode.startsWith("legacy") ? page : page.frameLocator("iframe");
    await card.locator(".mc-title").waitFor();
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 120)));
    assert.equal(calls.length, mode === "input-only" || mode === "legacy-input" ? 1 : 0, mode);
    assert.doesNotMatch(await card.locator(".mc-head").innerText(), /已收束|静止|执行中/);
    assert.match(await card.locator(".mc-head").innerText(), /✓ 1\/1 判据/);
    assert.equal(await card.locator(".mc-assumptions, .mc-blocker-row, .mc-gate-box, .mc-resolved-receipt").count(), 0);
    assert.equal(await card.locator(".mc-body").evaluate(node => node.getBoundingClientRect().height), 0);
    assert.doesNotMatch(await card.locator("#squad-card").innerText(), /Do not repeat this/);
    if (mode === "legacy") {
      for (const [activity, expected] of [["active", "⟳1 执行中"], ["quiescent", "1/1 静止"]]) {
        await page.evaluate(({ snapshot, activity }) => {
          window.openai.toolOutput = { ...snapshot, slots: [{ slotId: "one", activity }] };
          dispatchEvent(new Event("openai:set_globals"));
        }, { snapshot, activity });
        assert.match(await card.locator(".mc-head").innerText(), new RegExp(expected));
        assert.doesNotMatch(await card.locator(".mc-head").innerText(), /已收束/);
      }
      await page.evaluate(snapshot => { window.openai.toolOutput = { ...snapshot, status: "closed" }; dispatchEvent(new Event("openai:set_globals")); }, snapshot);
      assert.match(await card.locator(".mc-head").innerText(), /已收束/);
      assert.equal(calls.length, 0);
    }
    assert.deepEqual(errors, []);
    await page.close();
  }
});

test(
  "Host adapters browser E2E verifies ancestor Fiber & fallback route resolution, sidebar ::after capsule badges, client-new-thread hiding, and child-session return anchor",
  { timeout: 35000 },
  async t => {
    const browser = await launchHeadlessBrowser();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    const errors = [];
    page.on("pageerror", err => errors.push(err.message));

    const anchorId = "11111111-1111-4111-8111-111111111111";
    const workerOneId = "22222222-2222-4222-8222-222222222222";
    const workerTwoId = "33333333-3333-4333-8333-333333333333";
    const draftRowUuid = "99999999-9999-4999-8999-999999999999";

    await page.route("http://127.0.0.1/**", route => {
      return route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: `<!doctype html><html><body>
          <aside class="app-shell-left-panel" style="width:260px">
            <button id="row-anchor" data-app-action-sidebar-thread-row="1" data-app-action-sidebar-thread-host-id="local" data-app-action-sidebar-thread-id="local:${anchorId}" style="display:block;width:240px;text-align:left"><span>主会话 · Squad V2</span></button>
            <button id="row-worker-direct" data-app-action-sidebar-thread-row="1" data-app-action-sidebar-thread-host-id="local" data-app-action-sidebar-thread-id="local:${workerOneId}" style="display:block;width:240px"><span>Worker Direct</span></button>
            <button id="row-worker-draft" data-app-action-sidebar-thread-row="1" data-app-action-sidebar-thread-host-id="local" data-app-action-sidebar-thread-id="local:client-new-thread:${draftRowUuid}" style="display:block;width:240px"><span>Worker Client New Thread</span></button>
          </aside>
          <main id="stage">
            <div id="route-ancestor">
              <div id="above-marker" data-above-composer-conversation-id="local:${workerOneId}"></div>
              <section data-composer-surface-variant="default" data-composer-input="1">
                <div id="composer-box" class="ProseMirror" role="textbox" contenteditable="true"></div>
              </section>
            </div>
          </main>
        </body></html>`,
      });
    });

    await page.goto("http://127.0.0.1/");

    // 1. Verify readNativeComposerRoute ancestor Fiber walk + [data-above-composer-conversation-id] fallback
    const routeReaderSnippet = `(() => {
      const desktopPickerBinding = ${desktopPickerBinding.toString()};
      return ${readNativeComposerRoute.toString()};
    })()`;
    const routeChecks = await page.evaluate(
      ({ snippet, anchorId, workerOneId }) => {
        const readRoute = (0, eval)(snippet);
        const box = document.getElementById("composer-box");
        const fallbackHit = readRoute(box);
        const ancestor = document.getElementById("route-ancestor");
        const hostFiber = { stateNode: ancestor, memoizedProps: {}, child: null, sibling: null, return: null };
        const routeProviderFiber = {
          memoizedProps: { location: { pathname: `/local/${anchorId}`, key: "k1" } },
          child: hostFiber,
          sibling: null,
          return: null,
        };
        const hostRoot = { tag: 3, stateNode: { current: routeProviderFiber }, child: routeProviderFiber, sibling: null, return: null };
        routeProviderFiber.return = hostRoot;
        hostFiber.return = routeProviderFiber;
        ancestor.__reactFiber$test = hostFiber;
        const fiberHit = readRoute(box);
        delete ancestor.__reactFiber$test;
        document
          .getElementById("above-marker")
          .setAttribute("data-above-composer-conversation-id", `local:${workerOneId}`);
        return { fallbackHit, fiberHit };
      },
      { snippet: routeReaderSnippet, anchorId, workerOneId },
    );

    assert.deepEqual(routeChecks.fallbackHit, { pathname: `/local/${workerOneId}`, key: null });
    assert.deepEqual(routeChecks.fiberHit, { pathname: `/local/${anchorId}`, key: "k1" });

    // 2. Verify buildDesktopSquadsPatch hides direct & client-new-thread workers and renders CSS ::after capsule on anchor without mutating child nodes
    const squadsPatch = buildDesktopSquadsPatch("__squadBind", "squad-resp", true);
    await page.evaluate(
      ({ patch, anchorId, workerOneId, workerTwoId }) => {
        const draftRow = document.getElementById("row-worker-draft");
        draftRow.__reactFiber$row = {
          memoizedProps: { conversationId: `local:${workerTwoId}` },
          return: null,
        };
        globalThis.__squadBind = raw => {
          const req = JSON.parse(raw);
          if (req.method === "listSquads") {
            queueMicrotask(() => {
              globalThis.dispatchEvent(
                new CustomEvent("squad-resp", {
                  detail: {
                    id: req.id,
                    result: {
                      squads: [
                        {
                          id: "sq-v2",
                          label: "Squad V2",
                          status: "active",
                          anchorThreadId: anchorId,
                          members: [
                            { threadId: anchorId, role: "supervisor", shortName: "main" },
                            { threadId: workerOneId, role: "worker", shortName: "role-studio", sidebarHidden: true },
                            { threadId: workerTwoId, role: "worker", shortName: "clean-verifier", sidebarHidden: true },
                          ],
                          memberStates: {
                            [workerOneId]: "running",
                            [workerTwoId]: "done",
                          },
                        },
                      ],
                      threads: [
                        { id: anchorId, status: { type: "idle" } },
                        { id: workerOneId, status: { type: "active" } },
                        { id: workerTwoId, status: { type: "completed" } },
                      ],
                    },
                  },
                }),
              );
            });
          }
        };
        (0, eval)(patch);
      },
      { patch: squadsPatch, anchorId, workerOneId, workerTwoId },
    );

    await page.waitForFunction(() =>
      Boolean(document.getElementById("row-anchor")?.getAttribute("data-ccodex-squad-badge")),
    );
    const sidebarState = await page.evaluate(() => {
      const anchor = document.getElementById("row-anchor");
      const w1 = document.getElementById("row-worker-direct");
      const w2 = document.getElementById("row-worker-draft");
      return {
        badge: anchor.getAttribute("data-ccodex-squad-badge"),
        tone: anchor.getAttribute("data-ccodex-squad-tone"),
        afterContent: getComputedStyle(anchor, "::after").content,
        anchorDisplay: getComputedStyle(anchor).display,
        anchorChildCount: anchor.childElementCount,
        w1Display: getComputedStyle(w1).display,
        w2Display: getComputedStyle(w2).display,
      };
    });
    assert.equal(sidebarState.badge, "⟳1 · ✓1");
    assert.equal(sidebarState.tone, "running");
    assert.match(sidebarState.afterContent, /⟳1 · ✓1/);
    assert.equal(sidebarState.anchorDisplay, "block");
    assert.equal(sidebarState.anchorChildCount, 1);
    assert.equal(sidebarState.w1Display, "none");
    assert.equal(sidebarState.w2Display, "none");

    // 3. Return navigation shares the sidebar snapshot; no drawer is loaded.
    const pinnedVersion = currentHostContracts.at(-1).version;
    await page.evaluate(({ patch, pinnedVersion }) => {
      globalThis.codexWindowType = "electron";
      globalThis.electronBridge = { getSentryInitOptions: () => ({ appVersion: pinnedVersion }) };
      globalThis.__navigatedPaths = [];
      window.addEventListener("message", ev => {
        if (ev.data?.type === "navigate-to-route" && typeof ev.data.path === "string") {
          globalThis.__navigatedPaths.push(ev.data.path);
          document.getElementById("above-marker").setAttribute("data-above-composer-conversation-id", `local:${ev.data.path.replace(/^\/local\//, "")}`);
        }
      });
      globalThis.__codexCopilotSquadsV1.dispose();
      return (0, eval)(patch);
    }, { patch: squadsPatch, pinnedVersion });
    assert.equal(await page.locator('[data-mycodex-drawer]').count(), 0);
    assert.equal(await page.locator('#stage').evaluate(node => node.style.marginInlineEnd), "");

    const returnHost = page.locator('[data-mycodex-return-anchor="1"]');
    await page.waitForFunction(() => {
      const host = document.querySelector('[data-mycodex-return-anchor="1"]');
      return Boolean(host && !host.hidden);
    });
    assert.match(await returnHost.locator(".meta").innerText(), /role-studio · Squad V2/);
    await returnHost.getByRole("button", { name: "★ 返回主会话", exact: true }).click();

    await page.waitForFunction(() => {
      const host = document.querySelector('[data-mycodex-return-anchor="1"]');
      return Boolean(host && host.hidden);
    });
    assert.deepEqual(await page.evaluate(() => globalThis.__navigatedPaths), [`/local/${anchorId}`]);

    await page.evaluate(() => {
      globalThis.__codexCopilotSquadsV1.dispose();
    });
    assert.equal(await page.locator('[data-mycodex-return-anchor="1"]').count(), 0);
    assert.equal(await page.locator("#row-anchor").getAttribute("data-ccodex-squad-badge"), null);
    assert.deepEqual(errors, []);
  },
);


test("Studio system-wait buttons open the matching Desktop route, preserve clean isolation and report offline fallback", { timeout: 30000 }, async t => {
  const { openDesktopSquadThread } = await import("../bridge/desktop-gateway-ui.mjs");
  const browser = await launchHeadlessBrowser(); t.after(() => browser.close());
  const desktop = await browser.newPage(), studio = await browser.newPage(), errors = [];
  for (const page of [desktop, studio]) { page.setDefaultTimeout(4000); page.on("pageerror", e => errors.push(e.message)); }
  let connected = true;
  const targets = [{ contexts: new Set([1]), session: { active: true, send: async (_method, p) => ({ result: { value: await desktop.evaluate(p.expression) } }) } }];
  const f = await createV2KernelFixture(t, (thread, anchorThreadId) => openDesktopSquadThread(connected ? targets : [], { threadId: thread.id, anchorThreadId }, () => {}));
  const init = await f.kernel.init({ anchorThreadId: f.anchorId });
  const snap = await f.kernel.dispatch({ squadId: init.squadId, slots: [
    { slotId: "expert", continuity: "stateful", task: "Build", touches: [] },
    { slotId: "clean", continuity: "clean", task: "Verify", touches: [] },
  ] });
  const clean = snap.slots.find(s => s.slotId === "clean"), expert = snap.slots.find(s => s.slotId === "expert");
  await desktop.setContent(`<main><div data-above-composer-conversation-id="local:${f.anchorId}"></div><section data-composer-input><div contenteditable="true">Keep my draft</div></section></main>`);
  await desktop.evaluate(version => {
    globalThis.codexWindowType = "electron"; globalThis.electronBridge = { getSentryInitOptions: () => ({ appVersion: version }) };
    globalThis.routes = [];
    addEventListener("message", event => { if (event.data?.type === "navigate-to-route" && !globalThis.blockNavigation) { routes.push(event.data.path); document.querySelector('[data-above-composer-conversation-id]').setAttribute('data-above-composer-conversation-id', event.data.path); } });
  }, currentHostContracts.at(-1).version);
  f.threads.get(clean.threadId).status = { type: "active", activeFlags: ["waitingOnApproval"] };
  await studio.goto(snap.studioUrl);
  await studio.locator('#needs-you-slot [data-open-slot="clean"]').click();
  await studio.waitForFunction(() => document.body.textContent.includes("已打开"));
  assert.deepEqual(await desktop.evaluate(() => routes), [`/local/${clean.threadId}`]);
  const both = await openDesktopSquadThread([targets[0], targets[0]], { threadId: clean.threadId, anchorThreadId: f.anchorId }, () => {});
  assert.equal(both.opened, false, "multiple matching renderer contexts never broadcast navigation");
  await desktop.evaluate(() => document.querySelector('[data-above-composer-conversation-id]').setAttribute('data-above-composer-conversation-id', 'local:99999999-9999-4999-8999-999999999999'));
  const ordinary = await openDesktopSquadThread(targets, { threadId: expert.threadId, anchorThreadId: f.anchorId }, () => {});
  assert.equal(ordinary.opened, true, "a unique verified host can open a stateful slot from another chat");
  assert.equal((await desktop.evaluate(() => routes)).at(-1), `/local/${expert.threadId}`);
  await assert.rejects(openDesktopSquadThread(targets, { threadId: '/remote/invalid', anchorThreadId: f.anchorId }, () => {}), /Invalid Desktop/);
  await desktop.evaluate(() => globalThis.blockNavigation = true);
  const unacknowledged = await openDesktopSquadThread(targets, { threadId: clean.threadId, anchorThreadId: f.anchorId }, () => {});
  assert.equal(unacknowledged.opened, false, "dispatching a route message alone is not successful navigation");
  await desktop.evaluate(() => globalThis.blockNavigation = false);


  if (await studio.locator('#slot-card-clean .role-card-summary').getAttribute('aria-expanded') !== 'true') await studio.locator('#slot-card-clean .role-card-summary').click();
  const cleanPanel = studio.locator('#slot-card-clean');
  assert.equal(await cleanPanel.getByRole("button", { name: "扶正至侧栏", exact: true }).count(), 0);
  assert.equal(await cleanPanel.locator('[data-open-slot="clean"]').count(), 1);
  f.threads.get(clean.threadId).status = { type: "idle" };
  await studio.reload();
  if (await studio.locator('#slot-card-clean .role-card-summary').getAttribute('aria-expanded') !== 'true') await studio.locator('#slot-card-clean .role-card-summary').click();
  assert.equal(await studio.locator('[data-open-slot="clean"]').count(), 0);
  f.threads.get(clean.threadId).status = { type: "waitingOnUserInput" };
  connected = false;
  await studio.reload();
  await studio.locator('#needs-you-slot [data-open-slot="clean"]').click();
  await studio.waitForFunction(() => document.body.textContent.includes("Desktop") && document.body.textContent.includes("未连接"));
  assert.equal((await f.kernel.status({ squadId: init.squadId })).slots.find(s => s.slotId === "clean").sidebarHidden, true);
  await studio.locator('#slot-card-expert .role-card-summary').click();
  await studio.locator('#slot-card-expert [data-open-slot="expert"]').click();
  await studio.waitForFunction(() => document.body.textContent.includes("侧栏"));
  assert.equal((await f.kernel.status({ squadId: init.squadId })).slots.find(s => s.slotId === "expert").sidebarHidden, true);
  assert.equal(await desktop.locator('[contenteditable]').innerText(), "Keep my draft");
  assert.deepEqual(errors, []);
});


test("Studio polls preserve timers, hover and selections in place, then restore inspection state on a semantic change", { timeout: 25000 }, async t => {
  const f = await createV2KernelFixture(t);
  const snapshot = await f.kernel.init({ anchorThreadId: f.anchorId, state: {
    activeGate: { id: "G", kind: "decision", status: "open", title: "Decide", question: "Ready?" },
    criteria: [{ id: "C1", text: "Verified", detail: "Evidence", verifiedBy: "@main" }],
  } });
  const receipt = { status: "done", summary: "Verified result", assumptions: ["Observed input"], body: "Verification logs", reportedAt: 1 };
  const slot = { slotId: "dev", handle: "dev", continuity: "stateful", workspace: "worktree", stage: "running", activity: "active", touches: [], dependsOn: [], elapsedMs: 1000, result: receipt,
    rounds: [
      { round: 1, stage: "delivered", goal: "Original goal", result: receipt, deliverables: [] },
      { round: 2, stage: "running", goal: "Current goal", deliverables: [] },
    ],
    delta: { changed: [{ path: "owned.ts", status: "M", add: 1, del: 1 }], outsideTouches: [] },
  };
  const synthetic = { status: "blocked", autoSynthesized: true, summary: "Physical snapshot", reportedAt: 1 };
  snapshot.slots = [slot, ...Array.from({ length: 7 }, (_, i) => ({
    slotId: "work-" + i, handle: "work-" + i, continuity: "stateful", workspace: "shared", stage: "running", activity: "active", touches: [], dependsOn: [], result: synthetic,
  })), { ...slot, slotId: "retired", handle: "retired", stage: "superseded", activity: "closed" }];
  const browser = await launchHeadlessBrowser(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 400, height: 560 } });
  await page.route("http://127.0.0.1/**", route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith("/snapshot")) return route.fulfill({ json: snapshot });
    if (pathname.endsWith("/diff")) return route.fulfill({ json: { diff: "@@ -1 +1 @@\n-old\n+new\n" } });
    return route.fulfill({ contentType: "text/html", body: renderSquadStudioHtml(snapshot) });
  });
  await page.goto("http://127.0.0.1/squads/steady");
  const refresh = page.getByRole("button", { name: "刷新", exact: true });
  const poll = async () => {
    const response = page.waitForResponse(resp => resp.url().endsWith("/snapshot"));
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await response;
    await page.waitForFunction(() => !document.querySelector('[data-action="refresh"]').disabled);
  };
  const card = page.locator("#slot-card-dev");
  const handle = card.locator(".role-handle");
  await handle.hover();
  await handle.evaluate(node => {
    window.initialHandle = node;
    const selection = getSelection();
    selection.selectAllChildren(node);
  });
  slot.elapsedMs = 7000;
  synthetic.reportedAt++;
  await poll();
  assert.match(await card.locator(".role-metrics").textContent(), /00:07/);
  assert.deepEqual(await handle.evaluate(node => [node === initialHandle, node.matches(":hover"), getSelection().toString()]), [true, true, "dev"]);
  slot.elapsedMs = 8000;
  const elapsed = card.locator(".role-elapsed");
  await elapsed.evaluate(node => getSelection().setBaseAndExtent(node.firstChild, 3, node.firstChild, 5));
  await poll();
  assert.equal(await page.evaluate(() => getSelection().toString()), "08");
  await refresh.click();
  await page.waitForFunction(() => document.querySelector(".status-banner")?.textContent.includes("已同步"));
  assert.ok(await handle.evaluate(node => node === initialHandle));

  await page.locator(".completed-criteria > summary").click();
  await page.locator('[data-criterion-id="C1"] > summary').click();
  await page.locator(".archived-members > summary").click();
  await card.locator(".round-history > summary").click();
  await card.locator(".round-history .evidence-drawer > summary").click();
  await card.locator(".role-peek-panel > .evidence-drawer > summary").click();
  await card.getByRole("button", { name: /交付与变更/ }).click();
  await card.locator(".file-row-btn").click();
  await card.locator(".diff-row-add").waitFor();
  const input = page.locator('[data-gate-note-input="1"]');
  await input.fill("Draft for the Gate");
  await input.evaluate(node => {
    window.initialGateInput = node;
    node.setSelectionRange(2, 9, "backward");
    document.body.scrollTop = 100;
  });
  receipt.reportedAt++;
  await poll();
  assert.deepEqual(await input.evaluate(node => ({
    replaced: node !== initialGateInput, active: document.activeElement === node,
    value: node.value, start: node.selectionStart, end: node.selectionEnd, direction: node.selectionDirection,
    scrollTop: document.body.scrollTop,
  })), { replaced: true, active: true, value: "Draft for the Gate", start: 2, end: 9, direction: "backward", scrollTop: 100 });
  assert.equal(await card.locator(".peek-tab.is-active").textContent(), "交付与变更 · 1");
  assert.equal(await card.locator(".diff-row-add .diff-code").textContent(), "+new");
  for (const selector of [".completed-criteria", "[data-criterion-id='C1']", ".archived-members"]) {
    assert.equal(await page.locator(selector).getAttribute("open"), "");
  }
  await card.getByRole("button", { name: "结论与波次" }).click();
  for (const selector of [".role-peek-panel > .evidence-drawer", ".round-history", ".round-history .evidence-drawer"]) {
    assert.equal(await card.locator(selector).getAttribute("open"), "");
  }
});

test("Studio orders active stages and keeps settled slots in a compact, expandable archive", { timeout: 15000 }, async t => {
  const f = await createV2KernelFixture(t);
  const snapshot = await f.kernel.init({ anchorThreadId: f.anchorId });
  const stages = ["accepted", "planned", "delivered", "running", "superseded", "waiting", "failed", "blocked", "escalated"];
  snapshot.slots = stages.map(stage => ({
    slotId: stage, handle: stage, continuity: "stateful", workspace: "worktree", activity: "quiescent", stage, touches: [], dependsOn: [],
    ...(["accepted", "superseded"].includes(stage) ? {
      result: { status: "done", summary: "Archived outcome", assumptions: [] },
      deliverables: [{ kind: "mr", label: "repo!1", href: "https://git.example/mr/1" }, { kind: "commit", label: "12345678" }, { kind: "branch", label: "work/dev" }],
    } : { result: { autoSynthesized: true, summary: "Physical snapshot" } }),
  }));
  snapshot.state.tasks = [{ slotId: "planned", goal: "Planned objective" }];
  const browser = await launchHeadlessBrowser(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 360, height: 900 } });
  await page.route("http://127.0.0.1/**", route => route.request().url().endsWith("/snapshot")
    ? route.fulfill({ json: snapshot })
    : route.fulfill({ contentType: "text/html", body: renderSquadStudioHtml(snapshot) }));
  await page.goto("http://127.0.0.1/squads/archive");
  assert.deepEqual(await page.locator(".studio-scroll > .role-card-list > .role-card").evaluateAll(cards => cards.map(card => card.dataset.slotId)),
    ["waiting", "failed", "blocked", "escalated", "running", "delivered", "planned"]);
  const archive = page.locator(".archived-members");
  assert.equal(await archive.getAttribute("open"), null);
  assert.equal(await archive.locator("summary").first().textContent(), "已归档成员 (2)");
  assert.match(await page.locator("#slot-card-planned .role-preview").textContent(), /目标.*Planned objective/);
  assert.doesNotMatch(await page.locator("#slot-card-planned").textContent(), /Physical snapshot/);
  await archive.locator("summary").first().click();
  assert.match(await archive.locator(".role-preview").first().textContent(), /结论.*Archived outcome/);
  assert.deepEqual(await archive.locator(".deliverable-chip").evaluateAll(chips => chips.map(chip => chip.dataset.kind)), ["mr", "mr"]);
  snapshot.slots = snapshot.slots.filter(slot => ["accepted", "superseded"].includes(slot.stage));
  snapshot.state.revision++;
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".status-banner")?.textContent.includes("已同步"));
  assert.equal(await archive.getAttribute("open"), "");
  assert.equal(await page.locator(".studio-scroll > .role-card-list > .role-card").count(), 0);
  await archive.locator("summary").first().click();
  assert.equal(await archive.locator(".role-card:visible").count(), 0);
  snapshot.state.revision++;
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await page.waitForFunction(revision => document.querySelector(".status-banner")?.textContent.includes("rev." + revision), snapshot.state.revision);
  assert.equal(await archive.getAttribute("open"), null);
  await archive.locator("summary").first().click();
  assert.equal(await archive.locator(".role-card:visible").count(), 2);
});

test("Studio safely opens inline links and previews local commit, Markdown and text in their member card", { timeout: 25000 }, async t => {
  const f = await createV2KernelFixture(t);
  const snapshot = await f.kernel.init({ anchorThreadId: f.anchorId });
  const inline = "**[MR](https://git.example/repo!8)** and https://example.test/a_(b). [unsafe](javascript:alert(1)) [data](data:text/plain,unsafe) file:///tmp/file";
  const slot = { slotId: "dev", handle: "dev", continuity: "stateful", workspace: "worktree", stage: "delivered", activity: "quiescent", touches: [], dependsOn: [],
    result: { status: "done", summary: inline, assumptions: [inline], body: inline, reportedAt: 1 },
    deliverables: [
      { kind: "mr", label: "Remote MR", href: "https://git.example/mr/8", target: "repo!8", previewKind: "text", previewRef: "file:ignored" },
      { kind: "report", label: "Read the report", previewKind: "markdown", previewRef: "file:review #1.md" },
      { kind: "commit", label: "123456789abc", previewKind: "commit", previewRef: "commit:123456789abc" },
      { kind: "artifact", label: "Text trace", previewKind: "text", previewRef: "file:trace.txt" },
      { kind: "artifact", label: "Failing preview", previewKind: "text", previewRef: "file:missing.txt" },
      { kind: "artifact", label: "Legacy link", href: "file:///unsafe", target: "http://legacy.example/item" },
      { kind: "artifact", label: "Unsafe target", target: "data:text/html,unsafe" },
    ],
  };
  snapshot.slots = [{ ...slot, slotId: "other", handle: "other", stage: "waiting", result: null, deliverables: [] }, slot];
  const browser = await launchHeadlessBrowser(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 400, height: 900 } });
  page.setDefaultTimeout(5000);
  const requests = [];
  const reportResponse = Promise.withResolvers();
  await page.route("http://127.0.0.1/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/snapshot")) return route.fulfill({ json: snapshot });
    if (!url.pathname.endsWith("/artifact")) return route.fulfill({ contentType: "text/html", body: renderSquadStudioHtml(snapshot) });
    requests.push([route.request().method(), url.pathname, url.searchParams.get("token"), url.searchParams.get("slotId"), url.searchParams.get("ref")]);
    const ref = url.searchParams.get("ref");
    if (ref === "file:review #1.md") {
      await reportResponse.promise;
      return route.fulfill({ json: { kind: "markdown", title: "Review", subtitle: "Read-only", content: "# Findings\n" + inline + "\n<img src=x>", truncated: true } });
    }
    if (ref === "commit:123456789abc") return route.fulfill({ json: { kind: "commit", title: "Commit", content: "diff --git a/one b/one\n@@ -1 +2 @@\n-old\n+new\ndiff --git a/two b/two\n@@ -4 +5 @@\n+second\n" } });
    if (ref === "file:trace.txt") return route.fulfill({ json: { kind: "text", title: "Trace", content: "<img src=x>\n" + "long-line".repeat(180) } });
    return route.fulfill({ status: 409, json: { error: "Preview unavailable" } });
  });
  await page.goto("http://127.0.0.1/squads/preview-test?token=studio-token");
  const card = page.locator("#slot-card-dev");
  const excerpt = card.locator(".role-preview");
  assert.deepEqual(await excerpt.locator("a").allTextContents(), ["MR", "https://example.test/a_(b)"]);
  const link = excerpt.getByRole("link", { name: "MR", exact: true });
  assert.equal(await link.getAttribute("href"), "https://git.example/repo!8");
  assert.equal(await link.getAttribute("target"), "_blank");
  assert.equal(await link.getAttribute("rel"), "noopener noreferrer");
  assert.equal(await excerpt.getByRole("link", { name: "https://example.test/a_(b)" }).getAttribute("href"), "https://example.test/a_(b)");
  await link.evaluate(a => {
    a.addEventListener("click", e => e.preventDefault(), { once: true });
    a.closest("article").addEventListener("click", () => { window.linkBubbled = true; }, { once: true });
  });
  await link.click();
  assert.equal(await page.evaluate(() => window.linkBubbled), undefined);
  assert.equal(await card.locator(".role-card-summary").getAttribute("aria-expanded"), "false");
  assert.equal(await card.locator(".deliverable-chip.is-link").getAttribute("href"), "https://git.example/mr/8");

  const preview = card.locator(".artifact-preview");
  const close = preview.getByRole("button", { name: "关闭预览" });
  await card.getByRole("button", { name: /Read the report/ }).click();
  assert.equal(await card.locator(".role-card-summary").getAttribute("aria-expanded"), "true");
  assert.match(await preview.innerText(), /正在读取产物/);
  await page.waitForFunction(() => document.querySelector(".artifact-preview [role='status']"));
  reportResponse.resolve();
  await preview.getByRole("heading", { name: "Findings" }).waitFor();
  assert.match(await preview.innerText(), /Read-only/);
  assert.match(await preview.innerText(), /内容已截断/);
  assert.equal(await card.locator(".assumptions-callout a").count(), 2);
  assert.equal(await card.locator(".result-body-text a").count(), 2);
  assert.equal(await preview.locator("a").count(), 2);
  assert.equal(await page.locator("a[href^='javascript:'],a[href^='data:'],a[href^='file:'],img").count(), 0);
  snapshot.state.revision++;
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".status-banner")?.textContent.includes("已同步"));
  assert.equal(await preview.getByRole("heading", { name: "Findings" }).isVisible(), true);
  await close.click();
  assert.equal(await preview.count(), 0);
  await card.getByRole("button", { name: /交付与变更/ }).click();
  await card.getByRole("button", { name: "12345678" }).click();
  await preview.locator(".diff-row-add").last().waitFor();
  assert.match(await preview.locator(".diff-table").textContent(), /diff --git a\/two b\/two/);
  assert.deepEqual(await preview.locator(".diff-row-add .diff-code").allTextContents(), ["+new", "+second"]);
  assert.deepEqual(await preview.locator(".diff-row-add .diff-ln:nth-child(2)").allTextContents(), ["2", "5"]);
  await close.click();
  await card.getByText(/附件与过程证据/).click();
  assert.equal(await card.getByRole("link", { name: /Legacy link/ }).getAttribute("href"), "http://legacy.example/item");
  await card.getByRole("button", { name: "Text trace" }).click();
  await preview.locator("pre > code").waitFor();
  assert.match(await preview.locator("pre > code").textContent(), /^<img src=x>/);
  for (const width of [360, 400, 520, 680]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(await page.evaluate(() => [document.documentElement, document.querySelector(".studio-scroll"), document.querySelector(".artifact-preview")].every(node => node.scrollWidth <= node.clientWidth)), "no horizontal overflow at " + width);
  }
  await close.click();
  await card.getByRole("button", { name: "Failing preview" }).click();
  await preview.getByText("Preview unavailable").waitFor();
  assert.deepEqual(requests, ["file:review #1.md", "commit:123456789abc", "file:trace.txt", "file:missing.txt"].map(ref => ["GET", "/squads/" + snapshot.squadId + "/artifact", "studio-token", "dev", ref]));
});

test("Studio labels external Git bindings and prioritizes forbidden edits at split-pane widths", { timeout: 18000 }, async t => {
  const f = await createV2KernelFixture(t);
  const snapshot = await f.kernel.init({ anchorThreadId: f.anchorId });
  const longBranch = "integration/" + "long-topic/".repeat(12) + "check";
  snapshot.integrationBranch = "base-integration";
  snapshot.integrationWorktree = "/tmp/default-tree";
  snapshot.integrations = {
    primary: { repoKey: "primary", source: "/code/main", branch: snapshot.integrationBranch, worktreePath: snapshot.integrationWorktree },
    external: { repoKey: "external", source: "git@git.example:acme/core-runtime.git", branch: longBranch, worktreePath: "/tmp/external-tree" },
  };
  const running = { slotId: "live", handle: "live", continuity: "stateful", workspace: "worktree", stage: "running",
    activity: "active", touches: [], dependsOn: [], repoKey: "primary", repo: { source: "/code/main" },
    delta: { changed: [], commits: [], outsideTouches: [], dirtyCount: 7 } };
  const offender = { ...running, slotId: "dev", handle: "dev", stage: "delivered", activity: "quiescent",
    repoKey: "external", repo: { source: snapshot.integrations.external.source, baseRef: "release/2026" }, branch: "role/core-runtime-review",
    readOnly: true, forbid: ["keys/**", "secret/" + "long-path".repeat(25) + "<img src=x>"],
    delta: { changed: [{ path: "keys/private.txt", status: "M", add: 2, del: 1 }], commits: [], outsideTouches: [], dirtyCount: 2,
      forbidViolations: ["keys/private.txt"] } };
  snapshot.slots = [running, offender];
  const browser = await launchHeadlessBrowser(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 360, height: 800 } });
  await page.route("http://127.0.0.1/**", route => route.request().url().endsWith("/snapshot")
    ? route.fulfill({ json: snapshot })
    : route.fulfill({ contentType: "text/html", body: renderSquadStudioHtml(snapshot) }));
  await page.goto("http://127.0.0.1/squads/cross-repo");
  const integrations = page.locator(".integration-badges .integration-badge");
  assert.equal(await integrations.count(), 2);
  assert.match(await integrations.nth(0).textContent(), /main · base-integration/);
  assert.match(await integrations.nth(1).textContent(), /core-runtime · integration/);
  assert.match(await integrations.nth(1).getAttribute("title"), /git@git\.example:acme\/core-runtime\.git/);
  assert.equal(await page.locator(".role-card-list .role-card").first().getAttribute("data-slot-id"), "dev");
  const dev = page.locator("#slot-card-dev");
  assert.equal(await dev.locator(".role-repo-badge").textContent(), "repo: core-runtime");
  assert.equal(await page.locator("#slot-card-live .role-repo-badge").count(), 0);
  assert.equal(await dev.locator(".badge-danger").first().textContent(), "1 处触碰禁区");
  assert.equal(await dev.getByText("2 个未提交改动", { exact: true }).isVisible(), true);
  assert.equal(await page.getByText("7 个未提交改动", { exact: true }).count(), 0);
  const boundaries = dev.locator(".slot-boundaries");
  assert.match(await boundaries.innerText(), /git@git\.example:acme\/core-runtime\.git[\s\S]*role\/core-runtime-review[\s\S]*release\/2026/);
  assert.match(await boundaries.innerText(), /只读[\s\S]*keys\/\*\*/);
  assert.equal(await page.locator("img").count(), 0);
  for (const width of [360, 400, 520, 680]) {
    await page.setViewportSize({ width, height: 800 });
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll("html, .studio-scroll, .studio-card, .role-card, .slot-boundaries")]
      .filter(node => node.scrollWidth > node.clientWidth).map(node => node.className)), [], "no horizontal overflow at " + width);
  }
});

test("Studio shows dependencies and observed model differences once, with safe partial settings and zero narrow overflow", { timeout: 30000 }, async t => {
  const f = await createV2KernelFixture(t);
  Object.assign(f.threads.get(f.anchorId), { model: "anchor-current-model", reasoningEffort: "xhigh" });
  const init = await f.kernel.init({ anchorThreadId: f.anchorId });
  const snap = await f.kernel.dispatch({ squadId: init.squadId, slots: ["both", "model-only", "effort-only", "unknown", "same"].map(slotId => ({ slotId, handle: slotId === "both" ? "dev-core-service" : slotId, task: "Inspect", touches: [] })) });
  const longModel = "mycodex/provider/" + "very-long-provider-".repeat(16) + "/gpt-observed-model";
  Object.assign(f.threads.get(snap.slots[0].threadId), { model: longModel, reasoningEffort: "high" });
  f.threads.get(snap.slots[1].threadId).model = "model-only-value";
  f.threads.get(snap.slots[2].threadId).reasoningEffort = "medium";
  Object.assign(f.threads.get(snap.slots[4].threadId), { model: "provider/anchor-current-model", reasoningEffort: "xhigh" });
  const fixture = await f.kernel.status({ squadId: snap.squadId });
  fixture.slots.at(-1).dependsOn = ["both"];
  const browser = await launchHeadlessBrowser(); t.after(() => browser.close());
  const page = await browser.newPage(), errors = []; page.setDefaultTimeout(4000);
  page.on("pageerror", error => errors.push(error.message));
  await page.route("http://127.0.0.1/**", route => route.fulfill({
    contentType: route.request().url().includes("/snapshot") ? "application/json" : "text/html",
    body: route.request().url().includes("/snapshot") ? JSON.stringify(fixture) : renderSquadStudioHtml(fixture),
  }));
  await page.goto("http://127.0.0.1/squads/models");
  assert.equal(await page.locator(".topology-tree").count(), 0);
  const both = page.locator('#slot-card-both .model-settings-badge');
  assert.equal(await both.textContent(), "gpt-observed-model · high");
  assert.equal(await both.getAttribute("title"), `${longModel} · high`);
  const anchor = page.locator(".orchestrator-summary");
  assert.match(await anchor.textContent(), /Orchestrator/);
  assert.equal(await anchor.locator('.model-settings-badge').textContent(), "anchor-current-model · xhigh");
  for (const [slotId, label] of [["model-only", "model-only-value"], ["effort-only", "medium"]]) {
    assert.equal(await page.locator(`#slot-card-${slotId} .model-settings-badge`).textContent(), label);
  }
  assert.equal(await page.locator('#slot-card-unknown .model-settings-badge').count(), 0);
  const same = page.locator("#slot-card-same");
  assert.equal(await same.locator(".model-settings-badge").count(), 0);
  assert.equal(await same.locator(".role-dependency").textContent(), "↳ after both");
  assert.match(await same.locator(".role-handle").getAttribute("title"), /provider\/anchor-current-model · xhigh/);
  for (const width of [360, 400, 520, 680]) {
    await page.setViewportSize({ width, height: 1200 });
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('.role-card,.model-settings-badge')].filter(node => node.scrollWidth > node.clientWidth + 1).map(node => node.className)), [], `overflow at ${width}px`);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `page overflow at ${width}px`);
  }
  await same.locator(".role-card-summary").click();
  assert.equal(await same.locator(".model-settings-badge").textContent(), "anchor-current-model · xhigh");
  fixture.slots[0].model = '<img src=x onerror="globalThis.__modelXss=1">';
  fixture.slots[0].reasoningEffort = "low";
  delete fixture.anchorSettings;
  await page.reload();
  assert.equal(await same.locator(".model-settings-badge").textContent(), "anchor-current-model · xhigh");
  assert.equal(await page.locator('#slot-card-both .model-settings-badge').textContent(), '<img src=x onerror="globalThis.__modelXss=1"> · low');
  assert.equal(await page.locator('.model-settings-badge img').count(), 0);
  assert.equal(await page.evaluate(() => globalThis.__modelXss), undefined);
  assert.deepEqual(errors, []);
});


test("Technical review card grows naturally without internal scrolling and preserves curated review across status refresh", { timeout: 30000 }, async t => {
  const review = { summary: "完整倒扫保住权限继承，并把真实审批送回原生会话。", highlights: Array.from({ length: 6 }, (_, i) => ({ title: `技术取舍 ${i+1}`, kind: ["tradeoff", "architecture", "performance", "risk"][i%4], body: (`选择 **单写者** 与 \`expectedRevision\`，保留真实的验证边界。\n\n` + `长路径 \`/tmp/isolated/${"long-path-".repeat(18)}file.mts\` 仍应完整换行。`).repeat(3) })) };
  const snapshot = { squadId: "curated", status: "active", slots: [{ slotId: "dev", handle: "dev", activity: "quiescent", result: { status: "done", summary: "已完成后端验证", assumptions: ["本轮未发布、免责流程原文不应挤占精选品鉴区"] } }], state: { schemaVersion: 2, revision: 1, title: "阶段技术品鉴", criteria: [{ id: "C4", text: "卡片可读" }], openBlockers: [], activeGate: { id: "G", kind: "decision", title: "选择状态所有权", question: "是否采用单写者？", status: "open", options: Array.from({ length: 7 }, (_, i) => ({ id: `o${i}`, label: `方案 ${i+1}`, summary: "需要完整阅读的方案依据。".repeat(8) })) } } };
  const browser = await launchHeadlessBrowser(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 680, height: 900 } }), errors = [];
  page.setDefaultTimeout(4000); page.on("pageerror", e => errors.push(e.message));
  await page.exposeFunction("cardStatus", () => ({ structuredContent: { ...snapshot, state: { ...snapshot.state, revision: 2 } } }));
  await page.route("http://127.0.0.1/**", route => route.fulfill({ contentType: "text/html", body: route.request().url().endsWith("/card") ? conversationSquadCardResource().text : `<!doctype html><html><meta charset="utf-8"><body style="margin:0"><iframe src="/card" style="width:100%;border:0"></iframe><script>
    const frame=document.querySelector('iframe'); window.sizes=[]; window.calls=[];
    const reply=msg=>frame.contentWindow.postMessage({jsonrpc:'2.0',...msg},'*');
    addEventListener('message',async event=>{
      if(event.source!==frame.contentWindow)return;const msg=event.data;
      if(msg.method==='ui/initialize')reply({id:msg.id,result:{hostContext:{theme:'light'}}});
      if(msg.method==='ui/notifications/initialized')reply({method:'ui/notifications/tool-result',params:{structuredContent:${JSON.stringify({ ...snapshot, review })}}});
      if(msg.method==='ui/notifications/size-changed'){sizes.push(msg.params);frame.style.height=msg.params.height+'px';}
      if(msg.method==='tools/call'){calls.push(msg.params);reply({id:msg.id,result:await window.cardStatus()});}
    });</script></body></html>` }));
  await page.goto("http://127.0.0.1/"); const card = page.frameLocator("iframe");
  await card.locator('.mc-review-item').last().waitFor();
  assert.equal(await card.locator('.mc-review-item').count(), 6);
  assert.equal(await card.locator('.mc-review-summary').textContent(), review.summary);
  assert.doesNotMatch(await card.locator('#squad-card').innerText(), /免责流程原文/);
  assert.equal(await card.locator('.mc-review-item button').count(), 0);
  assert.equal(await card.locator('.mc-review-item code').count() > 0, true);
  assert.equal(conversationSquadCardResource()._meta.ui.prefersBorder, false);
  for (const width of [400, 680]) {
    await page.setViewportSize({ width, height: 900 });
    const frame = page.frames().find(frame => frame.url().endsWith('/card'));
    assert.deepEqual(await frame.evaluate(() => [...document.querySelectorAll('#squad-card *')].filter(node => ['auto','scroll'].includes(getComputedStyle(node).overflowY) || ['auto','scroll'].includes(getComputedStyle(node).overflowX)).map(node => node.className)), []);
    assert.ok(await frame.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.ok(await card.locator('#squad-card').evaluate(node => node.getBoundingClientRect().height > 900), 'all six long reviews and all Gate options stay in flow');
  }
  await card.getByRole('button', { name: '刷新状态', exact: true }).click();
  await card.getByText('STATE rev.2', { exact: true }).waitFor();
  assert.equal(await card.locator('.mc-review-item').count(), 6);
  assert.equal(await card.locator('.mc-review-summary').textContent(), review.summary);
  await page.waitForFunction(() => calls.length===1 && sizes.some(size=>size.height>900));
  assert.deepEqual(await page.evaluate(() => calls.map(call=>call.name)), ['mycodex.squad_status']);
  assert.deepEqual(errors, []);
});


test("Squad review fallback shows concise real delivery conclusions and skips physical snapshots and Gate audit noise", { timeout: 15000 }, async t => {
  const snapshot = { squadId: "fallback", status: "active", slots: [
    { slotId: "physical", handle: "physical", result: { autoSynthesized: true, summary: "Physical snapshot: quiescent", assumptions: [] } },
    ...Array.from({ length: 5 }, (_, i) => ({ slotId: `dev${i}`, handle: `dev${i}`, result: { status: "done", summary: `交付结论 ${i}`, assumptions: ["- 显式配置与实测值分开存放，避免改变重派契约。", "不应原样倾倒的第二条长流程记录"] } })),
  ], state: { schemaVersion: 2, revision: 1, title: "交付回退", criteria: [], openBlockers: [] } };
  const browser = await launchHeadlessBrowser(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 400, height: 900 } });
  await page.addInitScript(snapshot => { window.openai = { toolOutput: snapshot }; }, snapshot);
  await page.route('http://127.0.0.1/**', route => route.fulfill({ contentType:'text/html', body:conversationSquadCardResource().text }));
  await page.goto('http://127.0.0.1/');
  assert.equal(await page.locator('.mc-delivery-item').count(), 3);
  assert.equal(await page.locator('.mc-delivery-assumption').count(), 3);
  assert.doesNotMatch(await page.locator('#squad-card').innerText(), /Physical snapshot|第二条长流程记录/);
  assert.match(await page.locator('#squad-card').innerText(), /交付结论 0/);
  await page.evaluate(snapshot => {
    window.openai.toolOutput = { ...snapshot, state: { ...snapshot.state, revision: 2, activeGate: { id:'G', kind:'decision', title:'待你选择', question:'采用哪个方案？', status:'open' } } };
    dispatchEvent(new Event('openai:set_globals'));
  }, snapshot);
  assert.equal(await page.locator('.mc-gate-box').count(), 1);
  assert.equal(await page.locator('.mc-delivery-item').count(), 0);
});


test("Studio offline slots stay out of Needs You and show a local reconnect label", {timeout:15000}, async t=>{
  const f=await createV2KernelFixture(t),init=await f.kernel.init({anchorThreadId:f.anchorId});
  const snap=await f.kernel.dispatch({squadId:init.squadId,slots:[{slotId:'done',task:'Build',touches:[]}]});
  f.threads.delete(snap.slots[0].threadId);
  const browser=await launchHeadlessBrowser();t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:400,height:900}});page.setDefaultTimeout(3000);
  await page.goto(snap.studioUrl);
  assert.equal(await page.locator('#needs-you-slot').isVisible(),false);
  assert.match(await page.locator('#slot-card-done').innerText(),/运行时暂未连接/);
  assert.doesNotMatch(await page.locator('#slot-card-done').innerText(),/等待前置依赖|等待输入/);
  assert.equal(await page.locator('#slot-card-done').getAttribute('class').then(value=>value.includes('has-attention')),false);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
});


test('C6: an already open Studio page resumes polling at the same address after kernel restart', { timeout: 15000 }, async t => {
  const f = await createV2KernelFixture(t);
  const initial = await f.kernel.init({ anchorThreadId: f.anchorId, title: 'C6 original stage', intent: 'Standing squad' });
  const browser = await launchHeadlessBrowser(); t.after(() => browser.close());
  const page = await browser.newPage(); await page.goto(initial.studioUrl);
  await page.getByText('C6 original stage', { exact: true }).waitFor();
  await f.kernel.shutdown();
  // Keep the original document alive through a failed polling cycle.
  await page.waitForTimeout(2300);
  const restored = new SquadV2Kernel(f.root, {
    read: async id => f.threads.get(id), create: async () => assert.fail('reuse never creates workers'), send: async () => {},
  }, () => {});
  t.after(() => restored.shutdown());
  const evolved = await restored.init({ anchorThreadId: f.anchorId, title: 'C6 restored stage' });
  assert.equal(evolved.squadId, initial.squadId); assert.equal(evolved.studioUrl, initial.studioUrl);
  await page.getByText('C6 restored stage', { exact: true }).waitFor({ timeout: 7000 });
  assert.equal(page.url(), initial.studioUrl, 'the same document reconnects without navigation or a new pane');
});

test('C7: Studio rounds/deliverables stay readable at 400-680px, preserve history expansion and reject executable links', { timeout: 20000 }, async t => {
  const f = await createV2KernelFixture(t), init = await f.kernel.init({ anchorThreadId: f.anchorId, state: { criteria: [{ id: 'C1', text: 'Cross repo output' }] } });
  const { squadId } = init;
  let snap = await f.kernel.dispatch({ squadId, slots: [{ slotId: 'dev', task: 'First round objective', goal: 'First round goal', criteriaIds: ['C1'], touches: [] }, { slotId: 'accepted', task: 'Old blocked result', touches: [] }] });
  const report = async (slotId, summary, status = 'done', legacy = false) => {
    const slot = snap.slots.find(s => s.slotId === slotId);
    await pageDelay(5);
    const summaryBlock = legacy ? `# Older report\n\n## Summary\n\n${summary}` : `summary: ${summary}`;
    await fsp.writeFile(path.join(f.root, '.mycodex', 'squads-v2', squadId, 'slots', slotId, '.mycodex', 'result.md'), `status: ${status}\n${summaryBlock}\n\n## Deliverables\n- [mr] core-runtime!83 | https://git.example/repo/merge_requests/83\n- [report] local report | /tmp/c7-final-report.md\n- [report] result.md | /tmp/.mycodex/result.md\n- [commit] 100293017747f46e3aa2bcf1fb98c6f22c33b37a | /tmp/repo\n- [artifact] <img src=x onerror=window.C7_XSS=1> | javascript:window.C7_XSS=1\n- [artifact] data probe | data:text/html,attack\n- [artifact] file probe | file:///tmp/report.md\n\n## Assumptions & Trade-offs\n- C7 original assumption\n`);
    f.threads.get(slot.threadId).status = { type: 'idle' };
  };
  const pageDelay = ms => new Promise(resolve => setTimeout(resolve, ms));
  await report('dev', 'C7 prior wave conclusion'); await report('accepted', 'C7 accepted blocked', 'blocked');
  await f.kernel.state({ squadId, expectedRevision: 1, acceptSlots: ['accepted'] });
  const longGoal = `## What & Why\nC7 current goal with **bold** and \`code\`。${'原始派发指令不应该占满成员卡。'.repeat(60)}末尾派发标记`;
  snap = await f.kernel.dispatch({ squadId, slots: [{ slotId: 'dev', task: longGoal, goal: longGoal, criteriaIds: ['C1'], touches: [] }] });
  const browser = await launchHeadlessBrowser(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 400, height: 900 } }); await page.goto(snap.studioUrl);
  const card = page.locator('#slot-card-dev');
  if (await card.getAttribute('class').then(x => !x.includes('is-expanded'))) await card.locator('.role-card-summary').click();
  await card.locator('.current-round').waitFor(); assert.match(await card.locator('.current-round').innerText(), /R2[\s\S]*C7 current goal/);
  assert.doesNotMatch(await card.innerText(), /末尾派发标记|## What & Why/, 'long dispatch instructions belong in the brief, not the overview');
  const history = card.locator('details.round-history');
  const historySummary = history.locator('.history-summary');
  assert.match(await historySummary.innerText(), /R1[\s\S]*C7 prior wave conclusion/, 'history shows what came out before it is opened');
  await historySummary.click();
  assert.match(await history.innerText(), /First round goal/);
  assert.equal(await history.locator('a[target="_blank"]').getAttribute('rel'), 'noopener noreferrer');
  await history.getByText('查看本轮证据与变更', { exact: true }).click();
  await page.waitForTimeout(2300); assert.equal(await card.locator('details.round-history').getAttribute('open'), '');
  assert.match(await card.locator('details.round-history').innerText(), /C7 original assumption/);
  await report('dev', 'C7 current delivery', 'done', true);
  await card.locator('.role-card-outputs .deliverable-chip').first().waitFor({ timeout: 6000 });
  assert.match(await card.locator('.current-round').innerText(), /C7 current goal/);
  assert.doesNotMatch(await card.locator('.current-round').innerText(), /C7 current delivery|C7 original assumption|末尾派发标记/);
  assert.match(await card.locator('.result-summary-head').innerText(), /C7 current delivery/);
  assert.doesNotMatch(await card.locator('.result-summary-head').innerText(), /status:|Older report|Deliverables/);
  assert.equal(await card.locator('.role-peek-panel > .assumptions-callout .assumptions-list').isVisible(), true);
  assert.equal(await card.locator('.role-card-outputs .deliverable-chip').count(), 3, 'show typed primary outputs, demote .mycodex/result.md and shorten raw SHAs');
  assert.match(await card.locator('.role-card-outputs').innerText(), /MR[\s\S]*core-runtime!83[\s\S]*报告[\s\S]*local report[\s\S]*提交[\s\S]*10029301/);
  assert.doesNotMatch(await card.locator('.role-card-outputs').innerText(), /result\.md|100293017747/);
  const link = card.locator('.role-card-outputs a.deliverable-chip.is-link');
  await link.evaluate(a => a.addEventListener('click', e => e.preventDefault(), { once: true })); await link.click();
  assert.ok((await card.getAttribute('class')).includes('is-expanded'), 'clicking an output never collapses its role');
  await card.getByRole('button', { name: /交付与变更/ }).click(); await card.locator('.deliverables-list').first().waitFor();
  assert.match(await card.locator('.deliverables-list').first().innerText(), /core-runtime!83[\s\S]*local report/);
  assert.doesNotMatch(await card.innerText(), /https:\/\/git.example|\/tmp\/c7-final-report\.md|data probe/, 'raw references and auxiliary artifacts do not dominate the default list');
  await card.getByText('查看完整路径与引用', { exact: true }).click();
  assert.match(await card.innerText(), /\/tmp\/c7-final-report\.md/, 'the exact reference remains accessible');
  for (const name of [/交付与变更/, /裁剪 Brief/]) {
    await card.getByRole('button', { name }).click();
    assert.equal(await card.locator('.current-round').count(), 1, 'compact round header remains above every Tab');
    assert.equal(await card.locator('.result-summary-head, .round-history').count(), 0, 'Result content belongs only to the Result Tab');
  }
  assert.match(await card.locator('.brief-markdown').innerText(), /末尾派发标记/, 'the complete prompt remains available');
  await card.getByRole('button', { name: '结论与波次', exact: true }).click();
  assert.match(await card.locator('.result-summary-head').innerText(), /C7 current delivery/);
  assert.equal(await card.locator('details.round-history').getAttribute('open'), '', 'history expansion survives Tab switches');
  assert.equal(await page.locator('a[href^="javascript:"],a[href^="data:"],a[href^="file:"]').count(), 0);
  assert.equal(await page.evaluate(() => window.C7_XSS), undefined);
  assert.equal(await page.locator('#slot-card-accepted.has-attention').count(), 0);
  for (const width of [400, 520, 680]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no horizontal overflow at ' + width);
  }
});


test('C7 closeout: themed output borders and keyboard focus remain visible on role summaries', async t => {
  const f = await createV2KernelFixture(t), initial = await f.kernel.init({ anchorThreadId: f.anchorId });
  let snap = await f.kernel.dispatch({ squadId: initial.squadId, slots: [{ slotId: 'dev', task: 'first', touches: [] }] });
  f.threads.get(snap.slots[0].threadId).status = { type: 'idle' };
  snap = await f.kernel.dispatch({ squadId: initial.squadId, slots: [{ slotId: 'dev', task: 'second', touches: [] }] });
  const browser = await launchHeadlessBrowser(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 400, height: 900 } }); await page.goto(snap.studioUrl);
  const summary = page.locator('#slot-card-dev .role-card-summary');
  await page.keyboard.press('Tab'); await summary.focus();
  const focus = await summary.evaluate(node => ({ cursor: getComputedStyle(node).cursor, visible: node.matches(':focus-visible'), outline: getComputedStyle(node).outlineStyle, width: getComputedStyle(node).outlineWidth }));
  assert.equal(focus.cursor, 'pointer'); assert.equal(focus.visible, true); assert.equal(focus.outline, 'solid'); assert.equal(focus.width, '2px');
  // A small output is sufficient to exercise the actual theme CSS without
  // relying on network delivery or another report polling cycle.
  await page.evaluate(() => { const chip = document.createElement('span'); chip.className = 'deliverable-chip'; chip.textContent = 'report.md'; document.querySelector('.current-round').append(chip); });
  for (const theme of ['light', 'dark']) {
    const actual = await page.evaluate(theme => {
      document.documentElement.dataset.theme = theme;
      const probe = document.createElement('span'); document.body.append(probe);
      probe.style.border = '1px solid var(--border-default)'; const border = getComputedStyle(probe).borderTopColor;
      probe.style.borderColor = 'var(--border-hairline)'; const hairline = getComputedStyle(probe).borderTopColor; probe.remove();
      return { expected: { border, hairline }, chip: getComputedStyle(document.querySelector('.current-round .deliverable-chip')).borderTopColor,
        chipWidth: getComputedStyle(document.querySelector('.current-round .deliverable-chip')).borderTopWidth,
        divider: getComputedStyle(document.querySelector('.current-round')).borderBottomColor,
        history: getComputedStyle(document.querySelector('.round-history')).borderTopColor };
    }, theme);
    assert.equal(actual.chipWidth, '1px'); assert.equal(actual.chip, actual.expected.border);
    assert.equal(actual.divider, actual.expected.hairline); assert.equal(actual.history, actual.expected.hairline);
  }
});

test("Phase 3 full-stack: Studio resolves GitLab MR links and previews real local commits and Markdown reports", { timeout: 25000 }, async t => {
  const f = await createV2KernelFixture(t);
  const { git } = await import("../gateway/spine/squad-v2-workspace.mjs");
  await git(f.root, "init", "-b", "main");
  await git(f.root, "config", "user.email", "phase3@example.invalid");
  await git(f.root, "config", "user.name", "Phase 3");
  await git(f.root, "remote", "add", "origin", "http://gitlab.example/examples/acme/core-runtime.git");
  await fsp.writeFile(path.join(f.root, "feature.ts"), "export const phase = 3;\n");
  await fsp.writeFile(path.join(f.root, "audit.md"), "# Audit Report\n\nVerified **Phase 3** preview.\n");
  await git(f.root, "add", "feature.ts");
  await git(f.root, "commit", "-m", "feat: live phase 3 commit");
  const sha = await git(f.root, "rev-parse", "HEAD");

  const init = await f.kernel.init({ anchorThreadId: f.anchorId });
  const snap = await f.kernel.dispatch({ squadId: init.squadId, slots: [{ slotId: "impl", task: "Ship Phase 3", touches: [] }] });
  const slot = snap.slots[0];
  await new Promise(resolve => setTimeout(resolve, 10));
  await fsp.writeFile(
    path.join(f.root, ".mycodex", "squads-v2", init.squadId, "slots", "impl", ".mycodex", "result.md"),
    `- **STATUS**: done\nsummary: Ready for acme/core-runtime!83 review\n\n## Deliverables\n- [mr] acme/core-runtime!83\n- [report] Audit Doc | ./audit.md\n- [commit] ${sha} | ${f.root}\n`,
  );
  f.threads.get(slot.threadId).status = { type: "idle" };

  const browser = await launchHeadlessBrowser();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  await page.goto(snap.studioUrl);

  const card = page.locator("#slot-card-impl");
  await card.locator(".result-summary-head").waitFor({ timeout: 6000 });
  assert.match(await card.locator(".result-summary-head").innerText(), /Ready for acme\/core-runtime!83 review/);
  assert.equal(await card.locator(".assumptions-callout").count(), 0);

  const mrLink = card.locator('a.deliverable-chip.is-link[href="http://gitlab.example/examples/acme/core-runtime/-/merge_requests/83"]');
  assert.equal(await mrLink.count(), 1);

  await card.locator('button.deliverable-chip.is-preview', { hasText: "Audit Doc" }).click();
  const preview = card.getByRole("region", { name: "只读产物预览" });
  await preview.locator(".artifact-markdown").waitFor();
  assert.match(await preview.innerText(), /Audit Report[\s\S]*Verified Phase 3 preview/);

  await card.locator('button.deliverable-chip.is-preview', { hasText: sha.slice(0, 8) }).click();
  await preview.locator(".diff-table").waitFor();
  assert.match(await preview.innerText(), /\+export const phase = 3;/);
  await preview.getByRole("button", { name: "关闭预览" }).click();
  assert.equal(await preview.count(), 0);
});

test("Phase 4 full-stack: real kernel binds external repo, scopes incremental briefs and surfaces Studio repo/forbid signals", { timeout: 25000 }, async t => {
  const f = await createV2KernelFixture(t);
  const { git } = await import("../gateway/spine/squad-v2-workspace.mjs");
  const extRepo = path.join(f.root, "external-service");
  await fsp.mkdir(path.join(extRepo, "core"), { recursive: true });
  await git(f.root, "init", "-b", "main", extRepo);
  await git(extRepo, "config", "user.email", "phase4@example.invalid");
  await git(extRepo, "config", "user.name", "Phase 4");
  await fsp.writeFile(path.join(extRepo, "core/locked.ts"), "export const locked = true;\n");
  await fsp.writeFile(path.join(extRepo, "app.ts"), "export const v = 1;\n");
  await git(extRepo, "add", ".");
  await git(extRepo, "commit", "-m", "initial external repo");

  const sentPrompts = [];
  const init = await f.kernel.init({
    anchorThreadId: f.anchorId,
    intent: "Global intent only sent on round 1",
    state: {
      contracts: ["Long global contract that should not repeat unchanged on round 2"],
      criteria: [
        { id: "C-OTHER", text: "Unrelated frontend criterion" },
        { id: "C-EXT", text: "External repo bounded delivery" },
      ],
    },
  });
  const origSend = f.kernel.runtime.send.bind(f.kernel.runtime);
  f.kernel.runtime.send = async (thread, text, reqId, role, readOnly) => {
    sentPrompts.push({ threadId: thread.id, text, role, readOnly });
    return origSend(thread, text, reqId, role, readOnly);
  };

  let snap = await f.kernel.dispatch({
    squadId: init.squadId,
    slots: [
      { slotId: "upstream", task: "Provide shared types", workspace: "scratch" },
      { slotId: "ext", task: "Wave 1 external edit", criteriaIds: ["C-EXT"], repo: { source: extRepo }, forbid: ["core/**"], inputs: ["./spec.md"] },
    ],
  });
  assert.match(sentPrompts[1].text, /C-EXT/);
  assert.doesNotMatch(sentPrompts[1].text, /C-OTHER/);
  assert.match(sentPrompts[1].text, /@upstream ->/);
  assert.match(sentPrompts[1].text, /Long global contract/);

  for (const s of snap.slots) f.threads.get(s.threadId).status = { type: "idle" };
  snap = await f.kernel.dispatch({
    squadId: init.squadId,
    slots: [{ slotId: "ext", task: "Wave 2 incremental follow-up", criteriaIds: ["C-EXT"] }],
  });
  assert.match(sentPrompts.at(-1).text, /Shared STATE unchanged/);
  assert.doesNotMatch(sentPrompts.at(-1).text, /Long global contract/);

  const extSlot = snap.slots.find(s => s.slotId === "ext");
  await fsp.writeFile(path.join(extSlot.worktreePath, "core/locked.ts"), "export const locked = false;\n");
  f.threads.get(extSlot.threadId).status = { type: "idle" };

  const browser = await launchHeadlessBrowser();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  await page.goto(snap.studioUrl);

  const card = page.locator("#slot-card-ext");
  await card.locator(".role-repo-badge").waitFor({ timeout: 6000 });
  assert.match(await card.locator(".role-repo-badge").innerText(), /repo:\s*external-service/);
  assert.match(await card.innerText(), /1 处触碰禁区/);
  assert.match(await card.innerText(), /1 个未提交改动/);
});
