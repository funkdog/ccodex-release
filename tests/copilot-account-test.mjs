import assert from "node:assert/strict";
import test from "node:test";
import { CopilotAccountCache, fetchCopilotAccount, normalizeCopilotQuotas,
  quotaSnapshotFreshness, quotaSnapshotText } from "../bridge/copilot-account.mjs";
import { buildAccountUiPatch } from "../bridge/desktop-patch.mjs";
import vm from "node:vm";

const now = Date.parse("2026-10-03T02:00:00Z");
const identity = { token: "fake-secret-token", login: "test-user", generation: "one" };
const profile = { login: "test-user", name: "Test User",
  avatar_url: "https://avatars.githubusercontent.com/u/123?v=4",
  html_url: "https://github.com/test-user" };
const entitlement = { copilot_plan: "individual_pro",
  quota_reset_date: "2026-11-01T00:00:00Z", quota_snapshots: {
    premium_interactions: { entitlement: 300, remaining: 240, percent_remaining: 80,
      unlimited: false, overage_count: 0, overage_permitted: false },
    chat: { entitlement: -1, unlimited: true },
  } };
const response = (value, status = 200) => new Response(JSON.stringify(value), { status });
const mock = ({ user = profile, quota = entitlement } = {}) =>
  async url => response(url.endsWith("/user") && !url.endsWith("/copilot_internal/user") ? user : quota);

test("Copilot quotas report remaining, consumed, unlimited and zero separately", () => {
  const quota = normalizeCopilotQuotas(entitlement, { now });
  assert.equal(quota.status, "available");
  assert.equal(quota.snapshots[0].remaining, 240);
  assert.equal(quota.snapshots[0].percentRemaining, 80);
  assert.equal(quotaSnapshotText(quota.snapshots[0]), "240/300 requests remaining · 80.0% remaining");
  assert.equal(quotaSnapshotText(quota.snapshots[1]), "Unlimited");
  const zero = normalizeCopilotQuotas({ quota_snapshots: {
    premium_interactions: { entitlement: 300, remaining: 0, percent_remaining: 0 },
  } }, { now });
  assert.equal(zero.snapshots[0].remaining, 0);
  assert.match(quotaSnapshotText(zero.snapshots[0]), /0\/300.*0\.0% remaining/);
  const fresh = normalizeCopilotQuotas({ quota_snapshots: {
    premium_interactions: { entitlement: 300, remaining: 300, percent_remaining: 100 },
  } }, { now });
  assert.equal(fresh.snapshots[0].percentRemaining, 100);
});

test("unavailable or invalid quota is never silently presented as zero", () => {
  for (const body of [{}, { quota_snapshots: { chat: {} } },
    { quota_snapshots: { chat: { remaining: -1, percent_remaining: 1000 } } },
    { quota_snapshots: { chat: { remaining: "0", entitlement: "300" } } }]) {
    const quota = normalizeCopilotQuotas(body, { now });
    assert.equal(quota.status, "unavailable");
    assert.deepEqual(quota.snapshots, []);
  }
});

test("quota freshness expires each bucket independently, including unlimited buckets", () => {
  const premium = { updatedAt: new Date(now - 15 * 60000).toISOString() };
  const chat = { unlimited: true, updatedAt: new Date(now).toISOString() };
  assert.equal(quotaSnapshotFreshness(premium, { now }), "unavailable");
  assert.equal(quotaSnapshotFreshness(chat, { now }), "available");
  assert.equal(quotaSnapshotFreshness({ updatedAt: new Date(now - 120000).toISOString() },
    { now }), "stale");
  assert.equal(quotaSnapshotFreshness({ unlimited: true }, { now }), "unavailable");
  assert.equal(quotaSnapshotFreshness({ updatedAt: "invalid" }, { now }), "unavailable");
  assert.equal(quotaSnapshotFreshness({ updatedAt: new Date(now + 1).toISOString() },
    { now }), "unavailable");
});

