import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { CopilotApiResolver } from "./copilot-endpoint.mjs";

export const CODEX_COPILOT_HOME =
  process.env.CODEX_COPILOT_HOME || path.join(os.homedir(), ".codex-copilot");

const AUTH_FILE = path.join(CODEX_COPILOT_HOME, "github-auth.json");
const ACCOUNTS_VAULT_FILE = path.join(CODEX_COPILOT_HOME, "github-accounts.json");
const MODEL_RECORD_CACHE_FILE = path.join(
  CODEX_COPILOT_HOME,
  "copilot-model-cache.json",
);
const MODEL_POLICY_FILE = path.join(
  CODEX_COPILOT_HOME,
  "model-policies.json",
);
const AUTH_MODES = new Set(["auto", "credential-manager", "saved", "environment"]);
const DIAGNOSTIC_SOURCES = new Set(["saved", "environment", "credential-manager"]);
const DIAGNOSTIC_CATEGORIES = new Set([
  "credential_missing", "store_unreadable", "store_invalid_json",
  "authorization_denied", "rate_limited", "upstream_error", "network_error",
  "timeout", "tls_error", "invalid_json", "invalid_schema", "no_eligible_models",
  "ok", "cache_write_error", "identity_mismatch",
]);

function safeDiagnostic(source, detail) {
  const result = {
    ...(source === null ? {} : {
      source: DIAGNOSTIC_SOURCES.has(source) ? source : "saved",
    }),
    category: DIAGNOSTIC_CATEGORIES.has(detail.category) ? detail.category : "network_error",
  };
  if (Array.isArray(detail.statuses)) {
    result.statuses = detail.statuses.filter(status =>
      Number.isInteger(status) && status >= 100 && status <= 599);
  }
  for (const key of ["samples", "successfulSamples", "returnedModels", "eligibleModels"]) {
    if (Number.isSafeInteger(detail[key]) && detail[key] >= 0) result[key] = detail[key];
  }
  return result;
}

function collectDiagnostic(diagnostics, source, detail) {
  const result = safeDiagnostic(source, detail);
  diagnostics?.push(result);
  return result;
}

