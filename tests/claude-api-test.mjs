import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { configureClaude } from "../tools/configure-claude.mjs";

test("provider model discovery follows bounded pagination, preserves explicit IDs and treats authentication failures as errors", async () => {
  const { claudeApiModels } = await import("../gateway/claude-api-profile.mjs");
  const requests = [];
  const models = await claudeApiModels({ ANTHROPIC_API_KEY: "fixture-key", ANTHROPIC_BASE_URL: "https://api.example.test" }, async (url, options) => {
    requests.push(String(url));assert.equal(options.headers["x-api-key"], "fixture-key");
    return new Response(JSON.stringify(requests.length === 1 ? { data: [{ id: "first" }], has_more: true, last_id: "first" }
      : { data: [{ id: "second" }], has_more: false }), { status: 200 });
  });
  assert.deepEqual(models.map(m => m.id), ["first", "second"]);assert.match(requests[1], /after_id=first/);
  assert.equal(await claudeApiModels({ ANTHROPIC_API_KEY: "fixture-key" }, async () => new Response("", { status: 404 })), null);
  await assert.rejects(claudeApiModels({ ANTHROPIC_API_KEY: "fixture-key" }, async () => new Response("", { status: 401 })), /401/);
});
import { claudeCodeEngine } from "../gateway/engines/claude-code.mjs";

test("Claude advertises native efforts and applies saved auto/deny modes while explicit ask rules and business questions stay manual", async () => {
  let mode = "auto", prompts = 0;
  const decisions = [], calls = [];
  const sdk = { query: ({ options }) => {
    calls.push(options);
    return { close() {}, supportedModels: async () => [{ value: "from-cli", displayName: "Native Claude", supportedEffortLevels: ["low", "high"] }],
      async *[Symbol.asyncIterator]() {
        decisions.push(await options.canUseTool("Bash", { command: "pwd" }, {}));
        mode = "deny";
        decisions.push(await options.canUseTool("Bash", { command: "pwd" }, {}));
        mode = "auto";
        decisions.push(await options.canUseTool("Bash", {}, { matchedAskRule: { source: "managed", toolName: "Bash" } }));
        decisions.push(await options.canUseTool("Bash", {}, { decisionReasonType: "rule" }));
        decisions.push(await options.canUseTool("Bash", {}, { serverPolicyAskOnly: true }));
        decisions.push(await options.canUseTool("AskUserQuestion", { questions: [{ header: "Choice", question: "Which?", options: [{ label: "A", description: "A" }] }] }, {}));
        yield { type: "result", subtype: "success", result: "done" };
      } };
  } };
  const engine = claudeCodeEngine({ sdk, env: {} });
  assert.deepEqual(engine.approvalModes, ["ask", "auto", "deny"]);
  assert.equal(engine.supportsModelSwitch, true);
  assert.deepEqual((await engine.models())[0].supportedReasoningEfforts, ["low", "high"]);
  await engine.run({ model: "from-cli", cwd: os.tmpdir(), prompt: "test", reasoningEffort: "high", signal: new AbortController().signal,
    getApprovalMode: () => mode, onSession() {}, onText() {}, ask: async questions => {
      prompts++; return { answers: questions[0].id === "permission" ? { permission: { answers: ["Deny"] } } : { q0: { answers: ["A"] } } };
    } });
  assert.equal(calls.at(-1).effort, "high");
  assert.deepEqual(decisions.map(x => x.behavior), ["allow", "deny", "deny", "deny", "deny", "allow"]);
  assert.equal(prompts, 4);
});

test("Claude profile credentials override ambient authentication, hot reload and never enter engine error messages", async t => {
  const { claudeApiEnvironment, writeClaudeApiProfile } = await import("../gateway/claude-api-profile.mjs");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "claude-profile-"));t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  writeClaudeApiProfile(home, { baseUrl: "https://api.example.test", model: "my-explicit-model" }, "fixture-personal-key");
  const ambient = { HOME: "/original", ANTHROPIC_API_KEY: "other-key", ANTHROPIC_AUTH_TOKEN: "other-token", CLAUDE_CODE_OAUTH_TOKEN: "oauth", CLAUDE_CODE_USE_BEDROCK: "1" };
  const env = claudeApiEnvironment(home, ambient);
  assert.equal(env.ANTHROPIC_API_KEY, "fixture-personal-key");assert.equal(env.ANTHROPIC_BASE_URL, "https://api.example.test");
  assert.equal(env.CLAUDE_CONFIG_DIR, home);assert.equal(env.ANTHROPIC_MODEL, "my-explicit-model");
  for (const k of ["ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK"]) assert.equal(env[k], undefined);
  assert.equal(ambient.ANTHROPIC_API_KEY, "other-key");
  writeClaudeApiProfile(home, {}, "fixture-replaced-key");
  const engine = claudeCodeEngine({ sdk: { query() { throw new Error("server echoed fixture-replaced-key"); } }, credentialProfile: home, environment: () => claudeApiEnvironment(home, ambient) });
  await assert.rejects(engine.models(), error => !error.message.includes("fixture-replaced-key") && error.message.includes("redacted"));
  assert.equal(fs.readdirSync(home).some(name => name.startsWith(".mycodex-auth-")), false, "Failed discovery must remove its secret-bearing overlay");
  assert.equal(claudeApiEnvironment(home, ambient).ANTHROPIC_BASE_URL, undefined);
  if (process.platform !== "win32") {
    fs.chmodSync(path.join(home, "credentials.json"), 0o644);
    assert.throws(() => claudeApiEnvironment(home, ambient), /private/);
  }
});

