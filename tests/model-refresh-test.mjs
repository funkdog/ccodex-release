import assert from "node:assert/strict";
import test from "node:test";
import { refreshModels } from "../bridge/model-refresh.mjs";

function fixture({ cached = true, nextLogin = "alice", category = "network_error" } = {}) {
  const state = { login: "alice", models: cached ? [{ id: "gemini-fixture-pro" }] : [], modelsAt: 123 };
  const failure = Object.assign(new Error("Copilot catalogue unavailable"), { diagnostic: { category } });
  const api = { id: "api-source--gemini-fixture-pro" };
  return { state, failure, options: {
    state,
    ensureAuth: async ({ force } = {}) => {
      if (force) { state.login = nextLogin; state.models = []; state.modelsAt = 0; }
      return "fixture-token";
    },
    fetchModels: async () => { throw failure; },
    sources: { merge: models => [...models, api] },
  } };
}

for (const category of ["network_error", "timeout", "tls_error", "rate_limited", "upstream_error"]) {
  test(`${category} retains the same account's Copilot model alongside explicit API IDs`, async () => {
    const { state, failure, options } = fixture({ category });
    const result = await refreshModels(options, { force: true });
    assert.deepEqual(result.map(x => x.id), ["gemini-fixture-pro", "api-source--gemini-fixture-pro"]);
    assert.equal(state.modelsAt, 123);
    assert.equal(state.modelRefreshError, failure);
  });
}
for (const setup of [{ cached: false }, { nextLogin: "bob" }, { category: "authorization_denied" }]) {
  test(`failure never substitutes API or another account's models: ${JSON.stringify(setup)}`, async () => {
    const { failure, options } = fixture(setup);
    await assert.rejects(refreshModels(options, { force: true }), error => error === failure);
  });
}
test("successful refresh replaces stale models and clears the outage", async () => {
  const { state, options } = fixture();
  state.modelRefreshError = new Error("old outage");
  options.fetchModels = async () => [{ id: "new-copilot-model" }];
  const result = await refreshModels(options, { force: true });
  assert.equal(result[0].id, "new-copilot-model");
  assert.equal(state.modelRefreshError, null);
  assert.ok(state.modelsAt > 123);
});
