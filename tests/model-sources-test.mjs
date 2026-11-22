import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import test from "node:test";
import { ModelSources, sourceModelId } from "../bridge/model-sources.mjs";
import { createModelSourcesHandler } from "../bridge/model-sources-http.mjs";
import { launchModelSources } from "../bridge/model-sources-launch.mjs";
import { readProcessIdentity, sameProcessLifetime } from "../bridge/desktop-process.mjs";
import { buildCatalog } from "../bridge/catalog.mjs";
import { memoryResponsesBridge, encodeEvents } from "./fixtures/responses-bridge.mjs";

const key = "fixture-provider-key-1234";
function store(t, options) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "model-sources-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return new ModelSources(home, options);
}
const create = sources => sources.save({ label: "Primary API", baseUrl: "https://example.test/v1", apiKey: key, protocol: "responses", revision: 0 }).savedId;
test("private sources preserve identity, reject stale writes and expose keys only through an explicit local read", async t => {
  const sources = store(t, { fetchImpl: async (url, options) => {
    assert.equal(url, "https://example.test/v1/models"); assert.equal(options.headers.authorization, `Bearer ${key}`); assert.equal(options.redirect, "error");
    return Response.json({ data: [{ id: "gpt-fixture" }, { id: "gpt-image-fixture" }, { id: "gemini-fixture" }] });
  } });
  const id = create(sources);
  assert.equal(fs.statSync(sources.file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(sources.directory).mode & 0o777, 0o700);
  assert.ok(!JSON.stringify(sources.snapshot()).includes(key));
  assert.equal(sources.snapshot().sources[1].maskedKey, "••••••••1234");
  assert.throws(() => sources.prefer({ id, model: "gpt-fixture", revision: 1 }), /请选择/);
  await sources.discover(id, 1);
  assert.deepEqual(sources.source(id).models.map(model => model.id), ["gpt-fixture", "gemini-fixture"]);
  sources.prefer({ id, model: "gpt-fixture", revision: 2 });
  const catalog = buildCatalog(sources.merge([]));
  assert.equal(catalog.models[0].slug, sourceModelId(id, "gpt-fixture"));
  assert.equal(catalog.models[0].api_source.preferred, true);
  assert.ok(!catalog.models[0].description.includes("GitHub Copilot"));
  assert.ok(!JSON.stringify(catalog).includes(key));
  assert.equal(catalog.models[0].copilot.capability_provenance.context, "local-conservative-default");
  const reopened = new ModelSources(path.dirname(sources.directory));
  assert.equal(reopened.preferredModel(), sourceModelId(id, "gpt-fixture"));
  assert.throws(() => sources.save({ id, label: "Renamed", baseUrl: "https://example.test/v1", revision: 2 }), /另一窗口/);
  assert.throws(() => sources.save({ id, label: "Renamed", baseUrl: "https://other.test/v1", revision: 3 }), /新增来源/);
  sources.save({ id, label: "Renamed", baseUrl: "https://example.test/v1", apiKey: "fixture-new-key-5678", revision: 3 });
  assert.equal(sources.source(id).apiKey, "fixture-new-key-5678");
  assert.equal(sources.preferredModel(), sourceModelId(id, "gpt-fixture"));
  sources.prefer({ id: "copilot", revision: 4 });
  assert.equal(sources.preferredModel(), null);
  assert.equal(sources.models().length, 2, "Switching defaults must retain old source bindings");
});

test("external discovery preserves declared image capability without guessing it from Gemini or Carbon names", async t => {
  const sources = store(t, { fetchImpl: async () => Response.json({ data: [
    { id: "gemini-carbon-fixture", input_modalities: ["text", "image"], supports_parallel_tool_calls: true },
    { id: "gemini-unknown-fixture" },
    { id: "provider-vision-fixture", capabilities: { supports: { vision: true } } },
  ] }) });
  const id = create(sources); await sources.discover(id, 1);
  const catalog = buildCatalog(sources.models());
  assert.deepEqual(catalog.models.find(m => m.slug === sourceModelId(id, "gemini-carbon-fixture")).input_modalities, ["text", "image"]);
  assert.deepEqual(catalog.models.find(m => m.slug === sourceModelId(id, "gemini-unknown-fixture")).input_modalities, ["text"]);
  assert.deepEqual(catalog.models.find(m => m.slug === sourceModelId(id, "provider-vision-fixture")).input_modalities, ["text", "image"]);
  const reopened = new ModelSources(path.dirname(sources.directory));
  assert.equal(reopened.models().find(m => m.id === sourceModelId(id, "gemini-carbon-fixture")).capabilities.supports.vision, true);
});

test("linked or corrupt source stores are preserved, and discovery cannot overwrite a concurrent key rotation", async t => {
  const sources = store(t); create(sources);
  const before = fs.readFileSync(sources.file, "utf8");
  const outside = path.join(path.dirname(sources.directory), "outside.json"); fs.renameSync(sources.file, outside); fs.symlinkSync(outside, sources.file);
  assert.throws(() => sources.read(), /不能使用链接/); assert.equal(fs.readFileSync(outside, "utf8"), before);
  fs.unlinkSync(sources.file); fs.renameSync(outside, sources.file);
  const id = sources.snapshot().sources[1].id;
  let release; const wait = new Promise(resolve => { release = resolve; });
  sources.fetchImpl = async () => { await wait; return Response.json({ data: [{ id: "old-key-model" }] }); };
  const pending = sources.discover(id, 1);
  sources.save({ id, label: "Updated", baseUrl: "https://example.test/v1", apiKey: "fixture-rotated-key-9999", revision: 1 });
  release(); await assert.rejects(pending, /另一窗口/);
  assert.equal(sources.source(id).apiKey, "fixture-rotated-key-9999");
  assert.equal(sources.source(id).models.length, 0);
});

test("another settings writer cannot overwrite credentials, and a temporary view works beside an older bridge", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sources-launch-")), sources = new ModelSources(home); create(sources);
  let receipt;
  t.after(async () => {
    if (receipt && sameProcessLifetime(receipt.identity, readProcessIdentity(receipt.identity.pid))) process.kill(receipt.identity.pid, "SIGTERM");
    for (let count = 0; receipt && count < 100 && sameProcessLifetime(receipt.identity, readProcessIdentity(receipt.identity.pid)); count++) await new Promise(resolve => setTimeout(resolve, 10));
    if (receipt) assert.equal(sameProcessLifetime(receipt.identity, readProcessIdentity(receipt.identity.pid)), false);
    fs.rmSync(home, { recursive: true, force: true });
  });
  const lock = path.join(sources.directory, "writer.lock"), before = fs.readFileSync(sources.file, "utf8");
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }), { mode: 0o600 });
  assert.throws(() => sources.prefer({ id: "copilot", revision: 1 }), /正在保存/);
  assert.equal(fs.readFileSync(sources.file, "utf8"), before); fs.unlinkSync(lock);
  const url = await launchModelSources(path.dirname(sources.directory), 1);
  receipt = JSON.parse(fs.readFileSync(path.join(path.dirname(sources.directory), "model-sources-ui.json"), "utf8"));
  assert.equal(await launchModelSources(path.dirname(sources.directory), 1), url);
  const page = await fetch(url); assert.equal(page.status, 200); assert.ok(!(await page.text()).includes(key));
  assert.equal(fs.readFileSync(sources.file, "utf8"), before, "Opening settings does not change source or inference state");
});