test("account metadata uses the same authenticated token and exposes only bounded public fields", async () => {
  const calls = [];
  const result = await fetchCopilotAccount({
    ...identity, now, request: async (url, options) => {
      calls.push({ url, options });
      return mock({ user: { ...profile, oauth_token: identity.token } })(url);
    },
  });
  assert.equal(result.profile.name, "Test User");
  assert.equal(result.profile.avatarUrl, profile.avatar_url);
  assert.equal(result.plan, "individual_pro");
  assert.equal(result.quota.snapshots[0].remaining, 240);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.options.headers.authorization === `Bearer ${identity.token}`));
  assert.ok(calls.every(call => call.options.headers["x-github-api-version"] === "2022-11-28"));
  assert.ok(calls.every(call => call.options.redirect === "error"));
  assert.doesNotMatch(JSON.stringify(result), /fake-secret-token|oauth_token/);
});

test("profile identity mismatch refuses all quotas instead of showing another account", async () => {
  let calls = 0;
  const result = await fetchCopilotAccount({ ...identity, now, request: async () => {
    calls += 1;
    return response({ ...profile, login: "other-user" });
  } });
  assert.equal(calls, 1);
  assert.equal(result.quota.reason, "identity_mismatch");
  assert.equal(result.plan, null);
  assert.equal(result.profile.avatarUrl, null);
  assert.deepEqual(result.quota.snapshots, []);
});

test("avatar and profile URLs cannot load arbitrary origins or embed credentials", async () => {
  for (const avatar_url of ["https://evil.invalid/avatar", "javascript:alert(1)",
    "https://secret@avatars.githubusercontent.com/u/1", "https://avatars.githubusercontent.com:444/u/1"]) {
    const result = await fetchCopilotAccount({ ...identity, now,
      request: mock({ user: { ...profile, avatar_url, html_url: "https://evil.invalid" } }) });
    assert.equal(result.profile.avatarUrl, null);
    assert.equal(result.profile.url, null);
  }
});

test("bounded invalid JSON and denied quota requests preserve identity without leaking errors", async () => {
  for (const reply of [response({ secret: identity.token }, 403),
    new Response("{broken"), response({ filler: "a".repeat(256 * 1024) })]) {
    const result = await fetchCopilotAccount({ ...identity, now,
      request: async url => url.endsWith("/copilot_internal/user") ? reply : response(profile) });
    assert.equal(result.profile.name, "Test User");
    assert.equal(result.quota.status, "unavailable");
    assert.doesNotMatch(JSON.stringify(result), /fake-secret-token|filler|broken/);
  }
});

test("cached quota coalesces reads and changes immediately on token/account generation", async () => {
  let calls = 0;
  let clock = now;
  const cache = new CopilotAccountCache({ now: () => clock, request: async url => {
    calls += 1;
    return mock()(url);
  } });
  const [one, two] = await Promise.all([cache.read(identity), cache.read(identity)]);
  assert.deepEqual(one, two);
  assert.equal(calls, 2);
  await cache.read(identity);
  assert.equal(calls, 2);
  clock += 100;
  await cache.read({ ...identity, generation: "two" });
  assert.equal(calls, 4);
});

test("outdated account fetch cannot replace a new account's quota", async () => {
  let finish;
  const slow = new Promise(resolve => { finish = resolve; });
  const cache = new CopilotAccountCache({ now: () => now,
    request: async (url, options) => {
      if (options.headers.authorization.includes("fake-secret-token")) await slow;
      const other = options.headers.authorization.includes("other-token");
      return response(url.endsWith("/copilot_internal/user")
        ? { ...entitlement, quota_snapshots: { chat: { remaining: other ? 7 : 99 } } }
        : { ...profile, login: other ? "other-user" : "test-user" });
    },
  });
  const old = cache.read(identity);
  const next = await cache.read({ token: "other-token", login: "other-user", generation: "two" });
  finish();
  assert.equal((await old).quota.reason, "identity_changed");
  assert.equal(next.quota.snapshots[0].remaining, 7);
  assert.equal(cache.value.profile.login, "other-user");
});

test("temporary errors are explicitly stale and authorization denial removes old quotas", async () => {
  let clock = now;
  let fail = null;
  const cache = new CopilotAccountCache({ now: () => clock, request: async url => {
    if (fail === "network") throw new Error(`Do not expose ${identity.token}`);
    if (fail === "denied") return response({}, 403);
    return mock()(url);
  } });
  await cache.read(identity);
  fail = "network";
  clock += 60001;
  const stale = await cache.read(identity);
  assert.equal(stale.quota.status, "stale");
  assert.equal(stale.quota.snapshots[0].remaining, 240);
  assert.equal(stale.quota.updatedAt, new Date(now).toISOString());
  fail = "denied";
  const denied = await cache.read(identity, { force: true });
  assert.equal(denied.quota.status, "unavailable");
  assert.deepEqual(denied.quota.snapshots, []);
});