test("Claude profile rejects credential-bearing URLs, linked secrets and missing credentials without fallback", async t => {
  const { claudeApiEnvironment, writeClaudeApiProfile } = await import("../gateway/claude-api-profile.mjs");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "claude-invalid-"));t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  for (const baseUrl of ["http://outside.test", "https://user:password@example.test", "https://example.test?key=secret"])
    assert.throws(() => writeClaudeApiProfile(home, { baseUrl }, "fixture-key"), /HTTPS|credentials/);
  assert.throws(() => claudeApiEnvironment(home, { ANTHROPIC_API_KEY: "ambient-key" }), /配置|configure/);
  const target = path.join(home, "preserve");fs.writeFileSync(target, "preserve", { mode: 0o600 });fs.symlinkSync(target, path.join(home, "credentials.json"));
  assert.throws(() => writeClaudeApiProfile(home, {}, "fixture-key"), /regular|linked/);
  assert.equal(fs.readFileSync(target, "utf8"), "preserve");
});

test("Claude setup prepares hidden local entry and attaches only private profile references while preserving the existing instance", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "claude-setup-"));t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const configFile = path.join(home, "config.json"), sdkPath = path.join(home, "sdk.mjs");fs.writeFileSync(sdkPath, "export function query(){}\n");
  const existing = { id: "copilot", adapter: "github-copilot", sdkPath };
  const config = { configVersion: 1, defaultInstance: "fixture", instances: [{ id: "fixture", mode: "app-server-gateway", host: "isolated", gateway: { defaultEngine: "copilot", engines: [existing] } }] };
  fs.writeFileSync(configFile, JSON.stringify(config));
  const args = ["--config", configFile, "--sdk-path", sdkPath, "--base-url", "https://api.example.test", "--model", "explicit-model"];
  await assert.rejects(configureClaude(["configure", "--config", configFile, "--sdk-path", sdkPath, "--engine", "copilot"]), /belongs to another/);
  const prepared = await configureClaude(["prepare", ...args]);
  assert.equal(prepared.desktopConfigurationChanged, false);assert.equal(fs.readFileSync(configFile, "utf8"), JSON.stringify(config));
  const launcher = fs.readFileSync(prepared.launcher, "utf8");assert.match(launcher, /configure/);assert.equal(launcher.includes("fixture-personal-secret"), false);
  process.env.MYCODEX_CLAUDE_FIXTURE_KEY = "fixture-personal-secret";
  try { const result = await configureClaude(["configure", ...args, "--api-key-env", "MYCODEX_CLAUDE_FIXTURE_KEY"]);assert.equal(result.accountInferenceVerified, false); }
  finally { delete process.env.MYCODEX_CLAUDE_FIXTURE_KEY; }
  const saved = JSON.parse(fs.readFileSync(configFile, "utf8"));
  assert.deepEqual(saved.instances[0].gateway.engines[0], existing);
  assert.equal(saved.instances[0].gateway.defaultEngine, "copilot");
  assert.equal(saved.instances[0].gateway.engines[1].adapter, "claude-code");
  assert.equal(JSON.stringify(saved).includes("fixture-personal-secret"), false);
  const status = await configureClaude(["status", ...args]);
  assert.equal(status.configured, true);assert.equal(status.accountInferenceVerified, null, "Read-only status must not falsely label a previously verified account as failed");
  process.env.MYCODEX_CLAUDE_FIXTURE_KEY = "fixture-rotated-secret";
  try {
    const rotated = await configureClaude(["configure", "--config", configFile, "--api-key-env", "MYCODEX_CLAUDE_FIXTURE_KEY"]);
    assert.equal(rotated.restartRequiredForNewEngine, false);
    const { readClaudeApiProfile } = await import("../gateway/claude-api-profile.mjs");
    assert.equal(readClaudeApiProfile(prepared.profile).profile.baseUrl, "https://api.example.test", "Key rotation must not silently change its recipient");
  } finally { delete process.env.MYCODEX_CLAUDE_FIXTURE_KEY; }
});

