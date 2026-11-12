import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import {
  CODEX_COPILOT_HOME,
  COPILOT_API,
  copilotApiFor,
  copilotApiStatus,
  copilotHeaders,
  deviceLogin,
  modelPoliciesRevision,
  readModelPolicies,
  resolveToken,
  saveAuthRecord,
  savedAuthRevision,
  setModelPolicy,
} from "./auth.mjs";
import {
  publishAccountSnapshot,
  readAccountGeneration,
  readAccountSnapshot,
} from "./account-store.mjs";
import { CopilotAccountCache, fetchCopilotAccount } from "./copilot-account.mjs";
import { buildCatalog, fetchCopilotModels, resolveModelSelection, routeFor } from "./catalog.mjs";
import { CATALOG_FILE, catalogFilesHealthy, readCatalogGeneration, writeCatalogSnapshot } from "./catalog-store.mjs";
import { chooseConfiguredModel } from "./model-selection.mjs";
import { sanitizeResponsesBody } from "./request-sanitize.mjs";
import { buildChatRequest, createResponsesWriter, readSse, sendJson } from "./translate.mjs";
import {
  isRetryableCopilotForbidden,
  isRetryableUpstreamError,
  isRetryableUpstreamStatus,
  waitForCopilotForbiddenRetry,
  waitForRetry,
} from "./upstream-retry.mjs";
import { startNetworkMonitor } from "./network-state.mjs";
import { readLatestRequestAudit, startRequestAudit } from "./request-audit.mjs";
import { ResponseIdentityError, ResponseIdentityStore } from "./response-identity.mjs";
import { CREDITS_RULES, creditsView } from "./copilot-credits.mjs";
import { forwardResponsesStream, ResponsesStreamError } from "./responses-stream.mjs";
import { fetchResponsesUpstream } from "./upstream-responses.mjs";
import {
  encodeResponseEvent,
  failedResponseEvent,
  isContextWindowError,
  normalizeResponsesError,
  normalizeResponsesErrorEvent,
} from "./responses-errors.mjs";
import { bridgeSourceGeneration } from "./runtime-generation.mjs";
import { selectedBridgePort } from "./port-selection.mjs";
import { SessionManagement, sessionRequestAuthorized } from "./session-management.mjs";
import { observeCliRequest } from "./cli-session-ownership.mjs";
import {
  checkAndCacheReleaseUpdate,
  getCachedReleaseUpdate,
  installRepositoryReleaseUpdate,
} from "./release-update.mjs";

const HOST = process.env.CODEX_COPILOT_BRIDGE_HOST || "127.0.0.1";
const HOST_URL = HOST === "::1" ? "[::1]" : HOST;
const PORT = selectedBridgePort({ home: CODEX_COPILOT_HOME, env: process.env });
// Never write or remove the legacy bridge.json: an older bridge on another port
// may still own it while a replacement starts in the same profile.
const RUNTIME_FILE = path.join(CODEX_COPILOT_HOME, `bridge-${PORT}.json`);
const CONTROL_FILE = path.join(CODEX_COPILOT_HOME, `bridge-control-${PORT}.json`);
const LOG_FILE = path.join(CODEX_COPILOT_HOME, "bridge.log");
const CATALOG_SYNC_MS = Number(process.env.CODEX_COPILOT_CATALOG_SYNC_MS || 30 * 1000);
const LOCAL_WATCH_MS = Number(process.env.CODEX_COPILOT_LOCAL_WATCH_MS || 2000);
const TRANSIENT_FORBIDDEN_MAX_ATTEMPTS = 10;
const configuredHeartbeatMs = Number(process.env.CODEX_COPILOT_SSE_HEARTBEAT_MS || 30000);
const SSE_HEARTBEAT_MS = Number.isSafeInteger(configuredHeartbeatMs) &&
  configuredHeartbeatMs > 0 && configuredHeartbeatMs <= 300000 ? configuredHeartbeatMs : 30000;
const RUNTIME = Object.freeze({
  sourceGeneration: bridgeSourceGeneration(),
  responsesItemIdentity: 1,
  responsesStreamContinuity: 1,
  responsesReasoningCheckpoints: 0,
  responsesCheckpointMs: 0,
  responsesMaxCheckpoints: 0,
  responsesTimeoutCompaction: 0,
  responsesAbortableRetries: 1,
  responsesCapabilityDowngrade: 0,
  responsesAccountEndpoint: 1,
  responsesUpstreamWebSocket: 1,
  releaseUpdateHotNotification: 1,
  nodeVersion: process.versions.node,
  controlProtocol: 1,
  instanceId: randomUUID(), // Public instance identity, never the control credential.
  ...(fs.existsSync(path.resolve(import.meta.dirname, "..", "release.json")) ? {
    releaseProfileIdentity: (
      await import("../release/bridge-port.mjs")
    ).profileIdentity(CODEX_COPILOT_HOME),
  } : {}),
});
const CONTROL_TOKEN = randomBytes(32).toString("base64url");
let activeRequests = 0;
const sessionManagement = new SessionManagement({ home: CODEX_COPILOT_HOME });

fs.mkdirSync(CODEX_COPILOT_HOME, { recursive: true });

function log(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  try {
    fs.appendFileSync(LOG_FILE, line, "utf8");
  } catch {
    /* diagnostics must never break a request */
  }
  if (process.env.CODEX_COPILOT_BRIDGE_VERBOSE === "1") process.stderr.write(line);
}