test("local management rejects cross-origin requests, forged hosts and unknown writes; list never reveals the credential", async t => {
  const sources = store(t); const id = create(sources); let handler;
  const server = http.createServer((req, res) => handler(req, res));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port, base = `http://127.0.0.1:${port}`;
  handler = createModelSourcesHandler({ sources, port });
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const page = await fetch(base + "/sources"); const html = await page.text();
  assert.ok(!html.includes(key)); assert.equal(page.headers.get("x-frame-options"), "DENY");
  const token = /\)\("([A-Za-z0-9_-]{43})"\);<\/script>/.exec(html)[1];
  const post = (operation, params, extra = {}) => fetch(base + "/sources/api/" + operation, { method: "POST",
    headers: { "content-type": "application/json", "x-mycodex-sources": token, ...extra }, body: JSON.stringify(params) });
  assert.equal((await post("list", {}, { origin: "https://evil.test" })).status, 403);
  const forgedHost = await new Promise((resolve, reject) => {
    const request = http.request(base + "/sources/api/list", { method: "POST", headers: { host: `evil.test:${port}`, "x-mycodex-sources": token } }, response => { response.resume(); response.on("end", () => resolve(response.statusCode)); });
    request.on("error", reject); request.end("{}");
  });
  assert.equal(forgedHost, 403);
  assert.equal((await post("list", {}, { "x-mycodex-sources": "forged" })).status, 403);
  assert.equal((await post("prefer", { id: "copilot", revision: 1, extra: true })).status, 400);
  assert.ok(!(await (await post("list", {})).text()).includes(key));
  assert.deepEqual(await (await post("reveal", { id, revision: 1 })).json(), { apiKey: key });
});

for (const route of ["/responses", "/chat/completions"]) {
  test(`external ${route} uses only its bound credential and never falls back to the Copilot account`, async t => {
    const bridge = await memoryResponsesBridge(async (req, res) => {
      assert.equal(req.headers.authorization, `Bearer ${key}`);
      assert.equal(req.headers["copilot-integration-id"], undefined);
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `Invalid credential ${key}` } }));
    }, { route, model: { sourceCredential: { id: "fixture-source", apiKey: key, get baseUrl() { return bridge.upstream; } } } });
    t.after(() => bridge.close());
    // The fixture exposes its local upstream explicitly, avoiding real credentials/profiles.
    const response = await fetch(bridge.url, { method: "POST", body: JSON.stringify({ model: "gpt-fixture", stream: false, input: "test" }) });
    assert.equal(response.status, 401); assert.ok(!(await response.text()).includes(key));
    assert.equal(bridge.requests.length, 1);
  });
}
