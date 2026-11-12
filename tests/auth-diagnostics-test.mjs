import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { pathToFileURL } from "node:url";
import { credentialRecoveryHint, formatCredentialDiagnostic } from "../bridge/doctor-diagnostics.mjs";

const PRIVATE = "synthetic-private-token-body-url-and-target";
const SAVED_TOKEN = `${PRIVATE}-saved`;
const ENV_TOKEN = `${PRIVATE}-environment`;
const MANAGER_TOKEN = `${PRIVATE}-manager`;
const MODEL = {
  id: "test-current",
  model_picker_enabled: true,
  supported_endpoints: ["/responses"],
  capabilities: { type: "chat", supports: {}, limits: {} },
  policy: { state: "enabled" },
};
const ENV_KEYS = [
  "CODEX_COPILOT_HOME", "CODEX_COPILOT_AUTH_MODE", "CODEX_COPILOT_MODEL_SAMPLES",
  "CODEX_COPILOT_API_BASE", "CODEX_COPILOT_GITHUB_API_BASE",
  "CODEX_COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN",
  "CODEX_COPILOT_MODEL_CACHE_TTL_MS",
];
const DIAGNOSTIC_KEYS = new Set([
  "source", "category", "statuses", "samples", "successfulSamples", "returnedModels", "eligibleModels",
]);
let imports = 0;
const OWNED_PROFILE_PREFIX = "ccodex-auth-diagnostics-";
const ownedProfiles = new Set();
let createdProfiles = 0;
let cleanedProfiles = 0;

after(() => {
  assert.equal(ownedProfiles.size, 0, "every owned isolated profile must be cleaned");
  assert.equal(cleanedProfiles, createdProfiles, "profile cleanup must actually run for every fixture");
});

function response(status = 200, body = { data: [MODEL] }) {
  return {
    status, ok: status >= 200 && status < 300,
    async json() {
      assert.ok(status >= 200 && status < 300, "failed HTTP bodies must not be read");
      return body;
    },
  };
}

function sampleResponse(sample) {
  if (typeof sample === "number") return response(sample);
  if (sample.error) throw sample.error;
  const res = response(sample.status ?? 200, sample.body);
  if (sample.jsonError) res.json = async () => { throw sample.jsonError; };
  return res;
}

function assertSafe(value, extraPrivate = []) {
  const entries = Array.isArray(value) ? value : [value];
  for (const entry of entries) {
    assert.ok(entry && typeof entry === "object");
    for (const key of Object.keys(entry)) assert.ok(DIAGNOSTIC_KEYS.has(key), key);
    if (Object.hasOwn(entry, "source")) {
      assert.ok(["saved", "environment", "credential-manager"].includes(entry.source));
    }
    if (entry.statuses) {
      assert.ok(entry.statuses.every(status => Number.isInteger(status) && status >= 100 && status <= 599));
    }
  }
  const serialized = JSON.stringify(value);
  for (const secret of [PRIVATE, "https://models.invalid", ...extraPrivate]) {
    assert.ok(!serialized.includes(secret), "diagnostics must contain no private data");
  }
}

