import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import {
  credentialRecoveryHint,
  formatCredentialDiagnostic,
} from "../bridge/doctor-diagnostics.mjs";

test("doctor distinguishes provider failure from missing or denied credentials", () => {
  assert.equal(formatCredentialDiagnostic([
    { category: "upstream_error", statuses: [503, 502, 503] },
  ]), "provider model service unavailable (HTTP 502/503)");
  assert.match(formatCredentialDiagnostic([{ category: "credential_missing" }]), /no credential/);
  assert.match(formatCredentialDiagnostic([
    { category: "authorization_denied", statuses: [403] },
  ]), /authorization or entitlement.*403/);
});

test("doctor deduplicates classified failures and never emits untrusted error data", () => {
  const secret = "SYNTHETIC_SECRET_NOT_FOR_OUTPUT";
  const detail = formatCredentialDiagnostic([
    { category: "ok", source: secret },
    { category: "timeout", message: secret, token: secret },
    { category: "timeout", responseBody: secret },
    { category: secret, statuses: [secret, 999, 401.5, 0], source: secret },
    { category: "constructor" },
    { category: "__proto__" },
  ]);
  assert.equal(detail, "model validation timed out; credential validation failed");
  assert.ok(!detail.includes(secret));
});

test("doctor network/schema failures do not instruct an account switch or login", () => {
  for (const category of ["network_error", "tls_error", "timeout", "rate_limited",
    "upstream_error", "invalid_json", "invalid_schema", "no_eligible_models"]) {
    const hint = credentialRecoveryHint([{ category }]);
    assert.match(hint, /does not establish.*invalid/);
    assert.doesNotMatch(hint, /login --force/);
  }
});

test("doctor gives targeted store and account-isolation recovery", () => {
  assert.match(credentialRecoveryHint([{ category: "cache_write_error" }]),
    /do not replace a validated credential/);
  assert.match(credentialRecoveryHint([{ category: "identity_mismatch" }]), /account is pinned/);
  assert.match(credentialRecoveryHint([{ category: "authorization_denied" }]), /Copilot access/);
  assert.doesNotMatch(credentialRecoveryHint([
    { category: "authorization_denied", statuses: [401] },
    { category: "upstream_error", statuses: [503] },
  ]), /login --force/);
  assert.equal(formatCredentialDiagnostic([
    { source: "credential-manager", category: "store_unreadable" },
  ]), "Credential Manager could not be read");
  assert.doesNotMatch(formatCredentialDiagnostic([
    { source: "credential-manager", category: "store_invalid_json" },
  ]), /saved credential store/);
});

const testModel = {
  id: "gpt-test", name: "GPT Test", vendor: "OpenAI",
  is_chat_default: true, model_picker_enabled: true,
  supported_endpoints: ["/responses"],
  capabilities: {
    type: "chat",
    supports: { reasoning_effort: ["low", "high"] },
    limits: { max_prompt_tokens: 272000, max_context_window_tokens: 400000, max_output_tokens: 128000 },
  },
};

async function isolatedDoctor(response) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ccodex-doctor-diagnostic-"));
  const secret = "SYNTHETIC_DOCTOR_TOKEN_MUST_NOT_LEAK";
  fs.writeFileSync(path.join(home, "github-auth.json"),
    JSON.stringify({ oauth_token: secret, login: "isolated-doctor-account" }));
  fs.writeFileSync(path.join(home, "config.toml"), 'model = "gpt-test"\n');
  fs.writeFileSync(path.join(home, "models.json"), JSON.stringify({ models: [{ slug: "gpt-test" }] }));
  let requests = 0;
  const server = http.createServer((request, reply) => {
    reply.setHeader("content-type", "application/json");
    if (request.url === "/health") {
      reply.end(JSON.stringify({ bridge: "codex-copilot", pid: 1234 }));
      return;
    }
    if (request.url !== "/models") { reply.writeHead(404).end(); return; }
    requests++;
    reply.writeHead(response.status ?? 200);
    reply.end(response.body ?? JSON.stringify({ data: [testModel] }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const child = spawn(process.execPath, [
    path.resolve(import.meta.dirname, "../bridge/cli.mjs"), "doctor",
  ], {
    windowsHide: true,
    env: {
      ...process.env, CODEX_COPILOT_HOME: home, CODEX_COPILOT_AUTH_MODE: "saved",
      CODEX_COPILOT_API_BASE: endpoint, CODEX_COPILOT_GITHUB_API_BASE: endpoint,
      CODEX_COPILOT_BRIDGE_PORT: String(server.address().port),
      CODEX_COPILOT_MODEL_SAMPLES: "3", CODEX_COPILOT_GITHUB_TOKEN: "",
      GH_TOKEN: "", GITHUB_TOKEN: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  try {
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert.ok(!stdout.includes(secret) && !stderr.includes(secret));
    return { code, stdout, stderr, requests };
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  }
}

for (const [name, response, expected] of [
  ["provider outage", { status: 503 }, /model service unavailable.*503/],
  ["rate limiting", { status: 429 }, /rate-limited.*429/],
  ["malformed JSON", { body: '{"unclosed"' }, /not valid JSON/],
  ["unsupported schema", { body: '{"models":[]}' }, /unsupported structure/],
  ["no eligible models", { body: '{"data":[]}' }, /no eligible chat models/],
]) {
  test(`doctor CLI reports ${name} without claiming missing credentials`, async () => {
    const result = await isolatedDoctor(response);
    assert.equal(result.code, 1);
    assert.match(result.stdout, expected);
    assert.doesNotMatch(result.stdout, /no usable Copilot credential|login --force/);
    assert.equal(result.requests, 3);
  });
}

test("doctor CLI reports an authorization rejection separately", async () => {
  const result = await isolatedDoctor({ status: 401 });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /authorization or entitlement.*401/);
  assert.match(result.stdout, /selected account.*Copilot access/);
});

test("doctor CLI uses its fresh validation once instead of repeating the model request batch", async () => {
  const result = await isolatedDoctor({});
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /OK\s+credential/);
  assert.match(result.stdout, /OK\s+live models/);
  assert.equal(result.requests, 3);
});