test("response headers update current-account percentages without fabricating exact remaining counts", async () => {
  const cache = new CopilotAccountCache({ now: () => now, request: mock() });
  await cache.read(identity);
  const headers = new Headers({ "x-quota-snapshot-premium_interactions":
    "ent=300&rem=79.5&ov=1&ovPerm=true&rst=2026-11-01T00%3A00%3A00Z" });
  assert.equal(cache.observeHeaders(headers, { ...identity, generation: "other" }), null);
  const value = cache.observeHeaders(headers, identity);
  assert.equal(value.quota.source, "response-headers");
  assert.equal(value.quota.snapshots[0].remaining, null);
  assert.equal(value.quota.snapshots[0].percentRemaining, 79.5);
  assert.equal(value.quota.snapshots[1].unlimited, true);
  assert.equal(quotaSnapshotText(value.quota.snapshots[0]), "79.5% remaining");
});

test("a slow quota refresh cannot overwrite a newer inference quota or postpone metadata refresh", async () => {
  let clock = now;
  let release;
  let delayed = false;
  const wait = new Promise(resolve => { release = resolve; });
  const cache = new CopilotAccountCache({ now: () => clock, request: async url => {
    if (delayed) await wait;
    return mock()(url);
  } });
  await cache.read(identity);
  clock += 60001;
  delayed = true;
  const pending = cache.read(identity);
  clock += 1000;
  cache.observeHeaders(new Headers({
    "x-quota-snapshot-premium_interactions": "ent=300&rem=75",
  }), identity);
  assert.equal(cache.checkedAt, now);
  release();
  const result = await pending;
  assert.equal(result.quota.source, "response-headers");
  assert.equal(result.quota.snapshots[0].percentRemaining, 75);
  assert.equal(result.quota.snapshots[0].remaining, null);
  assert.equal(result.quota.snapshots[1].updatedAt, new Date(now + 60001).toISOString());
});

test("one later inference bucket does not discard other buckets from a successful metadata refresh", async () => {
  let clock = now;
  let release;
  let delayed = false;
  const wait = new Promise(resolve => { release = resolve; });
  const cache = new CopilotAccountCache({ now: () => clock, request: async url => {
    if (delayed) await wait;
    return mock({ quota: { ...entitlement, quota_snapshots: {
      ...entitlement.quota_snapshots, chat: { entitlement: 100, remaining: delayed ? 60 : 80 },
    } } })(url);
  } });
  await cache.read(identity);
  clock += 60001;
  delayed = true;
  const pending = cache.read(identity);
  clock += 1000;
  cache.observeHeaders(new Headers({
    "x-quota-snapshot-premium_interactions": "ent=300&rem=75",
  }), identity);
  release();
  const result = await pending;
  assert.equal(result.quota.snapshots[0].percentRemaining, 75);
  assert.equal(result.quota.snapshots[0].updatedAt, new Date(clock).toISOString());
  assert.equal(result.quota.snapshots[1].remaining, 60);
  assert.equal(result.quota.snapshots[1].updatedAt, new Date(now + 60001).toISOString());
});

test("inference headers cannot publish an account quota before its profile identity was verified", async () => {
  const cache = new CopilotAccountCache({ now: () => now,
    request: async () => response({}, 403) });
  const result = await cache.read(identity);
  assert.equal(result.profile.verified, false);
  assert.equal(cache.observeHeaders(new Headers({
    "x-quota-snapshot-premium_interactions": "ent=300&rem=75",
  }), identity), null);
});

test("account renderer patch parses and remains isolated from native model/effort controls", () => {
  const patch = buildAccountUiPatch();
  new vm.Script(patch);
  assert.match(patch, /cc-account-avatar/);
  assert.match(patch, /percentRemaining/);
  assert.match(patch, /% used/);
  assert.match(patch, /quota\/refresh|account\/refresh/);
  assert.match(patch, /freshness !== 'unavailable'.*snapshot\.unlimited/);
  assert.match(patch, /Quota unavailable \(expired or not timestamped\)/);
  assert.doesNotMatch(patch, /innerHTML|Debugger\.|modelControls|ReasoningEffort/);
});
