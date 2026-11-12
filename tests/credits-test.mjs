import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { CREDITS_RULES, creditsView, normalizeCopilotCredits } from "../bridge/copilot-credits.mjs";
import { CopilotAccountCache } from "../bridge/copilot-account.mjs";
import { renderCreditLine, creditTerminalCapabilities, runCredits } from "../bridge/credits-cli.mjs";
import { buildDesktopCreditsPatch } from "../bridge/desktop-credits.mjs";

const now = Date.parse("2026-10-06T00:00:00Z");
const body = used => ({
  token_based_billing: true, quota_reset_date_utc: "2026-11-01T00:00:00Z",
  quota_snapshots: {
    chat: { token_based_billing: true, credits_used: 0, unlimited: true },
    premium_interactions: {
      has_quota: true, token_based_billing: true, credits_used: used, entitlement: 1000000,
      remaining: 888, quota_remaining: 123, percent_remaining: 12,
    },
  },
});
const snapshot = used => normalizeCopilotCredits(body(used), { now });
const identity = { token: "synthetic-token", login: "synthetic-user", generation: "a" };

test("AI credits use explicit token-billing usage, not legacy remaining requests or rounded percentage headers", () => {
  const credits = snapshot(2612);
  assert.equal(credits.used, 2612);
  assert.equal(credits.allowance, 1000000);
  assert.equal(credits.bucket, "premium_interactions");
  const view = creditsView(credits, { now });
  assert.equal(view.status, "available");
  assert(Math.abs(view.percent - 0.2612) < Number.EPSILON);
  assert.equal(view.percentText, "0.3% used");
  assert.equal(view.usageText, "2,612 / 1,000,000 AI credits");
  assert.equal(view.tone, "normal");
  assert.equal(view.resetAt, "2026-11-01T00:00:00.000Z");
});

test("old request quotas and incomplete credit schemas are explicitly unavailable, never relabeled or zero-filled", () => {
  for (const raw of [
    { entitlement: 300, remaining: 240, percent_remaining: 80 },
    { token_based_billing: true, entitlement: 1000 },
    { token_based_billing: true, entitlement: 1000, credits_used: "123" },
    { token_based_billing: true, entitlement: 1000, credits_used: -1 },
    { token_based_billing: true, entitlement: 1000, credits_used: 0, has_quota: false },
  ]) {
    const credits = normalizeCopilotCredits({ token_based_billing: true,
      quota_snapshots: { premium_interactions: raw } }, { now });
    const view = creditsView(credits, { now });
    assert.equal(view.status, "unavailable");
    assert.equal(view.used, null);
    assert.equal(view.percent, null);
    assert.equal(view.statusText, "AI credits unavailable");
  }
  const freeFeatures = normalizeCopilotCredits({ quota_snapshots: {
    chat: { token_based_billing: true, credits_used: 0, unlimited: true },
    completions: { token_based_billing: true, credits_used: 0, unlimited: true },
  } }, { now });
  assert.equal(creditsView(freeFeatures, { now }).status, "unavailable",
    "Unlimited free features cannot substitute for a missing account AI-credit budget.");
});

test("shared percentage and color thresholds include exact zero, 75%, 90%, 100% and overages", () => {
  for (const [used, tone, percent] of [[0, "normal", "0.0% used"], [750000, "warning", "75.0% used"],
    [900000, "danger", "90.0% used"], [1000000, "danger", "100.0% used"],
    [1200000, "danger", "120.0% used"]]) {
    const view = creditsView(snapshot(used), { now });
    assert.equal(view.tone, tone);
    assert.equal(view.percentText, percent);
    assert.deepEqual(view.color, CREDITS_RULES.colors[tone]);
    assert.equal(view.progress, Math.min(1, used / 1000000));
  }
  assert.equal(creditsView(snapshot(1), { now }).percentText, "<0.1% used");
});

test("credit freshness uses its own receipt, shows stale explicitly and rejects expired or future observations", () => {
  const credits = snapshot(1);
  assert.equal(creditsView(credits, { now: now + 119999 }).status, "available");
  assert.equal(creditsView(credits, { now: now + 120000 }).status, "stale");
  assert.equal(creditsView(credits, { now: now + 899999 }).tone, "unavailable");
  assert.equal(creditsView(credits, { now: now + 900000 }).status, "unavailable");
  assert.equal(creditsView(credits, { now: now - 1 }).status, "unavailable");
});