function transportCategory(error) {
  const visited = new Set();
  for (let current = error; current && !visited.has(current) && visited.size < 8;
    current = current.cause) {
    visited.add(current);
    if (current.name === "AbortError" || current.name === "TimeoutError" ||
        ["ABORT_ERR", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT",
          "UND_ERR_BODY_TIMEOUT"].includes(current.code)) return "timeout";
    if (typeof current.code === "string" &&
        (/^ERR_TLS_/.test(current.code) ||
          ["CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN",
            "UNABLE_TO_GET_ISSUER_CERT", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
            "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "CERT_NOT_YET_VALID"].includes(current.code))) {
      return "tls_error";
    }
  }
  return "network_error";
}

function modelRecordsError(diagnostic) {
  const safe = safeDiagnostic(null, diagnostic);
  const detail = safe.statuses?.length
    ? safe.statuses.map(status => `HTTP ${status}`).join(", ") : safe.category;
  const error = new Error(`GitHub Copilot /models failed: ${detail}`);
  error.diagnostic = safe;
  return error;
}

// GitHub Copilot's public OAuth client (device-flow capable).
const DEVICE_CLIENT_ID = process.env.CODEX_COPILOT_CLIENT_ID || "Iv1.b507a08c87ecfe98";
const DEVICE_SCOPE = "read:user";
const DEVICE_CODE_URL =
  process.env.CODEX_COPILOT_GITHUB_DEVICE_CODE_URL ||
  "https://github.com/login/device/code";
const DEVICE_TOKEN_URL =
  process.env.CODEX_COPILOT_GITHUB_DEVICE_TOKEN_URL ||
  "https://github.com/login/oauth/access_token";
export const GITHUB_API_BASE =
  process.env.CODEX_COPILOT_GITHUB_API_BASE || "https://api.github.com";

export const COPILOT_API =
  process.env.CODEX_COPILOT_API_BASE || "https://api.githubcopilot.com";
const apiResolver = new CopilotApiResolver({
  apiBase: process.env.CODEX_COPILOT_API_BASE, githubApiBase: GITHUB_API_BASE,
});

export function copilotApiFor(token, options) {
  return apiResolver.resolve(token, options);
}

export function copilotApiStatus(token) {
  return apiResolver.describe(token);
}
const MODEL_SAMPLE_COUNT = Math.max(
  1,
  Math.min(5, Number(process.env.CODEX_COPILOT_MODEL_SAMPLES || 3)),
);
const MODEL_RECORD_TTL_MS = Math.max(
  0,
  Number(process.env.CODEX_COPILOT_MODEL_CACHE_TTL_MS || 24 * 60 * 60 * 1000),
);

export function copilotHeaders(token, extra = {}) {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    accept: "application/json",
    "copilot-integration-id": "vscode-chat",
    "editor-version": "vscode/1.99.0",
    "editor-plugin-version": "copilot-chat/0.26.7",
    "user-agent": "GitHubCopilotChat/0.26.7",
    "x-github-api-version": "2025-05-01",
    "openai-intent": "conversation-edits",
    ...extra,
  };
}

function eligibleCopilotModels(models) {
  return models.filter((model) => {
    const endpoints = Array.isArray(model.supported_endpoints) ? model.supported_endpoints : [];
    const hasSupportedEndpoint = endpoints.some(
      (endpoint) => endpoint === "/responses" || endpoint === "/chat/completions"
    );
    const policyEnabled = !model.policy?.state || model.policy.state === "enabled";
    return (
      model.capabilities?.type === "chat" &&
      hasSupportedEndpoint &&
      model.model_picker_enabled &&
      policyEnabled
    );
  });
}

function mergeModelRecord(existing, incoming) {
  if (!existing) return incoming;
  const supportedEndpoints = [
    ...new Set([
      ...(Array.isArray(existing.supported_endpoints) ? existing.supported_endpoints : []),
      ...(Array.isArray(incoming.supported_endpoints) ? incoming.supported_endpoints : []),
    ]),
  ];
  const existingPolicyEnabled =
    !existing.policy?.state || existing.policy.state === "enabled";
  const incomingPolicyEnabled =
    !incoming.policy?.state || incoming.policy.state === "enabled";
  const policy = incomingPolicyEnabled || !existingPolicyEnabled
    ? incoming.policy || existing.policy
    : existing.policy;
  const existingLimits = existing.capabilities?.limits || {};
  const incomingLimits = incoming.capabilities?.limits || {};
  const limits = { ...existingLimits, ...incomingLimits };
  for (const key of new Set([...Object.keys(existingLimits), ...Object.keys(incomingLimits)])) {
    if (
      Number.isFinite(existingLimits[key]) &&
      Number.isFinite(incomingLimits[key])
    ) {
      limits[key] = Math.max(existingLimits[key], incomingLimits[key]);
    }
  }

  return {
    ...existing,
    ...incoming,
    model_picker_enabled:
      Boolean(existing.model_picker_enabled) || Boolean(incoming.model_picker_enabled),
    supported_endpoints: supportedEndpoints,
    policy,
    capabilities: {
      ...(existing.capabilities || {}),
      ...(incoming.capabilities || {}),
      supports: {
        ...(existing.capabilities?.supports || {}),
        ...(incoming.capabilities?.supports || {}),
      },
      limits,
    },
  };
}

export function mergeCopilotModelLists(lists) {
  const merged = new Map();
  for (const list of lists) {
    for (const model of Array.isArray(list) ? list : []) {
      if (!model?.id) continue;
      merged.set(model.id, mergeModelRecord(merged.get(model.id), model));
    }
  }
  return [...merged.values()];
}

function mergeTemporalModelRecord(existing, incoming) {
  if (!existing) return incoming;
  const merged = mergeModelRecord(existing, incoming);
  return {
    ...merged,
    model_picker_enabled: Boolean(incoming.model_picker_enabled),
    policy: incoming.policy !== undefined ? incoming.policy : existing.policy,
  };
}

export function readModelPolicies() {
  try {
    const parsed = JSON.parse(fs.readFileSync(MODEL_POLICY_FILE, "utf8"));
    return parsed?.schemaVersion === 1 && parsed.models && typeof parsed.models === "object"
      ? parsed
      : { schemaVersion: 1, models: {} };
  } catch {
    return { schemaVersion: 1, models: {} };
  }
}

export function modelPoliciesRevision() {
  try {
    const stat = fs.statSync(MODEL_POLICY_FILE, { bigint: true });
    return `${stat.mtimeNs}:${stat.size}`;
  } catch {
    return "missing";
  }
}

export function applyModelPolicies(models) {
  const policies = readModelPolicies().models || {};
  if (!Object.keys(policies).length) return models;
  return models.map((model) => {
    const entry = model?.id ? policies[model.id] : null;
    if (!entry || !["enabled", "disabled"].includes(entry.state)) return model;
    if (entry.state === "disabled") {
      return {
        ...model,
        model_picker_enabled: false,
        policy: { ...(model.policy || {}), state: "disabled" },
      };
    }
    return {
      ...model,
      model_picker_enabled: true,
      policy: { ...(model.policy || {}), state: "enabled" },
    };
  });
}

export async function setModelPolicy(modelId, policyState, { token = null } = {}) {
  const id = String(modelId || "").trim();
  const state = String(policyState || "").trim().toLowerCase();
  if (!id || !["enabled", "disabled"].includes(state)) {
    throw new Error("Model policy update requires a model ID and state ('enabled' or 'disabled').");
  }
  let upstreamUpdated = false;
  let upstreamStatus = null;
  if (token) {
    try {
      const api = await copilotApiFor(token);
      const res = await fetch(`${api}/models/${encodeURIComponent(id)}/policy`, {
        method: "POST",
        headers: copilotHeaders(token),
        body: JSON.stringify({ state }),
        signal: AbortSignal.timeout(10000),
      });
      upstreamStatus = res.status;
      upstreamUpdated = res.ok;
    } catch {
      /* enterprise accounts manage policies via local/org settings */
    }
  }
  ensureHome();
  const current = readModelPolicies();
  current.models[id] = {
    state,
    updatedAt: new Date().toISOString(),
  };
  const temporary = `${MODEL_POLICY_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(current, null, 2)}\n`, "utf8");
  try {
    fs.renameSync(temporary, MODEL_POLICY_FILE);
  } catch {
    fs.rmSync(MODEL_POLICY_FILE, { force: true });
    fs.renameSync(temporary, MODEL_POLICY_FILE);
  }
  return { model: id, state, upstreamUpdated, upstreamStatus };
}