function publishControlToken() {
  const temporary = `${CONTROL_FILE}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(
      temporary,
      JSON.stringify({ pid: process.pid, instanceId: RUNTIME.instanceId, token: CONTROL_TOKEN }),
      { flag: "wx", mode: 0o600 },
    );
    if (process.platform === "win32") {
      // chmod(0600) does not restrict the inherited Windows ACL.
      const systemDirectory = path.join(process.env.SystemRoot, "System32");
      const user = execFileSync(path.join(systemDirectory, "whoami.exe"), ["/user", "/fo", "csv", "/nh"], {
        encoding: "utf8", windowsHide: true, timeout: 10000,
      });
      const sid = user.match(/"(S-\d+(?:-\d+)+)"\s*$/)?.[1];
      if (!sid) throw new Error("Could not identify the bridge user's Windows SID.");
      execFileSync(
        path.join(systemDirectory, "icacls.exe"),
        [temporary, "/grant:r", `*${sid}:F`, "/inheritance:r", "/Q"],
        { stdio: "ignore", windowsHide: true, timeout: 10000 },
      );
    } else {
      fs.chmodSync(temporary, 0o600);
    }
    fs.renameSync(temporary, CONTROL_FILE);
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch { /* best effort */ }
  }
}

function removeOwnedStartupFiles() {
  for (const file of [CONTROL_FILE, RUNTIME_FILE]) {
    try {
      const record = JSON.parse(fs.readFileSync(file, "utf8"));
      if (record.pid === process.pid &&
          (record.instanceId || record.runtime?.instanceId) === RUNTIME.instanceId) {
        fs.rmSync(file);
      }
    } catch {
      /* Never remove another instance's files or fail shutdown on stale metadata. */
    }
  }
}

function isLoopbackAddress(address) {
  return address === "::1" || /^127\./.test(address || "") ||
    /^::ffff:127\./i.test(address || "");
}

/* -------------------------------------------------------------- *
 * Auth + model state
 * -------------------------------------------------------------- */

const state = {
  token: null,
  login: null,
  source: null,
  models: [],
  modelsAt: 0,
  error: null,
  authRevision: null,
  authResolvedAt: 0,
};
const accountSwitches = new Map();
let activeAccountSwitchId = null;
const accountInfo = new CopilotAccountCache();
let accountRefreshes = 0;

function publishAccountDetails(details) {
  const catalog = buildCatalog(state.models);
  return publishAccountSnapshot({
    login: state.login, source: state.source,
    models: catalog.models.length, returnedModels: state.models.length,
    selectedModel: chooseConfiguredModel(catalog, state.models),
    ...details,
  });
}

async function refreshAccountDetails({ force = false } = {}) {
  if (!state.token) return;
  accountRefreshes += 1;
  try {
    const current = readAccountSnapshot();
    if (current?.login !== state.login || current?.source !== state.source) publishAccountDetails({});
    const identity = { token: state.token, login: state.login, generation: readAccountGeneration() };
    const details = await accountInfo.read(identity, { force });
    if (state.token === identity.token && state.login === identity.login &&
        readAccountGeneration() === identity.generation) publishAccountDetails(details);
  } finally {
    accountRefreshes -= 1;
  }
}

function observeQuotaHeaders(headers, token) {
  if (state.token !== token) return;
  const details = accountInfo.observeHeaders(headers, {
    token, login: state.login, generation: readAccountGeneration(),
  });
  if (details) publishAccountDetails(details);
}

async function ensureAuth({ force = false } = {}) {
  const revision = savedAuthRevision();
  const sharedCredentialCacheFresh =
    revision !== "missing" || Date.now() - state.authResolvedAt < 5 * 60 * 1000;
  if (
    !force &&
    state.token &&
    state.authRevision === revision &&
    sharedCredentialCacheFresh
  ) {
    return state.token;
  }
  const previousLogin = state.login;
  const previousToken = state.token;
  const resolved = await resolveToken();
  if (!resolved) {
    state.token = null;
    state.login = null;
    state.source = null;
    state.error =
      "No GitHub account with Copilot access was found. Run `codex-copilot login` (or sign in to the GitHub Copilot app) and try again.";
    throw new Error(state.error);
  }
  state.token = resolved.oauth_token;
  state.login = resolved.login;
  state.source = resolved.source;
  state.models = resolved.models || [];
  state.modelsAt = 0;
  state.error = null;
  state.authRevision = savedAuthRevision();
  state.authResolvedAt = Date.now();
  if (previousLogin && (previousLogin !== resolved.login || previousToken !== resolved.oauth_token)) {
    const catalog = buildCatalog(state.models);
    if (catalog.models.length) {
      writeCatalogSnapshot(catalog);
      const selectedModel = chooseConfiguredModel(catalog, state.models);
      publishAccountSnapshot({
        login: state.login,
        source: state.source,
        models: catalog.models.length,
        returnedModels: state.models.length,
        selectedModel,
      }, { forceNew: true });
      lastCatalogSignature = catalogSignature(state.models);
    }
  }
  log(`authenticated login=${resolved.login || "?"} source=${resolved.source} models=${state.models.length}`);
  return state.token;
}

async function recoverSameAccountCredential(currentToken) {
  if (!state.login) return null;
  return resolveToken({
    allowSharedFallback: true,
    expectedLogin: state.login,
    excludeToken: currentToken,
  });
}

function activateRecoveredCredential(record) {
  saveAuthRecord({ ...record, source: "recovered" });
  state.token = record.oauth_token;
  state.login = record.login;
  state.source = "codex-copilot login";
  state.models = record.models || state.models;
  state.modelsAt = Date.now();
  state.error = null;
  state.authRevision = savedAuthRevision();
  state.authResolvedAt = Date.now();
  const catalog = buildCatalog(state.models);
  if (catalog.models.length) {
    writeCatalogSnapshot(catalog);
    const selectedModel = chooseConfiguredModel(catalog, state.models);
    publishAccountSnapshot({
      login: state.login,
      source: state.source,
      models: catalog.models.length,
      returnedModels: state.models.length,
      selectedModel,
    });
  }
  log(`recovered same-account credential login=${state.login || "?"}`);
}

async function models({ force = false } = {}) {
  let token = await ensureAuth();
  if (force || Date.now() - state.modelsAt > 5 * 60 * 1000 || state.models.length === 0) {
    try {
      state.models = await fetchCopilotModels(token, {
        force: true,
        login: state.login,
      });
    } catch (error) {
      log(`model refresh failed with current credential: ${error.message}; resolving credential again`);
      token = await ensureAuth({ force: true });
      state.models = await fetchCopilotModels(token, {
        force: true,
        login: state.login,
      });
    }
    state.modelsAt = Date.now();
  }
  return state.models;
}

    function publicAccountState() {
      const catalog = buildCatalog(state.models);
      const snapshot = readAccountSnapshot();
      const matching = state.token && snapshot?.login === state.login &&
        snapshot?.source === state.source;
      return {
        status: state.token ? "authenticated" : "unauthenticated",
        login: state.login,
        source: state.source,
        models: catalog.models.length,
        returnedModels: state.models.length,
        accountGeneration: readAccountGeneration(),
        profile: matching ? snapshot.profile : null,
        plan: matching ? snapshot.plan : null,
        quota: matching ? snapshot.quota : null,
        credits: matching ? { ...creditsView(snapshot.quota?.credits),
          accountGeneration: snapshot.generation } : creditsView(null),
      };
    }

    function publicAccountSwitch(session) {
      return {
        id: session.id,
        status: session.status,
        verificationUri: session.verificationUri || null,
        verificationUriComplete: session.verificationUriComplete || null,
        userCode: session.userCode || null,
        expiresAt: session.expiresAt || null,
        login: session.login || null,
        models: session.models ?? null,
        returnedModels: session.returnedModels ?? null,
        selectedModel: session.selectedModel || null,
        accountGeneration: session.accountGeneration || null,
        error: session.error || null,
      };
    }

    async function applyAccountSwitch(record, session) {
      const liveModels = await fetchCopilotModels(record.oauth_token, {
        force: true,
        login: record.login,
      });
      const catalog = buildCatalog(liveModels);
      if (catalog.models.length === 0) {
        throw new Error("The selected GitHub account has no Codex-compatible Copilot models.");
      }

      const published = writeCatalogSnapshot(catalog);
      const selectedModel = chooseConfiguredModel(catalog, liveModels);
      saveAuthRecord(record);

      state.token = record.oauth_token;
      state.login = record.login;
      state.source = "codex-copilot login";
      state.models = liveModels;
      state.modelsAt = Date.now();
      state.error = null;
      state.authRevision = savedAuthRevision();
      state.authResolvedAt = Date.now();

      const accountPublished = publishAccountSnapshot({
        login: record.login,
        source: "codex-copilot login",
        models: catalog.models.length,
        returnedModels: liveModels.length,
        selectedModel,
      }, { forceNew: true });
      session.status = "complete";
      session.login = record.login;
      session.models = catalog.models.length;
      session.returnedModels = liveModels.length;
      session.selectedModel = selectedModel;
      session.generation = published.generation;
      session.accountGeneration = accountPublished.generation;
      activeAccountSwitchId = null;
      log(
        `desktop account switch complete login=${record.login || "?"} models=${catalog.models.length}`,
      );
    }

    function startAccountSwitch() {
      if (activeAccountSwitchId) {
        const active = accountSwitches.get(activeAccountSwitchId);
        if (active && ["starting", "pending"].includes(active.status)) return active;
      }

      const id = randomUUID();
      const controller = new AbortController();
      let resolveFlow;
      const flowReady = new Promise((resolve) => {
        resolveFlow = resolve;
      });
      const session = {
        id,
        status: "starting",
        controller,
        flowReady,
        createdAt: Date.now(),
      };
      accountSwitches.set(id, session);
      activeAccountSwitchId = id;

      deviceLogin(
        (flow) => {
          session.status = "pending";
          session.verificationUri = flow.verification_uri;
          session.verificationUriComplete = flow.verification_uri_complete || null;
          session.userCode = flow.user_code;
          session.expiresAt = new Date(
            Date.now() + (flow.expires_in || 900) * 1000,
          ).toISOString();
          resolveFlow();
        },
        { signal: controller.signal, persist: false },
      )
        .then((record) => applyAccountSwitch(record, session))
        .catch((error) => {
          session.status = error.name === "AbortError" ? "cancelled" : "error";
          session.error = error.message;
          activeAccountSwitchId = null;
          resolveFlow();
          log(`desktop account switch ${session.status}: ${error.message}`);
        })
        .finally(() => {
          const timer = setTimeout(() => accountSwitches.delete(id), 30 * 60 * 1000);
          timer.unref?.();
        });

      return session;
    }

    function accountOriginAllowed(req) {
      const origin = req.headers.origin;
      return !origin || origin === "app://-" || origin === "null";
    }

    function sendAccountJson(req, res, status, value) {
      const origin = req.headers.origin;
      const body = JSON.stringify(value);
      const allowedOrigin =
        origin === "app://-" || origin === "null" ? origin : "app://-";
      res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(body),
        "access-control-allow-origin": allowedOrigin,
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type",
        vary: "Origin",
      });
      res.end(body);
    }

/* -------------------------------------------------------------- *
 * Request helpers
 * -------------------------------------------------------------- */

function apiError(res, status, message, code = "invalid_request_error", details) {
  if (res.headersSent) {
    res.end();
    return;
  }
  const supplied = details && typeof details === "object" && !Array.isArray(details) ? details : {};
  sendJson(res, status, { error: {
    ...supplied, message, type: supplied.type || "invalid_request_error",
    param: supplied.param ?? null, code,
  } });
}

function readBody(req, limit = 256 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        fail(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on("aborted", () => fail(new Error("request body aborted by client")));
    req.on("error", fail);
  });
}

/* -------------------------------------------------------------- *
 * Route: native Responses passthrough
 * -------------------------------------------------------------- */

async function proxyResponses(req, res, request, model) {
  const controller = new AbortController();
  const progress = { responseId: null, sequenceNumber: -1, attempts: 0 };
  const disconnected = () => {
    if (!res.writableEnded) controller.abort(new Error("Responses client disconnected."));
  };
  req.once("aborted", disconnected);
  res.once("close", disconnected);
  if (req.aborted || res.destroyed) disconnected();
  try {
    await proxyResponsesRequest(req, res, request, controller.signal, progress, model);
  } catch (error) {
    request._audit?.complete({
      status: controller.signal.aborted ? "cancelled" : "error",
      error: { kind: error.name, message: error.message },
      attempts: progress.attempts,
      reasoningCheckpoints: 0,
      upstreamApi: progress.upstreamApi || null,
      upstreamTransport: progress.upstreamTransport || null,
      upstreamHandshakeHttpStatus: progress.upstreamHandshakeHttpStatus || null,
      upstreamTransportFallback: progress.upstreamTransportFallback || null,
      providerRequestId: progress.providerRequestId || null,
      serviceRequestId: progress.serviceRequestId || null,
    });
    if (!controller.signal.aborted) {
      if (!res.headersSent) throw error;
      if (request.stream === false) res.destroy();
      else res.end(encodeResponseEvent(failedResponseEvent({
        code: "upstream_stream_error",
        message: "GitHub Copilot interrupted the response before completion.",
      }, { responseId: progress.responseId, sequenceNumber: progress.sequenceNumber + 1 })));
    }
  } finally {
    req.off("aborted", disconnected);
    res.off("close", disconnected);
  }
}

async function proxyResponsesRequest(req, res, request, signal, progress, model) {
  const requestStartedAt = Date.now();
  signal.throwIfAborted();
  let token = await ensureAuth();
  const identities = new ResponseIdentityStore({
    home: CODEX_COPILOT_HOME, provider: COPILOT_API, account: state.login || token,
  });
  const streaming = request.stream !== false;
  let effectiveRequest;
  try {
    effectiveRequest = await identities.restoreRequest(request, {
      allowMaterializedRecovery: true,
      onRecovery(recovery) {
        res.setHeader("x-codex-copilot-identity-recovery", String(recovery.items));
        log(`responses identity recovery full_items=${recovery.items} response_groups=${recovery.responseGroups}`);
      },
    });
  } catch (error) {
    if (!(error instanceof ResponseIdentityError)) throw error;
    request._audit?.complete({ status: "error", error: { kind: error.name, message: error.message } });
    apiError(res, 400, error.message, "invalid_response_item_id");
    return;
  }
  let recoveredRecord = null;
  let maxAttempts = 3;
  const identity = identities.createSession();

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    signal.throwIfAborted();
    const payload = JSON.stringify(sanitizeResponsesBody(effectiveRequest));
    const payloadBytes = Buffer.byteLength(payload);
    const startedAt = Date.now();
    let upstream;
    try {
      progress.attempts += 1;
      const api = await copilotApiFor(token, { signal });
      progress.upstreamApi = api;
      const result = await fetchResponsesUpstream({
        api,
        headers: copilotHeaders(token, { accept: streaming ? "text/event-stream" : "application/json" }),
        payload,
        signal,
        // Sanitization removes provider IDs; keep legacy continuations off a new socket.
        preferWebSocket: effectiveRequest.previous_response_id == null &&
          model?.supported_endpoints?.includes("ws:/responses") === true,
      });
      upstream = result.response;
      progress.upstreamTransport = result.transport;
      progress.upstreamHandshakeHttpStatus = upstream.handshakeStatus || null;
      progress.upstreamTransportFallback = result.fallback;
      progress.providerRequestId = upstream.headers.get("x-github-request-id");
      progress.serviceRequestId = upstream.headers.get("x-copilot-service-request-id");
      if (result.fallback) log(
        `responses websocket_handshake_fallback model=${request.model} ` +
        `status=${result.fallback.httpStatus || "-"} inference_sent=false`,
      );
    } catch (error) {
      if (signal.aborted) throw error;
      if (error.responsesInferenceStarted) {
        progress.upstreamTransport = "websocket";
        progress.upstreamHandshakeHttpStatus = error.upstreamHandshakeHttpStatus || null;
        progress.upstreamTransportFallback = null;
        progress.providerRequestId = error.providerRequestId || null;
        progress.serviceRequestId = error.serviceRequestId || null;
      }
      if (!error.responsesInferenceStarted && attempt + 1 < maxAttempts && isRetryableUpstreamError(error)) {
        log(
          `responses retry model=${request.model} transport=${error?.cause?.code || error.name} ` +
          `attempt=${attempt + 1}/${maxAttempts} bytes=${payloadBytes}`,
        );
        await waitForRetry(null, attempt, signal);
        continue;
      }
      request._audit?.complete({
        status: "error", error: { kind: "transport", message: error.message },
        attempts: progress.attempts, reasoningCheckpoints: 0,
        upstreamApi: progress.upstreamApi || null,
        upstreamTransport: progress.upstreamTransport || null,
        upstreamHandshakeHttpStatus: progress.upstreamHandshakeHttpStatus || null,
        upstreamTransportFallback: progress.upstreamTransportFallback || null,
        providerRequestId: progress.providerRequestId || null,
        serviceRequestId: progress.serviceRequestId || null,
      });
      if (res.headersSent) {
        res.end(encodeResponseEvent(failedResponseEvent({
          code: "upstream_transport_error",
          message: "GitHub Copilot could not start the response after retries.",
        }, { responseId: progress.responseId, sequenceNumber: progress.sequenceNumber + 1 })));
        return;
      }
      throw error;
    }

    if (upstream.ok) {
      if (recoveredRecord) {
        activateRecoveredCredential(recoveredRecord);
        recoveredRecord = null;
      }
      observeQuotaHeaders(upstream.headers, token);
      if (!res.headersSent) {
        res.writeHead(upstream.status, {
          "content-type": upstream.headers.get("content-type") || (streaming ? "text/event-stream" : "application/json"),
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
      }
      let completedUsage = null;
      let outcome = streaming ? "incomplete" : "complete";
      let responseError = null;
      if (streaming) {
        let eventsForwarded = 0;
        let lastEventType = null;
        try {
          // A completed reasoning item is not a completed response. Keep reading
          // the same stream so the next message, tool call or terminal is not lost.
          await forwardResponsesStream(upstream.body, res, {
            identity, signal, heartbeatMs: SSE_HEARTBEAT_MS,
            normalizeEvent: normalizeResponsesErrorEvent,
            onEvent(event) {
              eventsForwarded += 1;
              lastEventType = event?.type || null;
              progress.responseId = event?.response?.id || progress.responseId;
              if (Number.isSafeInteger(event?.sequence_number)) progress.sequenceNumber = event.sequence_number;
              if (event?.type === "response.completed") {
                completedUsage = event.response?.usage || null;
                outcome = "complete";
              } else if (event?.type === "response.failed" || event?.type === "error") {
                outcome = "error";
                responseError = event.response?.error || event.error || { kind: "upstream", message: event.message };
              } else if (event?.type === "response.incomplete") {
                outcome = "incomplete";
                responseError = event.response?.incomplete_details || null;
              }
            },
          });
        } catch (error) {
          if (signal.aborted) throw error;
          const retryable = error instanceof ResponsesStreamError || isRetryableUpstreamError(error);
          // Published output or a sent WebSocket inference belongs to Codex's
          // reconnection policy. Preserve only the pre-existing empty HTTP retry.
          if (eventsForwarded === 0 && progress.upstreamTransport !== "websocket" &&
              retryable && attempt + 1 < maxAttempts) {
            log(`responses retry model=${request.model} stream=${error.code || error.name} attempt=${attempt + 1}/${maxAttempts}`);
            await waitForRetry(null, attempt, signal);
            continue;
          }
          const code = error instanceof ResponseIdentityError ? "invalid_prompt"
            : error instanceof ResponsesStreamError ? error.code
            : error.code === "upstream_websocket_buffer_limit" ? error.code : "upstream_stream_error";
          const message = code === "invalid_prompt" || code === "upstream_websocket_buffer_limit" ? error.message
            : "GitHub Copilot interrupted the response stream before completion. Codex can reconnect; no completion or usage was fabricated.";
          res.end(encodeResponseEvent(failedResponseEvent(
            { code, message }, {
              responseId: progress.responseId, sequenceNumber: progress.sequenceNumber + 1,
            },
          )));
          request._audit?.complete({
            status: error instanceof ResponsesStreamError ? "incomplete" : "error",
            error: { kind: "stream", code, transportCode: error.cause?.code || null },
            httpStatus: upstream.status,
            providerRequestId: upstream.headers.get("x-github-request-id"),
            serviceRequestId: upstream.headers.get("x-copilot-service-request-id"),
            upstreamApi: progress.upstreamApi,
            upstreamTransport: progress.upstreamTransport,
            upstreamHandshakeHttpStatus: progress.upstreamHandshakeHttpStatus,
            upstreamTransportFallback: progress.upstreamTransportFallback,
            upstreamWebSocketClose: upstream.upstreamWebSocketClose || null,
            attempts: progress.attempts, eventsForwarded, lastEventType,
            reasoningCheckpoints: 0,
          });
          log(`responses stream_error model=${request.model} code=${code} transport=${error.cause?.code || "-"} events=${eventsForwarded} last=${lastEventType || "-"} elapsed_ms=${Date.now() - requestStartedAt} upstream_elapsed_ms=${Date.now() - startedAt} api=${progress.upstreamApi}`);
          return;
        }
      } else {
        const bytes = Buffer.from(await upstream.arrayBuffer());
        res.write(bytes);
        try {
          const parsed = JSON.parse(bytes.toString("utf8"));
          completedUsage = parsed?.usage || null;
          if (parsed?.status === "failed") { outcome = "error"; responseError = parsed.error || null; }
          if (parsed?.status === "incomplete") { outcome = "incomplete"; responseError = parsed.incomplete_details || null; }
        } catch {
          // Non-JSON upstream responses are forwarded unchanged.
        }
      }
      res.end();
      request._audit?.complete({
        status: outcome,
        error: responseError,
        providerRequestId: upstream.headers.get("x-github-request-id"),
        serviceRequestId: upstream.headers.get("x-copilot-service-request-id"),
        usage: completedUsage,
        httpStatus: upstream.status,
        upstreamApi: progress.upstreamApi,
        upstreamTransport: progress.upstreamTransport,
        upstreamHandshakeHttpStatus: progress.upstreamHandshakeHttpStatus,
        upstreamTransportFallback: progress.upstreamTransportFallback,
        upstreamWebSocketClose: upstream.upstreamWebSocketClose || null,
        attempts: progress.attempts,
        strippedParameters: [],
        reasoningCheckpoints: 0,
      });
      log(
        `responses model=${request.model} status=${upstream.status} bytes=${payloadBytes} ` +
        `elapsed_ms=${Date.now() - requestStartedAt} upstream_elapsed_ms=${Date.now() - startedAt} attempts=${progress.attempts} checkpoints=0 stripped=[] api=${progress.upstreamApi}`,
      );
      return;
    }

    const detail = await upstream.text();
    let parsed = null;
    try {
      parsed = JSON.parse(detail);
    } catch {
      /* keep raw text */
    }
    if (upstream.status === 400 && isContextWindowError(parsed?.error)) {
      const error = normalizeResponsesError(parsed.error);
      request._audit?.complete({
        status: "error", httpStatus: upstream.status, attempts: progress.attempts,
        reasoningCheckpoints: 0,
        providerRequestId: upstream.headers.get("x-github-request-id"),
        serviceRequestId: upstream.headers.get("x-copilot-service-request-id"),
        error: { kind: "upstream", code: error.code, upstreamCode: parsed.error.code },
      });
      log(`responses context_exceeded model=${request.model} status=${upstream.status} bytes=${payloadBytes}`);
      if (streaming) {
        // A bare HTTP 400 is InvalidRequest in Codex, even with the right code.
        // The Responses failure event activates its native compaction recovery.
        if (!res.headersSent) res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache, no-transform", "x-accel-buffering": "no",
        });
        res.end(encodeResponseEvent(failedResponseEvent(error, {
          responseId: progress.responseId, sequenceNumber: progress.sequenceNumber + 1,
        })));
      } else {
        apiError(res, upstream.status, error.message, error.code);
      }
      return;
    }
    const retryableForbidden = isRetryableCopilotForbidden(upstream.status, detail);
    if (retryableForbidden) maxAttempts = TRANSIENT_FORBIDDEN_MAX_ATTEMPTS;
    if (upstream.status === 401 || upstream.status === 403) {
      const fallback =
        attempt + 1 < maxAttempts
          ? await recoverSameAccountCredential(token)
          : null;
      if (fallback) {
        recoveredRecord = fallback;
        token = fallback.oauth_token;
        log(`responses retry model=${request.model} auth=same-account-fallback`);
        continue;
      }
    }
    if (
      (isRetryableUpstreamStatus(upstream.status) || retryableForbidden) &&
      attempt + 1 < maxAttempts
    ) {
      log(
        `responses retry model=${request.model} status=${upstream.status} ` +
        `attempt=${attempt + 1}/${maxAttempts} bytes=${payloadBytes} elapsed_ms=${Date.now() - startedAt}` +
        (retryableForbidden ? " reason=transient-forbidden" : ""),
      );
      if (retryableForbidden) {
        await waitForCopilotForbiddenRetry(upstream, attempt, signal);
      } else {
        await waitForRetry(upstream, attempt, signal);
      }
      continue;
    }
    log(
      `responses error model=${request.model} status=${upstream.status} ` +
      `bytes=${payloadBytes} elapsed_ms=${Date.now() - startedAt}`,
    );
    request._audit?.complete({
      status: "error",
      httpStatus: upstream.status,
      providerRequestId: upstream.headers.get("x-github-request-id"),
      serviceRequestId: upstream.headers.get("x-copilot-service-request-id"),
      error: { kind: "upstream", code: parsed?.error?.code || "upstream_error" },
      attempts: progress.attempts,
      reasoningCheckpoints: 0,
    });
    const message = parsed?.error?.message || detail.slice(0, 600) || "Copilot request failed";
    if (streaming && res.headersSent) {
      res.end(encodeResponseEvent(failedResponseEvent({
        ...(parsed?.error && typeof parsed.error === "object" && !Array.isArray(parsed.error) ? parsed.error : {}),
        code: upstream.status === 400 ? "invalid_prompt" : parsed?.error?.code || "upstream_error",
        message,
      }, { responseId: progress.responseId, sequenceNumber: progress.sequenceNumber + 1 })));
    } else {
      apiError(res, upstream.status, message, parsed?.error?.code || "upstream_error", parsed?.error);
    }
    return;
  }
  request._audit?.complete({
    status: "error",
    attempts: progress.attempts,
    reasoningCheckpoints: 0,
    error: { kind: "upstream", code: "retries_exhausted" },
  });
  apiError(res, 502, "GitHub Copilot rejected the request after retries", "upstream_error");
}

/* -------------------------------------------------------------- *
 * Route: Chat Completions translation
 * -------------------------------------------------------------- */

async function proxyChat(req, res, request, model) {
  const controller = new AbortController();
  const disconnected = () => {
    if (!res.writableEnded) controller.abort(new Error("Chat client disconnected."));
  };
  req.once("aborted", disconnected);
  res.once("close", disconnected);
  if (req.aborted || res.destroyed) disconnected();
  try {
    await proxyChatRequest(req, res, request, model, controller.signal);
  } catch (error) {
    if (!controller.signal.aborted) throw error;
    request._audit?.complete({
      status: "cancelled", error: { kind: error.name, message: error.message },
    });
  } finally {
    req.off("aborted", disconnected);
    res.off("close", disconnected);
  }
}

async function proxyChatRequest(req, res, request, model, signal) {
  signal.throwIfAborted();
  let token = await ensureAuth();
  const streaming = request.stream !== false;
  const { _audit, ...wireRequest } = request;
  const { body, toolKinds } = buildChatRequest(wireRequest, model);
  const writer = createResponsesWriter(res, wireRequest, toolKinds, { streaming, onLog: (m) => log(`chat ${request.model} ${m}`) });
  const payload = JSON.stringify(body);
  const payloadBytes = Buffer.byteLength(payload);
  let maxAttempts = 3;
  let recoveredRecord = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    signal.throwIfAborted();
    const startedAt = Date.now();
    let upstream;
    try {
      const api = await copilotApiFor(token, { signal });
      upstream = await fetch(`${api}/chat/completions`, {
        method: "POST",
        headers: copilotHeaders(token, { accept: streaming ? "text/event-stream" : "application/json" }),
        body: payload,
        duplex: "half",
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      if (attempt + 1 < maxAttempts && isRetryableUpstreamError(error)) {
        log(
          `chat retry model=${request.model} transport=${error?.cause?.code || error.name} ` +
          `attempt=${attempt + 1}/${maxAttempts} bytes=${payloadBytes}`,
        );
        await waitForRetry(null, attempt, signal);
        continue;
      }
      request._audit?.complete({
        status: "error",
        error: { kind: "transport", message: error.message },
      });
      writer.fail(`GitHub Copilot transport error: ${error.message}`);
      return;
    }

    if (!upstream.ok) {
      const detail = await upstream.text();
      let message = detail.slice(0, 600);
      let providerError = null;
      try {
        const error = JSON.parse(detail)?.error;
        if (error && typeof error === "object" && !Array.isArray(error)) {
          providerError = error;
          message = error.message || message;
        }
      } catch {
        /* raw */
      }
      const retryableForbidden = isRetryableCopilotForbidden(upstream.status, detail);
      if (retryableForbidden) maxAttempts = TRANSIENT_FORBIDDEN_MAX_ATTEMPTS;
      if ((upstream.status === 401 || upstream.status === 403) && attempt + 1 < maxAttempts) {
        const fallback = await recoverSameAccountCredential(token);
        if (fallback) {
          recoveredRecord = fallback;
          token = fallback.oauth_token;
          log(`chat retry model=${request.model} auth=same-account-fallback`);
          continue;
        }
      }
      if (
        (isRetryableUpstreamStatus(upstream.status) || retryableForbidden) &&
        attempt + 1 < maxAttempts
      ) {
        log(
          `chat retry model=${request.model} status=${upstream.status} ` +
          `attempt=${attempt + 1}/${maxAttempts} bytes=${payloadBytes} elapsed_ms=${Date.now() - startedAt}` +
          (retryableForbidden ? " reason=transient-forbidden" : ""),
        );
        if (retryableForbidden) {
          await waitForCopilotForbiddenRetry(upstream, attempt, signal);
        } else {
          await waitForRetry(upstream, attempt, signal);
        }
        continue;
      }
      log(
        `chat error model=${request.model} status=${upstream.status} ` +
        `bytes=${payloadBytes} elapsed_ms=${Date.now() - startedAt}`,
      );
      request._audit?.complete({
        status: "error",
        httpStatus: upstream.status,
        providerRequestId: upstream.headers.get("x-github-request-id"),
        serviceRequestId: upstream.headers.get("x-copilot-service-request-id"),
        attempts: attempt + 1,
        error: {
          kind: "upstream",
          code: normalizeResponsesError(providerError)?.code || "upstream_error",
          upstreamCode: providerError?.code || null,
        },
      });
      writer.fail(providerError || `GitHub Copilot: ${message}`, upstream.status);
      return;
    }

    if (recoveredRecord) {
      activateRecoveredCredential(recoveredRecord);
      recoveredRecord = null;
    }
    log(
      `chat model=${request.model} status=${upstream.status} bytes=${payloadBytes} ` +
      `elapsed_ms=${Date.now() - startedAt} attempts=${attempt + 1}`,
    );
    if (!body.stream) {
      const completion = await upstream.json();
      writer.pushChunk(completion);
      writer.finish();
      request._audit?.complete({
        status: "complete",
        providerRequestId: upstream.headers.get("x-github-request-id"),
        serviceRequestId: upstream.headers.get("x-copilot-service-request-id"),
        usage: writer.currentUsage(),
        httpStatus: upstream.status,
        attempts: attempt + 1,
      });
      return;
    }

    let done = false;
    let streamError = null;
    try {
      await readSse(
        upstream.body,
        (_name, chunk) => {
          if (done) return false;
          if (chunk?.error) {
            const error = normalizeResponsesError(chunk.error);
            streamError = {
              kind: "upstream", code: error?.code || "upstream_error",
              upstreamCode: chunk.error?.code || null,
            };
            writer.fail(error);
            done = true;
            return false;
          }
          writer.pushChunk(chunk);
        },
        () => {
          if (!done) {
            done = true;
            writer.finish();
          }
        }
      );
    } catch (error) {
      if (signal.aborted) throw error;
      request._audit?.complete({
        status: "error",
        providerRequestId: upstream.headers.get("x-github-request-id"),
        serviceRequestId: upstream.headers.get("x-copilot-service-request-id"),
        usage: writer.currentUsage(),
        error: { kind: "stream", message: error.message },
      });
      writer.fail(`GitHub Copilot stream error: ${error.message}`);
      return;
    }
    if (streamError || !done) {
      const error = streamError || { kind: "stream", code: "upstream_stream_incomplete" };
      if (!done) writer.fail(
        "GitHub Copilot interrupted the Chat Completions stream before [DONE]. No completion or usage was fabricated.",
        502, error.code,
      );
      request._audit?.complete({
        status: streamError ? "error" : "incomplete",
        providerRequestId: upstream.headers.get("x-github-request-id"),
        serviceRequestId: upstream.headers.get("x-copilot-service-request-id"),
        usage: writer.currentUsage(),
        httpStatus: upstream.status, attempts: attempt + 1, error,
      });
      return;
    }
    request._audit?.complete({
      status: "complete",
      providerRequestId: upstream.headers.get("x-github-request-id"),
      serviceRequestId: upstream.headers.get("x-copilot-service-request-id"),
      usage: writer.currentUsage(),
      httpStatus: upstream.status,
      attempts: attempt + 1,
    });
    return;
  }
}

/* -------------------------------------------------------------- *
 * HTTP handler
 * -------------------------------------------------------------- */

let lastCatalogSignature = null;

/** Identity of the current entitlement: which models exist and how they can be driven. */
function catalogSignature(list) {
  return list
    .filter((m) => m.capabilities?.type === "chat")
    .map((m) => {
      const context = m.codex_copilot_context || {};
      const limits = m.capabilities?.limits || {};
      return [
        m.id,
        routeFor(m) || "-",
        m.model_picker_enabled ? 1 : 0,
        m.policy?.state || "-",
        limits.max_prompt_tokens || "-",
        limits.max_context_window_tokens || "-",
        limits.max_output_tokens || "-",
        context.default_prompt_tokens || "-",
        context.long_context_prompt_tokens || "-",
      ].join(":");
    })
    .sort()
    .join("|");
}

function catalogFingerprint(catalog) {
  return (catalog?.models || [])
    .map(
      (model) =>
        `${model.slug}:${model.context_window}:${model.max_context_window}:${model.copilot?.default_context_window_tokens || "-"}:${model.copilot?.long_context_window_tokens || "-"}`
    )
    .sort()
    .join("|");
}

async function writeCatalog({ force = true } = {}) {
  const list = await models({ force });
  const catalog = buildCatalog(list);
  const published = writeCatalogSnapshot(catalog);
  if (published.changed && !published.cacheInvalidated) {
    log("catalog changed but models_cache.json could not be removed");
  }
  chooseConfiguredModel(catalog, list);
  lastCatalogSignature = catalogSignature(list);
  return catalog;
}

/** True when the catalog on disk still describes `list` in full. */
function catalogIsHealthy(list) {
  try {
    return catalogFilesHealthy(buildCatalog(list));
  } catch {
    return false;
  }
}

/**
 * Re-reads the account's Copilot entitlement and rewrites the catalog, unless the
 * cached list is younger than `maxAgeMs` and the file on disk is intact. This is what
 * every CLI and desktop start goes through, so a model enabled in GitHub Copilot
 * settings is picked up on the next launch without costing a round trip each time.
 */
async function refreshCatalog({ maxAgeMs = 0 } = {}) {
  if (maxAgeMs > 0 && state.models.length > 0 && Date.now() - state.modelsAt < maxAgeMs) {
    const list = state.models;
    if (catalogSignature(list) === lastCatalogSignature && catalogIsHealthy(list)) {
      return { models: buildCatalog(list).models.length, refreshed: false };
    }
  }
  const catalog = await writeCatalog({ force: true });
  return { models: catalog.models.length, refreshed: true };
}

/**
 * Keeps the Codex model catalog in step with the account's GitHub Copilot settings:
 * enabling or disabling a model on github.com shows up here without any manual step.
 * Also repairs the catalog if it goes missing or is truncated.
 */
async function syncCatalog() {
  try {
    await ensureAuth();
    const list = await models({ force: true });
    const signature = catalogSignature(list);

    const catalog = buildCatalog(list);
    const healthy = catalogFilesHealthy(catalog);
    if (signature === lastCatalogSignature && healthy) return;

    const published = writeCatalogSnapshot(catalog);
    if (published.changed && !published.cacheInvalidated) {
      log("catalog changed but models_cache.json could not be removed");
    }
    const selectedModel = chooseConfiguredModel(catalog, list);
    publishAccountSnapshot({
      login: state.login,
      source: state.source,
      models: catalog.models.length,
      returnedModels: list.length,
      selectedModel,
    });
    lastCatalogSignature = signature;
    log(`catalog synced models=${catalog.models.length}${healthy ? "" : " (repaired)"}`);
  } catch (error) {
    log(`catalog sync failed: ${error.message}`);
  }
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || `${HOST_URL}:${PORT}`}`);
  const route = url.pathname.replace(/^\/v1(?=\/|$)/, "") || "/";
  if (route === "/responses" || route === "/chat/completions") observeCliRequest(CODEX_COPILOT_HOME, req.headers);

  if (route.startsWith("/sessions/")) {
    res.setHeader("cache-control", "no-store");
    if (!sessionRequestAuthorized(req, { port: PORT, token: CONTROL_TOKEN })) {
      sendJson(res, 403, { error: { code: "session_not_authorized",
        message: "Use the local Desktop or ccodex session-management entry point." } });
      return;
    }
    try {
      const args = JSON.parse(await readBody(req, 1024 * 1024));
      const body = await sessionManagement.request(route.slice("/sessions/".length), args);
      sendJson(res, body.accepted ? 202 : 200, body);
    } catch (error) {
      sendJson(res, 400, { error: { code: error.code || "session_management_failed", message: error.message } });
    }
    return;
  }

  if (route.startsWith("/account")) {
    if (!accountOriginAllowed(req)) {
      sendAccountJson(req, res, 403, { error: "origin_not_allowed" });
      return;
    }
    if (req.method === "OPTIONS") {
      sendAccountJson(req, res, 204, {});
      return;
    }
    if (req.method === "POST" && route === "/account/usage") {
      const token = await ensureAuth();
      const identity = { login: state.login, source: state.source,
        generation: readAccountGeneration() };
      const details = await fetchCopilotAccount({ token, login: identity.login });
      if (state.token !== token || state.login !== identity.login ||
          readAccountGeneration() !== identity.generation) {
        sendAccountJson(req, res, 409, { error: "Account changed during the usage query; retry." });
        return;
      }
      sendAccountJson(req, res, 200, {
        status: "authenticated", login: identity.login, source: identity.source,
        accountGeneration: identity.generation, ...details,
        credits: { ...creditsView(details.quota?.credits),
          accountGeneration: identity.generation },
      });
      return;
    }
    if ((req.method === "GET" && route === "/account") ||
        (req.method === "POST" && route === "/account/refresh")) {
      try {
        await ensureAuth();
        await refreshAccountDetails({ force: req.method === "POST" });
      } catch {
        /* return the unauthenticated state */
      }
      sendAccountJson(req, res, 200, publicAccountState());
      return;
    }
    if (req.method === "POST" && route === "/account/switch") {
      let requestedLogin = null;
      try {
        const raw = await readBody(req, 64 * 1024);
        if (raw.length) {
          const parsed = JSON.parse(raw.toString("utf8"));
          if (typeof parsed?.login === "string" && parsed.login.trim()) {
            requestedLogin = parsed.login.trim();
          }
        }
      } catch {
        /* empty or non-JSON body starts standard device flow */
      }
      if (requestedLogin) {
        const existing = await resolveToken({
          allowSharedFallback: true,
          expectedLogin: requestedLogin,
        });
        if (!existing) {
          sendAccountJson(req, res, 404, {
            error: `No valid local credential found for GitHub account '${requestedLogin}'.`,
          });
          return;
        }
        const session = {
          id: randomUUID(),
          status: "starting",
          createdAt: Date.now(),
        };
        accountSwitches.set(session.id, session);
        await applyAccountSwitch(existing, session);
        sendAccountJson(req, res, 200, publicAccountSwitch(session));
        return;
      }
      const session = startAccountSwitch();
      if (session.status === "starting") {
        await Promise.race([
          session.flowReady,
          new Promise((resolve) => setTimeout(resolve, 15000)),
        ]);
      }
      const status = session.status === "error" ? 500 : 202;
      sendAccountJson(req, res, status, publicAccountSwitch(session));
      return;
    }
    const match = route.match(/^\/account\/switch\/([^/]+)(?:\/(cancel))?$/);
    if (match && req.method === "GET" && !match[2]) {
      const session = accountSwitches.get(match[1]);
      sendAccountJson(
        req,
        res,
        session ? 200 : 404,
        session ? publicAccountSwitch(session) : { error: "switch_not_found" },
      );
      return;
    }
    if (match && req.method === "POST" && match[2] === "cancel") {
      const session = accountSwitches.get(match[1]);
      if (!session) {
        sendAccountJson(req, res, 404, { error: "switch_not_found" });
        return;
      }
      if (["starting", "pending"].includes(session.status)) {
        session.controller.abort();
      }
      sendAccountJson(req, res, 200, publicAccountSwitch(session));
      return;
    }
    sendAccountJson(req, res, 404, { error: "account_route_not_found" });
    return;
  }

  if (req.method === "GET" && (route === "/health" || route === "/")) {
    let auth = null;
    try {
      await ensureAuth();
      auth = { login: state.login, source: state.source };
    } catch (error) {
      auth = { error: error.message };
    }
    sendJson(res, 200, {
      status: state.token ? "ok" : "unauthenticated",
      bridge: "codex-copilot",
      pid: process.pid,
      runtime: RUNTIME,
      activeRequests: Math.max(0, activeRequests - 1),
      endpoint: `http://${HOST_URL}:${PORT}`,
      upstream: (state.token ? copilotApiStatus(state.token)?.api : null) || COPILOT_API,
      upstreamResolution: state.token ? copilotApiStatus(state.token)?.source || null : null,
      auth,
      models: state.models.length,
    });
    return;
  }

  if (req.method === "GET" && route === "/models") {
    let catalog = null;
    try {
      catalog = JSON.parse(fs.readFileSync(CATALOG_FILE, "utf8"));
    } catch {
      catalog = await writeCatalog();
    }
    const body = JSON.stringify(catalog);
    const etag = `"${Buffer.from(catalogFingerprint(catalog)).toString("base64url")}"`;
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
      etag,
      "cache-control": "no-cache",
    });
    res.end(body);
    return;
  }

  if (req.method === "GET" && route === "/catalog") {
    sendJson(res, 200, await writeCatalog());
    return;
  }

  if (req.method === "GET" && route === "/diagnostics/effective") {
    const latest = readLatestRequestAudit();
    sendJson(res, latest ? 200 : 404, latest || { error: "no_audited_request" });
    return;
  }

  if (req.method === "POST" && route === "/catalog/refresh") {
    const maxAge = Number(url.searchParams.get("max_age_ms") || 0);
    const result = await refreshCatalog({ maxAgeMs: Number.isFinite(maxAge) ? maxAge : 0 });
    if (result.refreshed) log(`catalog refreshed on demand models=${result.models}`);
    sendJson(res, 200, { written: CATALOG_FILE, ...result });
    return;
  }

  if (route === "/models/policy") {
    if (!accountOriginAllowed(req)) {
      sendAccountJson(req, res, 403, { error: "origin_not_allowed" });
      return;
    }
    if (req.method === "OPTIONS") {
      sendAccountJson(req, res, 204, {});
      return;
    }
    if (req.method === "GET") {
      sendAccountJson(req, res, 200, readModelPolicies());
      return;
    }
    if (req.method === "POST") {
      try {
        const body = JSON.parse((await readBody(req, 64 * 1024)).toString("utf8") || "{}");
        const modelTarget = body.model || body.modelId || body.id;
        const token = await ensureAuth().catch(() => null);
        const result = await setModelPolicy(modelTarget, body.state, { token });
        state.modelsAt = 0;
        lastCatalogSignature = null;
        await syncCatalog();
        const catalog = buildCatalog(state.models);
        sendAccountJson(req, res, 200, {
          ok: true,
          ...result,
          models: catalog.models.length,
          catalogGeneration: readCatalogGeneration(),
          accountGeneration: readAccountGeneration(),
        });
      } catch (error) {
        sendAccountJson(req, res, 400, { error: error.message });
      }
      return;
    }
  }

  if (route.startsWith("/release-update")) {
    if (!accountOriginAllowed(req)) {
      sendAccountJson(req, res, 403, { error: "origin_not_allowed" });
      return;
    }
    if (req.method === "OPTIONS") {
      sendAccountJson(req, res, 204, {});
      return;
    }
    try {
      if (req.method === "GET" && route === "/release-update") {
        const state = getCachedReleaseUpdate({ home: CODEX_COPILOT_HOME });
        sendAccountJson(req, res, 200, state);
        return;
      }
      if (req.method === "POST" && route === "/release-update/check") {
        const state = await checkAndCacheReleaseUpdate({ home: CODEX_COPILOT_HOME });
        sendAccountJson(req, res, 200, state);
        return;
      }
      if (req.method === "POST" && route === "/release-update/install") {
        const result = await installRepositoryReleaseUpdate({ home: CODEX_COPILOT_HOME });
        sendAccountJson(req, res, 200, result);
        return;
      }
      sendAccountJson(req, res, 404, { error: "release_update_route_not_found" });
    } catch (error) {
      sendAccountJson(req, res, 500, { error: error.message });
    }
    return;
  }

  if (req.method !== "POST" || route !== "/responses") {
    apiError(res, 404, `Route ${req.method} ${url.pathname} not found`, "not_found");
    return;
  }

  let request;
  let rawBody;
  try {
    rawBody = await readBody(req);
    request = JSON.parse(rawBody.toString("utf8"));
  } catch (error) {
    apiError(res, 400, `Invalid JSON body: ${error.message}`);
    return;
  }
  log(
    `request_body route=/responses bytes=${rawBody.length} ` +
    `content_length=${req.headers["content-length"] || "chunked"}`,
  );

  const list = await models();

  const selection = resolveModelSelection(list, request.model, request.service_tier);
  if (!selection) {
    apiError(
      res,
      400,
      `Model '${request.model}' is not available to this GitHub Copilot account. Run \`codex-copilot models\` to list the enabled models.`,
      "model_not_found"
    );
    return;
  }

  const route2 = routeFor(selection.model);
  const contextMetadata = selection.model.codex_copilot_context || {};
  const limits = selection.model.capabilities?.limits || {};
  const effectiveContextWindow =
    selection.contextTier === "long_context"
      ? contextMetadata.long_context_prompt_tokens || limits.max_prompt_tokens || null
      : contextMetadata.default_prompt_tokens || limits.max_prompt_tokens || null;
  const audit = startRequestAudit({
    surface: String(req.headers["x-codex-copilot-surface"] || "codex"),
    account: state.login,
    accountGeneration: readAccountGeneration(),
    threadId: req.headers["thread-id"] || null,
    requestedModel: request.model,
    upstreamModel: selection.model.id,
    contextTier: selection.contextTier,
    effectiveContextWindow,
    endpoint: route2 === "responses" ? "/responses" : "/chat/completions",
    request,
  });
  const upstreamRequest = { ...request, model: selection.model.id, _audit: audit };
  log(
    `request model=${request.model} upstream=${selection.model.id} context=${selection.contextTier}`
  );
  if (route2 === "responses") await proxyResponses(req, res, upstreamRequest, selection.model);
  else if (route2 === "chat") await proxyChat(req, res, upstreamRequest, selection.model);
  else apiError(res, 400, `Model '${request.model}' cannot be driven by Codex`, "model_not_supported");
}