async function fixture(t, {
  record = { oauth_token: SAVED_TOKEN, login: "alpha" },
  mode = "saved",
  env = {},
  manager = [],
  managerRead = null,
  models = () => response(),
  login = () => "alpha",
} = {}) {
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const home = fs.mkdtempSync(path.join(temporaryRoot, OWNED_PROFILE_PREFIX));
  const previous = new Map(ENV_KEYS.map(key => [key, process.env[key]]));
  ownedProfiles.add(home);
  createdProfiles++;
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    // Remove only the exact mkdtemp directory owned by this fixture, after
    // restoring filesystem mocks. Never enumerate or retry older failed dirs.
    assert.ok(ownedProfiles.has(home));
    assert.equal(path.dirname(path.resolve(home)), temporaryRoot);
    assert.ok(path.basename(home).startsWith(OWNED_PROFILE_PREFIX));
    const stat = fs.lstatSync(home);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
    const resolvedHome = fs.realpathSync(home);
    assert.equal(path.dirname(resolvedHome), temporaryRoot);
    assert.equal(path.basename(resolvedHome), path.basename(home));
    fs.rmSync(resolvedHome, { recursive: true, force: true });
    assert.equal(fs.existsSync(home), false);
    ownedProfiles.delete(home);
    cleanedProfiles++;
  });
  const authFile = path.join(home, "github-auth.json");
  const cacheFile = path.join(home, "copilot-model-cache.json");
  if (record !== null) {
    fs.writeFileSync(authFile, typeof record === "string" ? record : JSON.stringify(record));
  }
  Object.assign(process.env, {
    CODEX_COPILOT_HOME: home,
    CODEX_COPILOT_AUTH_MODE: mode,
    CODEX_COPILOT_MODEL_SAMPLES: "3",
    CODEX_COPILOT_API_BASE: "https://models.invalid",
    CODEX_COPILOT_GITHUB_API_BASE: "https://identity.invalid",
    CODEX_COPILOT_MODEL_CACHE_TTL_MS: "86400000",
  });
  for (const key of ["CODEX_COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"]) delete process.env[key];
  Object.assign(process.env, env);
  const calls = { models: [], identity: [], manager: 0, removals: [] };
  let deletionFailure = new Error("Cache deletion is simulated while filesystem mocks are active.");
  t.mock.method(fs, "rmSync", file => {
    calls.removals.push(file);
    throw deletionFailure;
  });
  // Even explicit recovery must never read the user's real Credential Manager.
  t.mock.method(childProcess, "execFileSync", (command, args) => {
    assert.equal(command, "powershell.exe");
    assert.ok(args.some(arg => String(arg).endsWith("credman.ps1")));
    calls.manager++;
    return managerRead ? managerRead() : JSON.stringify(manager);
  });
  syncBuiltinESMExports();
  t.mock.method(globalThis, "fetch", async (input, options = {}) => {
    const url = new URL(String(input));
    assert.equal(options.method || "GET", "GET");
    if (url.origin === "https://models.invalid" && url.pathname === "/models") {
      const token = options.headers.authorization.replace(/^Bearer /, "");
      const index = calls.models.length;
      calls.models.push(token);
      return models(index, token);
    }
    assert.equal(url.origin, "https://identity.invalid");
    assert.equal(url.pathname, "/user");
    const token = options.headers.authorization.replace(/^token /, "");
    calls.identity.push(token);
    return response(200, { login: login(token) });
  });
  const auth = await import(
    `${pathToFileURL(path.resolve(import.meta.dirname, "../bridge/auth.mjs")).href}?diagnostics=${++imports}`
  );
  return {
    auth, home, authFile, cacheFile, calls,
    setDeletionFailure(error) { deletionFailure = error; },
  };
}

test("fixture cleanup restores filesystem mocks and removes only its owned profile", async (t) => {
  let home;
  await t.test("owned isolated fixture", async (t) => {
    ({ home } = await fixture(t));
    assert.equal(fs.existsSync(home), true);
    assert.equal(ownedProfiles.has(home), true);
  });
  assert.equal(fs.existsSync(home), false);
  assert.equal(ownedProfiles.has(home), false);
});