test("the hidden-input helper writes the runtime-compatible private credential document and refuses unattended entry", { skip: !fs.existsSync("/usr/bin/python3") }, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "claude-hidden-"));t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const helper = path.resolve("tools/claude-api-key.py");
  const unattended = spawnSync("/usr/bin/python3", [helper, home, '{"schemaVersion":1}'], { encoding: "utf8", input: "not-a-real-key\n" });
  assert.notEqual(unattended.status, 0);assert.equal(fs.existsSync(path.join(home, "credentials.json")), false);
  execFileSync("/usr/bin/python3", ["-c", [
    "import importlib.util,sys",
    "spec=importlib.util.spec_from_file_location('fixture_helper',sys.argv[1])",
    "module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)",
    "module.getpass.getpass=lambda prompt:'fixture-python-key'",
    "module.store(sys.argv[2],{'schemaVersion':1,'baseUrl':'https://api.example.test'})",
  ].join("\n"), helper, home], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  const { readClaudeApiProfile } = await import("../gateway/claude-api-profile.mjs");
  assert.equal(readClaudeApiProfile(home).apiKey, "fixture-python-key");
});

test("account checks retain actionable native authentication errors while masking the supplied key", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "claude-check-error-"));t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const profile = path.join(home, "profile"), sdkPath = path.join(home, "sdk.mjs"), configFile = path.join(home, "config.json");
  const { writeClaudeApiProfile } = await import("../gateway/claude-api-profile.mjs");
  writeClaudeApiProfile(profile, {}, "fixture-check-secret");
  fs.writeFileSync(sdkPath, `export function query({options}) { return { close(){}, async supportedModels(){return [{value:'fixture'}]}, async accountInfo(){return {apiKeySource:'ANTHROPIC_API_KEY'}}, async *[Symbol.asyncIterator](){yield {type:'result',subtype:'error_during_execution',is_error:true,result:'401 authentication_error: '+options.env.ANTHROPIC_API_KEY}} }; }`);
  fs.writeFileSync(configFile, JSON.stringify({ configVersion: 1, defaultInstance: "fixture", instances: [{ id: "fixture", mode: "app-server-gateway", host: "isolated", gateway: { defaultEngine: "claude", engines: [{ id: "claude", adapter: "claude-code", sdkPath, cliHome: profile }] } }] }));
  await assert.rejects(configureClaude(["check", "--config", configFile]), error => /401 authentication_error/.test(error.message) && !error.message.includes("fixture-check-secret") && error.message.includes("[redacted]"));
  const engine = claudeCodeEngine({ env: { ANTHROPIC_API_KEY: "fixture-check-secret" }, sdk: { query() { return { close() {}, async *[Symbol.asyncIterator]() {
    yield { type: "result", subtype: "error_during_execution", is_error: true, result: "401 authentication_error: fixture-check-secret" };
  } }; } } });
  await assert.rejects(engine.run({ model: "fixture", cwd: home, prompt: "check", signal: new AbortController().signal, onSession() {}, onText() {}, ask() {} }), error => /401 authentication_error/.test(error.message) && !error.message.includes("fixture-check-secret"));
});


test("Claude candidates intersect CLI support with the service directory and retain only explicitly configured custom IDs", async t => {
  const http = await import("node:http");
  const server = http.createServer((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ data: [{ id: "claude-supported" }, { id: "gemini-unrelated" }, { id: "service-only" }], has_more: false })); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "claude-candidates-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const { writeClaudeApiProfile } = await import("../gateway/claude-api-profile.mjs");
  writeClaudeApiProfile(home, {}, "fixture-key");
  const engine = claudeCodeEngine({ credentialProfile: home, environment: () => ({ ANTHROPIC_API_KEY: "fixture-key", ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, ANTHROPIC_MODEL: "own-custom-model" }), sdk: {
    query: () => ({ close() {}, supportedModels: async () => [{ value: "sonnet", resolvedModel: "claude-supported", displayName: "CLI supported", supportedEffortLevels: ["low", "high"] }, { value: "not-on-service", displayName: "Unavailable" }] }),
  } });
  const candidates = await engine.models();
  assert.deepEqual(candidates.map(model => model.id), ["own-custom-model", "claude-supported"]);
  assert.deepEqual(candidates[1].supportedReasoningEfforts, ["low", "high"]);
});