/* -------------------------------------------------------------- *
 * Startup
 * -------------------------------------------------------------- */

async function main() {
  if (process.argv.includes("--catalog-only")) {
    const catalog = await writeCatalog();
    process.stdout.write(`wrote ${catalog.models.length} models to ${CATALOG_FILE}\n`);
    return;
  }

  let catalogTimer = null;
  let localWatchTimer = null;
  const accountTimer = setInterval(() => {
    refreshAccountDetails().catch(() => log("Account/credit refresh failed; the last verified timestamp remains authoritative."));
  }, CREDITS_RULES.refreshMs);
  accountTimer.unref();
  const networkTimer = startNetworkMonitor((event) => {
    state.authRevision = null;
    state.authResolvedAt = 0;
    state.modelsAt = 0;
    lastCatalogSignature = null;
    log(
      `network changed generation=${event.generation} id=${event.id} ` +
      `connections_reset=${event.connectionsReset}`,
    );
  });
  let draining = false;
  let catalogInitializing = true;
  let catalogRefreshes = 0;
  const finishShutdown = () => {
    removeOwnedStartupFiles();
  };
  const beginDrain = () => {
    if (draining) return;
    draining = true;
    clearInterval(networkTimer);
    clearInterval(accountTimer);
    if (catalogTimer) clearInterval(catalogTimer);
    if (localWatchTimer) clearInterval(localWatchTimer);
    server.close((error) => {
      if (error) log(`server_close_error ${error.message}`);
      sessionManagement.close().catch(error => log(`session_shutdown_error ${error.message}`))
        .finally(finishShutdown);
    });
    server.closeIdleConnections?.();
  };
  const server = http.createServer((req, res) => {
    if (draining) {
      res.writeHead(503, { connection: "close" });
      res.end();
      return;
    }
    activeRequests += 1;
    let settled = false;
    const finished = () => {
      if (settled) return;
      settled = true;
      activeRequests -= 1;
      res.off("finish", finished);
      res.off("close", finished);
    };
    res.once("finish", finished);
    res.once("close", finished);
    if (req.url?.split("?", 1)[0] === "/_control/stop") {
      res.setHeader("cache-control", "no-store");
      res.setHeader("connection", "close");
      const host = req.headers.host;
      const local =
        isLoopbackAddress(req.socket.remoteAddress) &&
        isLoopbackAddress(req.socket.localAddress) &&
        [`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`].includes(host);
      const fromBrowser =
        req.headers.origin !== undefined ||
        req.headers.referer !== undefined ||
        Object.keys(req.headers).some((header) => header.startsWith("sec-fetch-"));
      const supplied = req.headers["x-codex-copilot-control"];
      const authorized =
        req.method === "POST" &&
        req.url === "/_control/stop" &&
        local &&
        !fromBrowser &&
        typeof supplied === "string" &&
        supplied.length === CONTROL_TOKEN.length &&
        timingSafeEqual(Buffer.from(supplied), Buffer.from(CONTROL_TOKEN));
      if (!authorized) {
        sendJson(res, 403, { error: "control_not_authorized" });
      } else if (
        activeRequests !== 1 || activeAccountSwitchId !== null ||
        catalogInitializing || catalogRefreshes !== 0 || accountRefreshes !== 0 ||
        sessionManagement.backgroundJobs !== 0
      ) {
        sendJson(res, 409, {
          error: "bridge_busy",
          activeRequests: activeRequests - 1,
          backgroundJobs: Number(activeAccountSwitchId !== null) +
            Number(catalogInitializing) + catalogRefreshes + accountRefreshes +
            sessionManagement.backgroundJobs,
        });
      } else {
        // No await between the last workload check and refusing new work.
        beginDrain();
        sendJson(res, 202, { status: "draining", pid: process.pid, instanceId: RUNTIME.instanceId });
      }
      return;
    }
    handle(req, res).catch((error) => {
      log(`request_error ${error.stack || error.message}`);
      apiError(res, 500, error.message, "bridge_error");
    });
  });
  server.keepAliveTimeout = 120_000;
  server.headersTimeout = 125_000;
  server.requestTimeout = 0;

  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      log(`port ${PORT} already in use`);
      process.exit(1);
    }
    log(`server_error ${error.message}`);
    process.exit(1);
  });

  server.listen(PORT, HOST, async () => {
    try {
      publishControlToken();
      fs.writeFileSync(
        RUNTIME_FILE,
        JSON.stringify({ pid: process.pid, host: HOST, port: PORT,
          started_at: new Date().toISOString(), runtime: RUNTIME }, null, 2),
      );
    } catch (error) {
      log(`bridge startup could not secure control state: ${error.message}`);
      process.exitCode = 1;
      catalogInitializing = false;
      beginDrain();
      return;
    }
    log(`listening on http://${HOST_URL}:${PORT}`);
    try {
      const catalog = await writeCatalog();
      const selectedModel = chooseConfiguredModel(catalog, state.models);
      publishAccountSnapshot({
        login: state.login,
        source: state.source,
        models: catalog.models.length,
        returnedModels: state.models.length,
        selectedModel,
      });
      log(`catalog refreshed models=${catalog.models.length}`);
      refreshAccountDetails().catch(() => {});
    } catch (error) {
      log(`catalog refresh failed: ${error.message}`);
    } finally {
      catalogInitializing = false;
    }
    // Pick up models the user enables or disables in their GitHub Copilot settings.
    if (!draining) {
      let watchedAuthRev = savedAuthRevision();
      let watchedPolicyRev = modelPoliciesRevision();
      localWatchTimer = setInterval(() => {
        if (draining || catalogInitializing || catalogRefreshes !== 0 || activeAccountSwitchId !== null) return;
        const nextAuthRev = savedAuthRevision();
        const nextPolicyRev = modelPoliciesRevision();
        if (nextAuthRev === watchedAuthRev && nextPolicyRev === watchedPolicyRev) return;
        watchedAuthRev = nextAuthRev;
        watchedPolicyRev = nextPolicyRev;
        state.modelsAt = 0;
        lastCatalogSignature = null;
        catalogRefreshes += 1;
        syncCatalog().catch((error) => log(`local watch sync failed: ${error.message}`))
          .finally(() => { catalogRefreshes -= 1; });
      }, LOCAL_WATCH_MS);
      localWatchTimer.unref?.();

      catalogTimer = setInterval(() => {
        if (draining || catalogInitializing || catalogRefreshes !== 0 || activeAccountSwitchId !== null) return;
        catalogRefreshes += 1;
        syncCatalog().catch((error) => log(`catalog sync failed: ${error.message}`))
          .finally(() => { catalogRefreshes -= 1; });
      }, CATALOG_SYNC_MS);
      catalogTimer.unref?.();
    }
  });

  process.on("SIGINT", beginDrain);
  process.on("SIGTERM", beginDrain);
}

main().catch((error) => {
  log(`fatal ${error.stack || error.message}`);
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