test("layered model validation classifies HTTP, transport, body and schema failures without secrets", async (t) => {
  const cases = [
    { label: "401", category: "authorization_denied", status: 401 },
    { label: "403", category: "authorization_denied", status: 403 },
    { label: "429", category: "rate_limited", status: 429 },
    { label: "500", category: "upstream_error", status: 500 },
    { label: "502", category: "upstream_error", status: 502 },
    { label: "503", category: "upstream_error", status: 503 },
    { label: "network", category: "network_error", error: new TypeError(PRIVATE) },
    { label: "DNS", category: "network_error",
      error: Object.assign(new TypeError(PRIVATE), { cause: { code: "ENOTFOUND", message: PRIVATE } }) },
    { label: "TLS", category: "tls_error",
      error: Object.assign(new TypeError(PRIVATE), { cause: { code: "ERR_TLS_CERT_ALTNAME_INVALID" } }) },
    { label: "nested TLS", category: "tls_error",
      error: Object.assign(new TypeError(PRIVATE), { cause: { cause: { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" } } }) },
    { label: "abort", category: "timeout", error: new DOMException(PRIVATE, "AbortError") },
    { label: "timeout", category: "timeout", error: new DOMException(PRIVATE, "TimeoutError") },
    { label: "transport timeout", category: "timeout",
      error: Object.assign(new TypeError(PRIVATE), { cause: { code: "UND_ERR_HEADERS_TIMEOUT" } }) },
    { label: "JSON", category: "invalid_json", status: 200,
      jsonError: new SyntaxError(PRIVATE) },
    { label: "missing data", category: "invalid_schema", status: 200, body: { message: PRIVATE } },
    { label: "non-array data", category: "invalid_schema", status: 200, body: { data: PRIVATE } },
    { label: "body transport", category: "network_error", status: 200,
      jsonError: new TypeError(PRIVATE) },
    { label: "body abort", category: "timeout", status: 200,
      jsonError: new DOMException(PRIVATE, "AbortError") },
  ];
  for (const scenario of cases) {
    await t.test(scenario.label, async (t) => {
      const { auth, calls } = await fixture(t, {
        models() {
          if (scenario.error) throw scenario.error;
          const res = response(scenario.status, scenario.body);
          if (scenario.jsonError) res.json = async () => { throw scenario.jsonError; };
          return res;
        },
      });
      const expected = {
        category: scenario.category,
        statuses: scenario.status ? Array(3).fill(scenario.status) : [],
        samples: 3, successfulSamples: 0, returnedModels: 0, eligibleModels: 0,
      };
      await assert.rejects(auth.fetchCopilotModelRecords(SAVED_TOKEN), (error) => {
        assert.deepEqual(error.diagnostic, expected);
        assertSafe(error.diagnostic);
        assert.ok(!error.message.includes(PRIVATE));
        return true;
      });
      assert.equal(await auth.validateToken(SAVED_TOKEN), null);
      const diagnostics = [];
      assert.equal(await auth.resolveToken({ diagnostics }), null);
      assert.deepEqual(diagnostics, [{ source: "saved", ...expected }]);
      assertSafe(diagnostics);
      assert.equal(calls.models.length, 9);
      assert.equal(calls.identity.length, 0);
      assert.equal(calls.manager, 0);
    });
  }
});

test("successful HTTP with no eligible models is not reported as authorization denial", async (t) => {
  const cases = [
    { label: "empty", data: [] },
    { label: "picker disabled", data: [{ ...MODEL, model_picker_enabled: false }] },
    { label: "picker missing", data: [{ ...MODEL, model_picker_enabled: undefined }] },
    { label: "endpoints missing", data: [{ ...MODEL, supported_endpoints: undefined }] },
    { label: "policy disabled", data: [{ ...MODEL, policy: { state: "disabled" } }] },
    { label: "non-chat", data: [{ ...MODEL, capabilities: { type: "embeddings" } }] },
  ];
  for (const { label, data } of cases) {
    await t.test(label, async (t) => {
      const { auth } = await fixture(t, { models: () => response(200, { data }) });
      const records = await auth.fetchCopilotModelRecords(SAVED_TOKEN);
      assert.equal(records.length, data.length);
      assert.equal(await auth.validateToken(SAVED_TOKEN), null);
      const diagnostics = [];
      assert.equal(await auth.resolveToken({ diagnostics }), null);
      assert.deepEqual(diagnostics, [{
        source: "saved", category: "no_eligible_models", statuses: [200, 200, 200],
        samples: 3, successfulSamples: 3, returnedModels: data.length, eligibleModels: 0,
      }]);
      assertSafe(diagnostics);
    });
  }
});

test("partial sample success remains usable and preserves every observed HTTP status", async (t) => {
  const cases = [
    { label: "rate-limit and outage", samples: [429, 200, 503], statuses: [429, 200, 503] },
    { label: "authorization denials", samples: [401, 200, 403], statuses: [401, 200, 403] },
    { label: "transport failures", samples: [
      { error: new DOMException(PRIVATE, "AbortError") }, 200,
      { error: Object.assign(new TypeError(PRIVATE), { cause: { code: "CERT_HAS_EXPIRED" } }) },
    ], statuses: [200] },
  ];
  for (const { label, samples, statuses } of cases) {
    await t.test(label, async (t) => {
      const { auth, calls } = await fixture(t, {
        models: index => sampleResponse(samples[index % 3]),
      });
      assert.equal((await auth.fetchCopilotModelRecords(SAVED_TOKEN)).length, 1);
      assert.equal((await auth.validateToken(SAVED_TOKEN)).length, 1);
      const diagnostics = [];
      const record = await auth.resolveToken({ diagnostics });
      assert.equal(record.oauth_token, SAVED_TOKEN);
      assert.equal(record.source, "codex-copilot login");
      assert.deepEqual(record.validatedModels, [MODEL]);
      assert.deepEqual(record.validation, {
        source: "saved", category: "ok", statuses,
        samples: 3, successfulSamples: 1, returnedModels: 1, eligibleModels: 1,
      });
      assert.deepEqual(diagnostics, [record.validation]);
      assertSafe(record.validation);
      assert.equal(calls.models.length, 9);
    });
  }
});

test("mixed failed samples have deterministic classification and retain HTTP evidence", async (t) => {
  const cases = [
    { label: "denied plus rate-limit and network", samples: [429, 403, { error: new TypeError(PRIVATE) }],
      category: "rate_limited", statuses: [429, 403] },
    { label: "denied plus outage", samples: [401, 403, 503],
      category: "upstream_error", statuses: [401, 403, 503] },
    { label: "denied plus network", samples: [401, 403, { error: new TypeError(PRIVATE) }],
      category: "network_error", statuses: [401, 403] },
    { label: "denied plus TLS", samples: [401, 403, {
      error: Object.assign(new TypeError(PRIVATE), { cause: { code: "CERT_HAS_EXPIRED" } }),
    }], category: "tls_error", statuses: [401, 403] },
    { label: "denied plus timeout", samples: [401, 403, {
      error: new DOMException(PRIVATE, "AbortError"),
    }], category: "timeout", statuses: [401, 403] },
    { label: "denied plus JSON", samples: [401, 403, { jsonError: new SyntaxError(PRIVATE) }],
      category: "invalid_json", statuses: [401, 403, 200] },
    { label: "denied plus schema", samples: [401, 403, { body: { data: PRIVATE } }],
      category: "invalid_schema", statuses: [401, 403, 200] },
    { label: "all denied", samples: [401, 403, 401],
      category: "authorization_denied", statuses: [401, 403, 401] },
  ];
  for (const { label, samples, category, statuses } of cases) {
    await t.test(label, async (t) => {
      const { auth } = await fixture(t, { models: index => sampleResponse(samples[index % 3]) });
      const diagnostics = [];
      assert.equal(await auth.resolveToken({ diagnostics }), null);
      assert.deepEqual(diagnostics, [{
        source: "saved", category, statuses,
        samples: 3, successfulSamples: 0, returnedModels: 0, eligibleModels: 0,
      }]);
      if (category !== "authorization_denied") {
        assert.doesNotMatch(credentialRecoveryHint(diagnostics), /login --force/);
        assert.doesNotMatch(formatCredentialDiagnostic(diagnostics), /rejected authorization/);
      }
      assertSafe(diagnostics);
    });
  }
});

test("record merge/schema exceptions carry safe diagnostics rather than raw exception data", async (t) => {
  const invalid = { id: "test-invalid", get capabilities() { throw new Error(PRIVATE); } };
  const { auth } = await fixture(t, { models: () => response(200, { data: [MODEL, invalid] }) });
  await assert.rejects(auth.fetchCopilotModelRecords(SAVED_TOKEN), error => {
    assert.equal(error.diagnostic.category, "invalid_schema");
    assert.deepEqual(error.diagnostic.statuses, [200, 200, 200]);
    assert.ok(!error.message.includes(PRIVATE));
    assertSafe(error.diagnostic);
    return true;
  });
  assert.equal(await auth.validateToken(SAVED_TOKEN), null);
  const diagnostics = [];
  assert.equal(await auth.resolveToken({ diagnostics }), null);
  assert.equal(diagnostics[0].category, "invalid_schema");
  assertSafe(diagnostics);
});

test("missing credentials and saved-store read/JSON errors stay distinct", async (t) => {
  await t.test("missing saved record", async (t) => {
    const { auth, calls } = await fixture(t, { record: null });
    const diagnostics = [];
    assert.equal(await auth.resolveToken({ diagnostics }), null);
    assert.deepEqual(diagnostics, [{ source: "saved", category: "credential_missing" }]);
    assert.equal(await auth.validateToken(null), null);
    assert.equal(calls.models.length, 0);
    assert.equal(calls.manager, 0);
  });
  await t.test("invalid JSON", async (t) => {
    const { auth, calls } = await fixture(t, { record: `{"oauth_token":"${PRIVATE}"` });
    const diagnostics = [];
    assert.equal(await auth.resolveToken({ diagnostics }), null);
    assert.deepEqual(diagnostics, [{ source: "saved", category: "store_invalid_json" }]);
    assertSafe(diagnostics);
    assert.equal(calls.models.length, 0);
  });
  await t.test("unreadable store", async (t) => {
    const { auth, authFile, home, calls } = await fixture(t);
    const originalRead = fs.readFileSync;
    t.mock.method(fs, "readFileSync", (file, ...args) => {
      if (file === authFile) throw Object.assign(new Error(`${PRIVATE} ${home}`), { code: "EACCES" });
      return originalRead(file, ...args);
    });
    const diagnostics = [];
    assert.equal(await auth.resolveToken({ diagnostics }), null);
    assert.deepEqual(diagnostics, [{ source: "saved", category: "store_unreadable" }]);
    assertSafe(diagnostics, [home]);
    assert.equal(calls.models.length, 0);
  });
  await t.test("record has no token", async (t) => {
    const { auth } = await fixture(t, { record: { login: "alpha" } });
    const diagnostics = [];
    assert.equal(await auth.resolveToken({ diagnostics }), null);
    assert.deepEqual(diagnostics, [{ source: "saved", category: "credential_missing" }]);
  });
  await t.test("environment source absent", async (t) => {
    const { auth } = await fixture(t, { mode: "environment" });
    const diagnostics = [];
    assert.equal(await auth.resolveToken({ diagnostics }), null);
    assert.deepEqual(diagnostics, [{ source: "environment", category: "credential_missing" }]);
  });
});

test("unselected saved-store failures do not pollute environment or manager diagnostics", async (t) => {
  const stores = [
    { label: "missing saved store", record: null },
    { label: "invalid saved JSON", record: `{"oauth_token":"${PRIVATE}"` },
    { label: "saved record has no token", record: { login: "alpha" } },
    { label: "unreadable saved store", unreadable: true },
  ];
  for (const mode of ["environment", "credential-manager"]) {
    await t.test(mode, { skip: mode === "credential-manager" && process.platform !== "win32" },
      async (t) => {
        for (const store of stores) {
          await t.test(store.label, async (t) => {
            const options = {
              mode, models: () => response(503),
              env: mode === "environment" ? { GH_TOKEN: ENV_TOKEN } : {},
              manager: mode === "credential-manager" ? [{ secret: MANAGER_TOKEN, target: PRIVATE }] : [],
            };
            if (Object.hasOwn(store, "record")) options.record = store.record;
            const { auth, authFile, calls, home } = await fixture(t, options);
            if (store.unreadable) {
              const originalRead = fs.readFileSync;
              t.mock.method(fs, "readFileSync", (file, ...args) => {
                if (file === authFile) throw Object.assign(new Error(PRIVATE), { code: "EACCES" });
                return originalRead(file, ...args);
              });
            }
            const diagnostics = [];
            assert.equal(await auth.resolveToken({ diagnostics }), null);
            assert.deepEqual(diagnostics, [{
              source: mode, category: "upstream_error", statuses: [503, 503, 503],
              samples: 3, successfulSamples: 0, returnedModels: 0, eligibleModels: 0,
            }]);
            assert.equal(calls.models.length, 3);
            assert.equal(calls.manager, mode === "credential-manager" ? 1 : 0);
            assert.doesNotMatch(credentialRecoveryHint(diagnostics), /login --force/);
            assert.doesNotMatch(formatCredentialDiagnostic(diagnostics), /saved credential store|no credential/);
            assertSafe(diagnostics, [home]);
          });
        }
      });
  }
});

test("saved missing is not a credential-missing conclusion when an environment candidate fails validation", async (t) => {
  const cases = [
    { label: "auto/shared environment", mode: "auto", env: { GH_TOKEN: ENV_TOKEN } },
    { label: "saved/explicit environment", mode: "saved", env: { CODEX_COPILOT_GITHUB_TOKEN: ENV_TOKEN } },
    { label: "environment only", mode: "environment", env: { GH_TOKEN: ENV_TOKEN } },
  ];
  for (const scenario of cases) {
    await t.test(scenario.label, async (t) => {
      const { auth, calls } = await fixture(t, {
        record: null, mode: scenario.mode, env: scenario.env, models: () => response(503),
      });
      const diagnostics = [];
      assert.equal(await auth.resolveToken({ diagnostics }), null);
      assert.deepEqual(diagnostics, [{
        source: "environment", category: "upstream_error", statuses: [503, 503, 503],
        samples: 3, successfulSamples: 0, returnedModels: 0, eligibleModels: 0,
      }]);
      assert.deepEqual(calls.models, [ENV_TOKEN, ENV_TOKEN, ENV_TOKEN]);
      assert.doesNotMatch(credentialRecoveryHint(diagnostics), /login --force/);
      assertSafe(diagnostics);
    });
  }
});

test("zero candidates report only the selected source even when the saved store is invalid", async (t) => {
  for (const mode of ["environment", "credential-manager"]) {
    await t.test(mode, async (t) => {
      const { auth, calls } = await fixture(t, { mode, record: PRIVATE });
      const diagnostics = [];
      assert.equal(await auth.resolveToken({ diagnostics }), null);
      assert.deepEqual(diagnostics, [{ source: mode, category: "credential_missing" }]);
      assert.equal(calls.models.length, 0);
      assertSafe(diagnostics);
    });
  }
});

test("environment success is not reported as failure of an unselected saved store", async (t) => {
  const { auth, calls } = await fixture(t, {
    mode: "environment", record: PRIVATE, env: { GH_TOKEN: ENV_TOKEN },
  });
  const diagnostics = [];
  const record = await auth.resolveToken({ diagnostics });
  assert.equal(record.validation.category, "ok");
  assert.deepEqual(diagnostics, [record.validation]);
  assert.equal(record.validation.source, "environment");
  assert.deepEqual(record.validatedModels, [MODEL]);
  assert.equal(calls.manager, 0);
  assertSafe(diagnostics);
});

test("fresh validatedModels are separate from stabilized same-account cache records", async (t) => {
  const { auth, cacheFile, calls } = await fixture(t);
  const stale = { ...MODEL, id: "test-cache-only" };
  fs.writeFileSync(cacheFile, JSON.stringify({
    schemaVersion: 1,
    accounts: { alpha: { models: [{ model: stale, lastSeenAt: new Date().toISOString() }] } },
  }));
  const diagnostics = [];
  const record = await auth.resolveToken({ diagnostics });
  assert.equal(record.models.length, 2);
  assert.deepEqual(record.validatedModels, [MODEL]);
  assert.equal(record.validation.returnedModels, 1);
  assert.equal(record.validation.eligibleModels, 1);
  assert.equal(calls.models.length, 3, "resolution must not fetch twice for fresh validation");
  assertSafe(record.validation);
});

test("Credential Manager read/JSON failures use fixed safe source labels", {
  skip: process.platform !== "win32",
}, async (t) => {
  for (const category of ["store_invalid_json", "store_unreadable"]) {
    await t.test(category, async (t) => {
      const { auth, calls } = await fixture(t, {
        mode: "credential-manager",
        managerRead() {
          if (category === "store_unreadable") throw new Error(PRIVATE);
          return PRIVATE;
        },
      });
      const diagnostics = [];
      assert.equal(await auth.resolveToken({ diagnostics }), null);
      assert.deepEqual(diagnostics, [{ source: "credential-manager", category }]);
      assert.equal(calls.models.length, 0);
      assert.equal(calls.manager, 1);
      assertSafe(diagnostics);
    });
  }
});

test("diagnostics do not enable fallback away from a saved account", async (t) => {
  const { auth, calls, cacheFile } = await fixture(t, {
    mode: "auto",
    env: { GH_TOKEN: ENV_TOKEN },
    manager: [{ secret: MANAGER_TOKEN, target: PRIVATE }],
    models: () => response(401),
  });
  const diagnostics = [];
  assert.equal(await auth.resolveToken({ diagnostics }), null);
  assert.deepEqual(calls.models, [SAVED_TOKEN, SAVED_TOKEN, SAVED_TOKEN]);
  assert.equal(calls.manager, 0);
  assert.equal(calls.identity.length, 0);
  assert.equal(fs.existsSync(cacheFile), false);
  assertSafe(diagnostics);
});

test("explicit same-account recovery rejects a different manager login before accepting the matching environment login", async (t) => {
  const { auth, calls, authFile } = await fixture(t, {
    mode: "auto",
    env: { GH_TOKEN: ENV_TOKEN },
    manager: [{ secret: MANAGER_TOKEN, target: PRIVATE }],
    login: token => token === MANAGER_TOKEN ? "beta" : "ALPHA",
  });
  const originalStore = fs.readFileSync(authFile, "utf8");
  const diagnostics = [];
  const record = await auth.resolveToken({
    diagnostics, allowSharedFallback: true, expectedLogin: "alpha", excludeToken: SAVED_TOKEN,
  });
  assert.equal(record.oauth_token, ENV_TOKEN);
  assert.equal(record.source, "env:GH_TOKEN");
  assert.deepEqual(diagnostics.map(({ source, category }) => ({ source, category })), [
    ...(process.platform === "win32"
      ? [{ source: "credential-manager", category: "identity_mismatch" }] : []),
    { source: "environment", category: "ok" },
  ]);
  assert.deepEqual(calls.identity, process.platform === "win32"
    ? [MANAGER_TOKEN, ENV_TOKEN] : [ENV_TOKEN]);
  assert.equal(calls.manager, process.platform === "win32" ? 1 : 0);
  assert.equal(fs.readFileSync(authFile, "utf8"), originalStore);
  assertSafe(diagnostics);
});

test("same-account recovery refuses a usable credential with an unknown or mismatched identity", async (t) => {
  for (const identity of ["beta", null]) {
    await t.test(identity || "unknown", async (t) => {
      const { auth, cacheFile } = await fixture(t, {
        mode: "saved", env: { CODEX_COPILOT_GITHUB_TOKEN: ENV_TOKEN }, login: () => identity,
      });
      const diagnostics = [];
      assert.equal(await auth.resolveToken({
        diagnostics, expectedLogin: "alpha", excludeToken: SAVED_TOKEN,
      }), null);
      assert.equal(diagnostics.length, 1);
      assert.equal(diagnostics[0].category, "identity_mismatch");
      assert.equal(diagnostics[0].source, "environment");
      assert.equal(fs.existsSync(cacheFile), false);
      assertSafe(diagnostics);
    });
  }
});

test("explicit environment precedes saved credentials without widening shared fallback", async (t) => {
  const { auth, calls } = await fixture(t, {
    mode: "auto", env: { CODEX_COPILOT_GITHUB_TOKEN: ENV_TOKEN, GH_TOKEN: `${PRIVATE}-unused` },
    models: (_index, token) => response(token === ENV_TOKEN ? 429 : 200),
  });
  const diagnostics = [];
  const record = await auth.resolveToken({ diagnostics });
  assert.equal(record.oauth_token, SAVED_TOKEN);
  assert.deepEqual(diagnostics.map(({ source, category }) => ({ source, category })), [
    { source: "environment", category: "rate_limited" },
    { source: "saved", category: "ok" },
  ]);
  assert.equal(calls.manager, 0);
  assert.equal(calls.identity.length, 0);
  assertSafe(diagnostics);
});

test("quiet-false diagnostics never print a Credential Manager target or secret", {
  skip: process.platform !== "win32",
}, async (t) => {
  const { auth } = await fixture(t, {
    mode: "credential-manager",
    manager: [{ secret: MANAGER_TOKEN, target: PRIVATE }],
    models: () => response(403),
  });
  let output = "";
  t.mock.method(process.stderr, "write", text => { output += text; return true; });
  const diagnostics = [];
  assert.equal(await auth.resolveToken({ quiet: false, diagnostics }), null);
  assert.equal(diagnostics[0].source, "credential-manager");
  assert.ok(output.includes("credential-manager"));
  assert.ok(!output.includes(PRIVATE));
  assertSafe(diagnostics);
});

test("cache write failures are diagnosed and the original exception still propagates", async (t) => {
  await t.test("write refused", async (t) => {
    const { auth, cacheFile, authFile, home } = await fixture(t);
    const originalStore = fs.readFileSync(authFile, "utf8");
    const failure = Object.assign(new Error(`${PRIVATE} ${home}`), { code: "EACCES" });
    const originalWrite = fs.writeFileSync;
    t.mock.method(fs, "writeFileSync", (file, ...args) => {
      if (String(file).startsWith(`${cacheFile}.`)) throw failure;
      return originalWrite(file, ...args);
    });
    const diagnostics = [];
    await assert.rejects(auth.resolveToken({ diagnostics }), error => error === failure);
    assert.deepEqual(diagnostics.map(entry => entry.category), ["ok", "cache_write_error"]);
    assertSafe(diagnostics, [home]);
    assert.equal(fs.readFileSync(authFile, "utf8"), originalStore);
    await assert.rejects(auth.resolveToken(), error => error === failure);
  });
  await t.test("rename and fallback removal refused", async (t) => {
    const { auth, cacheFile, home, calls, setDeletionFailure } = await fixture(t);
    const before = JSON.stringify({ schemaVersion: 1, accounts: {} });
    fs.writeFileSync(cacheFile, before);
    const refusal = Object.assign(new Error(`${PRIVATE} ${home}`), { code: "EPERM" });
    t.mock.method(fs, "renameSync", () => { throw new Error(PRIVATE); });
    setDeletionFailure(refusal); // Simulate refusal only; never delete anything.
    const diagnostics = [];
    await assert.rejects(auth.resolveToken({ diagnostics }), error => error === refusal);
    assert.deepEqual(diagnostics.map(entry => entry.category), ["ok", "cache_write_error"]);
    assert.deepEqual(calls.removals, [cacheFile]);
    assert.equal(fs.readFileSync(cacheFile, "utf8"), before);
    assertSafe(diagnostics, [home]);
  });
});

test("default return types, token deduplication and explicit diagnostics validation remain compatible", async (t) => {
  const { auth, calls } = await fixture(t, {
    env: { CODEX_COPILOT_GITHUB_TOKEN: SAVED_TOKEN },
  });
  const records = await auth.fetchCopilotModelRecords(SAVED_TOKEN, { samples: 1 });
  assert.ok(Array.isArray(records));
  assert.deepEqual(records, [MODEL]);
  assert.ok(Array.isArray(await auth.validateToken(SAVED_TOKEN)));
  const record = await auth.resolveToken();
  assert.equal(record.oauth_token, SAVED_TOKEN);
  assert.equal(record.source, "env:CODEX_COPILOT_GITHUB_TOKEN");
  assert.equal(record.validation.source, "environment");
  assert.deepEqual(record.validatedModels, [MODEL]);
  assert.equal(calls.models.length, 7);
  assert.equal(calls.identity.length, 0);
  assert.equal(calls.manager, 0);
  assertSafe(record.validation);
  const before = calls.models.length;
  await assert.rejects(auth.resolveToken({ diagnostics: {} }), /array or null/);
  assert.equal(calls.models.length, before);
});