function readModelRecordCache() {
  try {
    const parsed = JSON.parse(fs.readFileSync(MODEL_RECORD_CACHE_FILE, "utf8"));
    return parsed?.schemaVersion === 1 && parsed.accounts
      ? parsed
      : { schemaVersion: 1, accounts: {} };
  } catch {
    return { schemaVersion: 1, accounts: {} };
  }
}

function writeModelRecordCache(cache) {
  ensureHome();
  const temporary = `${MODEL_RECORD_CACHE_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(cache, null, 2), "utf8");
  try {
    fs.renameSync(temporary, MODEL_RECORD_CACHE_FILE);
  } catch {
    fs.rmSync(MODEL_RECORD_CACHE_FILE, { force: true });
    fs.renameSync(temporary, MODEL_RECORD_CACHE_FILE);
  }
}

export function stabilizeCopilotModels(login, observedModels, { now = Date.now() } = {}) {
  if (!login) return mergeCopilotModelLists([observedModels]);

  const cache = readModelRecordCache();
  const previousEntries = Array.isArray(cache.accounts[login]?.models)
    ? cache.accounts[login].models
    : [];
  const previousById = new Map(
    previousEntries
      .filter((entry) => entry?.model?.id)
      .map((entry) => [entry.model.id, entry]),
  );
  const observedIds = new Set();
  const lastSeenAt = new Date(now).toISOString();
  const entries = [];

  for (const model of mergeCopilotModelLists([observedModels])) {
    observedIds.add(model.id);
    entries.push({
      model: mergeTemporalModelRecord(previousById.get(model.id)?.model, model),
      lastSeenAt,
    });
  }

  if (observedIds.size <= 8) {
    for (const entry of previousEntries) {
      const id = entry?.model?.id;
      const seenAt = Date.parse(entry?.lastSeenAt || "");
      if (
        !id ||
        observedIds.has(id) ||
        !Number.isFinite(seenAt) ||
        now - seenAt > MODEL_RECORD_TTL_MS
      ) {
        continue;
      }
      entries.push(entry);
    }
  }

  cache.accounts[login] = { updatedAt: lastSeenAt, models: entries };
  writeModelRecordCache(cache);
  return applyModelPolicies(entries.map((entry) => entry.model));
}

async function probeCopilotModelRecords(token, samples = MODEL_SAMPLE_COUNT) {
  const count = Math.max(1, Math.min(5, Number(samples) || 1));
  const api = await copilotApiFor(token);
  const results = await Promise.allSettled(
    Array.from({ length: count }, async () => {
      let res;
      try {
        res = await fetch(`${api}/models`, {
          headers: copilotHeaders(token),
        });
      } catch (error) {
        throw { category: transportCategory(error) };
      }
      const status = res.status;
      if (!res.ok) {
        throw {
          status,
          category: status === 401 || status === 403 ? "authorization_denied"
            : status === 429 ? "rate_limited" : "upstream_error",
        };
      }
      let body;
      try {
        body = await res.json();
      } catch (error) {
        throw { status, category: error instanceof SyntaxError ? "invalid_json" : transportCategory(error) };
      }
      if (!Array.isArray(body?.data)) throw { status, category: "invalid_schema" };
      return { status, models: body.data };
    }),
  );
  const successful = results
    .filter((result) => result.status === "fulfilled")
    .map((result) => result.value.models);
  const statuses = results.map(result =>
    result.status === "fulfilled" ? result.value.status : result.reason?.status);
  const diagnostic = safeDiagnostic(null, {
    category: "ok", statuses, samples: results.length, successfulSamples: successful.length,
    returnedModels: 0, eligibleModels: 0,
  });
  if (successful.length === 0) {
    // Mixed failures do not establish that the credential is invalid. Report
    // authorization denial only when every sample was denied; preserve all
    // observed HTTP statuses alongside the non-auth failure classification.
    const categories = results.map(result => result.reason?.category || "network_error");
    diagnostic.category = categories.every(category => category === "authorization_denied")
      ? "authorization_denied"
      : ["rate_limited", "tls_error", "timeout", "network_error", "upstream_error",
        "invalid_json", "invalid_schema"].find(category => categories.includes(category)) || "network_error";
    throw modelRecordsError(diagnostic);
  }
  try {
    const models = mergeCopilotModelLists(successful);
    diagnostic.returnedModels = models.length;
    diagnostic.eligibleModels = eligibleCopilotModels(models).length;
    return { models, diagnostic };
  } catch {
    throw modelRecordsError({ ...diagnostic, category: "invalid_schema" });
  }
}

export async function fetchCopilotModelRecords(
  token,
  { samples = MODEL_SAMPLE_COUNT } = {},
) {
  return (await probeCopilotModelRecords(token, samples)).models;
}

function ensureHome() {
  fs.mkdirSync(CODEX_COPILOT_HOME, { recursive: true });
}

function readStore(diagnostics = null) {
  try {
    const stored = JSON.parse(fs.readFileSync(AUTH_FILE, "utf8"));
    if (typeof stored?.oauth_token !== "string" || !stored.oauth_token.trim()) {
      collectDiagnostic(diagnostics, "saved", { category: "credential_missing" });
    }
    return stored;
  } catch (error) {
    collectDiagnostic(diagnostics, "saved", {
      category: error?.code === "ENOENT" ? "credential_missing"
        : error instanceof SyntaxError ? "store_invalid_json" : "store_unreadable",
    });
    return null;
  }
}

export function savedAuthRevision() {
  try {
    const stat = fs.statSync(AUTH_FILE, { bigint: true });
    return `${stat.mtimeNs}:${stat.size}`;
  } catch {
    return "missing";
  }
}

function writeStore(value) {
  ensureHome();
  const temporary = `${AUTH_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8");
  try {
    fs.renameSync(temporary, AUTH_FILE);
  } catch {
    fs.rmSync(AUTH_FILE, { force: true });
    fs.renameSync(temporary, AUTH_FILE);
  }
  try {
    if (process.platform === "win32") {
      execFileSync(
        "icacls",
        [
          AUTH_FILE,
          "/inheritance:r",
          "/grant:r",
          `${os.userInfo().username}:F`,
        ],
        { stdio: "ignore" },
      );
    } else {
      fs.chmodSync(AUTH_FILE, 0o600);
    }
  } catch {
    /* non-fatal */
  }
}

export function saveAuthRecord(record) {
  writeStore(record);
  if (record?.login && record?.oauth_token) {
    try {
      let vault = { schemaVersion: 1, accounts: {} };
      if (fs.existsSync(ACCOUNTS_VAULT_FILE)) {
        const parsed = JSON.parse(fs.readFileSync(ACCOUNTS_VAULT_FILE, "utf8"));
        if (parsed?.schemaVersion === 1 && parsed.accounts) vault = parsed;
      }
      vault.accounts[record.login.toLowerCase()] = {
        oauth_token: record.oauth_token,
        login: record.login,
        source: record.source || "codex-copilot login",
        verified_at: record.verified_at || new Date().toISOString(),
      };
      const tmp = `${ACCOUNTS_VAULT_FILE}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(vault, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, ACCOUNTS_VAULT_FILE);
    } catch {
      /* non-fatal */
    }
  }
}

function readAccountsVault() {
  try {
    const parsed = JSON.parse(fs.readFileSync(ACCOUNTS_VAULT_FILE, "utf8"));
    return parsed?.schemaVersion === 1 && parsed.accounts ? Object.values(parsed.accounts) : [];
  } catch {
    return [];
  }
}

/** Read GitHub tokens that the GitHub Copilot app / CLI already stored in Windows Credential Manager. */
function credentialManagerTokens(diagnostics = null) {
  if (process.platform !== "win32") return [];
  const script = path.join(import.meta.dirname, "credman.ps1");
  if (!fs.existsSync(script)) return [];
  try {
    const out = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script],
      { encoding: "utf8", timeout: 20000, windowsHide: true }
    );
    const parsed = JSON.parse(out.trim() || "[]");
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (error) {
    collectDiagnostic(diagnostics, "credential-manager", {
      category: error instanceof SyntaxError ? "store_invalid_json" : "store_unreadable",
    });
    return [];
  }
}

export function authMode() {
  const mode = (process.env.CODEX_COPILOT_AUTH_MODE || "auto").trim().toLowerCase();
  if (!AUTH_MODES.has(mode)) {
    throw new Error(
      `Unsupported CODEX_COPILOT_AUTH_MODE '${mode}'. Expected auto, credential-manager, saved, or environment.`
    );
  }
  return mode;
}

async function tokenValidation(token) {
  if (!token) return { models: null, diagnostic: { category: "credential_missing" } };
  try {
    const result = await probeCopilotModelRecords(token);
    if (!result.diagnostic.eligibleModels) {
      return { models: null, diagnostic: { ...result.diagnostic, category: "no_eligible_models" } };
    }
    return result;
  } catch (error) {
    return {
      models: null,
      diagnostic: safeDiagnostic(null, error?.diagnostic || { category: transportCategory(error) }),
    };
  }
}

export async function validateToken(token) {
  return (await tokenValidation(token)).models;
}

async function githubLogin(token) {
  try {
    const res = await fetch(`${GITHUB_API_BASE}/user`, {
      headers: { authorization: `token ${token}`, "user-agent": "codex-copilot" },
    });
    if (!res.ok) return null;
    const body = await res.json();
    return body.login || null;
  } catch {
    return null;
  }
}

/**
 * Resolve a GitHub token that is entitled to the Copilot API.
 * Order: explicit env -> saved login -> existing GitHub Copilot credentials on this machine.
 */
export async function resolveToken({
  quiet = true,
  allowSharedFallback = false,
  expectedLogin = null,
  excludeToken = null,
  diagnostics = null,
} = {}) {
  if (diagnostics !== null && !Array.isArray(diagnostics)) {
    throw new TypeError("Auth diagnostics must be an array or null.");
  }
  const diagnosticStart = diagnostics?.length || 0;
  const candidates = [];
  const push = (token, source, diagnosticSource) => {
    const normalized = typeof token === "string" ? token.trim() : "";
    if (
      normalized &&
      normalized !== excludeToken &&
      !candidates.some((candidate) => candidate.token === normalized)
    ) {
      candidates.push({ token: normalized, source, diagnosticSource });
    }
  };

  const mode = authMode();
  const storeDiagnostics = [];
  push(process.env.CODEX_COPILOT_GITHUB_TOKEN, "env:CODEX_COPILOT_GITHUB_TOKEN", "environment");
  // Retain the existing store read/login optimization, but diagnose the saved
  // store only when that credential source is selected by the configured mode.
  const stored = readStore(mode === "auto" || mode === "saved" ? storeDiagnostics : null);
  const hasStoredCredential =
    typeof stored?.oauth_token === "string" && stored.oauth_token.trim().length > 0;

  if (mode === "auto" || mode === "saved") {
    push(stored?.oauth_token, "codex-copilot login", "saved");
    if (allowSharedFallback || expectedLogin) {
      for (const entry of readAccountsVault()) {
        push(entry?.oauth_token, entry?.source || "codex-copilot login", "saved");
      }
    }
  }
  if (
    mode === "credential-manager" ||
    (mode === "auto" && (!hasStoredCredential || allowSharedFallback))
  ) {
    for (const entry of credentialManagerTokens(storeDiagnostics)) {
      push(entry.secret, `windows credential: ${entry.target}`, "credential-manager");
    }
  }
  if (
    mode === "environment" ||
    (mode === "auto" && (!hasStoredCredential || allowSharedFallback))
  ) {
    push(process.env.GH_TOKEN, "env:GH_TOKEN", "environment");
    push(process.env.GITHUB_TOKEN, "env:GITHUB_TOKEN", "environment");
  }
  for (const entry of storeDiagnostics) {
    // A missing source is not a missing-credential conclusion when another
    // candidate exists and its validation provides the actual failure reason.
    if (entry.category !== "credential_missing" || !candidates.length) {
      collectDiagnostic(diagnostics, entry.source, entry);
    }
  }
  if (!candidates.length) {
    const source = mode === "environment" ? "environment"
      : mode === "credential-manager" ? "credential-manager" : "saved";
    if (!diagnostics?.slice(diagnosticStart).some(entry => entry.source === source)) {
      collectDiagnostic(diagnostics, source, { category: "credential_missing" });
    }
  }

  for (const candidate of candidates) {
    const { models, diagnostic } = await tokenValidation(candidate.token);
    if (models) {
      const isStored = stored?.oauth_token === candidate.token;
      const login = isStored ? stored.login : await githubLogin(candidate.token);
      if (
        expectedLogin &&
        (!login || login.toLowerCase() !== expectedLogin.toLowerCase())
      ) {
        collectDiagnostic(diagnostics, candidate.diagnosticSource, {
          ...diagnostic, category: "identity_mismatch",
        });
        continue;
      }
      const record = {
        oauth_token: candidate.token,
        login: login || null,
        source: candidate.source,
        verified_at: new Date().toISOString(),
      };
      const validation = collectDiagnostic(diagnostics, candidate.diagnosticSource, diagnostic);
      let stabilized;
      try {
        stabilized = stabilizeCopilotModels(record.login, models);
      } catch (error) {
        collectDiagnostic(diagnostics, candidate.diagnosticSource, {
          ...diagnostic, category: "cache_write_error",
        });
        throw error;
      }
      return { ...record, models: stabilized, validatedModels: models, validation };
    }
    collectDiagnostic(diagnostics, candidate.diagnosticSource, diagnostic);
    if (!quiet) {
      process.stderr.write(`codex-copilot: ${candidate.diagnosticSource} credential validation failed (${diagnostic.category})\n`);
    }
  }
  return null;
}

function abortError() {
  const error = new Error("device login cancelled");
  error.name = "AbortError";
  return error;
}

function wait(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(abortError());
      },
      { once: true },
    );
  });
}

/** GitHub OAuth device flow. `onCode` receives {user_code, verification_uri, expires_in}. */
export async function deviceLogin(onCode, { signal, persist = true } = {}) {
  const start = await fetch(DEVICE_CODE_URL, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ client_id: DEVICE_CLIENT_ID, scope: DEVICE_SCOPE }),
    signal,
  });
  if (!start.ok) throw new Error(`device code request failed: HTTP ${start.status}`);
  const flow = await start.json();
  if (!flow.device_code) throw new Error(`device code request failed: ${JSON.stringify(flow)}`);
  onCode(flow);

  const deadline = Date.now() + (flow.expires_in || 900) * 1000;
  let interval = (flow.interval || 5) * 1000;
  while (Date.now() < deadline) {
    await wait(interval, signal);
    const res = await fetch(DEVICE_TOKEN_URL, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        client_id: DEVICE_CLIENT_ID,
        device_code: flow.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
      signal,
    });
    const body = await res.json().catch(() => ({}));
    if (body.access_token) {
      const login = await githubLogin(body.access_token);
      const record = {
        oauth_token: body.access_token,
        login,
        source: "device-flow",
        verified_at: new Date().toISOString(),
      };
      if (persist) writeStore(record);
      return record;
    }
    if (body.error === "authorization_pending") continue;
    if (body.error === "slow_down") {
      interval += (body.interval || 5) * 1000;
      continue;
    }
    throw new Error(`device login failed: ${body.error_description || body.error || "unknown error"}`);
  }
  throw new Error("device login timed out");
}

export function logout() {
  try {
    fs.rmSync(AUTH_FILE);
    return true;
  } catch {
    return false;
  }
}

export { AUTH_FILE };
