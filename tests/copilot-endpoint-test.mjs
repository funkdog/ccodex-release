import assert from "node:assert/strict";
import test from "node:test";
import { CopilotApiResolver } from "../bridge/copilot-endpoint.mjs";

const fallback = "https://api.githubcopilot.com";
const enterprise = "https://api.enterprise.githubcopilot.com";
const reply = (api = enterprise) => new Response(JSON.stringify({ endpoints: { api } }), {
  headers: { "content-type": "application/json" },
});

test("the authenticated account selects the same enterprise endpoint as native Copilot", async () => {
  const calls = [];
  const resolver = new CopilotApiResolver({
    request: async (url, options) => { calls.push({ url, options }); return reply(); },
  });
  assert.equal(await resolver.resolve("synthetic-private-token"), enterprise);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.github.com/copilot_internal/user");
  assert.equal(calls[0].options.headers.authorization, "Bearer synthetic-private-token");
  assert.equal(calls[0].options.headers["x-github-api-version"], "2022-11-28");
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(resolver.describe("synthetic-private-token").source, "account");
  assert.equal(JSON.stringify(resolver.describe("synthetic-private-token")).includes("private-token"), false);
});

test("explicit upstream configuration stays authoritative and never queries another service", async () => {
  const resolver = new CopilotApiResolver({
    apiBase: "http://127.0.0.1:12345/custom/",
    request: async () => { assert.fail("An explicit API base must not trigger endpoint discovery."); },
  });
  assert.equal(await resolver.resolve("synthetic-token"), "http://127.0.0.1:12345/custom");
  assert.equal(resolver.describe("synthetic-token").source, "override");
});

test("endpoint lookup is coalesced, cached, and refreshed without mixing authenticated accounts", async () => {
  let time = 0;
  const calls = [];
  const resolver = new CopilotApiResolver({
    ttlMs: 100, now: () => time,
    request: async (_url, options) => {
      const token = options.headers.authorization;
      calls.push(token);
      return reply(token.endsWith("alpha") ? enterprise : "https://api.individual.githubcopilot.com");
    },
  });
  assert.deepEqual(await Promise.all([resolver.resolve("alpha"), resolver.resolve("alpha")]),
    [enterprise, enterprise]);
  assert.equal(calls.length, 1);
  assert.equal(await resolver.resolve("beta"), "https://api.individual.githubcopilot.com");
  assert.equal(await resolver.resolve("alpha"), enterprise);
  assert.equal(calls.length, 2);
  time = 101;
  assert.equal(await resolver.resolve("alpha"), enterprise);
  assert.equal(calls.length, 3);
});

test("a metadata outage retains only the last endpoint belonging to the exact credential", async () => {
  let time = 0;
  let failed = false;
  const resolver = new CopilotApiResolver({
    ttlMs: 100, now: () => time,
    request: async () => failed ? new Response(null, { status: 503 }) : reply(),
  });
  assert.equal(await resolver.resolve("alpha"), enterprise);
  time = 101;
  failed = true;
  assert.equal(await resolver.resolve("alpha"), enterprise);
  assert.equal(resolver.describe("alpha").source, "cached-account");
  assert.equal(await resolver.resolve("beta"), fallback);
  assert.equal(resolver.describe("beta").source, "fallback");
});

test("older account metadata can retain the legacy endpoint without inventing an entitlement", async () => {
  const resolver = new CopilotApiResolver({
    request: async () => new Response(JSON.stringify({ copilot_plan: "unknown" })),
  });
  assert.equal(await resolver.resolve("synthetic-token"), fallback);
  assert.equal(resolver.describe("synthetic-token").source, "fallback");
});

for (const endpoint of [
  "http://api.enterprise.githubcopilot.com", "https://api.enterprise.githubcopilot.com.attacker.invalid",
  "https://attacker.invalid", "https://secret@api.enterprise.githubcopilot.com",
  "https://api.enterprise.githubcopilot.com/other", "https://api.enterprise.githubcopilot.com?token=secret",
]) {
  test(`account metadata cannot send the credential to an unsafe endpoint: ${endpoint}`, async () => {
    const resolver = new CopilotApiResolver({ request: async () => reply(endpoint) });
    await assert.rejects(resolver.resolve("synthetic-private-token"), /unsafe|invalid/i);
    assert.equal(resolver.describe("synthetic-private-token"), null);
  });
}

test("native cancellation stops an endpoint waiter without cancelling another request's lookup", async () => {
  let finish;
  let calls = 0;
  const resolver = new CopilotApiResolver({
    request: () => { calls += 1; return new Promise(resolve => { finish = resolve; }); },
  });
  const controller = new AbortController();
  const cancelled = resolver.resolve("alpha", { signal: controller.signal });
  const remaining = resolver.resolve("alpha");
  controller.abort();
  await assert.rejects(cancelled, { name: "AbortError" });
  finish(reply());
  assert.equal(await remaining, enterprise);
  assert.equal(calls, 1);
});