test("legacy inference headers cannot refresh a stale credit snapshot or invent an exact credit balance", async () => {
  let clock = now;
  const cache = new CopilotAccountCache({
    now: () => clock,
    request: async url => new Response(JSON.stringify(url.endsWith("/copilot_internal/user")
      ? body(2612) : { login: identity.login })),
  });
  await cache.read(identity);
  clock += 120000;
  cache.observeHeaders(new Headers({ "x-quota-snapshot-premium_interactions": "ent=300&rem=99" }), identity);
  assert.equal(cache.value.quota.credits.used, 2612);
  assert.equal(cache.value.quota.credits.updatedAt, new Date(now).toISOString());
  const premium = cache.value.quota.snapshots.find(snapshot => snapshot.id === "premium_interactions");
  assert.equal(premium.unit, "credits", "Untyped old headers cannot re-label a verified credit bucket as requests");
  assert.equal(premium.updatedAt, new Date(now).toISOString());
  assert.equal(creditsView(cache.value.quota.credits, { now: clock }).status, "stale");
});

test("portable terminal rendering uses ASCII outside a proven modern TTY and shares copy, percentages and colors", () => {
  const view = creditsView(snapshot(2612), { now });
  for (const [tty, env] of [[false, { TERM: "xterm" }], [true, { TERM: "dumb" }], [true, {}]]) {
    assert.equal(creditTerminalCapabilities({ isTTY: tty }, env).animate, false);
  }
  assert.equal(creditTerminalCapabilities({ isTTY: true }, { WT_SESSION: "synthetic" }).animate, true);
  assert.equal(creditTerminalCapabilities({ isTTY: true }, { TERM: "xterm", NO_COLOR: "" }).color, false);
  const line = renderCreditLine(view);
  assert.match(line, /^\[[=-]{12}\] /);
  assert(line.includes(view.statusText.replaceAll(" · ", " | ")));
  assert.doesNotMatch(line, /[^\x20-\x7e]/);
  assert.match(renderCreditLine(view, { unicode: true }), /^[○◔◑◕●] /);
});

test("credits JSON and non-TTY output never contain terminal escapes and require the current account generation", async () => {
  const view = { ...creditsView(snapshot(2612), { now }), accountGeneration: "a" };
  const account = { status: "authenticated", accountGeneration: "a", credits: view };
  const chunks = [];
  const output = { isTTY: false, write: text => chunks.push(text) };
  const request = async () => new Response(JSON.stringify(account));
  await runCredits([], { endpoint: "http://127.0.0.1:1234", output, request });
  assert.doesNotMatch(chunks.join(""), /\x1b/);
  chunks.length = 0;
  await runCredits(["--json"], { endpoint: "http://127.0.0.1:1234", output, request });
  assert.equal(JSON.parse(chunks.join("")).used, 2612);
  await assert.rejects(runCredits([], {
    endpoint: "http://127.0.0.1:1234", output,
    request: async () => new Response(JSON.stringify({ ...account, accountGeneration: "b" })),
  }), /current account generation/);
});

test("TTY credit watch restores the cursor and owns only one line when cancelled", async () => {
  const controller = new AbortController();
  const chunks = [];
  const view = { ...creditsView(snapshot(2612), { now }), accountGeneration: "a" };
  const output = { isTTY: true, columns: 120, write(text) {
    chunks.push(text);
    if (text.startsWith("\r")) setImmediate(() => controller.abort());
  } };
  await runCredits(["--watch"], {
    endpoint: "http://127.0.0.1:1234", output, env: { TERM: "xterm-256color" }, signal: controller.signal,
    request: async () => new Response(JSON.stringify({ status: "authenticated", accountGeneration: "a", credits: view })),
  });
  assert(chunks.includes("\x1b[?25l"));
  assert.equal(chunks.at(-1), "\x1b[0m\x1b[?25h\n");
  assert(chunks.some(chunk => chunk.startsWith("\r\x1b[2K")));
  assert.doesNotMatch(chunks.join(""), /\x1b\[[0-9]+[AB]/);
});

test("Desktop credits use a real SVG ring, smooth shared timing and independent rendering without replacing native controls", () => {
  const patch = buildDesktopCreditsPatch();
  new vm.Script(patch);
  assert.match(patch, /createElementNS.*svg/);
  assert.match(patch, /stroke-dashoffset/);
  assert.match(patch, /cubic-bezier/);
  assert(patch.includes('"transitionMs":480'));
  assert(patch.includes('"refreshMs":15000'));
  assert.match(patch, /prefers-reduced-motion/);
  assert.doesNotMatch(patch, /innerHTML|onSelectModel|reasoningEffort|\x1b/);
});
